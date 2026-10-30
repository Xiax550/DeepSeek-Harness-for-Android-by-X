package com.dha.harness;

import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Environment;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Process-wide paths and configuration.
 *
 * Everything the sandbox needs lives under the app's private files dir, because
 * that is the only place we may both write freely and (see AndroidManifest)
 * execute from. Layout:
 *
 *   files/distros/ubuntu/        bundled payload: Ubuntu + Node + dsh
 *   files/distros/<id>/          imported PRoot distributions
 *   files/tmp/                   staging for imports
 *   files/run/server.pid         guest pid of the running dsh server
 *   files/logs/server.log        combined server stdout/stderr
 */
public final class App extends Application {

    /**
     * Identity of the payload this build ships.
     *
     * Generated from the archive's own content hash (see scripts/build_apk.sh),
     * so a changed payload always re-extracts. A hand-bumped constant was wrong
     * twice: the app kept running the previous tree and every fix looked like it
     * had not landed.
     */
    public static final String PAYLOAD_VERSION = BuildInfo.PAYLOAD_VERSION;

    public static final String BUNDLED_ID = "ubuntu";

    private static App instance;

    public File distrosDir;
    public File distroDir;      // of the active distro
    public File tmpDir;
    public File runDir;
    public File logsDir;
    public File serverLog;
    public File pidFile;

    public SharedPreferences prefs;

    public static App i() {
        return instance;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        File root = getFilesDir();
        distrosDir = new File(root, "distros");
        tmpDir = new File(root, "tmp");
        runDir = new File(root, "run");
        logsDir = new File(root, "logs");
        serverLog = new File(logsDir, "server.log");
        pidFile = new File(runDir, "server.pid");
        for (File d : new File[]{distrosDir, tmpDir, runDir, logsDir}) {
            if (!d.exists() && !d.mkdirs()) {
                android.util.Log.e("dsh", "cannot create " + d);
            }
        }
        prefs = getSharedPreferences("dsh", Context.MODE_PRIVATE);
        resetRecoveryAfterUpdate();
        TaskImages.sweepOrphans();
        migrateSandboxOptIns();
        migrateAppearanceDefault();
        migrateLegacyDistro();
        removeLegacyLocalModel();
        distroDir = new File(distrosDir, activeDistroId());
    }

    /**
     * A newly installed shell should retry the harness once. Otherwise failure
     * counters from an old build can leave the new build stuck in recovery
     * before it has had a chance to prove that its own startup path works.
     */
    private void resetRecoveryAfterUpdate() {
        int previous = prefs.getInt("last_app_version_code", 0);
        if (previous == BuildInfo.APP_VERSION_CODE) return;
        prefs.edit().putInt("last_app_version_code", BuildInfo.APP_VERSION_CODE).apply();
        Recovery.noteReady();
        if (Recovery.active()) Recovery.exit("应用已更新，重新尝试正常启动");
    }

    /**
     * New installations keep the expensive network / display features off.
     * Earlier builds could leave them enabled before those defaults were made
     * explicit, so close both once on upgrade. The marker preserves any later
     * choice the user makes afterwards.
     */
    private void migrateSandboxOptIns() {
        if (prefs.getBoolean("sandbox_opt_ins_default_off_v1", false)) return;
        prefs.edit()
                .putBoolean(EdgeTts.PREF_ENABLED, false)
                .putBoolean(VirtualDisplayController.PREF_ENABLED, false)
                .putBoolean("sandbox_opt_ins_default_off_v1", true)
                .apply();
        VirtualDisplayController.release();
    }

    /**
     * Older builds treated "system" as the default and persisted that automatic
     * choice. New installs default to light. Convert that legacy automatic value
     * once, while leaving a later explicit "system" choice untouched.
     */
    private void migrateAppearanceDefault() {
        if (prefs.getBoolean("appearance_default_light_v1", false)) return;
        String mode = prefs.getString("appearance_mode", Appearance.MODE_LIGHT);
        SharedPreferences.Editor editor = prefs.edit()
                .putBoolean("appearance_default_light_v1", true)
                // The cache may be from the old automatic dark/system choice.
                .remove("page_theme_dark")
                .remove("page_theme_background")
                .remove("page_theme_background_alpha");
        if (Appearance.MODE_SYSTEM.equals(mode)) {
            editor.putString("appearance_mode", Appearance.MODE_LIGHT);
        }
        editor.apply();
    }

    /**
     * The bundled distro was Alpine before it was Ubuntu, so its ~400 MB tree is
     * dropped once rather than left orphaned beside the new payload.
     *
     * Two rules learned the hard way, both about not doing this on the main
     * thread inside Application.onCreate:
     *
     *   once      a tree that cannot be fully deleted (PRoot's --link2symlink
     *             leftovers refuse to unlink) would otherwise be walked again on
     *             every single launch.
     *   off-thread  that walk is tens of thousands of files. Inline, it blocked
     *             startup before the bridge bound its port or the sandbox began
     *             to boot — the app looked dead with no crash to show for it.
     */
    private void migrateLegacyDistro() {
        final File legacy = new File(distrosDir, "alpine");
        if (BUNDLED_ID.equals("alpine")) return;
        final SharedPreferences.Editor editor = prefs.edit()
                .remove("cmd.alpine")
                .remove("name.alpine");
        if ("alpine".equals(prefs.getString("distro", BUNDLED_ID))) {
            editor.remove("distro");
        }
        editor.apply();
        if (prefs.getBoolean("legacyCleanupDone", false)) return;
        if (!legacy.exists()) {
            prefs.edit().putBoolean("legacyCleanupDone", true).apply();
            return;
        }
        prefs.edit().putBoolean("legacyCleanupDone", true).apply();
        Thread cleanup = new Thread(() -> {
            Payload.deleteTree(legacy);
            if (legacy.exists()) {
                // Some entries cannot be unlinked at all; moving the directory
                // aside is enough to stop it being in the way, and it costs one
                // rename instead of another full walk.
                File orphan = new File(distrosDir, "alpine.orphan");
                if (legacy.renameTo(orphan)) {
                    android.util.Log.i("dsh", "legacy alpine tree moved to " + orphan.getName());
                } else {
                    android.util.Log.w("dsh", "legacy alpine tree could not be removed");
                }
            } else {
                android.util.Log.i("dsh", "legacy alpine tree removed");
            }
        }, "legacy-cleanup");
        cleanup.setPriority(Thread.MIN_PRIORITY);
        cleanup.start();
    }

    /**
     * Local multimodal inference was removed after 1.2.36. Reclaim the model
     * download and llama.cpp runtime once so an in-place update does not leave
     * hundreds of megabytes behind with no settings entry that can delete it.
     */
    private void removeLegacyLocalModel() {
        if (prefs.getBoolean("local_vision_removed_v1", false)) return;
        prefs.edit().remove("localVisionEnabled").remove("localVisionFallback").apply();
        Thread cleanup = new Thread(() -> {
            File model = new File(runDir, "home/.dha/local-vision");
            File log = new File(logsDir, "local-vision.log");
            Payload.deleteTree(model);
            Payload.deleteTree(log);
            if (!model.exists() && !log.exists()) {
                prefs.edit().putBoolean("local_vision_removed_v1", true).apply();
                android.util.Log.i("dsh", "legacy local vision model removed");
            } else {
                android.util.Log.w("dsh", "legacy local vision cleanup incomplete; will retry");
            }
        }, "local-vision-cleanup");
        cleanup.setPriority(Thread.MIN_PRIORITY);
        cleanup.start();
    }

    /** Shell version (the APK), for the update card and the bridge snapshot. */
    public static String appVersion() {
        return BuildInfo.APP_VERSION;
    }

    public static int appVersionCode() {
        return BuildInfo.APP_VERSION_CODE;
    }

    /**
     * Version of the sandbox runtime (rootfs, node, dsh, installed tools).
     *
     * Deliberately its own number: it only moves when the runtime itself changes,
     * so "1.1.6-t2" says the shell moved and the runtime did not. Anything that
     * shows a version shows this one next to the shell's.
     */
    public static String terminalVersion() {
        return BuildInfo.ROOTFS_VERSION;
    }

    /** Distro the app boots; the bundled Ubuntu unless the user picked another. */
    public String activeDistroId() {
        return prefs.getString("distro", BUNDLED_ID);
    }

    public void setActiveDistroId(String id) {
        prefs.edit().putString("distro", id).apply();
        distroDir = new File(distrosDir, id);
    }

    public int port() {
        return prefs.getInt("port", 3080);
    }

    /**
     * Port the running server actually bound. Starts equal to the preference and
     * moves only when that port is taken, so the UI, the WebView URL and the
     * bridge never disagree about where the harness is listening.
     */
    private int activePort;

    public int activePort() {
        return activePort > 0 ? activePort : port();
    }

    /**
     * First loopback port at or after the configured one that nothing holds.
     *
     * A phone can have another harness (or a desktop session forwarded to it)
     * already on 3080; failing to start because of that is a bad trade when the
     * harness supports any port.
     */
    public int resolveFreePort() {
        for (int offset = 0; offset < 20; offset++) {
            int candidate = port() + offset;
            try (java.net.ServerSocket probe = new java.net.ServerSocket(
                    candidate, 1, java.net.InetAddress.getByName("127.0.0.1"))) {
                if (offset > 0) App.log("port " + port() + " busy, using " + candidate);
                activePort = candidate;
                return candidate;
            } catch (java.io.IOException busy) {
                activePort = 0;
            }
        }
        App.log("no free loopback port in " + port() + ".." + (port() + 19));
        activePort = port();
        return activePort;
    }

    /** Loopback port of the app's control bridge (Web UI settings page). */
    public int bridgePort() {
        return prefs.getInt("bridgePort", 8399);
    }

    /** Loopback port of the in-guest PTY service the terminal panel uses. */
    public int ptyPort() {
        return prefs.getInt("ptyPort", 3099);
    }

    /**
     * Per-process secrets. Regenerated on every app start and never persisted:
     * both services are loopback-only, and a token that dies with the process
     * cannot be replayed by anything that reads the device later.
     */
    private static String bridgeToken;

    private static String ptyToken;

    public String ensureBridgeToken() {
        if (bridgeToken == null) bridgeToken = randomToken();
        return bridgeToken;
    }

    public String ensurePtyToken() {
        if (ptyToken == null) ptyToken = randomToken();
        return ptyToken;
    }

    public String ptyToken() {
        return ensurePtyToken();
    }

    /**
     * A per-process secret. Shared with recovery mode, which needs the same
     * alphabet: the value it mints becomes a password typed by hand on another
     * machine, so it must stay printable and free of shell metacharacters.
     */
    static String randomToken() {
        byte[] bytes = new byte[24];
        new java.security.SecureRandom().nextBytes(bytes);
        return android.util.Base64.encodeToString(bytes,
                android.util.Base64.URL_SAFE | android.util.Base64.NO_PADDING | android.util.Base64.NO_WRAP);
    }

    public String startCommand() {
        return prefs.getString("cmd", "");
    }

    /** Path the payload was installed to, or null when setup has not run. */
    public File bundledHome() {
        return new File(distrosDir, BUNDLED_ID);
    }

    /**
     * Has the runtime been unpacked — and is it the one this shell should use?
     *
     * A full shell ships a payload, so only that payload's own `.payload-<version>`
     * marker counts: otherwise an app update would leave the previous runtime in
     * place forever (that is how a hand-installed `pnpm` survived, and how new
     * payload contents silently never arrived). A slim shell carries no payload: its
     * runtime arrives by download (`t<terminal>`) or by import, so any marker counts.
     */
    public boolean isBundledReady() {
        File home = bundledHome();
        String[] markers = home.isDirectory() ? home.list() : null;
        if (markers == null) return false;
        return PayloadMarker.isReady(markers, Payload.hasBundledPayload(this),
                BuildInfo.PAYLOAD_VERSION, BuildInfo.ROOTFS_VERSION);
    }

    /** True once the user has granted the legacy read/write permission. */
    public boolean hasStorageAccess() {
        return checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Root of the shared storage bind, or null when unavailable/disabled.
     *
     * The permission gate matters: without it the bind would mount a path the
     * app cannot read, and the guest would see /sdcard as an empty directory
     * rather than as "not shared" — a failure the user cannot diagnose.
     */
    public File sharedStorage() {
        if (!prefs.getBoolean("shareStorage", true)) return null;
        if (!hasStorageAccess()) return null;
        File ext = Environment.getExternalStorageDirectory();
        if (ext == null || !ext.isDirectory()) return null;
        return ext;
    }

    public static void log(String message) {
        android.util.Log.i("dsh", message);
        App app = instance;
        if (app == null) return;
        try {
            String stamp = new SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(new Date());
            try (OutputStream out = new FileOutputStream(app.serverLog, true)) {
                out.write((stamp + "  " + message + "\n").getBytes("UTF-8"));
            }
        } catch (IOException ignored) {
            // logging must never take the app down
        }
    }

    public void clearServerLog() {
        try (OutputStream out = new FileOutputStream(serverLog, false)) {
            out.write(new byte[0]);
        } catch (IOException ignored) {
        }
    }
}

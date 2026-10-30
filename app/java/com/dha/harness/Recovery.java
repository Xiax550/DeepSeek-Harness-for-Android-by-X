package com.dha.harness;

import android.content.SharedPreferences;

import org.json.JSONObject;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Collections;

/**
 * Recovery mode: the way into the sandbox when the harness is the thing that
 * broke.
 *
 * The problem this solves is a deadlock the project walked into twice already
 * (issue #3, and the terminal before it): every repair tool we ship lives inside
 * the harness Web UI, so a sandbox whose harness will not start is a sandbox the
 * user cannot fix. Recovery mode is the second entry point — the app boots the
 * guest into {@code recovery.sh} instead of {@code start-dsh.sh}, and what comes
 * up is an SSH daemon plus the PTY endpoint, with no harness involved at all.
 *
 * Authentication is a *live* token, not a stored password:
 *
 *   * it is generated when recovery is entered and thrown away when it is left;
 *   * it is used as root's password only for the lifetime of that one process
 *     (`recovery.sh` puts the shadow entry back with a trap on exit);
 *   * it is never written into the log, which is copied into bug reports —
 *     the log gets a short digest instead, so the panel and the running sshd can
 *     still be shown to agree on which secret is live.
 *
 * The decisions live in {@link RecoveryPlan} (pure, JVM-tested); this class is
 * the Android half: preferences, the phone's own address, and the JSON the
 * bridge and the native console read.
 */
public final class Recovery {

    /** Printed by `recovery.sh` once sshd is up; the app watches for it. */
    static final String READY_MARKER = "dsh-recovery: ready";

    private static final String PREF_ACTIVE = "recoveryActive";
    private static final String PREF_PORT = "recoveryPort";
    private static final String PREF_AUTO = "recoveryAuto";
    private static final String PREF_TOKEN = "recoveryToken";
    private static final String PREF_FAILURES = "recoveryFailures";
    private static final String PREF_LAST_FAILURE = "recoveryLastFailure";

    private static volatile boolean sshReady;
    private static volatile String lastReason = "";
    private static volatile String lanCache;
    private static volatile long lanCacheAt;
    private static final long LAN_CACHE_MS = 15000;

    private Recovery() {
    }

    private static SharedPreferences prefs() {
        return App.i().prefs;
    }

    // ------------------------------------------------------------------- mode

    public static boolean active() {
        return prefs().getBoolean(PREF_ACTIVE, false);
    }

    public static boolean auto() {
        return prefs().getBoolean(PREF_AUTO, true);
    }

    public static void setAuto(boolean enabled) {
        prefs().edit().putBoolean(PREF_AUTO, enabled).apply();
    }

    public static int port() {
        return RecoveryPlan.clampPort(prefs().getInt(PREF_PORT, RecoveryPlan.DEFAULT_PORT));
    }

    public static void setPort(int port) {
        prefs().edit().putInt(PREF_PORT, RecoveryPlan.clampPort(port)).apply();
    }

    /**
     * Enter recovery mode: mint a new token now.
     *
     * Rotating on every entry is the whole point of calling it "live": the secret
     * that worked yesterday, or that appeared in a screenshot, is not the secret
     * that opens today's session.
     */
    public static void enter(String reason) {
        String token = App.randomToken();
        prefs().edit()
                .putBoolean(PREF_ACTIVE, true)
                .putString(PREF_TOKEN, token)
                .apply();
        sshReady = false;
        lastReason = reason == null ? "" : reason;
        App.log("recovery: 进入恢复模式（" + lastReason + "），ssh 端口 " + port()
                + "，令牌 " + digest(token) + "（sha256 前 8 位）");
    }

    /**
     * Leave recovery, and forget the token with it.
     *
     * The failure counter is cleared too: the user is telling us to try the
     * harness again, and keeping three old failures on the books would send the
     * app straight back into recovery after a single new one — a loop that looks
     * like the app is fighting them. Three fresh failures is the same evidence it
     * took the first time.
     */
    public static void exit(String why) {
        if (!active()) return;
        prefs().edit()
                .putBoolean(PREF_ACTIVE, false)
                .remove(PREF_TOKEN)
                .remove(PREF_FAILURES)
                .remove(PREF_LAST_FAILURE)
                .apply();
        sshReady = false;
        lastReason = "";
        App.log("recovery: 退出恢复模式（" + (why == null ? "用户操作" : why) + "）");
    }

    /**
     * The live token, minted on first use.
     *
     * Prefs can hold no token (an upgrade from a build without recovery, or a
     * session where entering failed halfway); generating one here keeps every
     * caller on the same value instead of each minting its own and locking the
     * user out of a running sshd.
     */
    public static synchronized String token() {
        String stored = prefs().getString(PREF_TOKEN, "");
        if (RecoveryPlan.validToken(stored)) return stored;
        String fresh = App.randomToken();
        prefs().edit().putString(PREF_TOKEN, fresh).apply();
        return fresh;
    }

    /** A new token for the *next* boot; the running sshd keeps the old one. */
    public static synchronized String rotateToken() {
        String fresh = App.randomToken();
        prefs().edit().putString(PREF_TOKEN, fresh).apply();
        return fresh;
    }

    // --------------------------------------------------------------- failures

    /** Called when the guest process exits without the harness ever answering. */
    public static void noteFailure(String detail) {
        long now = System.currentTimeMillis();
        int failures = RecoveryPlan.failuresAt(
                prefs().getInt(PREF_FAILURES, 0),
                prefs().getLong(PREF_LAST_FAILURE, 0), now) + 1;
        prefs().edit()
                .putInt(PREF_FAILURES, failures)
                .putLong(PREF_LAST_FAILURE, now)
                .apply();
        App.log("recovery: harness 启动失败 " + failures + " 次（" + detail + "）");
    }

    /** Called the moment the harness announces its URL. */
    public static void noteReady() {
        if (prefs().getInt(PREF_FAILURES, 0) == 0
                && prefs().getLong(PREF_LAST_FAILURE, 0) == 0) {
            return;
        }
        prefs().edit().remove(PREF_FAILURES).remove(PREF_LAST_FAILURE).apply();
    }

    public static int failures() {
        return RecoveryPlan.failuresAt(
                prefs().getInt(PREF_FAILURES, 0),
                prefs().getLong(PREF_LAST_FAILURE, 0),
                System.currentTimeMillis());
    }

    public static boolean shouldAutoEnter() {
        return RecoveryPlan.shouldEnter(auto(), active(),
                prefs().getInt(PREF_FAILURES, 0),
                prefs().getLong(PREF_LAST_FAILURE, 0),
                System.currentTimeMillis());
    }

    // ------------------------------------------------------------------ state

    public static void markSshReady() {
        sshReady = true;
    }

    public static boolean sshReady() {
        return sshReady;
    }

    public static String reason() {
        return lastReason;
    }

    public static String describe() {
        return RecoveryPlan.describe(active(), sshReady, port(), failures());
    }

    /**
     * The phone's own address on the local network, or null when there is none.
     *
     * PRoot shares the phone's network namespace, so a daemon listening inside
     * the guest is reachable at whatever address the phone holds — the same
     * address a computer on the same Wi-Fi has to be told.
     */
    public static String lanAddress() {
        // /snapshot polls this every couple of seconds and enumerating interfaces
        // is a syscall per interface; the answer only changes when the network
        // does, so it is cached briefly. A stale value is harmless — it is
        // re-derived long before a user can act on it.
        String cached = lanCache;
        if (cached != null && System.currentTimeMillis() - lanCacheAt < LAN_CACHE_MS) {
            return cached.isEmpty() ? null : cached;
        }
        String found = lanAddressUncached();
        lanCache = found == null ? "" : found;
        lanCacheAt = System.currentTimeMillis();
        return found;
    }

    private static String lanAddressUncached() {
        try {
            for (NetworkInterface nic : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nic.isUp() || nic.isLoopback()) continue;
                for (InetAddress address : Collections.list(nic.getInetAddresses())) {
                    if (address instanceof Inet4Address
                            && !address.isLoopbackAddress()
                            && address.isSiteLocalAddress()) {
                        return address.getHostAddress();
                    }
                }
            }
        } catch (Throwable error) {
            App.log("recovery: 取局域网地址失败: " + error);
        }
        return null;
    }

    /** Where the on-phone console lives (a page served by pty-server.mjs). */
    public static String consoleUrl() {
        return "http://127.0.0.1:" + App.i().ptyPort() + "/recovery?token="
                + android.net.Uri.encode(App.i().ptyToken());
    }

    /** Everything the bridge and the native panel need to render the state. */
    public static JSONObject status() {
        JSONObject json = new JSONObject();
        try {
            int port = port();
            String lan = lanAddress();
            json.put("active", active());
            json.put("ready", sshReady);
            json.put("port", port);
            json.put("bind", "0.0.0.0");
            json.put("user", "root");
            json.put("token", token());
            json.put("auto", auto());
            json.put("failures", failures());
            json.put("reason", reason());
            json.put("lan", lan == null ? "" : lan);
            json.put("sshReady", sshReady);
            json.put("consoleUrl", consoleUrl());
            json.put("lanCommand", lan == null ? ""
                    : RecoveryPlan.sshCommand(lan, port, "root"));
            json.put("loopbackCommand", RecoveryPlan.sshCommand("127.0.0.1", port, "root"));
            json.put("forwardCommand", lan == null ? ""
                    : RecoveryPlan.forwardCommand(lan, port, "root", App.i().activePort()));
            json.put("adbForward", RecoveryPlan.adbForward(port));
        } catch (Throwable error) {
            App.log("recovery: status failed: " + error);
        }
        return json;
    }

    /** Short, non-reversible fingerprint of a token: what is safe to log. */
    public static String digest(String token) {
        try {
            java.security.MessageDigest sha = java.security.MessageDigest.getInstance("SHA-256");
            byte[] bytes = sha.digest((token == null ? "" : token).getBytes("UTF-8"));
            StringBuilder text = new StringBuilder();
            for (int i = 0; i < 4 && i < bytes.length; i++) {
                text.append(String.format("%02x", bytes[i]));
            }
            return text.toString();
        } catch (Throwable error) {
            return "????????";
        }
    }
}

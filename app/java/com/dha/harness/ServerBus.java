package com.dha.harness;

import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import java.io.BufferedReader;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.io.File;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Owns the PRoot/node server process and the state the UI observes.
 *
 * Both the activity and the foreground service live in the same process, so a
 * singleton with listener callbacks is enough and no IPC is needed.
 */
public final class ServerBus {

    public enum State {IDLE, PREPARING, STARTING, RUNNING, ERROR}

    public interface Listener {
        void onServerState();
    }

    /** The URL dsh prints once the Web UI is listening, token included. */
    private static final Pattern URL = Pattern.compile("(http://127\\.0\\.0\\.1:\\d+/\\?token=[A-Za-z0-9_\\-]+)");

    private static final Object LOCK = new Object();
    private static final Deque<String> LOG = new ArrayDeque<>();
    private static final List<Listener> LISTENERS = new ArrayList<>();

    private static State state = State.IDLE;
    private static String url;
    private static String error;
    private static Process process;
    private static Thread pump;
    private static long startedAt;
    /** Rootfs the current process was started in (recovery re-locks writes to it). */
    private static File activeRootfs;
    /** Bumped on every start, so a slow cleanup cannot touch a newer guest. */
    private static int generation;

    private ServerBus() {
    }

    public static State state() {
        return state;
    }

    public static String url() {
        return url;
    }

    public static String error() {
        return error;
    }

    public static long startedAt() {
        return startedAt;
    }

    public static boolean running() {
        return state == State.RUNNING;
    }

    public static List<String> log() {
        synchronized (LOCK) {
            return new ArrayList<>(LOG);
        }
    }

    public static void addListener(Listener listener) {
        synchronized (LISTENERS) {
            LISTENERS.add(listener);
        }
        listener.onServerState();
    }

    public static void removeListener(Listener listener) {
        synchronized (LISTENERS) {
            LISTENERS.remove(listener);
        }
    }

    private static void setState(State next, String detail) {
        synchronized (LOCK) {
            state = next;
            if (detail != null) {
                LOG.addLast(detail);
                while (LOG.size() > 400) LOG.removeFirst();
            }
        }
        if (detail != null) {
            App.log(detail);
        }
        notifyListeners();
    }

    private static void notifyListeners() {
        List<Listener> copy;
        synchronized (LISTENERS) {
            copy = new ArrayList<>(LISTENERS);
        }
        new Handler(Looper.getMainLooper()).post(() -> {
            for (Listener listener : copy) {
                listener.onServerState();
            }
        });
    }

    public static synchronized void start(Context ctx, Distros.Distro distro, String apiKey) {
        if (process != null && process.isAlive()) {
            // Only claim RUNNING once readiness was actually observed. The 15 s
            // watchdog calls this while a start is still in flight, and reporting
            // RUNNING for a process that has not announced itself yet hid the
            // difference between "coming up" and "up" — and would mask the
            // failure counter recovery mode is driven by.
            if (url != null) setState(State.RUNNING, "已在运行，忽略重复启动");
            return;
        }
        if (distro == null) {
            setState(State.ERROR, "没有可用的发行版（先导入一个 rootfs）");
            error = "no distro";
            return;
        }
        url = null;
        error = null;
        App app = App.i();
        app.clearServerLog();
        boolean recovery = Recovery.active();
        setState(State.STARTING, recovery
                ? "启动恢复模式（不加载 harness）"
                : "启动 " + distro.name);

        int port = app.resolveFreePort();
        String command;
        if (recovery) {
            // Recovery wins over a hand-written distro command on purpose: this
            // mode exists for the case where the normal start does not work, so
            // honouring a stale custom command here would defeat it.
            if (distro.command != null && !distro.command.trim().isEmpty()) {
                App.log("recovery: 忽略自定义启动命令，改用 recovery.sh");
            }
            command = Proot.recoveryCommand();
        } else if (distro.command == null || distro.command.trim().isEmpty()) {
            command = Proot.bundledCommand(port);
        } else {
            command = distro.command;
        }
        List<String> argv = Proot.argv(ctx, distro.root, command);

        ProcessBuilder builder = new ProcessBuilder(argv);
        builder.redirectErrorStream(true);
        builder.directory(app.distroDir);
        Mounts.ensureGuestDirs(distro.root);
        for (Mounts.Mount mount : Mounts.configured()) {
            String problem = mount.problem();
            App.log(problem.isEmpty()
                    ? "mount: " + mount.host + " -> " + mount.guest
                    : "mount: 跳过 " + mount.host + " -> " + mount.guest + "：" + problem);
        }
        java.util.Map<String, String> env = builder.environment();
        env.put("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
        env.put("HOME", "/root");
        env.put("TERM", "xterm-256color");
        env.put("LANG", "C.UTF-8");
        env.put("TMPDIR", "/tmp");
        // Ports and secrets for the two in-guest services. The PTY token is
        // generated here and handed to the Web UI through the native bridge, so
        // the terminal panel can reach the endpoint without any file on disk.
        env.put("DSH_PORT", String.valueOf(port));
        env.put("DSH_PTY_PORT", String.valueOf(app.ptyPort()));
        env.put("DSH_PTY_TOKEN", app.ensurePtyToken());
        env.put("DSH_ANDROID_BRIDGE_URL", "http://127.0.0.1:" + app.bridgePort());
        env.put("DSH_ANDROID_BRIDGE_TOKEN", app.ensureBridgeToken());
        env.put("DSH_ANDROID_APP", "1");
        if (Recovery.active()) {
            // The token is root's password inside the guest for exactly as long
            // as this process lives: recovery.sh installs it on the way up and
            // restores the shadow entry with a trap on the way out. Nothing about
            // it is persisted in the guest.
            env.put("DSH_RECOVERY_TOKEN", Recovery.token());
            env.put("DSH_RECOVERY_PORT", String.valueOf(Recovery.port()));
            env.put("DSH_RECOVERY_BIND", "0.0.0.0");
        }
        Proot.applyHostEnvironment(env);
        if (apiKey != null && !apiKey.trim().isEmpty()) {
            env.put("DEEPSEEK_API_KEY", apiKey.trim());
        }
        App.log("exec: " + String.join(" ", argv));

        try {
            process = builder.start();
            startedAt = System.currentTimeMillis();
            activeRootfs = distro.root;
            int mine = ++generation;
            // Captured, not read later from a mutable field: by the time this
            // process exits, "restart the server" has usually already bumped the
            // generation and cleared any global flag — which is exactly how the
            // first version of this silently skipped its cleanup.
            boolean recoveryBoot = Recovery.active();
            pump = new Thread(() -> pumpOutput(process, mine, recoveryBoot), "dsh-output");
            pump.setDaemon(true);
            pump.start();
        } catch (Exception e) {
            error = e.toString();
            setState(State.ERROR, "启动失败: " + e);
        }
    }

    private static void pumpOutput(Process p, int mine, boolean recoveryBoot) {
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8), 1 << 13);
             OutputStream raw = new FileOutputStream(App.i().serverLog, true);
             Writer file = new OutputStreamWriter(raw, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                file.write(line);
                file.write('\n');
                file.flush();
                onLine(line);
            }
        } catch (Exception e) {
            App.log("output pump: " + e);
        }
        int code = -1;
        try {
            code = p.waitFor();
        } catch (InterruptedException ignored) {
        }
        synchronized (LOCK) {
            if (process == p) {
                process = null;
                if (state != State.IDLE) {
                    boolean wasRunning = url != null;
                    state = code == 0 || wasRunning ? State.IDLE : State.ERROR;
                    if (code != 0 && !wasRunning) {
                        error = "进程退出，code=" + code + "（见日志）";
                    }
                    if (!wasRunning && !recoveryBoot) {
                        // A guest that died without ever announcing itself is the
                        // only honest signal that the harness cannot start.
                        // Recovery's own exit must not feed this counter.
                        Recovery.noteFailure("code=" + code);
                    }
                }
            }
        }
        setState(state, "服务进程退出，code=" + code);
        // Only when this is still the newest boot: if a newer one has started,
        // either it is a normal boot (which locks the password itself on the way
        // up — see start-dsh.sh) or a new recovery session that owns the
        // password. Writing here then would lock the user out of a live session.
        if (recoveryBoot && generation == mine) {
            relockRecoveryPassword();
        }
    }

    /**
     * Put root's password back to "locked" once a recovery session is over.
     *
     * Best effort, on purpose — the guarantee lives elsewhere (see below).
     *
     * `recovery.sh` traps INT/TERM and re-locks on the way out, but the app stops
     * the sandbox by killing the PRoot process and PRoot's --kill-on-exit tears
     * the guest down with signals the shell may never get to act on. This call
     * covers that, but it too can be missed: it only runs if the process exit is
     * observed while no newer boot has started, and `restartServer()` starts one
     * 800 ms later.
     *
     * So the thing that actually guarantees it is `start-dsh.sh`, which locks
     * root's password at the top of every *normal* boot. Recovery mode never runs
     * that script, so it can never fight a live session — and a device that was
     * force-stopped mid-recovery is cleaned up the next time it starts normally.
     *
     * Runs on the pump thread, after the process is gone (a second PRoot writing
     * /etc/shadow while the first is still serving is a race with no upside), and
     * only for the generation it belongs to: a user who stops recovery and
     * immediately starts it again must not have the *new* password locked out
     * from under them.
     */
    private static void relockRecoveryPassword() {
        final File rootfs = activeRootfs;
        if (rootfs == null) return;
        Thread lock = new Thread(() -> {
            try {
                Proot.Result result = Proot.exec(App.i(), rootfs,
                        Collections.emptyList(), "printf 'root:*\\n' | chpasswd -e", 20000);
                App.log("recovery: 已恢复 root 锁定（" + result.describe() + "）");
            } catch (Throwable error) {
                App.log("recovery: 恢复 root 锁定失败: " + error);
            }
        }, "recovery-relock");
        lock.setDaemon(true);
        lock.start();
    }

    private static void onLine(String line) {
        synchronized (LOCK) {
            LOG.addLast(line);
            while (LOG.size() > 400) LOG.removeFirst();
        }
        Matcher matcher = URL.matcher(line);
        if (matcher.find()) {
            url = matcher.group(1);
            Recovery.noteReady();
            setState(State.RUNNING, "服务就绪: " + url);
            return;
        }
        if (line.contains(Recovery.READY_MARKER)) {
            // Recovery announces no URL: sshd is listening and that is the whole
            // readiness condition. RUNNING here means "the sandbox is serving",
            // not "the harness is up" — the UI checks Recovery.active() to tell
            // the two apart, and the watchdog stops restarting either way.
            Recovery.markSshReady();
            setState(State.RUNNING, "恢复模式就绪: " + line.trim());
            return;
        }
        if (state == State.STARTING && line.trim().length() > 0) {
            notifyListeners();
        }
    }

    public static synchronized void stop() {
        setState(state == State.RUNNING ? State.IDLE : state, "停止服务");
        Process p = process;
        process = null;
        url = null;
        if (p != null) {
            App.log("server stop: alive=" + p.isAlive());
            try {
                // Process.destroy() is the portable SIGTERM path. Process.pid()
                // is absent at runtime on some Android 16 builds even though the
                // compile SDK exposes it, so signal by handle instead.
                p.destroy();
            } catch (Throwable error) {
                App.log("server stop destroy: " + error);
            }
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                if (p.isAlive()) {
                    App.log("server stop: force killing process");
                    try {
                        p.destroyForcibly();
                    } catch (Throwable ignored) {
                    }
                }
            }, 1500);
        }
        setState(State.IDLE, "已停止");
    }

    public static boolean isEmulator() {
        return "generic".equals(Build.BRAND) || Build.FINGERPRINT.contains("generic");
    }
}

package com.dha.harness;

/**
 * The decisions recovery mode makes, as pure functions.
 *
 * Same reason {@link HotVersion} and {@link UnpackPlan} are separate classes: no
 * Android API, no file system, no clock of its own — so the rule "when does the
 * app give up on the harness and offer a shell" can be pinned down by a plain
 * JVM test instead of by installing an APK and breaking a sandbox on purpose.
 *
 * The two ends of this feature have to agree on two things and this is where
 * both are written down: what a usable recovery token looks like (the guest
 * script refuses everything else, because it becomes a line in /etc/shadow) and
 * what the user is told to type.
 */
final class RecoveryPlan {

    static final int DEFAULT_PORT = 8022;

    /**
     * Ports below 1024 need privileges the app does not have; above 65535 is not
     * a port. Kept next to the guest's own check (`recovery.sh` rejects the same
     * range) so a bad value fails in the panel rather than at boot.
     */
    static final int MIN_PORT = 1024;
    static final int MAX_PORT = 65535;

    /**
     * How many failures inside {@link #FAILURE_WINDOW_MS} turn "the harness is
     * having a bad minute" into "the harness cannot start".
     *
     * Three, because one is noise (a port still held by the previous instance)
     * and the watchdog already ignores the first restart attempt. Taken together
     * with the 15 s watchdog, entering recovery is a ~45 s decision — long enough
     * not to interrupt a slow first unpack, short enough that the user is not
     * left staring at a dead screen.
     */
    static final int FAILURE_THRESHOLD = 3;

    /** After this long without a failure, the count is history and starts over. */
    static final long FAILURE_WINDOW_MS = 10 * 60 * 1000L;

    private RecoveryPlan() {
    }

    /**
     * Is this token usable as the recovery password?
     *
     * The token is written into /etc/shadow as `root:<token>` by the guest, so a
     * colon would split the entry and a newline would corrupt the file.
     *
     * The rule is exactly what {@link App#randomToken} mints — base64url, no
     * padding, 8..128 characters — and it is duplicated verbatim in
     * `recovery.sh` as a single `case` glob. Both ends must agree: the guest
     * refusing a token the app accepted is a user staring at a password that
     * cannot be installed, with no way to tell why.
     */
    static boolean validToken(String token) {
        if (token == null) return false;
        int length = token.length();
        if (length < 8 || length > 128) return false;
        for (int i = 0; i < length; i++) {
            char c = token.charAt(i);
            boolean allowed = (c >= 'A' && c <= 'Z')
                    || (c >= 'a' && c <= 'z')
                    || (c >= '0' && c <= '9')
                    || c == '-' || c == '_';
            if (!allowed) return false;
        }
        return true;
    }

    static boolean validPort(int port) {
        return port >= MIN_PORT && port <= MAX_PORT;
    }

    /** A port to actually use: the user's value when sane, the default otherwise. */
    static int clampPort(int port) {
        return validPort(port) ? port : DEFAULT_PORT;
    }

    /**
     * Failures that still count as of `now`.
     *
     * A bare counter would eventually trip recovery on a phone whose harness
     * failed three times over three days; ageing it out is what makes the
     * decision "cannot start *now*".
     */
    static int failuresAt(int failures, long lastFailureAt, long now) {
        if (failures <= 0) return 0;
        if (lastFailureAt <= 0) return failures;
        // The window is half-open: a failure recorded exactly FAILURE_WINDOW_MS
        // ago has expired, one recorded a millisecond later has not.
        return now - lastFailureAt >= FAILURE_WINDOW_MS ? 0 : failures;
    }

    /**
     * Should the app stop trying the harness and hand over a shell?
     *
     * `active` short-circuits everything: once the user is in recovery, a
     * failure counter must never be the reason to re-enter it.
     */
    static boolean shouldEnter(boolean autoEnabled, boolean active,
                               int failures, long lastFailureAt, long now) {
        if (active || !autoEnabled) return false;
        return failuresAt(failures, lastFailureAt, now) >= FAILURE_THRESHOLD;
    }

    /** `ssh -p 8022 root@192.168.1.5` — what to type on a computer. */
    static String sshCommand(String host, int port, String user) {
        return "ssh -p " + port + " " + user + "@" + host;
    }

    /**
     * `ssh -p 8022 -L 3080:127.0.0.1:3080 root@<phone>` — the tunnel half of
     * recovery: with the harness restarted inside the shell, a PC browser can
     * open it even when the phone's own WebView cannot.
     */
    static String forwardCommand(String host, int port, String user, int harnessPort) {
        return "ssh -p " + port + " -L " + harnessPort + ":127.0.0.1:" + harnessPort
                + " " + user + "@" + host;
    }

    /** `adb forward tcp:8022 tcp:8022` — the USB route, for a phone off Wi-Fi. */
    static String adbForward(int port) {
        return "adb forward tcp:" + port + " tcp:" + port;
    }

    /** One line for the panel header: where recovery stands. */
    static String describe(boolean active, boolean sshReady, int port, int failures) {
        if (!active) {
            return failures > 0
                    ? "未启用（harness 连续失败 " + failures + " 次）"
                    : "未启用";
        }
        return sshReady ? "运行中 · sshd 127.0.0.1:" + port + " 已就绪"
                : "启动中 · 等待 sshd（端口 " + port + "）";
    }
}

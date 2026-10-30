package com.dha.harness;

/**
 * Phase, pacing and wording for the install progress UI.
 *
 * Unpacking a first-run payload copies ~207 MB out of the APK and then extracts
 * ~20 700 entries (13 s on the reference phone). The old reporting was one callback
 * per 32 entries with a raw zip path as the label, and nothing at all during the
 * staging copy — so the bar looked frozen for the whole silent stretch.
 *
 * This class is the policy: which phase we are in, whether a callback is due, and
 * what the UI should say. It is plain Java on purpose so the cadence and the strings
 * can be checked on a JVM (see {@code UnpackPlanTest}) — {@link Payload} only feeds
 * it numbers.
 */
final class UnpackPlan {

    enum Phase {
        STAGE("准备载荷"),
        EXTRACT("解包中"),
        MANIFEST("应用清单（软链与权限）"),
        DONE("完成");

        final String label;

        Phase(String label) {
            this.label = label;
        }
    }

    /** Never more often than this — 5 Hz is plenty and keeps the UI thread quiet. */
    static final long MIN_INTERVAL_MS = 200;
    /** …but always after this many new entries, so a slow device still moves. */
    static final long MIN_ENTRIES = 200;

    private Phase phase = Phase.STAGE;
    private long lastReportMs = Long.MIN_VALUE;
    private long lastEntries;
    private boolean last;

    Phase phase() {
        return phase;
    }

    /** Switch phase; the next {@link #due} always returns true. */
    void enter(Phase next) {
        if (phase == next) return;
        phase = next;
        lastReportMs = Long.MIN_VALUE;
        lastEntries = 0;
        last = false;
    }

    /**
     * Is a callback due now?
     *
     * @param nowMs   monotonic milliseconds (SystemClock.uptimeMillis on device)
     * @param entries entries processed so far in this phase (bytes for {@code STAGE})
     * @param done    true for the final report of a phase or of the whole install
     */
    boolean due(long nowMs, long entries, boolean done) {
        if (done && last) return false;
        boolean first = lastReportMs == Long.MIN_VALUE;
        boolean byTime = !first && nowMs - lastReportMs >= MIN_INTERVAL_MS;
        boolean byCount = entries - lastEntries >= MIN_ENTRIES;
        if (!first && !byTime && !byCount && !done) return false;
        lastReportMs = nowMs;
        lastEntries = entries;
        last = done;
        return true;
    }

    /** 0..1000 for a determinate bar, or -1 when the total is unknown. */
    static int permille(long done, long total) {
        if (total <= 0) return -1;
        long value = done * 1000 / total;
        if (value < 0) return 0;
        return (int) Math.min(1000, value);
    }

    /** Human-readable label for the UI. */
    static String label(Phase phase, long done, long total) {
        switch (phase) {
            case STAGE:
                return total > 0
                        ? String.format(java.util.Locale.US, "%s %s / %s", phase.label,
                                megabytes(done), megabytes(total))
                        : String.format(java.util.Locale.US, "%s %s", phase.label, megabytes(done));
            case EXTRACT: {
                int permille = permille(done, total);
                if (permille < 0) {
                    return String.format(java.util.Locale.US, "%s %d 个条目", phase.label, done);
                }
                return String.format(java.util.Locale.US, "%s %d/%d（%d%%）",
                        phase.label, done, total, permille / 10);
            }
            case MANIFEST:
                return done > 0
                        ? String.format(java.util.Locale.US, "%s：%d 个软链 / %d 个权限", phase.label, done, total)
                        : phase.label + "…";
            default:
                return phase.label;
        }
    }

    /** "12.3 MB" for progress lines; used for staging, where the unit is bytes. */
    static String megabytes(long bytes) {
        if (bytes < 0) bytes = 0;
        long tenths = bytes * 10 / (1024 * 1024);
        return String.format(java.util.Locale.US, "%d.%d MB", tenths / 10, tenths % 10);
    }
}

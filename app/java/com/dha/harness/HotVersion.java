package com.dha.harness;

/**
 * Hot-package version arithmetic.
 *
 * A hot package is named `<app>-t<terminal>-sp<n>`: the app version, the
 * sandbox runtime version, and a sequence number that only moves inside one
 * line. Everything here is a pure function of those strings — no Android API,
 * no file system — so the decision the app makes at startup can be tested on a
 * plain JVM (see the checks in the repository's release notes and
 * `scripts/`-adjacent test runs).
 *
 * Why the app needs it at all: the baked overlay is re-applied on every launch,
 * so a package the user fetched or picked would otherwise be silently replaced
 * by the older files the APK carries. {@link #shouldReplay} is the rule that
 * says when that user package still wins.
 */
final class HotVersion {

    private HotVersion() {
    }

    /** The line a hot version belongs to, e.g. `1.1.5-t2-`. */
    static String line(String app, String terminal) {
        return (app == null ? "" : app) + "-t" + (terminal == null ? "" : terminal) + "-";
    }

    /** Whether a version string belongs to this app/terminal pair. */
    static boolean sameLine(String version, String app, String terminal) {
        if (version == null || version.isEmpty()) return false;
        String line = line(app, terminal);
        // No app/terminal to compare against: the caller has nothing better, so
        // the version is accepted rather than dropped on a technicality.
        if (line.equals("-t-")) return true;
        return version.startsWith(line);
    }

    /** The `sp` number, or -1 when the string does not carry one. */
    static int spOf(String version) {
        if (version == null) return -1;
        int at = version.lastIndexOf("-sp");
        if (at < 0) return -1;
        String digits = version.substring(at + 3);
        if (digits.isEmpty()) return -1;
        for (int i = 0; i < digits.length(); i++) {
            if (digits.charAt(i) < '0' || digits.charAt(i) > '9') return -1;
        }
        try {
            return Integer.parseInt(digits);
        } catch (NumberFormatException error) {
            return -1;
        }
    }

    /**
     * Whether the stored package must be re-applied after the baked overlay.
     *
     * True only for a package that was applied *after* the installed APK and is
     * ahead of it on the same line. Three ways to be false, each for a reason:
     *
     *   another line      a t3 package must never be written onto a t2 runtime
     *   older than the APK an app update supersedes any package fetched for the
     *                     previous one — and a re-release of the same app version
     *                     stamps its baked copy `sp0` again even though its content
     *                     is newer, so the sequence numbers alone cannot tell which
     *                     side is newer (see make_hot_zip.py's `--base` note)
     *   not ahead         equal or lower `sp` means the APK already carries it
     *
     * A version without a parsable `sp` falls back to "different from the baked
     * one wins", which is what a hand-built package needs.
     *
     * @param storedVersion version in the archived user package (`null` when none)
     * @param bakedVersion version in the APK's own package (`null` when absent)
     * @param storedAppliedAfterApk whether the stored package is newer than the
     *        installed APK; callers that cannot tell pass true and let the
     *        sequence numbers decide
     */
    static boolean shouldReplay(String storedVersion, String bakedVersion, String app, String terminal,
                                boolean storedAppliedAfterApk) {
        if (storedVersion == null || storedVersion.isEmpty()) return false;
        if (!sameLine(storedVersion, app, terminal)) return false;
        if (!storedAppliedAfterApk) return false;
        if (!sameLine(bakedVersion, app, terminal)) return true;
        int storedSp = spOf(storedVersion);
        int bakedSp = spOf(bakedVersion);
        if (storedSp < 0 || bakedSp < 0) return !storedVersion.equals(bakedVersion);
        return storedSp > bakedSp;
    }
}

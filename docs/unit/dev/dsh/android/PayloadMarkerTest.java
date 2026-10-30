package com.dha.harness;

/**
 * Decision table for "is the runtime on disk the one this shell should use".
 *
 * Regression focus: the reported bug was a device whose runtime marker came from an
 * older install (or a hand-installed shell) while the APK carried a new payload — the
 * old code answered "ready" for any marker, so the payload was never unpacked and the
 * new runtime (and its preinstalled pnpm) never arrived.
 */
public final class PayloadMarkerTest {
    static int checks = 0;
    static int failures = 0;

    static void check(boolean actual, boolean expected, String what) {
        checks++;
        if (actual == expected) return;
        failures++;
        System.out.println("FAIL  " + what + " (expected " + expected + ", got " + actual + ")");
    }

    static void checkString(String actual, String expected, String what) {
        checks++;
        if (actual == null ? expected == null : actual.equals(expected)) return;
        failures++;
        System.out.println("FAIL  " + what + " (expected " + expected + ", got " + actual + ")");
    }

    public static void main(String[] args) {
        String payload = "a9001b8ed364b544";
        String terminal = "2";

        // ---- the reported bug: full APK, marker from an older runtime ----------
        check(PayloadMarker.isReady(new String[]{".payload-d85c0d22da47889f"}, true, payload, terminal), false,
                "full APK + another runtime\'s marker => not ready (extract it)");
        check(PayloadMarker.isReady(new String[]{".payload-t2"}, true, payload, terminal), false,
                "full APK + a slim-downloaded marker => not ready");
        // ---- full APK, its own payload already there ---------------------------
        check(PayloadMarker.isReady(new String[]{".payload-" + payload}, true, payload, terminal), true,
                "full APK + its own marker => ready");
        check(PayloadMarker.isReady(new String[]{".payload-" + payload, ".payload-old"}, true, payload, terminal), true,
                "extra leftovers do not confuse it");
        // ---- full APK, nothing unpacked yet -----------------------------------
        check(PayloadMarker.isReady(new String[]{}, true, payload, terminal), false, "empty runtime dir => not ready");
        check(PayloadMarker.isReady(null, true, payload, terminal), false, "missing runtime dir => not ready");
        check(PayloadMarker.isReady(new String[]{".payload-" + payload}, true, "", terminal), false,
                "no payload version to compare => not ready (never skip extraction)");
        check(PayloadMarker.isReady(new String[]{".payload-" + payload}, true, null, terminal), false,
                "null payload version => not ready");
        // ---- slim shell: whatever runtime is there, keep it -------------------
        check(PayloadMarker.isReady(new String[]{".payload-t2"}, false, "", terminal), true,
                "slim shell + downloaded t2 => ready");
        check(PayloadMarker.isReady(new String[]{".payload-" + payload}, false, "", terminal), true,
                "slim shell + imported payload => ready");
        check(PayloadMarker.isReady(new String[]{}, false, "", terminal), false, "slim shell + no runtime => not ready");
        check(PayloadMarker.isReady(new String[]{"cache", "rootfs.img"}, false, "", terminal), false,
                "unrelated entries are not markers");
        // ---- marker naming ----------------------------------------------------
        checkString(PayloadMarker.expected(true, payload, terminal), ".payload-" + payload, "full marker name");
        checkString(PayloadMarker.expected(false, payload, terminal), ".payload-t2", "slim marker name");
        checkString(PayloadMarker.expected(true, "", terminal), null, "full marker without a version is null");

        System.out.println("PayloadMarker: " + checks + " checks, " + failures + " failure(s)");
        System.exit(failures == 0 ? 0 : 1);
    }
}

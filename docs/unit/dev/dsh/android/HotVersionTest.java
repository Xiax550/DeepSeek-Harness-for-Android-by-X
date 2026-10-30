package com.dha.harness;

/**
 * Hot-replay decision table, executed on a plain JVM (HotVersion has no Android
 * dependency on purpose). This is the rule behind "apply sp2 -> restart -> the
 * disk still holds the sp2 files".
 */
public final class HotVersionTest {
    static int checks = 0;
    static int failures = 0;

    static void check(boolean actual, boolean expected, String what) {
        checks++;
        if (actual == expected) return;
        failures++;
        System.out.println("FAIL  " + what + " (expected " + expected + ", got " + actual + ")");
    }

    static void checkInt(int actual, int expected, String what) {
        checks++;
        if (actual == expected) return;
        failures++;
        System.out.println("FAIL  " + what + " (expected " + expected + ", got " + actual + ")");
    }

    public static void main(String[] args) {
        String app = "1.1.5";
        String term = "2";

        // the case the fix exists for: a fetched sp2 must be replayed on top of a baked sp0
        check(HotVersion.shouldReplay("1.1.5-t2-sp2", "1.1.5-t2-sp0", app, term, true), true, "sp2 over baked sp0 replays");
        check(HotVersion.shouldReplay("1.1.5-t2-sp1", "1.1.5-t2-sp0", app, term, true), true, "sp1 over baked sp0 replays");
        check(HotVersion.shouldReplay("1.1.5-t2-sp12", "1.1.5-t2-sp2", app, term, true), true, "two-digit sp compares numerically");
        // the app already carries it (or something newer): drop, never downgrade
        check(HotVersion.shouldReplay("1.1.5-t2-sp0", "1.1.5-t2-sp0", app, term, true), false, "equal versions are superseded");
        check(HotVersion.shouldReplay("1.1.5-t2-sp1", "1.1.5-t2-sp2", app, term, true), false, "an older stored package never overwrites a newer baked one");
        check(HotVersion.shouldReplay("1.1.5-t2-sp2", "1.1.5-t2-sp3", app, term, true), false, "same, one ahead");
        // another runtime's package must never be written onto this one
        check(HotVersion.shouldReplay("1.1.5-t3-sp9", "1.1.5-t2-sp0", app, term, true), false, "another terminal line is refused");
        check(HotVersion.shouldReplay("1.2.0-t2-sp9", "1.1.5-t2-sp0", app, term, true), false, "another app version is refused");
        // nothing stored
        check(HotVersion.shouldReplay(null, "1.1.5-t2-sp0", app, term, true), false, "null stored version");
        check(HotVersion.shouldReplay("", "1.1.5-t2-sp0", app, term, true), false, "empty stored version");
        // a hand-built package on the line but without a parsable -sp: differing
        // content wins, identical content is dropped
        check(HotVersion.shouldReplay("1.1.5-t2-nightly", "1.1.5-t2-sp0", app, term, true), true, "unparsable sp falls back to inequality");
        check(HotVersion.shouldReplay("1.1.5-t2-sp", "1.1.5-t2-sp0", app, term, true), true, "empty sp number falls back to inequality");
        check(HotVersion.shouldReplay("1.1.5-t2-nightly", "1.1.5-t2-nightly", app, term, true), false, "identical unparsable versions are dropped");
        // a version that does not even name the line is refused: replaying an
        // unidentifiable package is how another runtime's files get written
        check(HotVersion.shouldReplay("1.1.5-t2", "1.1.5-t2-sp0", app, term, true), false, "a version without the line prefix is refused");
        // no baked package at all (older APK): the stored one is the only content
        check(HotVersion.shouldReplay("1.1.5-t2-sp2", "", app, term, true), true, "no baked version: replay");
        check(HotVersion.shouldReplay("1.1.5-t2-sp2", null, app, term, true), true, "null baked version: replay");

        // parsing
        checkInt(HotVersion.spOf("1.1.5-t2-sp12"), 12, "spOf two digits");
        checkInt(HotVersion.spOf("1.1.5-t2-sp0"), 0, "spOf zero");
        checkInt(HotVersion.spOf("1.1.5-t2"), -1, "spOf without -sp");
        checkInt(HotVersion.spOf("1.1.5-t2-sp"), -1, "spOf empty number");
        checkInt(HotVersion.spOf("1.1.5-t2-spX"), -1, "spOf non-numeric");
        checkInt(HotVersion.spOf(null), -1, "spOf null");

        // line identity
        check(HotVersion.sameLine("1.1.5-t2-sp2", app, term), true, "sameLine accepts this line");
        check(HotVersion.sameLine("1.1.5-t2-sp0", app, term), true, "sameLine accepts sp0");
        check(HotVersion.sameLine("1.2.0-t2-sp2", app, term), false, "sameLine rejects another app");
        check(HotVersion.sameLine("1.1.5-t3-sp2", app, term), false, "sameLine rejects another terminal");
        check(HotVersion.sameLine("", app, term), false, "sameLine rejects empty");
        check(HotVersion.sameLine(null, app, term), false, "sameLine rejects null");

        // the APK is newer than the stored package: never replay, whatever the sp
        check(HotVersion.shouldReplay("1.1.5-t2-sp9", "1.1.5-t2-sp0", app, term, false), false,
                "a package older than the installed APK is dropped (a re-released base stamps sp0 again)");
        check(HotVersion.shouldReplay("1.1.5-t2-sp0", "1.1.5-t2-sp0", app, term, false), false,
                "same version, older package: dropped");
        // ... but a package applied after the APK stays
        check(HotVersion.shouldReplay("1.1.5-t2-sp2", "1.1.5-t2-sp0", app, term, true), true,
                "applied after the APK: replayed");

        System.out.println("HotVersion: " + checks + " checks, " + failures + " failure(s)");
        System.exit(failures == 0 ? 0 : 1);
    }
}

package com.dha.harness;

import java.util.ArrayList;
import java.util.List;

/**
 * Cadence, phases and wording of the install progress UI.
 *
 * The device runs the real extraction; this checks the policy that decides when a
 * callback is emitted and what the screen says — including a synthetic 20 703-entry
 * payload that reproduces the reference phone's 13 s extraction, so the callback
 * count and the phase timeline can be inspected without installing anything.
 */
public final class UnpackPlanTest {
    static int checks = 0;
    static int failures = 0;

    static void check(boolean actual, boolean expected, String what) {
        checks++;
        if (actual == expected) return;
        failures++;
        System.out.println("FAIL  " + what + " (expected " + expected + ", got " + actual + ")");
    }

    static void checkLong(long actual, long expected, String what) {
        checks++;
        if (actual == expected) return;
        failures++;
        System.out.println("FAIL  " + what + " (expected " + expected + ", got " + actual + ")");
    }

    static void checkText(String actual, String expected, String what) {
        checks++;
        if (actual.equals(expected)) return;
        failures++;
        System.out.println("FAIL  " + what);
        System.out.println("      expected: " + expected);
        System.out.println("      actual  : " + actual);
    }

    public static void main(String[] args) {
        // ---- permille: -1 means "unknown total" → indeterminate bar -----------
        checkLong(UnpackPlan.permille(0, 0), -1, "no total => unknown");
        checkLong(UnpackPlan.permille(5, -1), -1, "negative total => unknown");
        checkLong(UnpackPlan.permille(0, 20703), 0, "start");
        checkLong(UnpackPlan.permille(10351, 20703), 499, "just under half truncates down");
        checkLong(UnpackPlan.permille(10352, 20703), 500, "half");
        checkLong(UnpackPlan.permille(20703, 20703), 1000, "full");
        checkLong(UnpackPlan.permille(99999, 20703), 1000, "clamped");

        // ---- wording ----------------------------------------------------------
        checkText(UnpackPlan.label(UnpackPlan.Phase.STAGE, 12 * 1024 * 1024, 0),
                "准备载荷 12.0 MB", "staging without a known size");
        checkText(UnpackPlan.label(UnpackPlan.Phase.STAGE, 12 * 1024 * 1024, 202 * 1024 * 1024),
                "准备载荷 12.0 MB / 202.0 MB", "staging with a known size");
        checkText(UnpackPlan.label(UnpackPlan.Phase.EXTRACT, 1234, 20703),
                "解包中 1234/20703（5%）", "extraction with entry counts");
        checkText(UnpackPlan.label(UnpackPlan.Phase.EXTRACT, 10351, 20703),
                "解包中 10351/20703（49%）", "extraction just under half");
        checkText(UnpackPlan.label(UnpackPlan.Phase.EXTRACT, 10352, 20703),
                "解包中 10352/20703（50%）", "extraction at half");
        checkText(UnpackPlan.label(UnpackPlan.Phase.EXTRACT, 20703, 20703),
                "解包中 20703/20703（100%）", "extraction complete");
        checkText(UnpackPlan.label(UnpackPlan.Phase.EXTRACT, 500, 0),
                "解包中 500 个条目", "extraction without a known total");
        checkText(UnpackPlan.label(UnpackPlan.Phase.MANIFEST, 0, 0),
                "应用清单（软链与权限）…", "manifest starts");
        checkText(UnpackPlan.label(UnpackPlan.Phase.MANIFEST, 765, 19938),
                "应用清单（软链与权限）：765 个软链 / 19938 个权限", "manifest done");
        checkText(UnpackPlan.label(UnpackPlan.Phase.DONE, 0, 0), "完成", "done");
        checkText(UnpackPlan.megabytes(0), "0.0 MB", "megabytes zero");
        checkText(UnpackPlan.megabytes(212245549), "202.4 MB", "megabytes of the real payload");

        // ---- cadence ----------------------------------------------------------
        UnpackPlan plan = new UnpackPlan();
        check(plan.due(1000, 1, false), true, "first report is immediate");
        check(plan.due(1010, 10, false), false, "too soon and too few entries");
        check(plan.due(1010, 250, false), true, "200 new entries force a report");
        check(plan.due(1030, 260, false), false, "…and then we wait again");
        check(plan.due(1250, 300, false), true, "200 ms elapsed");
        check(plan.due(1260, 301, true), true, "a forced final report always goes out");
        check(plan.due(1270, 302, true), false, "…but only once");
        plan.enter(UnpackPlan.Phase.MANIFEST);
        check(plan.due(1270, 0, false), true, "a phase change reports immediately");
        checkLong(plan.phase().ordinal(), UnpackPlan.Phase.MANIFEST.ordinal(), "phase tracked");

        // ---- the reference phone: 20703 entries in ~13 s ------------------------
        UnpackPlan run = new UnpackPlan();
        List<String> timeline = new ArrayList<>();
        int entries = 20703;
        long start = 5000;
        long durationMs = 13000;
        int reports = 0;
        for (int i = 1; i <= entries; i++) {
            long now = start + durationMs * i / entries;   // even progress, like the real run
            if (run.due(now, i, i == entries)) {
                reports++;
                // every 25th report, plus the last one: an evenly spaced sample that
                // shows movement instead of a wall of lines
                if (reports % 25 == 0 || i == entries) {
                    timeline.add(String.format("    t=%5dms  %s", now - start,
                            UnpackPlan.label(UnpackPlan.Phase.EXTRACT, i, entries)));
                }
            }
        }
        System.out.println("  合成时间线（20703 条目 / 13 s）：");
        for (String line : timeline) System.out.println(line);
        System.out.println("    → 回调次数 " + reports
                + "（13 s；5 Hz 是下限 ≈ 65，条目下限 200 会让快设备到 ≈ 8 Hz）");
        check(reports >= 30 && reports <= 140, true,
                "callback count stays in the intended band (got " + reports + ")");
        check(reports < entries / 32, true, "fewer callbacks than the old every-32-entries rule");

        System.out.println("UnpackPlan: " + checks + " checks, " + failures + " failure(s)");
        System.exit(failures == 0 ? 0 : 1);
    }
}

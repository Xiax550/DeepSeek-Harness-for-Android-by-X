package com.dha.harness;

public final class ScreenAwakePolicyTest {
    private static int checks;
    private static int failures;

    public static void main(String[] args) {
        check(ScreenAwakePolicy.decide(false, false), ScreenAwakePolicy.Action.IGNORE,
                "background work never wakes an off screen");
        check(ScreenAwakePolicy.decide(false, true), ScreenAwakePolicy.Action.RELEASE,
                "a task lock is released after the user turns the screen off");
        check(ScreenAwakePolicy.decide(true, false), ScreenAwakePolicy.Action.HOLD,
                "an already-visible task keeps the screen on");
        check(ScreenAwakePolicy.decide(true, true), ScreenAwakePolicy.Action.HOLD,
                "an active lock renews while the screen stays visible");
        System.out.println("ScreenAwakePolicy: " + checks + " checks, " + failures + " failure(s)");
        if (failures != 0) System.exit(1);
    }

    private static void check(ScreenAwakePolicy.Action actual,
                              ScreenAwakePolicy.Action expected,
                              String label) {
        checks++;
        if (actual != expected) {
            failures++;
            System.out.println("FAIL " + label + ": expected " + expected + ", got " + actual);
        }
    }
}

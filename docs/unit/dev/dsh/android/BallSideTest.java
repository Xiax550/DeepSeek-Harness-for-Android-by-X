package com.dha.harness;

public final class BallSideTest {
    private static int checks;
    private static int failures;

    public static void main(String[] args) {
        check(BallSide.choose(100, 1000, 40, null), BallSide.LEFT, "left half starts left");
        check(BallSide.choose(900, 1000, 40, null), BallSide.RIGHT, "right half starts right");
        check(BallSide.choose(540, 1000, 40, BallSide.LEFT), BallSide.LEFT,
                "left stays stable inside the dead band");
        check(BallSide.choose(541, 1000, 40, BallSide.LEFT), BallSide.RIGHT,
                "left turns right past the dead band");
        check(BallSide.choose(460, 1000, 40, BallSide.RIGHT), BallSide.RIGHT,
                "right stays stable inside the dead band");
        check(BallSide.choose(459, 1000, 40, BallSide.RIGHT), BallSide.LEFT,
                "right turns left past the dead band");
        check(BallSide.choose(500, 1000, -5, null), BallSide.RIGHT,
                "negative hysteresis is clamped");
        check(BallSide.choose(100, 1000, 40, "unknown"), BallSide.LEFT,
                "unknown previous state falls back to position");
        check(BallSide.nearEdge(120, 1000, .18f), true, "left edge zone pauses before turning");
        check(BallSide.nearEdge(880, 1000, .18f), true, "right edge zone pauses before turning");
        check(BallSide.nearEdge(500, 1000, .18f), false, "screen centre turns without edge pause");
        check(BallSide.nearEdge(120, 0, .18f), false, "zero-width screen is ignored");
        System.out.println("BallSide: " + checks + " checks, " + failures + " failure(s)");
        if (failures != 0) System.exit(1);
    }

    private static void check(String actual, String expected, String label) {
        checks++;
        if (!expected.equals(actual)) {
            failures++;
            System.out.println("FAIL " + label + ": expected " + expected + ", got " + actual);
        }
    }

    private static void check(boolean actual, boolean expected, String label) {
        checks++;
        if (actual != expected) {
            failures++;
            System.out.println("FAIL " + label + ": expected " + expected + ", got " + actual);
        }
    }
}

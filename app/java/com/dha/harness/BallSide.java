package com.dha.harness;

/** Pure left/right facing decision with a centre dead band. */
final class BallSide {
    static final String LEFT = "left";
    static final String RIGHT = "right";

    private BallSide() {
    }

    static String choose(int centreX, int screenWidth, int hysteresisPx, String previous) {
        int middle = screenWidth / 2;
        int band = Math.max(0, hysteresisPx);
        if (LEFT.equals(previous)) {
            return centreX > middle + band ? RIGHT : LEFT;
        }
        if (RIGHT.equals(previous)) {
            return centreX < middle - band ? LEFT : RIGHT;
        }
        return centreX < middle ? LEFT : RIGHT;
    }

    /** Whether a dropped ball sits close enough to a side to earn a turn pause. */
    static boolean nearEdge(int centreX, int screenWidth, float fraction) {
        if (screenWidth <= 0) return false;
        float edge = Math.max(0.05f, Math.min(0.45f, fraction));
        return centreX <= screenWidth * edge
                || centreX >= screenWidth * (1f - edge);
    }
}

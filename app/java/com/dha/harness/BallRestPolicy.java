package com.dha.harness;

/** Monotonic idle timing; background work always takes priority over resting. */
final class BallRestPolicy {
    static final long IDLE_MS = 7 * 60 * 1000L;
    static final long DROWSY_MS = 10 * 60 * 1000L;
    static final long SLEEP_MS = DROWSY_MS + 8000L;
    private long lastActivityAt;

    BallRestPolicy(long now) {
        lastActivityAt = now;
    }

    void interact(long now) {
        lastActivityAt = now;
    }

    boolean shouldRest(long now, boolean busy) {
        return stage(now, busy) > 0;
    }

    int stage(long now, boolean busy) {
        if (busy || now < lastActivityAt) {
            lastActivityAt = now;
            return 0;
        }
        long idle = now - lastActivityAt;
        return idle >= SLEEP_MS ? 3 : idle >= DROWSY_MS ? 2 : idle >= IDLE_MS ? 1 : 0;
    }

    long remaining(long now) {
        long idle = Math.max(0L, now - lastActivityAt);
        long next = idle < IDLE_MS ? IDLE_MS : idle < DROWSY_MS ? DROWSY_MS : SLEEP_MS;
        return idle >= SLEEP_MS ? 30000L : Math.max(1L, next - idle);
    }
}

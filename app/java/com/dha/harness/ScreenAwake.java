package com.dha.harness;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;

/**
 * Keep the display awake only while the phone assistant or agent is actively
 * operating the device. Every action extends a bounded lease; idle arms a
 * delayed release so a dead turn cannot leave the screen on forever.
 */
final class ScreenAwake {
    private static final long ACTION_LEASE_MS = 5 * 60 * 1000L;
    private static final long TASK_RELEASE_DELAY_MS = 15 * 1000L;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final ScreenAwakeLeases TASKS = new ScreenAwakeLeases();

    private static PowerManager.WakeLock lock;
    private static long expiresAt;
    private static long lastHoldLog;
    private static long lastSkipLog;
    private static final Runnable RELEASE = ScreenAwake::release;

    private ScreenAwake() {
    }

    static synchronized void hold(String reason) {
        Context context = App.i();
        if (context == null) return;
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        if (power == null) return;
        boolean interactive;
        try {
            interactive = power.isInteractive();
        } catch (Throwable ignored) {
            interactive = false;
        }
        boolean held = lock != null && lock.isHeld();
        ScreenAwakePolicy.Action action = ScreenAwakePolicy.decide(interactive, held);
        if (action == ScreenAwakePolicy.Action.IGNORE) {
            MAIN.removeCallbacks(RELEASE);
            if (!TASKS.active()) expiresAt = 0;
            long now = android.os.SystemClock.elapsedRealtime();
            if (now - lastSkipLog > 60_000) {
                lastSkipLog = now;
                App.log("screen awake skipped: screen off · " + reason);
            }
            return;
        }
        if (action == ScreenAwakePolicy.Action.RELEASE) {
            // A task lease still owns the display. A screen-off transition may
            // be the user pressing power, so do not wake it, but keep the lease
            // valid until the turn ends instead of dropping the lock mid-task.
            if (!TASKS.active()) releaseLock();
            MAIN.removeCallbacks(RELEASE);
            if (!TASKS.active()) expiresAt = 0;
            return;
        }
        boolean taskActive = TASKS.active();
        acquire(power, reason, taskActive ? 0L : ACTION_LEASE_MS);
        expiresAt = taskActive ? 0L
                : android.os.SystemClock.elapsedRealtime() + ACTION_LEASE_MS;
        MAIN.removeCallbacks(RELEASE);
        long now = android.os.SystemClock.elapsedRealtime();
        if (now - lastHoldLog > 30000) {
            lastHoldLog = now;
            App.log("screen awake: " + reason);
        }
    }

    /** A ball status may extend an existing turn, but never replace its end. */
    static synchronized void taskHold(String reason) {
        if (!TASKS.active()) return;
        hold(reason);
    }

    static synchronized void releaseSoon(long delayMs) {
        if (TASKS.active()) return;
        MAIN.removeCallbacks(RELEASE);
        MAIN.postDelayed(RELEASE, Math.max(250, delayMs));
    }

    static synchronized void release() {
        if (TASKS.active()) return;
        MAIN.removeCallbacks(RELEASE);
        expiresAt = 0;
        notifyTaskWindows(false);
        releaseLock();
    }

    /** Drop every task lease when the harness process itself stops or errors. */
    static synchronized void reset() {
        TASKS.clear();
        release();
    }

    /** A harness turn started; keep an already-visible screen on until its end. */
    static synchronized void taskStart(String sessionId, String reason) {
        ScreenAwakeLeases.Begin start = TASKS.begin(sessionId);
        if (!start.added) {
            App.log("screen awake task begin ignored (duplicate or missing session): "
                    + sessionId);
            return;
        }
        notifyTaskWindows(true);
        // A duplicate/overlapping turn must not inherit an old delayed release.
        MAIN.removeCallbacks(RELEASE);
        if (!start.first) {
            App.log("screen awake task added: " + reason
                    + " active=" + start.activeCount);
            return;
        }
        Context context = App.i();
        if (context == null) return;
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        if (power == null) return;
        boolean interactive;
        try {
            interactive = power.isInteractive();
        } catch (Throwable ignored) {
            interactive = false;
        }
        if (interactive) {
            acquire(power, reason, 0L);
            expiresAt = 0;
            App.log("screen awake task start: " + reason
                    + " active=" + start.activeCount);
        } else {
            App.log("screen awake task start skipped (screen off): " + reason
                    + " active=" + start.activeCount);
        }
    }

    /** A harness turn ended; release after a short grace period. */
    static synchronized void taskEnd(String sessionId, String reason) {
        ScreenAwakeLeases.End end = TASKS.end(sessionId);
        if (!end.removed) {
            App.log("screen awake task end ignored (unknown session): " + sessionId);
            return;
        }
        if (end.last) {
            App.log("screen awake task end: " + reason + " active=0");
            releaseSoon(TASK_RELEASE_DELAY_MS);
        } else {
            App.log("screen awake task ended: " + reason
                    + " active=" + end.activeCount);
        }
    }

    private static void acquire(PowerManager power, String reason, long timeoutMs) {
        if (lock == null) {
            // SCREEN_BRIGHT keeps an already-visible display on. Never request
            // ACQUIRE_CAUSES_WAKEUP: background plugins and scheduled tasks must
            // not light the screen while the user is asleep.
            lock = power.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK,
                    "DHA:active-task-screen");
            lock.setReferenceCounted(false);
        }
        // Action holds used to release and reacquire an indefinite task lock for
        // every tap, producing hundreds of churned wake-lock records. Once an
        // indefinite task lock is healthy there is nothing to refresh.
        if (timeoutMs == 0 && lock.isHeld()) {
            expiresAt = 0;
            return;
        }
        if (lock.isHeld()) lock.release();
        if (timeoutMs > 0) {
            lock.acquire(timeoutMs);
        } else {
            lock.acquire();
        }
        long now = android.os.SystemClock.elapsedRealtime();
        if (now - lastHoldLog > 30000) {
            lastHoldLog = now;
            App.log("screen awake: " + reason + (timeoutMs > 0 ? "" : " (until task end)"));
        }
    }

    private static void releaseLock() {
        if (lock != null && lock.isHeld()) {
            lock.release();
            App.log("screen awake: released");
        }
    }

    static synchronized boolean active() {
        return lock != null && lock.isHeld();
    }

    static synchronized long remainingMs() {
        if (!active()) return 0;
        if (expiresAt == 0) return -1;
        return Math.max(0, expiresAt - android.os.SystemClock.elapsedRealtime());
    }

    static synchronized int activeTasks() {
        return TASKS.size();
    }

    static synchronized boolean tasksActive() {
        return TASKS.active();
    }

    private static void notifyTaskWindows(boolean active) {
        try {
            BallService.setTaskScreenAwake(active);
        } catch (Throwable error) {
            App.log("screen awake ball flag: " + error);
        }
        try {
            MainActivity.setTaskScreenAwake(active);
        } catch (Throwable error) {
            App.log("screen awake activity flag: " + error);
        }
    }
}

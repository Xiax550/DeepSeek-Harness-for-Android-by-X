package com.dha.harness;

/** Decide whether screen-attached work may hold the display awake. */
final class ScreenAwakePolicy {
    enum Action {
        HOLD,
        RELEASE,
        IGNORE
    }

    private ScreenAwakePolicy() {
    }

    static Action decide(boolean screenInteractive, boolean lockHeld) {
        if (screenInteractive) return Action.HOLD;
        return lockHeld ? Action.RELEASE : Action.IGNORE;
    }
}

package com.dha.harness;

import android.content.Context;

/**
 * Keeps DHA's accessibility service recoverable when MIUI unbinds it.
 *
 * Recovery is deliberately limited to appending DHA's component. The secure
 * setting may contain GKD and any number of other accessibility services, so
 * replacing the list would break them and is never acceptable here.
 */
final class AccessibilityGuardian {

    static final String PREF_AUTO_REPAIR = "autoRepairAccessibility";

    private AccessibilityGuardian() {
    }

    static boolean enabled() {
        return App.i().prefs.getBoolean(PREF_AUTO_REPAIR, true);
    }

    static boolean canRepair() {
        return enabled()
                && !Assist.available()
                && ShizukuBridge.available()
                && ShizukuBridge.granted();
    }

    static ShizukuBridge.Result repair(Context context) {
        return ShizukuBridge.repairAccessibility(context);
    }
}

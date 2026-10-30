package com.dha.harness;

/** Resolve the app's theme preference without letting a stale window cache win. */
final class ThemeChoice {
    static final String LIGHT = "light";
    static final String DARK = "dark";
    static final String SYSTEM = "system";

    private ThemeChoice() {
    }

    static boolean isDark(String preference, boolean systemDark) {
        if (DARK.equals(preference)) return true;
        if (SYSTEM.equals(preference)) return systemDark;
        return false;
    }
}

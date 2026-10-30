package com.dha.harness;

public final class ThemeChoiceTest {
    private static int checks;
    private static int failures;

    public static void main(String[] args) {
        check(ThemeChoice.isDark("light", true), false, "explicit light wins over system dark");
        check(ThemeChoice.isDark("light", false), false, "explicit light stays light");
        check(ThemeChoice.isDark("dark", false), true, "explicit dark wins over system light");
        check(ThemeChoice.isDark("system", true), true, "system follows dark");
        check(ThemeChoice.isDark("system", false), false, "system follows light");
        check(ThemeChoice.isDark(null, true), false, "missing preference defaults light");
        check(ThemeChoice.isDark("unknown", true), false, "unknown preference defaults light");
        System.out.println("ThemeChoice: " + checks + " checks, " + failures + " failure(s)");
        if (failures != 0) System.exit(1);
    }

    private static void check(boolean actual, boolean expected, String label) {
        checks++;
        if (actual != expected) {
            failures++;
            System.out.println("FAIL " + label + ": expected " + expected + ", got " + actual);
        }
    }
}

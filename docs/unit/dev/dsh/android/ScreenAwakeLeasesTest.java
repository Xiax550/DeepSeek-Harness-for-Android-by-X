package com.dha.harness;

public final class ScreenAwakeLeasesTest {
    private static int checks;
    private static int failures;

    public static void main(String[] args) {
        ScreenAwakeLeases leases = new ScreenAwakeLeases();

        ScreenAwakeLeases.Begin first = leases.begin("session-a");
        check(first.added && first.first && first.activeCount == 1,
                "first session starts the task lease");

        ScreenAwakeLeases.Begin duplicate = leases.begin("session-a");
        check(!duplicate.added && duplicate.activeCount == 1,
                "duplicate begin is idempotent");

        ScreenAwakeLeases.Begin nested = leases.begin("session-b");
        check(nested.added && !nested.first && nested.activeCount == 2,
                "another session joins without replacing the first");

        ScreenAwakeLeases.End stillActive = leases.end("session-a");
        check(stillActive.removed && !stillActive.last && stillActive.activeCount == 1,
                "ending one session keeps the shared screen awake");

        ScreenAwakeLeases.End unknown = leases.end("session-a");
        check(!unknown.removed && !unknown.last && unknown.activeCount == 1,
                "duplicate end is ignored");

        ScreenAwakeLeases.End last = leases.end("session-b");
        check(last.removed && last.last && last.activeCount == 0,
                "the last session releases the task lease");

        ScreenAwakeLeases.Begin invalid = leases.begin("   ");
        check(!invalid.added && invalid.activeCount == 0,
                "an empty session id cannot create an immortal lease");

        leases.begin("session-c");
        leases.clear();
        check(leases.size() == 0 && !leases.active(),
                "reset drops every active lease");

        System.out.println("ScreenAwakeLeases: " + checks + " checks, "
                + failures + " failure(s)");
        if (failures != 0) System.exit(1);
    }

    private static void check(boolean condition, String label) {
        checks++;
        if (!condition) {
            failures++;
            System.out.println("FAIL " + label);
        }
    }
}

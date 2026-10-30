package com.dha.harness;

public final class MountPathTest {
    private static int checks;
    private static int failures;

    public static void main(String[] args) {
        check(MountPath.defaultGuestPath("/storage/emulated/0/Download"),
                "/mnt/Download", "keeps a simple folder name");
        check(MountPath.defaultGuestPath("/storage/emulated/0/My Files"),
                "/mnt/My_Files", "makes spaces shell-safe");
        check(MountPath.normalizeGuest(" /mnt//work/ "), "/mnt/work",
                "normalizes duplicate and trailing slashes");
        check(MountPath.safeGuest("/mnt/work"), true, "accepts /mnt child");
        check(MountPath.safeGuest("mnt/work"), false, "rejects a relative path");
        check(MountPath.safeGuest("/mnt/../etc"), false, "rejects parent traversal");
        check(MountPath.safeGuest("/proc"), false, "rejects a reserved root");
        check(MountPath.safeGuest("/"), false, "rejects rootfs itself");
        System.out.println("MountPath: " + checks + " checks, " + failures + " failure(s)");
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

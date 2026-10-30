package com.dha.harness;

import java.util.Arrays;
import java.util.List;

public final class ScreenshotPathsTest {
    private static int checks;
    private static int failures;

    public static void main(String[] args) {
        equal(ScreenshotPaths.fromCommand("shiz screencap -p /sdcard/Download/shot.png"),
                Arrays.asList("/sdcard/Download/shot.png"), "absolute shared-storage path");
        equal(ScreenshotPaths.fromCommand(
                        "screencap -p /storage/emulated/0/Pictures/a.jpg"),
                Arrays.asList("/sdcard/Pictures/a.jpg"), "normalizes emulated zero path");
        equal(ScreenshotPaths.fromCommand("cp /sdcard/DCIM/old.png /sdcard/DCIM/new.png"),
                Arrays.asList(), "ignores commands without screencap");
        equal(ScreenshotPaths.fromCommand(
                        "screencap -p /sdcard/Download/a.png && "
                                + "screencap -p /storage/emulated/0/Download/b.png && "
                                + "screencap -p /sdcard/Download/a.png"),
                Arrays.asList("/sdcard/Download/a.png", "/sdcard/Download/b.png"),
                "deduplicates multiple screenshots");
        equal(ScreenshotPaths.fromCommand("screencap -p '/sdcard/Download/shot one.png'"),
                Arrays.asList("/sdcard/Download/shot one.png"), "quoted path with spaces");
        equal(ScreenshotPaths.fromCommand(
                        "screencap -p /sdcard/Download/new.png; "
                                + "cp /sdcard/Download/family.jpg /sdcard/Download/copy.jpg"),
                Arrays.asList("/sdcard/Download/new.png"),
                "ignores image paths in later shell segments");
        equal(ScreenshotPaths.fromCommand(
                        "screencap -p /sdcard/Download/no-extension"),
                Arrays.asList("/sdcard/Download/no-extension"),
                "screencap path does not require an image extension");
        equal(ScreenshotPaths.fromCommand(
                        "screencap -p /storage/self/primary/Download/self.png"),
                Arrays.asList("/sdcard/Download/self.png"),
                "normalizes storage self primary path");
        equal(ScreenshotPaths.fromCommand(
                        "screencap -p > /mnt/sdcard/Download/redirected.png"),
                Arrays.asList("/sdcard/Download/redirected.png"),
                "recognizes redirection and mnt sdcard path");
        equal(ScreenshotPaths.fromCommand(
                        "screencap -p '/sdcard/Download/no extension shot'"),
                Arrays.asList("/sdcard/Download/no extension shot"),
                "quoted extensionless screenshot path");
        System.out.println("ScreenshotPaths: " + checks + " checks, " + failures + " failure(s)");
        if (failures != 0) System.exit(1);
    }

    private static void equal(List<String> actual, List<String> expected, String label) {
        checks++;
        if (!actual.equals(expected)) {
            failures++;
            System.out.println("FAIL " + label + ": expected " + expected + ", got " + actual);
        }
    }
}

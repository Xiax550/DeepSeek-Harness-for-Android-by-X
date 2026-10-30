package com.dha.harness;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Extract image destinations from shell commands that invoke Android screencap. */
final class ScreenshotPaths {
    private static final Pattern COMMAND_BREAK = Pattern.compile("(?:&&|\\|\\||;|\\r?\\n)");
    private static final String IMAGE_ROOT =
            "(?:/sdcard|/storage/emulated/0|/storage/self/primary|/mnt/sdcard)";
    private static final Pattern QUOTED_IMAGE = Pattern.compile(
            "(?i)([\"'])(" + IMAGE_ROOT + "/[^\"'\\r\\n]+?"
                    + "\\.(?:png|jpe?g|webp|bmp|gif))\\1");
    private static final Pattern BARE_IMAGE = Pattern.compile(
            "(?i)(?<![\"'])(" + IMAGE_ROOT
                    + "/[^\\s\"';&|<>]+\\.(?:png|jpe?g|webp|bmp|gif))");
    private static final Pattern QUOTED_CAPTURE_PATH = Pattern.compile(
            "(?i)([\"'])(" + IMAGE_ROOT + "/[^\"'\\r\\n]+)\\1");
    private static final Pattern BARE_CAPTURE_PATH = Pattern.compile(
            "(?i)(?<![\"'])(" + IMAGE_ROOT + "/[^\\s\"';&|<>]+)");

    private ScreenshotPaths() {
    }

    static List<String> fromCommand(String command) {
        Set<String> out = new LinkedHashSet<>();
        String text = command == null ? "" : command;
        for (String segment : COMMAND_BREAK.split(text)) {
            if (!segment.toLowerCase(Locale.US).contains("screencap")) continue;
            collect(QUOTED_IMAGE, segment, 2, out);
            collect(BARE_IMAGE, segment, 1, out);
            // `screencap` may write PNG bytes to a path without an extension.
            collect(QUOTED_CAPTURE_PATH, segment, 2, out);
            collect(BARE_CAPTURE_PATH, segment, 1, out);
        }
        return new ArrayList<>(out);
    }

    private static void collect(Pattern pattern, String text, int group, Set<String> out) {
        Matcher matcher = pattern.matcher(text);
        while (matcher.find()) {
            out.add(normalize(matcher.group(group)));
        }
    }

    static String normalize(String raw) {
        String path = raw.replace('\\', '/');
        if (path.startsWith("/storage/emulated/0/")) {
            path = "/sdcard/" + path.substring("/storage/emulated/0/".length());
        }
        if (path.startsWith("/storage/self/primary/")) {
            path = "/sdcard/" + path.substring("/storage/self/primary/".length());
        }
        if (path.startsWith("/mnt/sdcard/")) {
            path = "/sdcard/" + path.substring("/mnt/sdcard/".length());
        }
        return path;
    }
}

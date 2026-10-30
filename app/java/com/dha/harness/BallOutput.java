package com.dha.harness;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/** Keeps floating-ball output concise, Chinese-only, and free of reasoning. */
final class BallOutput {
    private static final int MAX_CHARS = 2000;
    private static final Pattern REASONING_BLOCK = Pattern.compile(
            "(?is)<(analysis|reasoning|thinking|thought|思考过程|分析过程|推理过程)>"
                    + ".*?</\\1\\s*>");
    private static final Pattern CODE_BLOCK = Pattern.compile("(?s)```.*?```");
    private static final Pattern REASONING_LINE = Pattern.compile(
            "(?i)^\\s*(analysis|reasoning|thinking|thought|chain of thought|"
                    + "let me\\b|i need\\b|i should\\b|i will\\b|we need\\b|we should\\b|"
                    + "the user\\b|思考过程\\b|分析过程\\b|推理过程\\b|内心想法\\b).*$");
    private static final Pattern LATIN = Pattern.compile(
            "(?i)[a-z]+(?:['-][a-z]+)*");
    private static final Pattern VISIBLE = Pattern.compile("[\\u3400-\\u9fff0-9]");
    private static final Pattern HAN = Pattern.compile("[\\u3400-\\u9fff]");
    private static final Pattern LIST_PREFIX = Pattern.compile(
            "^\\s{0,3}(?:#{1,6}|>|[-*+]|\\d+[.)、])\\s*");
    private static final Pattern MARKDOWN_PREFIX = Pattern.compile(
            "^\\s{0,3}(?:#{1,6}|>|[-*+])\\s*");
    private static final Pattern SPACE_RUN = Pattern.compile("\\s{2,}");
    private static final Pattern LEADING_PUNCT = Pattern.compile(
            "^[\\s:：,，;；.!?！？、]+");
    private static final Pattern TRAILING_PUNCT = Pattern.compile(
            "(?:\\s*[.!?。！？]){2,}\\s*$");

    private BallOutput() {
    }

    static String sanitize(String phase, String text) {
        String stage = phase == null ? "" : phase;
        String value = text == null ? "" : text.trim();
        // Thinking details never go to the ball; only the fixed Chinese state.
        if ("think".equals(stage)) return "思考中";
        boolean requireChinese = "work".equals(stage)
                || "done".equals(stage)
                || "permission".equals(stage);
        String cleaned = visibleText(value, requireChinese);
        if (cleaned.isEmpty()) {
            switch (stage) {
                case "work":
                    return "处理中";
                case "result":
                    return "任务已完成";
                case "done":
                    return "已完成";
                case "permission":
                    return "需要确认授权";
                default:
                    return "";
            }
        }
        if (cleaned.length() > MAX_CHARS) {
            cleaned = cleaned.substring(0, MAX_CHARS - 1).trim() + "…";
        }
        return cleaned;
    }

    private static String visibleText(String text, boolean requireChinese) {
        String compact = REASONING_BLOCK.matcher(text).replaceAll("\n");
        compact = CODE_BLOCK.matcher(compact).replaceAll("\n");
        List<String> lines = new ArrayList<>();
        for (String raw : compact.split("\\r?\\n")) {
            String line = raw.trim();
            if (line.isEmpty()) continue;
            String probe = LIST_PREFIX.matcher(line).replaceFirst("");
            if (REASONING_LINE.matcher(probe).matches()) continue;
            line = MARKDOWN_PREFIX.matcher(line).replaceFirst("");
            line = LATIN.matcher(line).replaceAll(" ");
            line = LEADING_PUNCT.matcher(line).replaceFirst("");
            line = TRAILING_PUNCT.matcher(line).replaceFirst(".");
            line = SPACE_RUN.matcher(line).replaceAll(" ").trim();
            boolean visible = requireChinese
                    ? HAN.matcher(line).find() : VISIBLE.matcher(line).find();
            if (line.isEmpty() || !visible) continue;
            lines.add(line);
        }
        return String.join("\n", lines).trim();
    }
}

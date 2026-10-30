package com.dha.harness;

public final class BallOutputTest {
    private static int checks;
    private static int failures;

    public static void main(String[] args) {
        equal(BallOutput.sanitize("think", "Let me inspect the hidden reasoning"),
                "思考中", "thinking is replaced by a Chinese status");
        equal(BallOutput.sanitize("work", "Running command adb shell input swipe"),
                "处理中", "English-only work is replaced by a Chinese status");
        equal(BallOutput.sanitize("work", "Step 3: running adb"),
                "处理中", "English work with digits is still replaced");
        equal(BallOutput.sanitize("think", "分析用户目标"),
                "思考中", "thinking details are not shown");
        equal(BallOutput.sanitize("work", "正在打开设置页面"), "正在打开设置页面",
                "Chinese work status is preserved");

        String mixed = "<analysis>private plan in English</analysis>\n"
                + "思考过程：The user wants this\n"
                + "```text\nadb shell input tap 1 2\n```\n"
                + "已处理 3 项，版本 2.4";
        equal(BallOutput.sanitize("result", mixed), "已处理 3 项，版本 2.4",
                "reasoning, code and English are removed");

        equal(BallOutput.sanitize("result", "Done. The result is ready."),
                "任务已完成", "English-only result gets a Chinese fallback");
        equal(BallOutput.sanitize("result", "Done: 42."), "42.",
                "numbers are retained without English");
        equal(BallOutput.sanitize("result", "结果：42"), "结果：42",
                "numbers in a Chinese result are kept");
        equal(BallOutput.sanitize("result", "12345"), "12345",
                "numeric-only result is kept");
        equal(BallOutput.sanitize("result", "已安装 DHA version 1.2.46"),
                "已安装 1.2.46", "Latin words are stripped from mixed text");
        equal(BallOutput.sanitize("result", "Let me think\n最终结果：成功"),
                "最终结果：成功", "English reasoning line is discarded");
        equal(BallOutput.sanitize("result", "1. Analysis: hidden\n最终结果：成功"),
                "最终结果：成功", "numbered English reasoning is discarded");

        String english = BallOutput.sanitize("result", "The final answer is ready.");
        check(!english.matches(".*[A-Za-z].*"), "no English letters survive");
        String chinese = BallOutput.sanitize("result",
                "第一行结果\n\n第二行结果，数字 7");
        check(chinese.contains("\n"), "Chinese result keeps line breaks");

        System.out.println("BallOutput: " + checks + " checks, " + failures + " failure(s)");
        if (failures != 0) System.exit(1);
    }

    private static void equal(String actual, String expected, String label) {
        check(expected.equals(actual), label + " (got " + actual + ")");
    }

    private static void check(boolean condition, String label) {
        checks++;
        if (!condition) {
            failures++;
            System.out.println("FAIL " + label);
        }
    }
}

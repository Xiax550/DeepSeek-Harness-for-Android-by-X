package com.dha.harness;

/**
 * JVM tests for {@link RecoveryPlan} — the rules behind recovery mode.
 *
 * The point of these is that getting recovery wrong is expensive to discover: it
 * is the mode you are in *because* something is already broken, so a mistake
 * here (a token the guest refuses, a port it will not bind, a failure counter
 * that never trips) shows up exactly when the user has nothing else to fall back
 * on. Everything asserted here is a pure function, so it runs in milliseconds on
 * a plain JVM with no device and no APK.
 *
 * Run: sh docs/run-unit-tests.sh
 */
public final class RecoveryPlanTest {

    private static int checks;
    private static int failures;

    private static void check(String what, boolean ok) {
        checks++;
        if (!ok) {
            failures++;
            System.out.println("FAIL  " + what);
        }
    }

    private static void equal(String what, Object expected, Object actual) {
        boolean ok = expected == null ? actual == null : expected.equals(actual);
        checks++;
        if (!ok) {
            failures++;
            System.out.println("FAIL  " + what + "  expected=" + expected + " actual=" + actual);
        }
    }

    public static void main(String[] args) {
        tokens();
        ports();
        failureAccounting();
        autoEntry();
        commands();
        describe();

        System.out.println("RecoveryPlan: " + checks + " checks, " + failures + " failure(s)");
        if (failures > 0) System.exit(1);
    }

    /**
     * The token becomes a line in /etc/shadow (`root:<token>`), so the guest
     * script refuses colons and newlines; the app must refuse the same things or
     * it would hand the user a password that cannot be installed.
     */
    private static void tokens() {
        check("普通 base64url 令牌可用", RecoveryPlan.validToken("AbC-123_xyz789"));
        check("8 位下限可用", RecoveryPlan.validToken("12345678"));
        check("128 位上限可用", RecoveryPlan.validToken(repeat('a', 128)));

        check("空令牌不可用", !RecoveryPlan.validToken(""));
        check("null 不可用", !RecoveryPlan.validToken(null));
        check("太短不可用", !RecoveryPlan.validToken("short"));
        check("太长不可用", !RecoveryPlan.validToken(repeat('a', 129)));
        check("含冒号不可用", !RecoveryPlan.validToken("abc:def123"));
        check("含换行不可用", !RecoveryPlan.validToken("abcdefg\n"));
        check("含回车不可用", !RecoveryPlan.validToken("abcdefg\r"));
        check("含空格不可用", !RecoveryPlan.validToken("abcd efg"));
        check("含制表符不可用", !RecoveryPlan.validToken("abcd\tefg"));
        check("含非 ASCII 不可用", !RecoveryPlan.validToken("abcdefg中"));
        // base64url 之外的标准 base64 字符也不行：guest 的 case 通配符拒绝它们，
        // 这里必须一致，否则用户会拿到一个装不上去的密码。
        check("含 + 不可用", !RecoveryPlan.validToken("abcd+efg1"));
        check("含 / 不可用", !RecoveryPlan.validToken("abcd/efg1"));
        check("含 = 填充不可用", !RecoveryPlan.validToken("abcdefg="));
        check("连字符与下划线可用", RecoveryPlan.validToken("ab-cd_ef12"));

        // The app's own generator must always produce something the guest accepts,
        // or entering recovery would fail on a device instead of here.
        boolean generatorAgrees = true;
        for (int i = 0; i < 200; i++) {
            if (!RecoveryPlan.validToken(sampleToken(i))) generatorAgrees = false;
        }
        check("200 个生成样例全部通过校验", generatorAgrees);
    }

    /**
     * A deterministic stand-in for App.randomToken(): 24 random-looking bytes,
     * URL-safe base64 without padding, which is what the app actually mints.
     */
    private static String sampleToken(int seed) {
        java.util.Random random = new java.util.Random(seed * 2654435761L + 17);
        byte[] bytes = new byte[24];
        random.nextBytes(bytes);
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static void ports() {
        check("默认端口合法", RecoveryPlan.validPort(RecoveryPlan.DEFAULT_PORT));
        check("1024 合法", RecoveryPlan.validPort(1024));
        check("65535 合法", RecoveryPlan.validPort(65535));
        check("1023 非法（要特权）", !RecoveryPlan.validPort(1023));
        check("0 非法", !RecoveryPlan.validPort(0));
        check("负数非法", !RecoveryPlan.validPort(-1));
        check("65536 非法", !RecoveryPlan.validPort(65536));

        equal("坏端口回落到默认", RecoveryPlan.DEFAULT_PORT, RecoveryPlan.clampPort(0));
        equal("好端口原样保留", 9022, RecoveryPlan.clampPort(9022));
        equal("越界端口回落到默认", RecoveryPlan.DEFAULT_PORT, RecoveryPlan.clampPort(70000));
    }

    private static void failureAccounting() {
        long now = 1_000_000_000L;

        equal("窗口内计数保留", 2, RecoveryPlan.failuresAt(2, now - 1000, now));
        equal("窗口外计数归零", 0,
                RecoveryPlan.failuresAt(5, now - RecoveryPlan.FAILURE_WINDOW_MS - 1, now));
        equal("恰好到期即归零", 0,
                RecoveryPlan.failuresAt(5, now - RecoveryPlan.FAILURE_WINDOW_MS, now));
        equal("负数计数当零", 0, RecoveryPlan.failuresAt(-3, now, now));
        equal("没有时间戳就用原值", 4, RecoveryPlan.failuresAt(4, 0, now));
    }

    /**
     * The one decision that has to be right: entering recovery takes the harness
     * away from the user, so it must need real evidence and must never re-enter
     * once it is already on.
     */
    private static void autoEntry() {
        long now = 1_000_000_000L;
        long recent = now - 1000;

        check("两次失败还不够", !RecoveryPlan.shouldEnter(true, false, 2, recent, now));
        check("三次失败进入", RecoveryPlan.shouldEnter(true, false, 3, recent, now));
        check("更多失败当然进入", RecoveryPlan.shouldEnter(true, false, 9, recent, now));
        check("关掉自动就不进", !RecoveryPlan.shouldEnter(false, false, 9, recent, now));
        check("已在恢复模式不再进", !RecoveryPlan.shouldEnter(true, true, 9, recent, now));
        check("陈旧的失败不算数", !RecoveryPlan.shouldEnter(true, false, 9,
                now - RecoveryPlan.FAILURE_WINDOW_MS - 1, now));
        check("零失败不进", !RecoveryPlan.shouldEnter(true, false, 0, 0, now));
    }

    private static void commands() {
        equal("同一 Wi-Fi 的连接命令",
                "ssh -p 8022 root@192.168.1.5",
                RecoveryPlan.sshCommand("192.168.1.5", 8022, "root"));
        equal("USB 的连接命令",
                "ssh -p 8022 root@127.0.0.1",
                RecoveryPlan.sshCommand("127.0.0.1", 8022, "root"));
        equal("adb 转发命令",
                "adb forward tcp:8022 tcp:8022",
                RecoveryPlan.adbForward(8022));
        equal("端口转发命令（带 harness 端口）",
                "ssh -p 8022 -L 3080:127.0.0.1:3080 root@192.168.1.5",
                RecoveryPlan.forwardCommand("192.168.1.5", 8022, "root", 3080));
    }

    private static void describe() {
        equal("未启用且没有失败", "未启用", RecoveryPlan.describe(false, false, 8022, 0));
        equal("未启用但有失败记录", "未启用（harness 连续失败 2 次）",
                RecoveryPlan.describe(false, false, 8022, 2));
        check("已启用且就绪时说明端口",
                RecoveryPlan.describe(true, true, 8022, 0).contains("8022"));
        check("已启用未就绪时说启动中",
                RecoveryPlan.describe(true, false, 8022, 0).contains("启动中"));
    }

    private static String repeat(char c, int count) {
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < count; i++) text.append(c);
        return text.toString();
    }
}

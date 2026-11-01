package com.dha.harness;

public final class BallRestPolicyTest {
    private static int checks;

    private static void check(boolean value) {
        checks++;
        if (!value) throw new AssertionError("check " + checks);
    }

    public static void main(String[] args) {
        BallRestPolicy p = new BallRestPolicy(1000);
        check(p.stage(420999, false) == 0);
        check(p.stage(421000, false) == 1);
        check(p.remaining(421000) == 180000);
        check(p.stage(600999, false) == 1);
        check(p.stage(601000, false) == 2);
        check(p.remaining(601000) == 8000);
        check(p.stage(608999, false) == 2);
        check(p.stage(609000, false) == 3);
        check(p.remaining(609000) == 30000);
        check(p.stage(700000, true) == 0);
        check(p.stage(1119999, false) == 0);
        check(p.stage(1120000, false) == 1);
        p.interact(1200000);
        check(p.stage(1200000, false) == 0);
        check(p.remaining(1200000) == 420000);
        check(p.remaining(1619999) == 1);
        check(!p.shouldRest(5, false));
        check(p.remaining(5) == 420000);
        for (int i = 1; i <= 20; i++) {
            long now = i * 200000L;
            check(!p.shouldRest(now, true));
            check(!p.shouldRest(now + 419999, false));
            check(p.stage(now + 420000, false) == 1);
            check(p.stage(now + 600000, false) == 2);
            check(p.stage(now + 608000, false) == 3);
            p.interact(now + 609000);
            check(p.stage(now + 609000, false) == 0);
        }
        System.out.println("BallRestPolicy: " + checks + " checks passed");
    }
}

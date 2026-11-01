package com.dha.harness;

import java.util.Calendar;
import java.util.TimeZone;

public final class UpdatePolicyTest {
    private static int checks;
    private static void check(boolean value) {
        checks++;
        if (!value) throw new AssertionError("check " + checks);
    }
    private static long time(int day, int hour, int minute) {
        Calendar c = Calendar.getInstance();
        c.clear(); c.set(2026, Calendar.OCTOBER, day, hour, minute);
        return c.getTimeInMillis();
    }
    public static void main(String[] args) {
        TimeZone.setDefault(TimeZone.getTimeZone("Asia/Shanghai"));
        check(UpdatePolicy.nextCheck(time(31, 0, 0)) == time(31, 1, 0));
        check(UpdatePolicy.nextCheck(time(31, 1, 0)) == time(32, 1, 0));
        check(UpdatePolicy.nextCheck(time(31, 23, 59)) == time(32, 1, 0));
        check(UpdatePolicy.shouldCheck(100, 0, true));
        check(!UpdatePolicy.shouldCheck(3600000, 1, true));
        check(UpdatePolicy.shouldCheck(3600001, 1, true));
        check(UpdatePolicy.shouldCheck(900001, 1, false));
        check(!UpdatePolicy.shouldCheck(900000, 1, false));
        check(UpdatePolicy.shouldCheck(1, 100, true));
        check(UpdatePolicy.newerHot("1.2.54-t3-sp10", "1.2.54-t3-sp9"));
        check(!UpdatePolicy.newerHot("1.2.54-t3-sp9", "1.2.54-t3-sp10"));
        check(!UpdatePolicy.newerHot("1.2.54-t3-sp1", "1.2.54-t3-sp1"));
        check(!UpdatePolicy.newerHot("1.2.53-t3-sp999", "1.2.54-t3-sp1"));
        check(!UpdatePolicy.newerHot("1.2.54-t4-sp9", "1.2.54-t3-sp1"));
        check(!UpdatePolicy.newerHot("1.2.54-t3-spbad", "1.2.54-t3-sp1"));
        System.out.println("UpdatePolicy: " + checks + " checks passed");
    }
}

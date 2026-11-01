package com.dha.harness;

import java.util.Calendar;

final class UpdatePolicy {
    static long nextCheck(long now) {
        Calendar next = Calendar.getInstance();
        next.setTimeInMillis(now);
        next.set(Calendar.HOUR_OF_DAY, 1);
        next.set(Calendar.MINUTE, 0);
        next.set(Calendar.SECOND, 0);
        next.set(Calendar.MILLISECOND, 0);
        if (next.getTimeInMillis() <= now) next.add(Calendar.DAY_OF_YEAR, 1);
        return next.getTimeInMillis();
    }

    static boolean shouldCheck(long now, long previous, boolean success) {
        return previous <= 0 || now < previous || now - previous >= (success ? 3600000L : 900000L);
    }

    static boolean newerHot(String candidate, String current) {
        int split = current.lastIndexOf("-sp");
        if (split < 0 || !candidate.startsWith(current.substring(0, split + 3))) return false;
        try {
            return Long.parseLong(candidate.substring(split + 3)) > Long.parseLong(current.substring(split + 3));
        } catch (RuntimeException ignored) {
            return false;
        }
    }
}

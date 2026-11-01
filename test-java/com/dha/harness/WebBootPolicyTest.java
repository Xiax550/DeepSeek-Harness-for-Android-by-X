package com.dha.harness;

public final class WebBootPolicyTest {
    public static void main(String[] args) {
        for (int attempts = -1; attempts <= 20; attempts++) {
            boolean expected = attempts == 0 || attempts == 1;
            if (WebBootPolicy.canRetry(attempts) != expected) throw new AssertionError("attempts=" + attempts);
        }
        if (!WebBootPolicy.PROBE.contains("[data-dsh-boot]")) throw new AssertionError("bootstrap scope");
        System.out.println("WebBootPolicy: 23 checks passed");
    }
}

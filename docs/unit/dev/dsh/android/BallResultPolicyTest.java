package com.dha.harness;

public final class BallResultPolicyTest {
    private static int checks;
    private static int failures;

    public static void main(String[] args) {
        BallResultPolicy policy = new BallResultPolicy();
        check(policy.claim("session:turn:1", "完成", 1000), true,
                "first delivery of a result is accepted");
        check(policy.claim("session:turn:1", "完成", 5000), false,
                "closing or expiring a result never reopens the same turn");
        check(policy.claim("session:turn:2", "完成", 5001), true,
                "a new turn may legitimately return identical text");

        BallResultPolicy sequenced = new BallResultPolicy();
        check(sequenced.claim("session-a:result:event:10", "同一轮结果", 1000), true,
                "the first sequence-based result is accepted");
        check(sequenced.claim("session-a:result:event:11", "同一轮结果", 5000), false,
                "a replay with a fresh event sequence does not reopen the same result");
        check(sequenced.claim("session-b:result:event:11", "同一轮结果", 5001), true,
                "sequence-based results remain isolated by session");
        check(sequenced.claim("session-a:result:event:12", "新的结果", 5002), true,
                "different sequence-based result text remains visible");
        check(sequenced.claim("session-a:result:turn:2", "同一轮结果", 5003), true,
                "a stable identifier allows a later turn with identical text");
        check(sequenced.claim("session-a:result:turn:2", "同一轮的修订文字", 5004), false,
                "a turn can only deliver one result even if its text changes");
        check(sequenced.claim("session-a:result:event:13", "同一轮结果", 32_000), true,
                "a later sequence can show identical text after the replay window");

        BallResultPolicy closedTurn = new BallResultPolicy();
        String turnEvent = "session-c:result:turn:7";
        check(closedTurn.claim(turnEvent, "手动关闭的结果", 1000), true,
                "a result is accepted before it is closed");
        closedTurn.markClosedResult(turnEvent, "手动关闭的结果", 1100);
        check(closedTurn.isClosedResultReplay(turnEvent, "手动关闭的结果", 1200), true,
                "the same closed turn is permanently recognized as a replay");
        check(closedTurn.isClosedResultReplay(turnEvent, "重放时文字略有变化", 1300), true,
                "the same closed turn is suppressed even if replay text changes");
        check(closedTurn.isClosedResultReplay("session-c:result:turn:8", "手动关闭的结果", 1400), false,
                "a later turn is not blocked by a prior closed turn");

        BallResultPolicy closedSequence = new BallResultPolicy();
        String firstSequence = "session-d:result:event:80";
        check(closedSequence.claim(firstSequence, "关闭后重播", 1000), true,
                "the first sequence result is accepted");
        closedSequence.markClosedResult(firstSequence, "关闭后重播", 1100);
        check(closedSequence.isClosedResultReplay(
                        "session-d:result:event:81", "关闭后重播", 1200), true,
                "a fresh event sequence cannot replay a closed result in the same session");
        check(closedSequence.isClosedResultReplay(
                        "session-e:result:event:81", "关闭后重播", 1200), false,
                "a different session may legitimately return identical text");
        check(closedSequence.isClosedResultReplay(
                        "session-d:result:event:81", "新的结果", 1200), false,
                "a different result in the same session remains visible");
        check(closedSequence.isClosedResultReplay(
                        "session-d:result:event:81", "关闭后重播", 121_100), false,
                "sequence-only receipts eventually expire for a future identical reply");

        BallResultPolicy legacy = new BallResultPolicy();
        check(legacy.claim("", "旧调用结果", 1000), true,
                "legacy callers can deliver their first result");
        check(legacy.claim("", "旧调用结果", 5000), false,
                "legacy duplicate text is suppressed in the repeat window");
        check(legacy.claim("", "新的调用结果", 5001), true,
                "different legacy output remains visible");
        check(legacy.claim("", "旧调用结果", 6000), false,
                "a delayed legacy duplicate stays suppressed after another result");
        legacy.markClosedResult("", "已关闭的旧调用结果", 7000);
        check(legacy.isClosedResultReplay("", "已关闭的旧调用结果", 7100), true,
                "a closed legacy result blocks late result and done callbacks");
        check(legacy.isClosedResultReplay("", "已关闭的旧调用结果", 127_001), false,
                "legacy closed-text receipts expire after the replay window");

        check(BallResultPolicy.timeoutAfterInteraction(false), 4000L,
                "an untouched result closes after four seconds");
        check(BallResultPolicy.timeoutAfterInteraction(true), 12000L,
                "a result with user interaction gets twelve seconds");

        System.out.println("BallResultPolicy: " + checks + " checks, " + failures + " failure(s)");
        if (failures != 0) System.exit(1);
    }

    private static void check(boolean actual, boolean expected, String label) {
        checks++;
        if (actual != expected) {
            failures++;
            System.out.println("FAIL " + label + ": expected " + expected + ", got " + actual);
        }
    }

    private static void check(long actual, long expected, String label) {
        checks++;
        if (actual != expected) {
            failures++;
            System.out.println("FAIL " + label + ": expected " + expected + ", got " + actual);
        }
    }
}

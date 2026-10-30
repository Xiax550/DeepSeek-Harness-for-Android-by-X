package com.dha.harness;

import java.util.LinkedHashMap;

/** Deduplicates delivered result bubbles and defines their reading window. */
final class BallResultPolicy {
    static final long IDLE_TIMEOUT_MS = 4_000L;
    static final long INTERACTION_TIMEOUT_MS = 12_000L;
    private static final long REPEAT_WINDOW_MS = 30_000L;
    private static final long CLOSED_REPLAY_WINDOW_MS = 120_000L;
    private static final int MAX_EVENTS = 256;

    private final LinkedHashMap<String, Long> shownEvents = new LinkedHashMap<>();
    private final LinkedHashMap<String, Long> closedResults = new LinkedHashMap<>();
    private final LinkedHashMap<String, Long> closedResultTexts = new LinkedHashMap<>();
    private final LinkedHashMap<String, Long> closedResultEventTexts = new LinkedHashMap<>();
    private final LinkedHashMap<String, Long> closedLegacyResultTexts = new LinkedHashMap<>();

    boolean claim(String eventId, String text, long now) {
        String value = normalize(text);
        if (eventId != null && !eventId.trim().isEmpty()) {
            String key = eventId.trim();
            String eventKey = "event:" + key;
            if (shownEvents.containsKey(eventKey)) return false;

            String turnKey = resultTurnKey(key);
            if (turnKey != null) {
                String resultKey = "turn:" + turnKey;
                if (shownEvents.containsKey(resultKey)) return false;
                shownEvents.put(resultKey, now);
            } else {
                String repeatedTextKey = resultEventTextKey(key, value);
                if (repeatedTextKey != null) {
                    Long previous = shownEvents.get(repeatedTextKey);
                    if (recent(previous, now)) return false;
                    shownEvents.put(repeatedTextKey, now);
                }
            }
            shownEvents.put(eventKey, now);
            trimEvents();
            return true;
        }
        if (value.isEmpty()) return true;
        String key = "legacy:" + value;
        Long previous = shownEvents.get(key);
        if (recent(previous, now)) return false;
        shownEvents.put(key, now);
        trimEvents();
        return true;
    }

    void markClosedResult(String eventId, String text, long now) {
        String value = normalize(text);
        if (value.isEmpty()) return;
        closedResults.put(resultReceiptKey(eventId, value), now);
        closedResultTexts.put(value, now);
        String session = resultSessionKey(eventId);
        if (session == null) {
            closedLegacyResultTexts.put(value, now);
        } else {
            closedResultEventTexts.put(session + ":" + value, now);
        }
        trim(closedResults);
        trim(closedResultTexts);
        trim(closedResultEventTexts);
        trim(closedLegacyResultTexts);
    }

    boolean isClosedResultReplay(String eventId, String text, long now) {
        String value = normalize(text);
        if (value.isEmpty()) return false;
        String receipt = resultReceiptKey(eventId, value);
        Long previous = closedResults.get(receipt);
        if (previous != null) {
            if (eventId != null && !eventId.trim().isEmpty()) return true;
            if (recentClosed(previous, now)) return true;
            closedResults.remove(receipt);
        }
        if (resultTurnKey(eventId == null ? "" : eventId.trim()) != null) return false;
        String session = resultSessionKey(eventId);
        if (session != null) {
            Long sessionPrevious = closedResultEventTexts.get(session + ":" + value);
            if (recentClosed(sessionPrevious, now)) return true;
            Long legacyPrevious = closedLegacyResultTexts.get(value);
            if (recentClosed(legacyPrevious, now)) return true;
            return false;
        }
        return isClosedResultTextReplay(value, now);
    }

    boolean isClosedResultTextReplay(String text, long now) {
        String value = normalize(text);
        if (value.isEmpty()) return false;
        Long previous = closedResultTexts.get(value);
        if (previous == null) return false;
        if (recentClosed(previous, now)) return true;
        closedResultTexts.remove(value);
        closedLegacyResultTexts.remove(value);
        return false;
    }

    private static String resultReceiptKey(String eventId, String text) {
        String value = eventId == null ? "" : eventId.trim();
        if (value.isEmpty()) return "text-result:" + text;
        String turn = resultTurnKey(value);
        return turn == null ? "event-result:" + value : "turn-result:" + turn;
    }

    private static String resultTurnKey(String eventId) {
        int marker = eventId.indexOf(":result:turn:");
        if (marker < 0) return null;
        String session = eventId.substring(0, marker);
        String turn = eventId.substring(marker + ":result:turn:".length());
        int suffix = turn.indexOf(':');
        if (suffix >= 0) turn = turn.substring(0, suffix);
        return session + ":" + turn;
    }

    private static String resultSessionKey(String eventId) {
        if (eventId == null) return null;
        String value = eventId.trim();
        int marker = value.indexOf(":result:turn:");
        if (marker < 0) marker = value.indexOf(":result:event:");
        if (marker <= 0) return null;
        return value.substring(0, marker);
    }

    private static String resultEventTextKey(String eventId, String text) {
        if (text == null || text.isEmpty()) return null;
        int marker = eventId.indexOf(":result:event:");
        if (marker < 0) return null;
        String session = eventId.substring(0, marker);
        return "event-text:" + session + ":" + text;
    }

    private static String normalize(String text) {
        return text == null ? "" : text.trim().replaceAll("\\s+", " ");
    }

    private static boolean recent(Long previous, long now) {
        return previous != null && now - previous < REPEAT_WINDOW_MS;
    }

    private static boolean recentClosed(Long previous, long now) {
        return previous != null && now - previous < CLOSED_REPLAY_WINDOW_MS;
    }

    private void trimEvents() {
        while (shownEvents.size() > MAX_EVENTS) {
            shownEvents.remove(shownEvents.keySet().iterator().next());
        }
    }

    private static void trim(LinkedHashMap<String, Long> values) {
        while (values.size() > MAX_EVENTS) {
            values.remove(values.keySet().iterator().next());
        }
    }

    static long timeoutAfterInteraction(boolean interacted) {
        return interacted ? INTERACTION_TIMEOUT_MS : IDLE_TIMEOUT_MS;
    }
}

package com.dha.harness;

import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Session-scoped task leases for the screen wake lock.
 *
 * Harness turn events can be delivered more than once and several sessions can
 * run at the same time. Counting raw begin/end notifications leaks a lease when
 * those events are duplicated, so the active session ids are the source of
 * truth instead.
 */
final class ScreenAwakeLeases {
    static final class Begin {
        final boolean added;
        final boolean first;
        final int activeCount;

        Begin(boolean added, boolean first, int activeCount) {
            this.added = added;
            this.first = first;
            this.activeCount = activeCount;
        }
    }

    static final class End {
        final boolean removed;
        final boolean last;
        final int activeCount;

        End(boolean removed, boolean last, int activeCount) {
            this.removed = removed;
            this.last = last;
            this.activeCount = activeCount;
        }
    }

    private final Set<String> sessions = new LinkedHashSet<>();

    synchronized Begin begin(String sessionId) {
        String id = clean(sessionId);
        if (id == null) {
            return new Begin(false, false, sessions.size());
        }
        boolean wasEmpty = sessions.isEmpty();
        boolean added = sessions.add(id);
        return new Begin(added, added && wasEmpty, sessions.size());
    }

    synchronized End end(String sessionId) {
        String id = clean(sessionId);
        if (id == null) {
            return new End(false, false, sessions.size());
        }
        boolean removed = sessions.remove(id);
        return new End(removed, removed && sessions.isEmpty(), sessions.size());
    }

    synchronized boolean active() {
        return !sessions.isEmpty();
    }

    synchronized int size() {
        return sessions.size();
    }

    synchronized void clear() {
        sessions.clear();
    }

    private static String clean(String value) {
        if (value == null) return null;
        String id = value.trim();
        return id.isEmpty() ? null : id;
    }
}

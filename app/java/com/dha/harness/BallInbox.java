package com.dha.harness;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Words spoken or typed into the floating ball, waiting for their conversation.
 *
 * The ball used to hand a sentence to whatever conversation was on screen, which
 * is how a stray "关掉这个" ended up in the middle of unrelated work. The words go
 * into this queue instead and the plugin drains it into a dedicated session (see
 * installBallInbox in the plugin). The app never interprets the text — it holds
 * it, hands it over, and only falls back to the old paste path if nobody claims
 * it (see Assist.deliverToBall).
 *
 * Plain static state, like the rest of this package: one process, one ball.
 */
final class BallInbox {

    /** One sentence, with the id the plugin acknowledges by. */
    static final class Item {
        final int id;
        final String text;

        Item(int id, String text) {
            this.id = id;
            this.text = text;
        }
    }

    private static final List<Item> ITEMS = new ArrayList<>();
    private static final Set<Integer> CLAIMED = new HashSet<>();
    /** A plugin that never drains must not grow this without bound. */
    private static final int MAX_PENDING = 20;
    private static int next = 1;

    private BallInbox() {
    }

    static synchronized int add(String text) {
        if (text == null || text.trim().isEmpty()) return -1;
        int id = next++;
        ITEMS.add(new Item(id, text.trim()));
        while (ITEMS.size() > MAX_PENDING) {
            // Oldest first, and marked claimed so the caller does not also paste it:
            // dropping silently would lose the user's sentence twice over.
            Item dropped = ITEMS.remove(0);
            CLAIMED.add(dropped.id);
        }
        return id;
    }

    static synchronized JSONArray pending() {
        JSONArray array = new JSONArray();
        for (Item item : ITEMS) {
            try {
                JSONObject one = new JSONObject();
                one.put("id", item.id);
                one.put("text", item.text);
                one.put("at", System.currentTimeMillis());
                array.put(one);
            } catch (Exception ignored) {
            }
        }
        return array;
    }

    static synchronized void ack(JSONArray ids) {
        if (ids == null) return;
        for (int index = 0; index < ids.length(); index++) {
            int id = ids.optInt(index, -1);
            if (id < 0) continue;
            remove(id);
            CLAIMED.add(id);
        }
        if (CLAIMED.size() > 200) CLAIMED.clear();   // these ids only matter for seconds
    }

    /** Has somebody taken this one (drained it, or dropped it as overflow)? */
    static synchronized boolean claimed(int id) {
        return id < 0 || CLAIMED.contains(id);
    }

    /** Give up on it so the caller's fallback path can take over. */
    static synchronized void drop(int id) {
        remove(id);
        CLAIMED.add(id);
    }

    private static void remove(int id) {
        for (int index = ITEMS.size() - 1; index >= 0; index--) {
            if (ITEMS.get(index).id == id) ITEMS.remove(index);
        }
    }
}

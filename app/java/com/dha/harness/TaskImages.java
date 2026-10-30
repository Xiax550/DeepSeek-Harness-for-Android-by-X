package com.dha.harness;

import android.os.Environment;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;

import java.io.File;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Tracks image files written by task-time screencap commands and `ui screenshot`. */
final class TaskImages {
    private static final String KEY = "taskTemporaryImages";
    private static final long CLEANUP_DELAY_MS = 2000;
    private static final long LATE_REGISTRATION_GRACE_MS = 10_000;
    private static final Set<String> ACTIVE = new HashSet<>();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final Runnable CLEANUP = TaskImages::cleanup;
    private static long acceptUntil;
    private static int cleanupAttempts;

    private TaskImages() {
    }

    /** File state before a shell command, used to prove the command changed it. */
    static final class Snapshot {
        final String path;
        final boolean existed;
        final long size;
        final long modified;

        Snapshot(String path, File file) {
            this.path = path;
            this.existed = file.exists();
            this.size = existed ? file.length() : -1;
            this.modified = existed ? file.lastModified() : -1;
        }

        boolean changed(File file) {
            if (!file.exists()) return false;
            return !existed || file.length() != size || file.lastModified() != modified;
        }
    }

    static synchronized void begin(String sessionId) {
        MAIN.removeCallbacks(CLEANUP);
        acceptUntil = 0;
        cleanupAttempts = 0;
        ACTIVE.add(sessionId == null || sessionId.isEmpty() ? "unknown" : sessionId);
    }

    static synchronized void end(String sessionId) {
        ACTIVE.remove(sessionId == null || sessionId.isEmpty() ? "unknown" : sessionId);
        if (!ACTIVE.isEmpty()) return;
        acceptUntil = System.currentTimeMillis() + LATE_REGISTRATION_GRACE_MS;
        scheduleCleanupIfIdle();
    }

    private static void scheduleCleanupIfIdle() {
        if (!ACTIVE.isEmpty()) return;
        MAIN.removeCallbacks(CLEANUP);
        MAIN.postDelayed(CLEANUP, CLEANUP_DELAY_MS);
    }

    static synchronized List<Snapshot> prepareCommand(String command) {
        List<Snapshot> snapshots = new ArrayList<>();
        if (ACTIVE.isEmpty()
                && System.currentTimeMillis() > acceptUntil) return snapshots;
        for (String path : ScreenshotPaths.fromCommand(command)) {
            File file = hostFile(path);
            if (file != null) snapshots.add(new Snapshot(path, file));
        }
        return snapshots;
    }

    /**
     * Register only files the command created or changed. Reusing a screenshot
     * path is common; skipping every path that already existed leaked the new
     * image and was the regression this snapshot check fixes.
     */
    static synchronized void completeCommand(List<Snapshot> snapshots) {
        if (snapshots == null || snapshots.isEmpty()) return;
        Set<String> pending = pending();
        List<String> added = new ArrayList<>();
        for (Snapshot snapshot : snapshots) {
            File file = hostFile(snapshot.path);
            if (file == null || !snapshot.changed(file)) continue;
            if (pending.add(snapshot.path)) added.add(snapshot.path);
        }
        if (added.isEmpty()) return;
        cleanupAttempts = 0;
        save(pending);
        App.log("task images: tracking " + added);
        scheduleCleanupIfIdle();
    }

    static synchronized int pendingCount() {
        return pending().size();
    }

    static synchronized void sweepOrphans() {
        acceptUntil = 0;
        cleanupAttempts = 0;
        if (!pending().isEmpty()) {
            MAIN.removeCallbacks(CLEANUP);
            MAIN.postDelayed(CLEANUP, 1000);
        }
    }

    /**
     * Register a screenshot written by the guest-side ui helper. The file already
     * exists when this is called, so existence is not a reason to skip it.
     */
    static synchronized boolean notePath(String path) {
        if (path == null) return false;
        if (ACTIVE.isEmpty()
                && System.currentTimeMillis() > acceptUntil) return false;
        String normalized = ScreenshotPaths.normalize(path.trim());
        if (!normalized.startsWith("/sdcard/")) return false;
        if (hostFile(normalized) == null) return false;
        Set<String> pending = pending();
        if (!pending.add(normalized)) return true;
        cleanupAttempts = 0;
        save(pending);
        App.log("task images: tracking " + normalized);
        scheduleCleanupIfIdle();
        return true;
    }

    static synchronized boolean active() {
        return !ACTIVE.isEmpty();
    }

    private static void cleanup() {
        Set<String> paths;
        synchronized (TaskImages.class) {
            if (!ACTIVE.isEmpty()) return;
            paths = pending();
        }
        Set<String> remain = new HashSet<>();
        Set<String> resolvedPaths = new HashSet<>();
        int deleted = 0;
        for (String path : paths) {
            File file = hostFile(path);
            if (file == null) continue;
            if (!file.exists()) {
                resolvedPaths.add(path);
                continue;
            }
            if (file.delete()) {
                deleted++;
                resolvedPaths.add(path);
            } else {
                remain.add(path);
            }
        }
        synchronized (TaskImages.class) {
            // A command can finish just after turn/end and add a path while the
            // files above are being removed. Merge with the latest set so that
            // late bookkeeping is not overwritten by this cleanup pass.
            Set<String> latest = pending();
            latest.removeAll(resolvedPaths);
            latest.addAll(remain);
            save(latest);
            if (remain.isEmpty()) {
                cleanupAttempts = 0;
            } else if (cleanupAttempts < 5) {
                cleanupAttempts++;
                MAIN.removeCallbacks(CLEANUP);
                MAIN.postDelayed(CLEANUP, 3000);
            }
        }
        if (deleted > 0 || !remain.isEmpty()) {
            App.log("task images: cleanup deleted=" + deleted + " remaining=" + remain.size());
        }
    }

    private static File hostFile(String path) {
        try {
            String external = Environment.getExternalStorageDirectory().getCanonicalPath();
            String candidate = path.startsWith("/sdcard/")
                    ? external + path.substring("/sdcard".length())
                    : path;
            File file = new File(candidate).getCanonicalFile();
            String parent = file.getParentFile() == null
                    ? "" : file.getParentFile().getCanonicalPath();
            if (!parent.equals(external) && !parent.startsWith(external + File.separator)) return null;
            return file;
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static Set<String> pending() {
        Set<String> out = new HashSet<>();
        try {
            JSONArray array = new JSONArray(App.i().prefs.getString(KEY, "[]"));
            for (int i = 0; i < array.length(); i++) out.add(array.getString(i));
        } catch (Throwable ignored) {
        }
        return out;
    }

    private static void save(Set<String> paths) {
        JSONArray array = new JSONArray();
        for (String path : paths) array.put(path);
        // Persist synchronously: the app may be force-stopped immediately after
        // a screenshot note, and the next launch must still know what to sweep.
        if (!App.i().prefs.edit().putString(KEY, array.toString()).commit()) {
            App.log("task images: failed to persist cleanup list");
        }
    }
}

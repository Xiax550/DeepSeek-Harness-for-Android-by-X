package com.dha.harness;

import org.json.JSONObject;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Intent;
import java.util.concurrent.atomic.AtomicBoolean;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Update check, two channels.
 *
 *   app  the shell — a new APK has to be installed
 *   hot  plugins, skills, prompt, guest scripts — applied in place
 *
 * The manifest lives in a repository (update.json, generated at build time), so there is no
 * service to run: publishing a release with two assets is the whole deployment story.
 * Fetched here rather than from the page because the app has no origin restrictions to
 * satisfy and a failure mode the UI can report.
 *
 * Checks this fork's manifest, never the upstream application's release feed.
 */
final class Updates {

    /** Preference holding the user's own manifest URL; empty means "not configured". */
    static final String PREF_URL = "updateManifestUrl";
    static final String DEFAULT_URL = "https://raw.githubusercontent.com/Xiax550/DeepSeek-Harness-for-Android-by-X/main/update.json";
    static final String BACKUP_URL = "https://api.github.com/repos/Xiax550/DeepSeek-Harness-for-Android-by-X/contents/update.json?ref=main";
    static final int JOB_ID = 0x444855;
    private static final AtomicBoolean BUSY = new AtomicBoolean();

    private Updates() {
    }

    /** The configured manifest URL, or null when the user has not set one. */
    static String configuredUrl() {
        String value = App.i().prefs.getString(PREF_URL, "");
        if (value == null) return DEFAULT_URL;
        value = value.trim();
        return value.isEmpty() ? DEFAULT_URL : value;
    }

    static void setConfiguredUrl(String url) {
        String value = url == null ? "" : url.trim();
        App.i().prefs.edit().putString(PREF_URL, value).apply();
    }

    static JSONObject check(String url) {
        JSONObject answer = new JSONObject();
        HttpURLConnection connection = null;
        try {
            String target = url == null || url.isEmpty() ? configuredUrl() : url;
            if (target == null) {
                answer.put("ok", false);
                answer.put("notConfigured", true);
                answer.put("error", "未配置更新源（本分支不跟随上游，避免装到签名不一致的包）");
                return answer;
            }
            if (!target.startsWith("https://")) {
                answer.put("ok", false);
                answer.put("error", "只接受 https 地址");
                return answer;
            }
            connection = (HttpURLConnection) new URL(target).openConnection();
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(15000);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("User-Agent", "DHA/" + BuildInfo.APP_VERSION);
            connection.setRequestProperty("Accept", "application/vnd.github.raw+json");
            int code = connection.getResponseCode();
            if (code != 200) {
                if (DEFAULT_URL.equals(target)) return check(BACKUP_URL);
                answer.put("ok", false);
                answer.put("error", "HTTP " + code + "（检查网络或代理）");
                return answer;
            }
            String body;
            try (InputStream in = connection.getInputStream()) {
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                byte[] chunk = new byte[8192];
                int read;
                while ((read = in.read(chunk)) > 0) {
                    buffer.write(chunk, 0, read);
                    if (buffer.size() > (1 << 20)) throw new java.io.IOException("更新清单过大");
                }
                body = buffer.toString("UTF-8");
            }
            JSONObject manifest = new JSONObject(body);
            answer.put("ok", true);
            answer.put("source", target);
            answer.put("installedAppVersion", App.appVersion());
            answer.put("installedAppVersionCode", App.appVersionCode());
            answer.put("installedHotVersion", Payload.hotVersion());
            answer.put("packagedHotVersion", Payload.packagedHotVersion());
            answer.put("app", manifest.optJSONObject("app"));
            answer.put("hot", manifest.optJSONObject("hot"));
            answer.put("terminal", manifest.optJSONObject("terminal"));
            if (manifest.optJSONObject("app") == null || manifest.getJSONObject("app").optLong("versionCode", 0) <= 0)
                throw new java.io.IOException("更新清单缺少有效版本号");
        } catch (Throwable error) {
            App.log("update check failed: " + error);
            String target = url == null || url.isEmpty() ? configuredUrl() : url;
            if (DEFAULT_URL.equals(target)) {
                if (connection != null) connection.disconnect();
                return check(BACKUP_URL);
            }
            try {
                answer.put("ok", false);
                answer.put("error", String.valueOf(error.getMessage()));
            } catch (Throwable ignored) {
            }
        } finally {
            if (connection != null) connection.disconnect();
        }
        return answer;
    }

    static void schedule(boolean replace) {
        try {
            JobScheduler scheduler = App.i().getSystemService(JobScheduler.class);
            if (scheduler == null || (!replace && scheduler.getPendingJob(JOB_ID) != null)) return;
            long delay = UpdatePolicy.nextCheck(System.currentTimeMillis()) - System.currentTimeMillis();
            int result = scheduler.schedule(new JobInfo.Builder(JOB_ID,
                    new ComponentName(App.i(), UpdateJobService.class))
                    .setMinimumLatency(Math.max(1000, delay))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true).build());
            App.log("update schedule result=" + result + " delayMs=" + delay);
        } catch (Throwable error) { App.log("update schedule failed: " + error); }
    }

    static JSONObject status() {
        JSONObject result = new JSONObject();
        try {
            result.put("ok", true);
            result.put("source", configuredUrl());
            result.put("lastAttempt", App.i().prefs.getLong("updateLastAttempt", 0));
            result.put("lastSuccess", App.i().prefs.getLong("updateLastSuccess", 0));
            result.put("reason", App.i().prefs.getString("updateLastReason", ""));
            result.put("result", new JSONObject(App.i().prefs.getString("updateResult", "{}")));
            result.put("checking", BUSY.get());
        } catch (Throwable ignored) { }
        return result;
    }

    static void automatic(String reason, Runnable finished) {
        long now = System.currentTimeMillis();
        long last = App.i().prefs.getLong("updateLastAttempt", 0);
        boolean success = App.i().prefs.getLong("updateLastSuccess", 0) >= last;
        if ((!"night".equals(reason) && !UpdatePolicy.shouldCheck(now, last, success)) || !BUSY.compareAndSet(false, true)) {
            if (finished != null) finished.run();
            return;
        }
        App.i().prefs.edit().putLong("updateLastAttempt", now).putString("updateLastReason", reason).apply();
        new Thread(() -> {
            try {
                JSONObject result = check("");
                android.content.SharedPreferences.Editor editor = App.i().prefs.edit().putString("updateResult", result.toString());
                if (result.optBoolean("ok")) editor.putLong("updateLastSuccess", System.currentTimeMillis());
                editor.apply();
                App.log("update automatic reason=" + reason + " ok=" + result.optBoolean("ok")
                        + " remote=" + result.optJSONObject("app"));
                if (result.optBoolean("ok")) notifyAvailable(result);
            } catch (Throwable error) { App.log("update automatic failed: " + error); }
            finally {
                BUSY.set(false);
                if (finished != null) finished.run();
            }
        }, "dha-update-check").start();
    }

    private static void notifyAvailable(JSONObject result) throws Exception {
        JSONObject app = result.optJSONObject("app"), hot = result.optJSONObject("hot");
        String version = app != null && app.optLong("versionCode") > App.appVersionCode()
                ? app.optString("version") : "";
        String current = Payload.hotVersion();
        if (current == null || current.isEmpty()) current = Payload.packagedHotVersion();
        if (version.isEmpty() && hot != null && current != null
                && UpdatePolicy.newerHot(hot.optString("version"), current)) version = hot.optString("version");
        NotificationManager manager = App.i().getSystemService(NotificationManager.class);
        if (manager == null) return;
        if (version.isEmpty()) { manager.cancel(JOB_ID); return; }
        if (version.equals(App.i().prefs.getString("updateNotified", "")) || !manager.areNotificationsEnabled()) return;
        manager.createNotificationChannel(new NotificationChannel("dha-updates", "版本更新", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(App.i(), JOB_ID, new Intent(App.i(), MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        manager.notify(JOB_ID, new Notification.Builder(App.i(), "dha-updates")
                .setSmallIcon(R.drawable.ic_dha_notification).setContentTitle("DHA 有新版本 " + version)
                .setContentText("请在设置中的版本更新查看，确认后安装")
                .setContentIntent(open).setAutoCancel(true).setOnlyAlertOnce(true).build());
        App.i().prefs.edit().putString("updateNotified", version).apply();
    }
}

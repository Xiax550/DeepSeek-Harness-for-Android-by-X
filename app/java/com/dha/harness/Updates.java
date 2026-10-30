package com.dha.harness;

import org.json.JSONObject;

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
 * NOTE ON THE DEFAULT: upstream points at its own repository, and this fork must NOT inherit
 * that URL — checking it would report the *upstream* version as an available update and offer
 * to install an APK signed with a different key, which Android refuses (and which would look
 * like a broken download). There is also no release feed for this fork, so the default is
 * empty: the check reports "not configured" instead of failing with a confusing HTTP error.
 * A user who publishes their own build can point this at their own update.json.
 */
final class Updates {

    /** Preference holding the user's own manifest URL; empty means "not configured". */
    static final String PREF_URL = "updateManifestUrl";

    private Updates() {
    }

    /** The configured manifest URL, or null when the user has not set one. */
    static String configuredUrl() {
        String value = App.i().prefs.getString(PREF_URL, "");
        if (value == null) return null;
        value = value.trim();
        return value.isEmpty() ? null : value;
    }

    static void setConfiguredUrl(String url) {
        String value = url == null ? "" : url.trim();
        App.i().prefs.edit().putString(PREF_URL, value).apply();
    }

    static JSONObject check(String url) {
        JSONObject answer = new JSONObject();
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
            HttpURLConnection connection = (HttpURLConnection) new URL(target).openConnection();
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(15000);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("User-Agent", "DHA/" + BuildInfo.APP_VERSION);
            int code = connection.getResponseCode();
            if (code != 200) {
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
                    if (buffer.size() > (1 << 20)) break;
                }
                body = buffer.toString("UTF-8");
            }
            JSONObject manifest = new JSONObject(body);
            answer.put("ok", true);
            answer.put("installedAppVersion", App.appVersion());
            answer.put("installedAppVersionCode", App.appVersionCode());
            answer.put("installedHotVersion", Payload.hotVersion());
            answer.put("packagedHotVersion", Payload.packagedHotVersion());
            answer.put("app", manifest.optJSONObject("app"));
            answer.put("hot", manifest.optJSONObject("hot"));
        } catch (Throwable error) {
            App.log("update check failed: " + error);
            try {
                answer.put("ok", false);
                answer.put("error", String.valueOf(error.getMessage()));
            } catch (Throwable ignored) {
            }
        }
        return answer;
    }
}

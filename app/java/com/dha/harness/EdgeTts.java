package com.dha.harness;

import android.content.Context;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/** Microsoft Edge Read Aloud voices over the public Edge speech websocket. */
final class EdgeTts {
    static final String PREF_ENABLED = "edgeTtsEnabled";
    private static final String TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    private static final String VOICE = "zh-CN-XiaoxiaoNeural";
    private static final String SEC_MS_GEC_VERSION = "2-143.0.3650.75";
    private static final String URL = "wss://speech.platform.bing.com/consumer/speech/"
            + "synthesize/readaloud/edge/v1?TrustedClientToken=" + TOKEN;
    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
            .connectTimeout(20, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(45, java.util.concurrent.TimeUnit.SECONDS)
            .build();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private static WebSocket socket;
    private static MediaPlayer player;
    private static ByteArrayOutputStream audio;
    private static long generation;
    private static String lastCue = "";
    private static long lastCueAt;

    private EdgeTts() {
    }

    static boolean enabled() {
        return App.i().prefs.getBoolean(PREF_ENABLED, false);
    }

    static void setEnabled(boolean enabled) {
        App.i().prefs.edit().putBoolean(PREF_ENABLED, enabled).apply();
        if (!enabled) stop();
    }

    static void speak(Context context, String text) {
        String clean = text == null ? "" : text.trim();
        if (clean.isEmpty()) return;
        if (clean.length() > 1200) clean = clean.substring(0, 1200);
        stop();
        final long requestGeneration = ++generation;
        final Context app = context.getApplicationContext();
        audio = new ByteArrayOutputStream();
        Request request = new Request.Builder()
                .url(URL
                        + "&ConnectionId=" + UUID.randomUUID().toString().replace("-", "")
                        + "&Sec-MS-GEC=" + EdgeToken.current()
                        + "&Sec-MS-GEC-Version=" + SEC_MS_GEC_VERSION)
                .header("Pragma", "no-cache")
                .header("Cache-Control", "no-cache")
                .header("Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold")
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        + "AppleWebKit/537.36 (KHTML, like Gecko) "
                        + "Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0")
                .header("Cookie", "muid="
                        + UUID.randomUUID().toString().replace("-", "").toUpperCase(Locale.US) + ";")
                .header("Sec-MS-GEC", EdgeToken.current())
                .header("Sec-MS-GEC-Version", SEC_MS_GEC_VERSION)
                .build();
        final String requestId = UUID.randomUUID().toString().replace("-", "");
        final String ssml = ssml(clean);
        socket = CLIENT.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                if (requestGeneration != generation) return;
                webSocket.send(configMessage());
                webSocket.send(ssmlMessage(requestId, ssml));
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                if (requestGeneration != generation) return;
                if (text.contains("Path:turn.end")) {
                    webSocket.close(1000, "done");
                    playAudio(app, requestGeneration);
                }
            }

            @Override
            public void onMessage(WebSocket webSocket, ByteString bytes) {
                if (requestGeneration != generation || audio == null) return;
                byte[] data = bytes.toByteArray();
                if (data.length < 2) return;
                int headerLength = ((data[0] & 0xff) << 8) | (data[1] & 0xff);
                if (headerLength <= 0 || data.length < headerLength + 2) return;
                String header = new String(data, 2, headerLength, StandardCharsets.UTF_8);
                if (header.contains("Path:audio")) {
                    audio.write(data, headerLength + 2, data.length - headerLength - 2);
                }
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable error, Response response) {
                App.log("edge tts failed: " + error + " status="
                        + (response == null ? 0 : response.code()));
            }
        });
    }

    /**
     * Speak a short event cue, never an arbitrary progress line.
     *
     * Tool steps can be long and noisy. The useful hands-free information is
     * that a turn finished, failed, stopped, or needs the user's confirmation.
     */
    static synchronized void announce(Context context, String cue) {
        if (!enabled() || cue == null || cue.isEmpty()) return;
        long now = android.os.SystemClock.elapsedRealtime();
        if (cue.equals(lastCue) && now - lastCueAt < 3000) return;
        String text;
        switch (cue) {
            case "complete":
                text = "任务已完成";
                break;
            case "interrupted":
                text = "任务已中断";
                break;
            case "error":
                text = "任务执行失败";
                break;
            case "permission":
            case "approval":
                text = "任务需要你确认授权";
                break;
            case "question":
                text = "需要你做出选择";
                break;
            default:
                return;
        }
        lastCue = cue;
        lastCueAt = now;
        speak(context, text);
    }

    static void stop() {
        generation++;
        WebSocket current = socket;
        socket = null;
        if (current != null) current.cancel();
        MediaPlayer currentPlayer = player;
        player = null;
        if (currentPlayer != null) {
            runCatching(currentPlayer::stop);
            currentPlayer.release();
        }
        audio = null;
    }

    static String testText() {
        return "你好，我是 DHA。Edge 在线语音朗读已经启用。";
    }

    private static void playAudio(Context context, long requestGeneration) {
        final byte[] data = audio == null ? new byte[0] : audio.toByteArray();
        if (data.length == 0 || requestGeneration != generation) return;
        MAIN.post(() -> {
            if (requestGeneration != generation) return;
            try {
                File file = new File(context.getCacheDir(), "edge-read-aloud.mp3");
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(data);
                }
                MediaPlayer next = new MediaPlayer();
                next.setDataSource(file.getAbsolutePath());
                next.setOnPreparedListener(media -> {
                    if (requestGeneration != generation) {
                        media.release();
                        return;
                    }
                    player = media;
                    media.start();
                });
                next.setOnCompletionListener(media -> {
                    media.release();
                    if (player == media) player = null;
                });
                next.setOnErrorListener((media, what, extra) -> {
                    App.log("edge tts playback error: " + what + "/" + extra);
                    media.release();
                    if (player == media) player = null;
                    return true;
                });
                next.prepareAsync();
            } catch (Throwable error) {
                App.log("edge tts write failed: " + error);
            }
        });
    }

    private static String configMessage() {
        String body = "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{"
                + "\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"},"
                + "\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}";
        return "X-Timestamp:" + timestamp() + "\r\n"
                + "Content-Type:application/json; charset=utf-8\r\n"
                + "Path:speech.config\r\n\r\n" + body;
    }

    private static String ssmlMessage(String requestId, String ssml) {
        return "X-RequestId:" + requestId + "\r\n"
                + "Content-Type:application/ssml+xml\r\n"
                + "X-Timestamp:" + timestamp() + "Z\r\n"
                + "Path:ssml\r\n\r\n" + ssml;
    }

    private static String ssml(String text) {
        String escaped = text.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;")
                .replace("'", "&apos;");
        return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>"
                + "<voice name='" + VOICE + "'>"
                + "<prosody rate='0%' pitch='0Hz'>" + escaped + "</prosody>"
                + "</voice></speak>";
    }

    private static String timestamp() {
        SimpleDateFormat date = new SimpleDateFormat(
                "EEE MMM dd yyyy HH:mm:ss 'GMT+0000 (Coordinated Universal Time)'",
                Locale.US);
        date.setTimeZone(TimeZone.getTimeZone("UTC"));
        return date.format(new Date());
    }

    private static void runCatching(Runnable action) {
        try {
            action.run();
        } catch (Throwable ignored) {
        }
    }
}

package com.dha.harness;

import android.content.Context;
import android.graphics.Rect;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The app's control bridge: a loopback HTTP/JSON service that the harness Web UI
 * (and, through it, the agent) uses to drive the sandbox.
 *
 * It exists because the Web UI is *inside* a WebView looking at the harness on a
 * different port, and because the things the settings page must do — start and
 * stop the PRoot process, install a distro from the phone's storage, ask
 * Shizuku for privileged execution — are app-side capabilities a web page
 * cannot reach on its own.
 *
 *   GET  /snapshot                     everything the settings page polls
 *   POST /theme                     {"dark": true|false}
 *   POST /server/start|stop|restart
 *   POST /open-in-browser
 *   POST /import
 *   POST /distros/select|delete|command
 *   POST /settings
 *   POST /log/clear
 *   POST /shizuku/request|exec
 *   POST /task/images/begin|end
 *   POST /task/awake/begin|end
 *
 * Security: 127.0.0.1 only, and every request carries the per-boot token the
 * app also injects into the WebView. Without it, another app on the phone could
 * reach in and get a shell in the sandbox.
 */
public final class BridgeServer {

    public interface Host {
        void onImportRequested();

        void onPickMountFolderRequested();

        void onOpenUrlRequested(String url);

        void onOpenInBrowser();

        void onShizukuPermissionRequested();

        /** Open the file picker so the user can apply a hot package by hand. */
        void onHotPickRequested();

        /**
         * Which palette the page is painting (see `POST /theme`).
         *
         * The window's bars and its own background belong to Android, and its theme
         * follows the *phone's* dark mode - which can disagree with the harness. The
         * page is the only place that knows the harness theme, so it pushes it here.
         */
        void onThemeReported(boolean dark, String background, float alpha);

        /** The window-chrome choice changed in the settings page; repaint the window. */
        void onChromeModeChanged();

        /** Open the file picker for the floating ball's picture. */
        void onBallImageRequested();

        /**
         * One of the grants the phone-assistant feature needs (see
         * {@link Assist#PERMISSION_ACCESSIBILITY} and friends). The activity owns
         * the system settings pages and the runtime-permission dialogs; the
         * bridge only names what is missing.
         */
        void onAssistPermission(int which);

        /**
         * A light tap under the finger for a Web-UI control (the terminal's key
         * row). The activity turns this into the platform's own
         * `HapticFeedbackConstants.KEYBOARD_TAP`, so it follows the user's
         * touch-feedback setting instead of buzzing unconditionally. Defaulted to
         * a no-op so an older host implementation still compiles.
         */
        default void onHapticTap() {
        }
    }

    private static ServerSocket server;
    private static Thread thread;
    private static volatile boolean running;
    private static String token = "";
    private static Host host;

    private BridgeServer() {
    }

    public static String token() {
        return token;
    }

    public static int port() {
        return App.i().bridgePort();
    }

    public static synchronized void start(Host callback) {
        host = callback;
        if (running) return;
        token = App.i().ensureBridgeToken();
        final int port = port();
        thread = new Thread(() -> {
            try {
                server = new ServerSocket(port, 16, InetAddress.getByName("127.0.0.1"));
                running = true;
                App.log("bridge: listening on 127.0.0.1:" + port);
                while (running) {
                    Socket socket = server.accept();
                    Thread worker = new Thread(() -> handle(socket), "bridge-request");
                    worker.setDaemon(true);
                    worker.start();
                }
            } catch (IOException error) {
                App.log("bridge: stopped: " + error);
            } finally {
                running = false;
            }
        }, "bridge-server");
        thread.setDaemon(true);
        thread.start();
    }

    public static synchronized void stop() {
        running = false;
        if (server != null) {
            try {
                server.close();
            } catch (IOException ignored) {
            }
            server = null;
        }
    }

    // ------------------------------------------------------------------ request

    private static void handle(Socket socket) {
        try (Socket client = socket;
             InputStream rawIn = new BufferedInputStream(client.getInputStream());
             OutputStream out = new BufferedOutputStream(client.getOutputStream())) {
            String requestLine = readLine(rawIn);
            if (requestLine == null) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0];
            String path = parts[1];
            // A CSS url() cannot carry the X-Dsh-Token header, so the one endpoint that
            // serves bytes to the page (/background) also accepts ?token=.
            String queryToken = null;
            int query = path.indexOf('?');
            if (query >= 0) {
                String queryString = path.substring(query + 1);
                path = path.substring(0, query);
                for (String pair : queryString.split("&")) {
                    int equals = pair.indexOf('=');
                    if (equals > 0 && "token".equals(pair.substring(0, equals))) {
                        queryToken = android.net.Uri.decode(pair.substring(equals + 1));
                    }
                }
            }

            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = readLine(rawIn)) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0) {
                    headers.put(line.substring(0, colon).trim().toLowerCase(), line.substring(colon + 1).trim());
                }
            }
            int length = 0;
            try {
                length = Integer.parseInt(headers.getOrDefault("content-length", "0"));
            } catch (NumberFormatException ignored) {
            }
            String body = "";
            if (length > 0) {
                // Screenshot and attachment payloads are several times larger than
                // ordinary JSON controls. Keep a hard bound, but read the whole
                // request instead of truncating valid JSON.
                if (length > 16 << 20) {
                    respondJson(out, 413, error("请求内容超过 16 MB"));
                    return;
                }
                byte[] buffer = new byte[length];
                int read = 0;
                while (read < buffer.length) {
                    int got = rawIn.read(buffer, read, buffer.length - read);
                    if (got < 0) break;
                    read += got;
                }
                body = new String(buffer, 0, read, StandardCharsets.UTF_8);
            }

            if ("OPTIONS".equals(method)) {
                respond(out, 204, "");
                return;
            }
            if (!token.equals(headers.get("x-dsh-token")) && !token.equals(queryToken)) {
                respondJson(out, 401, error("unauthorized"));
                return;
            }
            route(out, method, path, body);
        } catch (Throwable error) {
            App.log("bridge: request failed: " + error);
        }
    }

    private static void route(OutputStream out, String method, String path, String body) throws IOException {
        JSONObject request = new JSONObject();
        if (!body.isEmpty()) {
            try {
                request = new JSONObject(body);
            } catch (Throwable ignored) {
            }
        }
        String query = "";
        int q = path.indexOf('?');
        if (q >= 0) {
            query = path.substring(q + 1);
            path = path.substring(0, q);
        }

        try {
            handle(path, request, out, host);
        } catch (Throwable error) {
            // Assist throws IllegalStateException for every "the user has not
            // enabled this yet" case; the message is already written for them.
            try {
                respondJson(out, 200, error(String.valueOf(error.getMessage())));
            } catch (Exception ignored) {
            }
        }
    }

    /**
     * Stop the sandbox and bring it back up.
     *
     * ServerBus asks the old PRoot tree to exit and escalates to a forced kill
     * after 1.5 s. Start only after that window: the old 800 ms delay could race
     * the kill, leave a duplicate guest alive, and silently move the new server
     * from 3080 to 3081.
     */
    private static void restartServer() {
        ServerBus.stop();
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(
                () -> DshService.ensure(App.i()), 2500);
    }

    /** Screen size, so a caller can aim a swipe without guessing the panel size. */
    private static String screenSize() {
        try {
            android.hardware.display.DisplayManager manager =
                    (android.hardware.display.DisplayManager) App.i()
                            .getSystemService(Context.DISPLAY_SERVICE);
            int displayId = VirtualDisplayController.displayId();
            if (displayId <= 0) displayId = android.view.Display.DEFAULT_DISPLAY;
            android.view.Display display = manager == null
                    ? null : manager.getDisplay(displayId);
            if (display != null) {
                android.graphics.Point size = new android.graphics.Point();
                display.getRealSize(size);
                if (size.x > 0 && size.y > 0) return size.x + "x" + size.y;
            }
        } catch (Throwable ignored) {
        }
        android.util.DisplayMetrics metrics = App.i().getResources().getDisplayMetrics();
        return metrics.widthPixels + "x" + metrics.heightPixels;
    }

    private static void handle(String path, JSONObject request, OutputStream out, Host host)
            throws Exception {
        switch (path) {
            case "/background": {
                // The user's chosen background image. Served over HTTP rather than handed to
                // the page as a file:// URL: the page's origin is http://127.0.0.1, so a
                // file:// subresource is blocked by the WebView's origin rules.
                byte[] image = backgroundBytes();
                if (image == null) {
                    respondJson(out, 404, error("未设置背景图片"));
                    return;
                }
                respondBytes(out, image, backgroundMime(image));
                return;
            }
            case "/snapshot":
                respondJson(out, 200, snapshot());
                return;
            case "/theme":
                // The page's palette, so the window can paint its bars and its own
                // background to match it. Fire-and-forget: the app remembers the last
                // value and re-applies it on every load, so a lost report is corrected
                // by the next one instead of leaving white edges behind.
                // `bg` is the page's own background colour (#rrggbb); it is what the
                // bars are filled with, so they match the page instead of our guess.
                String background = request.optString("bg", "");
                if (!background.matches("^#[0-9a-fA-F]{6}$")) background = null;
                // `alpha` is how opaque the page paints its own scrim; the bars copy it so
                // the top, middle and bottom read as one surface.
                float alpha = (float) request.optDouble("alpha", 1);
                if (!(alpha > 0) || alpha > 1) alpha = 1f;
                host.onThemeReported(request.optBoolean("dark", false), background, alpha);
                respondJson(out, 200, ok("主题已同步"));
                return;
            case "/appearance/theme": {
                if (request.has("preference")) {
                    String preference = request.optString("preference", "system");
                    if (!"light".equals(preference)
                            && !"dark".equals(preference)
                            && !"system".equals(preference)) {
                        respondJson(out, 400, error("未知外观模式"));
                        return;
                    }
                    Appearance.setMode(preference);
                }
                JSONObject answer = ok("外观模式已保存");
                answer.put("preference", Appearance.mode());
                respondJson(out, 200, answer);
                return;
            }
            case "/tts/speak": {
                String text = request.optString("text", EdgeTts.testText());
                EdgeTts.speak(App.i(), text);
                respondJson(out, 200, ok("正在使用 Edge 语音朗读"));
                return;
            }
            case "/tts/stop":
                EdgeTts.stop();
                respondJson(out, 200, ok("已停止朗读"));
                return;
            case "/haptic":
                // Fire-and-forget feedback for a Web-UI control: the terminal's key
                // row sends this on every press and debounces it on the page, so the
                // answer carries no state and a missed tick is invisible.
                host.onHapticTap();
                respondJson(out, 200, ok("已反馈"));
                return;
            case "/server/start":
                DshService.ensure(App.i());
                respondJson(out, 200, ok("已请求启动"));
                return;
            case "/server/stop":
                DshService.stopServer(App.i());
                respondJson(out, 200, ok("已停止"));
                return;
            case "/server/restart":
                restartServer();
                respondJson(out, 200, ok("正在重启"));
                return;
            case "/sandbox/repair": {
                if (Recovery.active()) {
                    respondJson(out, 409, error("恢复模式下不能执行完整沙箱修复"));
                    return;
                }
                String command = "set -e; "
                        + "node /opt/dsh/android/repair-dsh.mjs /opt/dsh/node_modules; "
                        + "node /opt/dsh/android/repair-profile.mjs "
                        + "/opt/dsh/dsh-home-seed /root; "
                        + "test -f /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js; "
                        + "test -f /opt/dsh/node_modules/@deepseek-ai/dsh-permission-presets/package.json; "
                        + "test -f /opt/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml; "
                        + "test -f /root/.dsh/profiles/web/cordis.patch.yml; "
                        + "echo sandbox-repair-ok";
                Proot.Result result = Proot.exec(App.i(), java.util.Collections.emptyList(),
                        command, 120000);
                JSONObject answer = new JSONObject();
                try {
                    answer.put("ok", result.exitCode == 0);
                    answer.put("message", result.exitCode == 0
                            ? "沙箱组件已修复，正在重启"
                            : "沙箱修复失败");
                    answer.put("output", result.stdout.trim());
                    answer.put("error", result.stderr.trim());
                } catch (Throwable ignored) {
                }
                respondJson(out, 200, answer);
                if (result.exitCode == 0) {
                    new android.os.Handler(android.os.Looper.getMainLooper())
                            .postDelayed(BridgeServer::restartServer, 800);
                }
                return;
            }
            case "/recovery/status":
                respondJson(out, 200, Recovery.status());
                return;
            case "/recovery/start": {
                // Entering recovery is a restart: the guest's entry point (and so
                // whether sshd exists at all) is decided when the PRoot process
                // starts, not after.
                if (request.has("port")) Recovery.setPort(request.optInt("port", Recovery.port()));
                if (request.has("auto")) Recovery.setAuto(request.optBoolean("auto", Recovery.auto()));
                Recovery.enter("桥请求");
                restartServer();
                JSONObject answer = Recovery.status();
                answer.put("ok", true);
                answer.put("message", "已进入恢复模式，正在启动 sshd");
                respondJson(out, 200, answer);
                return;
            }
            case "/recovery/stop":
                Recovery.exit("桥请求");
                restartServer();
                respondJson(out, 200, ok("已退出恢复模式，正在回到 harness"));
                return;
            case "/recovery/token": {
                String fresh = Recovery.rotateToken();
                JSONObject answer = Recovery.status();
                answer.put("ok", true);
                answer.put("token", fresh);
                answer.put("message", "令牌已换新；重启恢复模式后才生效");
                respondJson(out, 200, answer);
                return;
            }
            case "/open-in-browser":
                if (host != null) host.onOpenInBrowser();
                respondJson(out, 200, ok("已交给系统浏览器"));
                return;
            case "/import":
                if (host != null) host.onImportRequested();
                respondJson(out, 200, ok("请在手机上选择 rootfs 归档"));
                return;
            case "/update/check": {
                respondJson(out, 200, Updates.check(request.optString("url", "")));
                return;
            }
            case "/terminal/fetch": {
                // The slim shell ships without the runtime; this pulls the one
                // published for its terminal version. Idempotent: a second call
                // while a download is running is ignored.
                JSONObject answer = new JSONObject();
                if (Payload.terminalBusy()) {
                    answer.put("ok", true);
                    answer.put("message", "正在下载（" + Payload.terminalProgress() + "）");
                } else if (App.i().isBundledReady()) {
                    answer.put("ok", true);
                    answer.put("message", "运行时已经在位");
                } else {
                    Payload.fetchTerminal(App.i(), request.optString("url", ""),
                            request.optString("manifest", ""));
                    answer.put("ok", true);
                    answer.put("message", "已开始下载，进度看这一行");
                }
                respondJson(out, 200, answer);
                return;
            }
            case "/hot/pick":
                if (host != null) host.onHotPickRequested();
                respondJson(out, 200, ok("请在手机上选择 dsh-hot.zip"));
                return;
            case "/hot/fetch": {
                respondJson(out, 200, Payload.fetchAndApply(App.i(), request.optString("url", "")));
                return;
            }
            case "/open-url": {
                if (host != null) host.onOpenUrlRequested(request.optString("url", ""));
                respondJson(out, 200, ok("已在浏览器打开"));
                return;
            }
            case "/export": {
                respondJson(out, 200, Exports.run(request.optString("path", "")));
                return;
            }
            case "/export/recent":
                respondJson(out, 200, Exports.recent());
                return;
            case "/mounts/test": {
                String id = request.optString("id", "");
                for (Mounts.Mount mount : Mounts.list()) {
                    if (!mount.id.equals(id)) continue;
                    JSONObject answer = new JSONObject();
                    try {
                        answer.put("ok", true);
                        answer.put("problem", mount.problem());
                        answer.put("host", mount.host);
                        answer.put("guest", mount.guest);
                        // Ask the guest itself: the only way to tell a bind that
                        // worked from one that produced an empty directory.
                        String script = "ls -la -- " + shellQuote(mount.guest)
                                + " 2>&1 | head -20; echo '---'; "
                                + "mount | grep -F -- " + shellQuote(mount.guest) + " || true";
                        Proot.Result result = Proot.exec(App.i(),
                                java.util.Collections.emptyList(), script, 30000);
                        answer.put("output", result.stdout.trim());
                        answer.put("exit", result.exitCode);
                    } catch (Throwable error) {
                        try {
                            answer.put("ok", false);
                            answer.put("error", String.valueOf(error.getMessage()));
                        } catch (Throwable ignored) {
                        }
                    }
                    respondJson(out, 200, answer);
                    return;
                }
                respondJson(out, 404, error("没有这条挂载"));
                return;
            }
            case "/mounts/add": {
                try {
                    Mounts.Mount added = Mounts.add(request.optString("host", ""),
                            request.optString("guest", ""));
                    JSONObject answer = ok("已添加挂载");
                    answer.put("mount", added.toJson());
                    answer.put("restartRequired", true);
                    respondJson(out, 200, answer);
                } catch (IllegalArgumentException invalid) {
                    respondJson(out, 400, error(invalid.getMessage()));
                } catch (Throwable failure) {
                    respondJson(out, 500, error("挂载失败：" + failure.getMessage()));
                }
                return;
            }
            case "/mounts/pick":
                if (host != null) host.onPickMountFolderRequested();
                respondJson(out, 200, ok("请在手机上选择文件夹"));
                return;
            case "/mounts/remove": {
                Mounts.remove(request.optString("id", ""));
                JSONObject answer = ok("已移除挂载");
                try {
                    answer.put("restartRequired", true);
                } catch (Throwable ignored) {
                }
                respondJson(out, 200, answer);
                return;
            }
            case "/mounts/toggle":
                Mounts.setEnabled(request.optString("id", ""), request.optBoolean("enabled", true));
                respondJson(out, 200, ok("已更新挂载"));
                return;
            case "/mounts/guest":
                Mounts.setGuestPath(request.optString("id", ""), request.optString("guest", ""));
                respondJson(out, 200, ok("已更新挂载路径"));
                return;
            case "/distros/select": {
                String id = request.optString("id", App.BUNDLED_ID);
                App.i().setActiveDistroId(id);
                respondJson(out, 200, ok("已选中 " + id));
                return;
            }
            case "/distros/delete": {
                String id = request.optString("id", "");
                Distros.remove(id);
                if (id.equals(App.i().activeDistroId())) App.i().setActiveDistroId(App.BUNDLED_ID);
                respondJson(out, 200, ok("已删除 " + id));
                return;
            }
            case "/distros/command": {
                String id = request.optString("id", "");
                Distros.setCommand(id, request.optString("command", ""));
                respondJson(out, 200, ok("命令已保存"));
                return;
            }
            case "/settings": {
                App app = App.i();
                boolean wantsVirtualDisplay = request.has("virtualDisplay")
                        ? request.optBoolean("virtualDisplay", false)
                        : VirtualDisplayController.enabled();
                // Validate a requested virtual display before writing any other
                // preference. A failed Shizuku create used to leave the port, API
                // key and other toggles half-saved even though the request failed.
                if (request.has("virtualDisplay") && wantsVirtualDisplay) {
                    try {
                        VirtualDisplayController.ensureCreated(app);
                    } catch (Throwable error) {
                        respondJson(out, 500, error("虚拟副屏启用失败：" + error.getMessage()));
                        return;
                    }
                }
                android.content.SharedPreferences.Editor editor = app.prefs.edit();
                boolean restartRequired = false;
                if (request.has("port")) {
                    int port = request.optInt("port", app.port());
                    if (port < 1 || port > 65535) {
                        respondJson(out, 400, error("端口必须在 1 到 65535 之间"));
                        return;
                    }
                    editor.putInt("port", port);
                    if (port != app.port()) restartRequired = true;
                }
                if (request.has("apiKey")) {
                    editor.putString("apiKey", request.optString("apiKey", "").trim());
                }
                if (request.has("shareStorage")) {
                    boolean share = request.optBoolean("shareStorage", true);
                    if (share != app.prefs.getBoolean("shareStorage", true)) restartRequired = true;
                    editor.putBoolean("shareStorage", share);
                }
                if (request.has("keepAwake")) editor.putBoolean("keepAwake", request.optBoolean("keepAwake", false));
                if (request.has("autoRestart")) editor.putBoolean("autoRestart", request.optBoolean("autoRestart", true));
                if (request.has("autoRepairAccessibility")) {
                    editor.putBoolean(AccessibilityGuardian.PREF_AUTO_REPAIR,
                            request.optBoolean("autoRepairAccessibility", true));
                }
                if (request.has("edgeTtsEnabled")) {
                    editor.putBoolean(EdgeTts.PREF_ENABLED,
                            request.optBoolean("edgeTtsEnabled", false));
                }
                if (request.has("virtualDisplay")) {
                    editor.putBoolean(VirtualDisplayController.PREF_ENABLED, wantsVirtualDisplay);
                }
                if (request.has("chromeMode")) {
                    String chrome = request.optString("chromeMode", "auto");
                    editor.putString("window_chrome_mode",
                            "acrylic".equals(chrome) || "solid".equals(chrome) ? chrome : "auto");
                }
                if (request.has("inputBackend")) {
                    editor.putString(PhoneInput.PREF_BACKEND, PhoneInput.normalizeMode(
                            request.optString("inputBackend", PhoneInput.MODE_AUTO)));
                }
                editor.apply();
                if (request.has("keepAwake")) DshService.refreshWakeLockSetting();
                if (request.has("edgeTtsEnabled")) {
                    EdgeTts.setEnabled(request.optBoolean("edgeTtsEnabled", false));
                }
                if (request.has("virtualDisplay")) {
                    if (!wantsVirtualDisplay) VirtualDisplayController.release();
                }
                App.log("settings saved: virtualDisplay=" + VirtualDisplayController.enabled()
                        + " edgeTts=" + EdgeTts.enabled()
                        + " keepAwake=" + app.prefs.getBoolean("keepAwake", false));
                if (request.has("chromeMode")) host.onChromeModeChanged();
                JSONObject answer = ok("设置已保存");
                try {
                    if (restartRequired) answer.put("restartRequired", true);
                } catch (Throwable ignored) {
                }
                respondJson(out, 200, answer);
                return;
            }
            case "/log/clear":
                App.i().clearServerLog();
                respondJson(out, 200, ok("日志已清空"));
                return;
            // ---------------------------------------------------------- 手机助手
            // The screen-control surface. Actions use PhoneInput's automatic
            // accessibility / Shizuku selection; `/a11y/request` only grants the
            // optional accessibility half.
            case "/a11y/status": {
                int virtualDisplayId = VirtualDisplayController.ensureIfEnabled(App.i());
                JSONObject answer = new JSONObject();
                answer.put("ok", true);
                answer.put("service", Assist.available());
                answer.put("overlay", Assist.canOverlay(App.i()));
                answer.put("microphone", App.i().checkSelfPermission(
                        android.Manifest.permission.RECORD_AUDIO)
                        == android.content.pm.PackageManager.PERMISSION_GRANTED);
                answer.put("ball", BallService.isRunning());
                answer.put("virtualDisplayEnabled", VirtualDisplayController.enabled());
                answer.put("virtualDisplayActive", virtualDisplayId > 0);
                answer.put("virtualDisplayId", virtualDisplayId);
                answer.put("edgeTtsEnabled", EdgeTts.enabled());
                answer.put("screenAwake", ScreenAwake.active());
                answer.put("screenAwakeRemainingMs", ScreenAwake.remainingMs());
                answer.put("screenAwakeTaskSessions", ScreenAwake.activeTasks());
                answer.put("screenWatchEnabled", App.i().prefs.getBoolean(
                        BallService.PREF_SCREEN_WATCH, false));
                answer.put("screenWatchMinutes", BallService.normalizeWatchMinutes(
                        App.i().prefs.getInt(BallService.PREF_SCREEN_WATCH_MINUTES, 60)));
                answer.put("screenWatchActive", MainActivity.screenWatchActive());
                answer.put("screen", screenSize());
                JSONObject input = PhoneInput.statusJson();
                answer.put("input", input);
                answer.put("inputBackend", input.optString("requested", PhoneInput.MODE_AUTO));
                answer.put("effectiveInputBackend", input.optString("effective", "unavailable"));
                answer.put("adbAvailable", input.optBoolean("adb", false));
                respondJson(out, 200, answer);
                return;
            }
            case "/a11y/screenshot": {
                JSONObject answer = new JSONObject();
                try {
                    List<Rect> observationMasks = request.optBoolean("excludeBall", false)
                            ? BallService.observationMasks() : null;
                    String base64 = Assist.screenshotBase64(observationMasks);
                    byte[] png = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
                    android.graphics.BitmapFactory.Options options =
                            new android.graphics.BitmapFactory.Options();
                    options.inJustDecodeBounds = true;
                    android.graphics.BitmapFactory.decodeByteArray(png, 0, png.length, options);
                    answer.put("ok", true);
                    answer.put("base64", base64);
                    answer.put("width", options.outWidth);
                    answer.put("height", options.outHeight);
                } catch (Throwable error) {
                    answer.put("ok", false);
                    answer.put("error", error.getMessage() == null ? String.valueOf(error) : error.getMessage());
                }
                respondJson(out, 200, answer);
                return;
            }
            case "/a11y/request":
                if (host != null) host.onAssistPermission(Assist.PERMISSION_ACCESSIBILITY);
                respondJson(out, 200, ok("请在「已下载的服务」里开启 DHA 手机助手"));
                return;
            case "/overlay/request":
                if (host != null) host.onAssistPermission(Assist.PERMISSION_OVERLAY);
                respondJson(out, 200, ok("请允许 DHA 显示在其他应用上层"));
                return;
            case "/mic/request":
                if (host != null) host.onAssistPermission(Assist.PERMISSION_MICROPHONE);
                respondJson(out, 200, ok("请允许 DHA 录音"));
                return;
            case "/ball/inbox": {
                // The ball's own conversation. `text` present means "the user just
                // said this"; absent means "what is still waiting". The plugin
                // drains it (see installBallInbox) and acks by id.
                JSONObject answer = new JSONObject();
                if (request.has("text")) {
                    answer.put("id", BallInbox.add(request.optString("text", "")));
                }
                answer.put("ok", true);
                answer.put("items", BallInbox.pending());
                respondJson(out, 200, answer);
                return;
            }
            case "/ball/inbox/ack": {
                BallInbox.ack(request.optJSONArray("ids"));
                JSONObject answer = new JSONObject();
                answer.put("ok", true);
                answer.put("items", BallInbox.pending());
                respondJson(out, 200, answer);
                return;
            }
            case "/ball/state": {
                // The status channel. `phase` present means "this is what I am
                // doing" (the `ball` CLI, or the page); absent means "tell me what
                // the ball is showing", which the page polls so its own fallback
                // stays out of the way.
                JSONObject answer = new JSONObject();
                if (request.has("phase")) {
                    BallService.setState(request.optString("phase", "idle"),
                            request.optString("text", ""), request.optString("cue", ""),
                            request.optString("eventId", ""));
                    answer.put("ok", true);
                }
                answer.put("state", BallService.stateJson());
                respondJson(out, 200, answer);
                return;
            }
            case "/ball/say": {
                // Anything with something to report: the page (which tool is
                // running), a guest script, or the agent itself.
                String text = request.optString("text", "");
                BallService.sayFromOutside(text);
                JSONObject answer = new JSONObject();
                answer.put("ok", true);
                answer.put("shown", BallService.isRunning());
                respondJson(out, 200, answer);
                return;
            }
            case "/ball/config": {
                // Appearance only — size and picture. Everything about how it
                // behaves is code, but this is what makes tweaks to how it looks
                // a hot package away rather than a new shell.
                android.content.SharedPreferences.Editor edit = App.i().prefs.edit();
                if (request.has("size")) {
                    edit.putInt(BallService.PREF_SIZE, BallService.normalizeSize(
                            request.optInt("size", BallService.DEFAULT_SIZE_DP)));
                }
                if (request.has("image")) {
                    edit.putString(BallService.PREF_IMAGE, request.optString("image", "").trim());
                }
                edit.apply();
                BallService.reload(App.i());
                respondJson(out, 200, ok("已应用"));
                return;
            }
            case "/ball/settings": {
                // The flat settings map: one read returns everything, and a body writes
                // only the keys it carries, so adding a key never changes the protocol.
                android.content.SharedPreferences.Editor edit = App.i().prefs.edit();
                boolean wrote = false;
                boolean needsReload = false;
                if (request.has("ballShowStatus")) { edit.putBoolean(BallService.PREF_SHOW_STATUS, request.optBoolean("ballShowStatus", true)); wrote = true; }
                if (request.has("ballShowThink")) { edit.putBoolean(BallService.PREF_SHOW_THINK, request.optBoolean("ballShowThink", true)); wrote = true; }
                if (request.has("ballShowRing")) { edit.putBoolean(BallService.PREF_SHOW_RING, request.optBoolean("ballShowRing", true)); wrote = true; }
                if (request.has("ballShowProcess")) { edit.putBoolean(BallService.PREF_SHOW_PROCESS, request.optBoolean("ballShowProcess", true)); wrote = true; }
                if (request.has("ballBubbleLines")) {
                    int lines = request.optInt("ballBubbleLines", 3);
                    edit.putInt(BallService.PREF_BUBBLE_LINES, BallService.normalizeBubbleLines(lines));
                    wrote = true;
                }
                if (request.has("ballSizeDp")) {
                    int size = request.optInt("ballSizeDp", BallService.DEFAULT_SIZE_DP);
                    edit.putInt(BallService.PREF_SIZE, BallService.normalizeSize(size));
                    wrote = true;
                    needsReload = true;
                }
                if (request.has("ballImagePath")) {
                    edit.putString(BallService.PREF_IMAGE, request.optString("ballImagePath", "").trim());
                    wrote = true;
                    needsReload = true;
                }
                if (request.has("screenWatchEnabled")) {
                    boolean enabled = request.optBoolean("screenWatchEnabled", false);
                    edit.putBoolean(BallService.PREF_SCREEN_WATCH, enabled);
                    if (!enabled) MainActivity.stopScreenWatch();
                    wrote = true;
                }
                if (request.has("screenWatchMinutes")) {
                    edit.putInt(BallService.PREF_SCREEN_WATCH_MINUTES,
                            BallService.normalizeWatchMinutes(request.optInt("screenWatchMinutes", 60)));
                    wrote = true;
                }
                if (wrote) {
                    edit.apply();
                    BallService.applySettings();
                    if (needsReload) BallService.reload(App.i());
                }
                JSONObject answer = new JSONObject(BallService.settingsJson());
                answer.put("ok", true);
                respondJson(out, 200, answer);
                return;
            }
            case "/ball/reset-position":
                BallService.resetPosition(App.i());
                respondJson(out, 200, ok("已重置到默认位置"));
                return;
            case "/ball/pick-image":
                if (host != null) host.onBallImageRequested();
                respondJson(out, 200, ok("请选择图片，随后可拖动和缩放选择显示区域"));
                return;
            case "/ball/start": {
                // `start` hands the work to a foreground service, so asking isRunning()
                // right here answers "not yet" even on the happy path - which used to be
                // reported as a missing overlay permission. The permission is the only
                // thing that can actually refuse the request, so ask that instead, and
                // treat "still coming up" as the success it is.
                App app = App.i();
                boolean allowed = Assist.canOverlay(app);
                BallService.start(app);
                JSONObject answer = allowed
                        ? ok(BallService.isRunning() ? "悬浮球已开启" : "正在开启悬浮球")
                        : error("需要「显示在其他应用上层」权限，请在「权限与助手」里授予");
                if (!allowed) answer.put("needsOverlayPermission", true);
                respondJson(out, 200, answer);
                return;
            }
            case "/ball/stop":
                BallService.stop(App.i());
                respondJson(out, 200, ok("悬浮球已关闭"));
                return;
            case "/screen-watch/toggle":
                MainActivity.toggleScreenWatch();
                respondJson(out, 200, ok("屏幕观察已切换"));
                return;
            case "/screen-watch/start":
                MainActivity.startScreenWatch();
                respondJson(out, 200, ok("正在开启屏幕观察"));
                return;
            case "/screen-watch/stop":
                MainActivity.stopScreenWatch();
                respondJson(out, 200, ok("正在停止屏幕观察"));
                return;
            case "/screen-watch/state":
                MainActivity.setScreenWatchActive(request.optBoolean("active", false));
                respondJson(out, 200, ok("屏幕观察状态已记录"));
                return;
            case "/screen-watch/status": {
                JSONObject answer = ok("屏幕观察状态");
                answer.put("active", MainActivity.screenWatchActive());
                respondJson(out, 200, answer);
                return;
            }
            case "/a11y/tree": {
                VirtualDisplayController.ensureIfEnabled(App.i());
                JSONObject answer = PhoneInput.tree(request.optBoolean("text", false));
                respondJson(out, 200, answer);
                return;
            }
            case "/a11y/tap": {
                PhoneInput.Output result = PhoneInput.tap(
                        (float) request.optDouble("x", -1),
                        (float) request.optDouble("y", -1));
                JSONObject answer = ok(result.message);
                answer.put("backend", result.backend);
                respondJson(out, 200, answer);
                return;
            }
            case "/a11y/swipe": {
                PhoneInput.Output result = PhoneInput.swipe(
                        (float) request.optDouble("x1", -1), (float) request.optDouble("y1", -1),
                        (float) request.optDouble("x2", -1), (float) request.optDouble("y2", -1),
                        request.optLong("ms", 300));
                JSONObject answer = ok(result.message);
                answer.put("backend", result.backend);
                respondJson(out, 200, answer);
                return;
            }
            case "/a11y/key": {
                PhoneInput.Output result = PhoneInput.key(request.optString("name", ""));
                JSONObject answer = ok(result.message);
                answer.put("backend", result.backend);
                respondJson(out, 200, answer);
                return;
            }
            case "/a11y/type": {
                PhoneInput.Output result = PhoneInput.type(request.optString("text", ""));
                JSONObject answer = ok(result.message);
                answer.put("backend", result.backend);
                respondJson(out, 200, answer);
                return;
            }
            case "/a11y/click": {
                String label = request.optString("label", "");
                PhoneInput.Output result = PhoneInput.click(label);
                JSONObject answer = ok(result.message);
                answer.put("backend", result.backend);
                respondJson(out, 200, answer);
                return;
            }
            case "/a11y/backend": {
                PhoneInput.setMode(request.optString("mode", PhoneInput.MODE_AUTO));
                JSONObject answer = ok("手机输入通道已设为 " + PhoneInput.requestedMode());
                answer.put("input", PhoneInput.statusJson());
                respondJson(out, 200, answer);
                return;
            }
            case "/a11y/open": {
                String app = request.optString("app", "");
                respondJson(out, 200, ok(Assist.launch(app, App.i())));
                return;
            }
            case "/shizuku/request":
                if (host != null) host.onShizukuPermissionRequested();
                respondJson(out, 200, ok("已请求授权，请在手机上确认"));
                return;
            case "/task/images/begin":
                TaskImages.begin(request.optString("sessionId", ""));
                respondJson(out, 200, ok("任务图片跟踪已开始"));
                return;
            case "/task/images/end":
                TaskImages.end(request.optString("sessionId", ""));
                respondJson(out, 200, ok("任务图片跟踪已结束"));
                return;
            case "/task/images/note": {
                boolean active = TaskImages.active();
                boolean tracked = TaskImages.notePath(request.optString("path", ""));
                JSONObject answer = ok("任务图片已登记");
                answer.put("active", active);
                answer.put("tracked", tracked);
                respondJson(out, 200, answer);
                return;
            }
            case "/task/awake/begin":
                ScreenAwake.taskStart(request.optString("sessionId", ""),
                        "harness turn " + request.optString("sessionId", ""));
                respondJson(out, 200, ok("任务屏幕保持已开始"));
                return;
            case "/task/awake/end":
                ScreenAwake.taskEnd(request.optString("sessionId", ""),
                        "harness turn " + request.optString("sessionId", ""));
                respondJson(out, 200, ok("任务屏幕保持已结束"));
                return;
            case "/shizuku/grant-all": {
                if (!ShizukuBridge.available()) {
                    respondJson(out, 503, error("Shizuku 未安装或服务未运行"));
                    return;
                }
                if (!ShizukuBridge.granted()) {
                    ShizukuBridge.afterNextGrant(() -> {
                        Context context = App.i();
                        ShizukuBridge.Result result =
                                ShizukuBridge.grantAllAppPermissions(context);
                        App.log("shizuku grant-all: exit=" + result.exitCode
                                + " out=" + result.stdout.trim()
                                + " err=" + result.stderr.trim());
                        String message = result.exitCode == 0
                                ? "Shizuku 一键授权完成"
                                : "Shizuku 已授权，但部分权限补齐失败";
                        new android.os.Handler(android.os.Looper.getMainLooper()).post(() ->
                                android.widget.Toast.makeText(context, message,
                                        android.widget.Toast.LENGTH_LONG).show());
                    });
                    if (host != null) host.onShizukuPermissionRequested();
                    JSONObject answer = ok("请在 Shizuku 中确认授权，确认后会自动补齐其余权限");
                    answer.put("pending", true);
                    respondJson(out, 200, answer);
                    return;
                }
                ShizukuBridge.Result result =
                        ShizukuBridge.grantAllAppPermissions(App.i());
                JSONObject answer = new JSONObject();
                try {
                    answer.put("ok", result.exitCode == 0);
                    answer.put("message", result.exitCode == 0
                            ? "Shizuku 一键授权完成"
                            : "部分权限补齐失败，请查看输出");
                    answer.put("stdout", result.stdout);
                    answer.put("stderr", result.stderr);
                    if (result.error != null) answer.put("error", result.error);
                    JSONObject permissions = new JSONObject();
                    permissions.put("overlay", Assist.canOverlay(App.i()));
                    permissions.put("microphone", App.i().checkSelfPermission(
                            android.Manifest.permission.RECORD_AUDIO)
                            == android.content.pm.PackageManager.PERMISSION_GRANTED);
                    permissions.put("accessibility", Assist.available());
                    answer.put("permissions", permissions);
                } catch (Throwable ignored) {
                }
                respondJson(out, 200, answer);
                return;
            }
            case "/shizuku/exec": {
                final String command = request.optString("command", "");
                List<TaskImages.Snapshot> imageSnapshots = TaskImages.prepareCommand(command);
                ShizukuBridge.Result result = ShizukuBridge.exec(command,
                        request.optLong("timeoutMs", 20000));
                TaskImages.completeCommand(imageSnapshots);
                JSONObject answer = new JSONObject();
                try {
                    answer.put("exit", result.exitCode);
                    answer.put("stdout", result.stdout);
                    answer.put("stderr", result.stderr);
                    if (result.error != null) answer.put("error", result.error);
                } catch (Throwable ignored) {
                }
                respondJson(out, 200, answer);
                return;
            }
            case "/diagnostics/client": {
                String text = request.optString("message", "").trim();
                if (text.length() > 500) text = text.substring(0, 500);
                if (!text.isEmpty()) App.log("web: " + text);
                respondJson(out, 200, ok("客户端诊断已记录"));
                return;
            }
            default:
                respondJson(out, 404, error("not found: " + path));
        }
    }

    // ----------------------------------------------------------------- snapshot

    private static JSONObject snapshot() {
        App app = App.i();
        JSONObject root = new JSONObject();
        try {
            JSONObject status = new JSONObject();
            status.put("state", ServerBus.state().name());
            status.put("url", ServerBus.url() == null ? "" : ServerBus.url());
            status.put("port", app.activePort());
            status.put("error", ServerBus.error() == null ? "" : ServerBus.error());
            status.put("uptimeMs", ServerBus.startedAt() == 0 ? 0
                    : System.currentTimeMillis() - ServerBus.startedAt());
            root.put("status", status);

            JSONArray distros = new JSONArray();
            String active = app.activeDistroId();
            for (Distros.Distro distro : Distros.list(app)) {
                JSONObject item = new JSONObject();
                item.put("id", distro.id);
                item.put("name", distro.name);
                item.put("path", distro.root.getAbsolutePath());
                item.put("bundled", distro.bundled);
                item.put("active", distro.id.equals(active));
                item.put("usable", distro.isUsable());
                item.put("command", distro.command == null ? "" : distro.command);
                distros.put(item);
            }
            root.put("distros", distros);

            JSONObject settings = new JSONObject();
            settings.put("port", app.port());
            settings.put("apiKey", app.prefs.getString("apiKey", ""));
            settings.put("shareStorage", app.prefs.getBoolean("shareStorage", true));
            settings.put("keepAwake", app.prefs.getBoolean("keepAwake", false));
            settings.put("chromeMode", app.prefs.getString("window_chrome_mode", "auto"));
            settings.put("autoRestart", app.prefs.getBoolean("autoRestart", true));
            settings.put("autoRepairAccessibility", AccessibilityGuardian.enabled());
            settings.put("virtualDisplay", VirtualDisplayController.enabled());
            settings.put("edgeTtsEnabled", EdgeTts.enabled());
            settings.put("screenWatchEnabled", app.prefs.getBoolean(
                    BallService.PREF_SCREEN_WATCH, false));
            settings.put("screenWatchMinutes", BallService.normalizeWatchMinutes(
                    app.prefs.getInt(BallService.PREF_SCREEN_WATCH_MINUTES, 60)));
            settings.put("inputBackend", PhoneInput.requestedMode());
            root.put("settings", settings);

            JSONArray mounts = new JSONArray();
            for (Mounts.Mount mount : Mounts.list()) {
                mounts.put(mount.toJson());
            }
            root.put("mounts", mounts);
            root.put("sharedStorage", app.sharedStorage() == null ? ""
                    : app.sharedStorage().getAbsolutePath());

            root.put("appVersion", App.appVersion());
            root.put("appVersionCode", App.appVersionCode());
            root.put("terminalVersion", App.terminalVersion());
            root.put("hotVersion", Payload.hotVersion());
            root.put("packagedHotVersion", Payload.packagedHotVersion());
            root.put("hotMessage", Payload.hotMessage());
            root.put("terminalVersion", App.terminalVersion());
            // Is the runtime in this APK, or does it have to be fetched?
            root.put("payloadBundled", Payload.hasBundledPayload(app));
            root.put("terminalReady", app.isBundledReady());
            root.put("terminalBusy", Payload.terminalBusy());
            root.put("terminalProgress", Payload.terminalProgress());
            JSONObject ball = new JSONObject();
            ball.put("size", BallService.normalizeSize(
                    App.i().prefs.getInt(BallService.PREF_SIZE, BallService.DEFAULT_SIZE_DP)));
            ball.put("image", App.i().prefs.getString(BallService.PREF_IMAGE, ""));
            root.put("ball", ball);

            JSONObject shizuku = new JSONObject();
            shizuku.put("installed", ShizukuBridge.available());
            shizuku.put("granted", ShizukuBridge.granted());
            shizuku.put("version", ShizukuBridge.version());
            root.put("shizuku", shizuku);

            JSONObject pty = new JSONObject();
            pty.put("url", "http://127.0.0.1:" + app.ptyPort());
            pty.put("token", app.ptyToken());
            root.put("pty", pty);

            JSONObject bridge = new JSONObject();
            bridge.put("url", "http://127.0.0.1:" + port());
            bridge.put("token", token);
            root.put("bridge", bridge);

            // Recovery state travels with the snapshot so the Web UI can show it
            // too — but note that the page is only reachable when the harness is
            // up, which is exactly when recovery is not needed. Its real consumer
            // is the native console.
            root.put("recovery", Recovery.status());

            JSONArray log = new JSONArray();
            List<String> lines = ServerBus.log();
            for (int i = Math.max(0, lines.size() - 160); i < lines.size(); i++) {
                log.put(lines.get(i));
            }
            root.put("log", log);
        } catch (Throwable error) {
            App.log("bridge: snapshot failed: " + error);
        }
        return root;
    }

    // ------------------------------------------------------------------ plumbing

    /** Single-quote for the guest shell: the path comes from the UI. */
    private static String shellQuote(String value) {
        return "'" + (value == null ? "" : value.replace("'", "'\\''")) + "'";
    }

    private static JSONObject ok(String message) {
        JSONObject object = new JSONObject();
        try {
            object.put("ok", true);
            object.put("message", message);
        } catch (Throwable ignored) {
        }
        return object;
    }

    private static JSONObject error(String message) {
        JSONObject object = new JSONObject();
        try {
            object.put("ok", false);
            object.put("error", message);
        } catch (Throwable ignored) {
        }
        return object;
    }

    private static void respondJson(OutputStream out, int code, JSONObject payload) throws IOException {
        byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
        StringBuilder head = new StringBuilder()
                .append("HTTP/1.1 ").append(code).append(' ').append(code == 200 ? "OK" : "ERR").append("\r\n")
                .append("Content-Type: application/json; charset=utf-8\r\n")
                .append("Content-Length: ").append(body.length).append("\r\n")
                .append("Cache-Control: no-store, no-cache, must-revalidate\r\n")
                .append("Pragma: no-cache\r\n")
                .append("Expires: 0\r\n")
                .append("Connection: close\r\n")
                .append("Access-Control-Allow-Origin: *\r\n")
                .append("Access-Control-Allow-Headers: X-Dsh-Token, Content-Type, Cache-Control, Pragma\r\n")
                .append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\r\n");
        out.write(head.toString().getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    private static void respond(OutputStream out, int code, String text) throws IOException {
        byte[] body = text.getBytes(StandardCharsets.UTF_8);
        out.write(("HTTP/1.1 " + code + " No Content\r\nContent-Length: " + body.length
                + "\r\nCache-Control: no-store, no-cache\r\nPragma: no-cache"
                + "\r\nAccess-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Headers: X-Dsh-Token, Content-Type, Cache-Control, Pragma\r\n"
                + "Connection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    /** Raw bytes with explicit content type; used for the background image. */
    private static void respondBytes(OutputStream out, byte[] body, String mime) throws IOException {
        out.write(("HTTP/1.1 200 OK\r\nContent-Type: " + mime + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Headers: X-Dsh-Token, Content-Type, Cache-Control, Pragma\r\n\r\n")
                .getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    /** The stored background image, or null when none is configured. */
    private static byte[] backgroundBytes() {
        try {
            String path = Appearance.imagePath();
            if (path == null) return null;
            java.io.File file = new java.io.File(path);
            if (file.length() <= 0 || file.length() > (32L << 20)) return null;
            byte[] data = new byte[(int) file.length()];
            try (java.io.FileInputStream in = new java.io.FileInputStream(file)) {
                int read = 0;
                while (read < data.length) {
                    int got = in.read(data, read, data.length - read);
                    if (got < 0) break;
                    read += got;
                }
            }
            return data;
        } catch (Throwable error) {
            App.log("background read failed: " + error);
            return null;
        }
    }

    /**
     * Sniff the image type from its magic bytes.
     *
     * The picker can hand back anything, and a wrong Content-Type makes the browser refuse
     * to render it, so the declared type follows the actual bytes rather than the filename.
     */
    private static String backgroundMime(byte[] data) {
        if (data.length >= 8 && (data[0] & 0xFF) == 0x89 && data[1] == 'P' && data[2] == 'N'
                && data[3] == 'G') {
            return "image/png";
        }
        if (data.length >= 3 && (data[0] & 0xFF) == 0xFF && (data[1] & 0xFF) == 0xD8) {
            return "image/jpeg";
        }
        if (data.length >= 12 && data[0] == 'R' && data[1] == 'I' && data[2] == 'F'
                && data[3] == 'F' && data[8] == 'W' && data[9] == 'E' && data[10] == 'B'
                && data[11] == 'P') {
            return "image/webp";
        }
        if (data.length >= 6 && data[0] == 'G' && data[1] == 'I' && data[2] == 'F') {
            return "image/gif";
        }
        return "application/octet-stream";
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder builder = new StringBuilder();
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') break;
            if (c != '\r') builder.append((char) c);
            if (builder.length() > 8192) break;
        }
        return c < 0 && builder.length() == 0 ? null : builder.toString();
    }
}

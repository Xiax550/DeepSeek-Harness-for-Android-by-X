package com.dha.harness;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.accessibilityservice.AccessibilityService.ScreenshotResult;
import android.accessibilityservice.AccessibilityService.TakeScreenshotCallback;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorSpace;
import android.graphics.Path;
import android.graphics.Paint;
import android.graphics.Rect;
import android.hardware.HardwareBuffer;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.SparseArray;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Screen control for the agent: an accessibility service, plus the small static
 * surface the control bridge talks to.
 *
 * The privileged alternative is Shizuku (`shiz input tap ...`), which is faster
 * but needs a separate app and a one-time adb pairing. This service needs only a
 * toggle in Settings, and it sees what a user sees: the view tree, so a tap can
 * be aimed at "the button labelled 发送" instead of at guessed coordinates. Both
 * stay available — the skill tells the agent which to reach for.
 *
 * Everything here is bounded on purpose. The tree walk is capped by node count
 * and depth because the caller is a language model: an unbounded dump of a real
 * app's hierarchy is thousands of nodes, and the useful part is the handful that
 * are clickable or editable.
 */
public final class Assist extends AccessibilityService {

    /** Which grant a permission request is about; the activity owns the dialogs. */
    public static final int PERMISSION_ACCESSIBILITY = 1;
    public static final int PERMISSION_OVERLAY = 2;
    public static final int PERMISSION_MICROPHONE = 3;

    private static volatile Assist current;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /** Bound on how much of a screen can be reported in one call. */
    private static final int MAX_NODES = 120;
    private static final int MAX_DEPTH = 24;

    // ------------------------------------------------------------------ state

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        current = this;
        App.log("accessibility service connected");
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Deliberately not subscribing to anything: the agent asks for the screen
        // when it needs it, and an event stream would only burn battery to build
        // state nobody reads.
    }

    @Override
    public void onInterrupt() {
    }

    @Override
    public boolean onUnbind(Intent intent) {
        current = null;
        ScreenAwake.release();
        App.log("accessibility service disconnected");
        return super.onUnbind(intent);
    }

    /** True once the user has switched the service on in Settings. */
    public static boolean available() {
        return current != null;
    }

    /** Is the overlay permission granted (the floating ball needs it)? */
    public static boolean canOverlay(Context ctx) {
        return android.provider.Settings.canDrawOverlays(ctx);
    }

    private static Assist require() {
        Assist service = current;
        if (service == null) {
            throw new IllegalStateException("无障碍服务未开启：设置 → 安卓沙箱 → 无障碍 → 去开启");
        }
        return service;
    }

    /** Read the managed task display without ever mixing it with the phone's main screen. */
    private static AccessibilityNodeInfo root() {
        Assist service = require();
        int displayId = VirtualDisplayController.displayId();
        if (displayId > 0) {
            if (Build.VERSION.SDK_INT >= 33) {
                try {
                    AccessibilityNodeInfo active = service.getRootInActiveWindow(displayId);
                    if (active != null) {
                        App.log("a11y active root: display=" + displayId
                                + " package=" + active.getPackageName());
                        return active;
                    }
                } catch (Throwable error) {
                    App.log("a11y active root unavailable: display=" + displayId + " " + error);
                }
            }
            List<AccessibilityWindowInfo> windows = null;
            if (Build.VERSION.SDK_INT >= 30) {
                try {
                    SparseArray<List<AccessibilityWindowInfo>> displays =
                            service.getWindowsOnAllDisplays();
                    StringBuilder ids = new StringBuilder();
                    for (int index = 0; index < displays.size(); index++) {
                        if (ids.length() > 0) ids.append(',');
                        ids.append(displays.keyAt(index));
                    }
                    App.log("a11y window displays: target=" + displayId + " available=" + ids);
                    windows = displays.get(displayId);
                } catch (Throwable error) {
                    App.log("a11y window displays unavailable: target=" + displayId + " " + error);
                }
            }
            if (windows == null) windows = new ArrayList<>();
            AccessibilityWindowInfo fallback = null;
            for (AccessibilityWindowInfo window : windows) {
                if (fallback == null) fallback = window;
                if (window.isActive() || window.isFocused()) fallback = window;
            }
            if (fallback != null) {
                AccessibilityNodeInfo node = fallback.getRoot();
                if (node != null) return node;
            }
            throw new IllegalStateException("虚拟副屏当前没有可读窗口");
        }
        return service.getRootInActiveWindow();
    }

    // ----------------------------------------------------------------- actions

    /**
     * The active window as JSON: one object per interesting node.
     *
     * @param withText include non-interactive text nodes too (screen reading);
     *                 without it only clickable/editable/scrollable nodes are
     *                 reported, which is what "find the button" needs.
     */
    public static String describe(boolean withText) throws Exception {
        ScreenAwake.hold("reading the screen");
        AccessibilityNodeInfo root = root();
        JSONObject answer = new JSONObject();
        if (root == null) {
            answer.put("ok", false);
            answer.put("error", "当前没有可读的窗口（锁屏或系统界面？）");
            return answer.toString();
        }
        CharSequence pkg = root.getPackageName();
        answer.put("ok", true);
        answer.put("displayId", VirtualDisplayController.displayId());
        answer.put("package", pkg == null ? "" : pkg.toString());
        JSONArray nodes = new JSONArray();
        walk(root, nodes, 0, withText);
        answer.put("nodes", nodes);
        answer.put("count", nodes.length());
        return answer.toString();
    }

    /**
     * Capture the current physical display through the accessibility service.
     *
     * Android 11 added this to AccessibilityService, so no Shizuku shell is
     * needed for the common "what is on screen now" screenshot. Older releases
     * still have `ui tree`, which usually carries enough structure for the agent.
     */
    public static String screenshotBase64() throws Exception {
        return screenshotBase64((Rect) null);
    }

    /**
     * Capture the screen, optionally replacing the floating overlay's rectangle
     * with a flat nearby colour so the observer cannot react to its own bubble.
     */
    public static String screenshotBase64(Rect excludeFloatingWindow) throws Exception {
        java.util.List<Rect> masks = excludeFloatingWindow == null
                ? null : java.util.Collections.singletonList(excludeFloatingWindow);
        return screenshotBase64(masks);
    }

    /** Capture the screen and mask each visible floating-window region. */
    public static String screenshotBase64(List<Rect> excludeFloatingWindows) throws Exception {
        if (Build.VERSION.SDK_INT < 30) {
            throw new IllegalStateException("当前系统不支持无障碍截屏，请改用 ui tree 读屏");
        }
        Assist service = require();
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<ScreenshotResult> result = new AtomicReference<>();
        AtomicReference<Integer> failure = new AtomicReference<>(0);
        TakeScreenshotCallback callback = new TakeScreenshotCallback() {
            @Override
            public void onSuccess(ScreenshotResult screenshot) {
                result.set(screenshot);
                latch.countDown();
            }

            @Override
            public void onFailure(int errorCode) {
                failure.set(errorCode);
                latch.countDown();
            }
        };
        int displayId = VirtualDisplayController.displayId();
        if (displayId <= 0) displayId = android.view.Display.DEFAULT_DISPLAY;
        service.takeScreenshot(displayId,
                service.getMainExecutor(), callback);
        if (!latch.await(5000, TimeUnit.MILLISECONDS)) {
            throw new IllegalStateException("无障碍截屏超时");
        }
        ScreenshotResult screenshot = result.get();
        if (screenshot == null) {
            throw new IllegalStateException("无障碍截屏失败：" + failure.get());
        }
        HardwareBuffer buffer = screenshot.getHardwareBuffer();
        ColorSpace colorSpace = screenshot.getColorSpace();
        if (colorSpace == null) colorSpace = ColorSpace.get(ColorSpace.Named.SRGB);
        Bitmap source = Bitmap.wrapHardwareBuffer(buffer, colorSpace);
        // The observation mask draws onto this copy. A non-mutable bitmap throws
        // "Immutable bitmap passed to Canvas constructor" on every frame.
        Bitmap bitmap = source.copy(Bitmap.Config.ARGB_8888, true);
        buffer.close();
        if (displayId == android.view.Display.DEFAULT_DISPLAY && excludeFloatingWindows != null) {
            for (Rect exclude : excludeFloatingWindows) {
                maskFloatingWindow(bitmap, exclude, service);
            }
        }
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        if (!bitmap.compress(Bitmap.CompressFormat.PNG, 90, bytes)) {
            throw new IllegalStateException("截屏编码失败");
        }
        return Base64.getEncoder().encodeToString(bytes.toByteArray());
    }

    private static void maskFloatingWindow(Bitmap bitmap, Rect requested, Assist service) {
        if (bitmap == null || requested == null || requested.isEmpty()) return;
        int margin = Math.round(3 * service.getResources().getDisplayMetrics().density);
        Rect area = new Rect(requested);
        area.inset(-margin, -margin);
        area.left = Math.max(0, area.left);
        area.top = Math.max(0, area.top);
        area.right = Math.min(bitmap.getWidth(), area.right);
        area.bottom = Math.min(bitmap.getHeight(), area.bottom);
        if (area.isEmpty()) return;

        // A nearby average blends into both light and dark screens better than a
        // black rectangle, which a vision model could mistake for a UI change.
        long red = 0;
        long green = 0;
        long blue = 0;
        int samples = 0;
        int outerLeft = Math.max(0, area.left - margin * 2);
        int outerTop = Math.max(0, area.top - margin * 2);
        int outerRight = Math.min(bitmap.getWidth() - 1, area.right + margin * 2);
        int outerBottom = Math.min(bitmap.getHeight() - 1, area.bottom + margin * 2);
        for (int x = outerLeft; x <= outerRight; x += 8) {
            int[] ys = {outerTop, outerBottom};
            for (int y : ys) {
                int color = bitmap.getPixel(x, y);
                red += Color.red(color);
                green += Color.green(color);
                blue += Color.blue(color);
                samples++;
            }
        }
        for (int y = outerTop; y <= outerBottom; y += 8) {
            int[] xs = {outerLeft, outerRight};
            for (int x : xs) {
                int color = bitmap.getPixel(x, y);
                red += Color.red(color);
                green += Color.green(color);
                blue += Color.blue(color);
                samples++;
            }
        }
        int fill = samples == 0
                ? Color.rgb(32, 33, 36)
                : Color.rgb((int) (red / samples), (int) (green / samples), (int) (blue / samples));
        Paint paint = new Paint();
        paint.setColor(fill);
        paint.setStyle(Paint.Style.FILL);
        paint.setAntiAlias(false);
        new Canvas(bitmap).drawRect(area, paint);
        App.log("a11y screenshot: masked floating window " + area.toShortString());
    }

    private static void walk(AccessibilityNodeInfo node, JSONArray out, int depth, boolean withText) {
        if (node == null || depth > MAX_DEPTH || out.length() >= MAX_NODES) return;
        try {
            String text = text(node);
            String id = node.getViewIdResourceName();
            boolean actionable = node.isClickable() || node.isEditable() || node.isScrollable()
                    || node.isLongClickable() || node.isCheckable();
            if (actionable || (withText && text != null && !text.isEmpty())) {
                Rect bounds = new Rect();
                node.getBoundsInScreen(bounds);
                JSONObject row = new JSONObject();
                if (text != null && !text.isEmpty()) row.put("text", text);
                if (id != null && !id.isEmpty()) {
                    int slash = id.lastIndexOf('/');
                    row.put("id", slash < 0 ? id : id.substring(slash + 1));
                }
                row.put("class", shortClass(node.getClassName()));
                row.put("at", new JSONArray(new int[]{bounds.centerX(), bounds.centerY()}));
                row.put("box", new JSONArray(new int[]{bounds.left, bounds.top, bounds.right, bounds.bottom}));
                JSONArray flags = new JSONArray();
                if (node.isClickable()) flags.put("click");
                if (node.isLongClickable()) flags.put("long");
                if (node.isEditable()) flags.put("edit");
                if (node.isScrollable()) flags.put("scroll");
                if (node.isCheckable()) flags.put("check");
                if (node.isEnabled()) flags.put("enabled");
                if (node.isFocused()) flags.put("focused");
                row.put("can", flags);
                out.put(row);
            }
            for (int index = 0; index < node.getChildCount(); index++) {
                walk(node.getChild(index), out, depth + 1, withText);
            }
        } catch (Exception ignored) {
            // A dying window can throw from any of these; one bad node is not a
            // reason to fail the whole call.
        }
    }

    private static String text(AccessibilityNodeInfo node) {
        CharSequence value = node.getText();
        if (value == null || value.length() == 0) value = node.getContentDescription();
        if (value == null || value.length() == 0) value = node.getHintText();
        return value == null ? null : value.toString();
    }

    private static String shortClass(CharSequence name) {
        if (name == null) return "";
        String text = name.toString();
        int dot = text.lastIndexOf('.');
        return dot < 0 ? text : text.substring(dot + 1);
    }

    /** One touch. Coordinates are screen pixels, as reported by {@link #describe}. */
    public static void tap(final float x, final float y) throws Exception {
        ScreenAwake.hold("tapping the screen");
        int displayId = VirtualDisplayController.displayId();
        if (displayId > 0) {
            VirtualDisplayController.injectTap(displayId, x, y);
            return;
        }
        Path path = new Path();
        path.moveTo(x, y);
        stroke(path, 0, 60);
    }

    /** A drag from one point to another over {@code ms} milliseconds. */
    public static void swipe(float x1, float y1, float x2, float y2, long ms) throws Exception {
        ScreenAwake.hold("swiping the screen");
        int displayId = VirtualDisplayController.displayId();
        if (displayId > 0) {
            VirtualDisplayController.injectSwipe(displayId, x1, y1, x2, y2, ms);
            return;
        }
        Path path = new Path();
        path.moveTo(x1, y1);
        path.lineTo(x2, y2);
        stroke(path, 0, Math.max(80, ms));
    }

    private static void stroke(Path path, long start, long duration) throws Exception {
        GestureDescription.StrokeDescription line =
                new GestureDescription.StrokeDescription(path, start, duration);
        final Object monitor = new Object();
        final boolean[] done = {false};
        final boolean[] ok = {false};
        boolean dispatched = require().dispatchGesture(
                new GestureDescription.Builder().addStroke(line).build(),
                new AccessibilityService.GestureResultCallback() {
                    @Override
                    public void onCompleted(GestureDescription description) {
                        synchronized (monitor) {
                            ok[0] = true;
                            done[0] = true;
                            monitor.notifyAll();
                        }
                    }

                    @Override
                    public void onCancelled(GestureDescription description) {
                        synchronized (monitor) {
                            done[0] = true;
                            monitor.notifyAll();
                        }
                    }
                }, MAIN);
        if (!dispatched) throw new IllegalStateException("手势被系统拒绝");
        // The bridge answers a request, not a stream: wait for the callback so a
        // caller that taps and then reads the screen sees the result.
        long deadline = System.currentTimeMillis() + 3000;
        synchronized (monitor) {
            while (!done[0] && System.currentTimeMillis() < deadline) {
                try {
                    monitor.wait(200);
                } catch (InterruptedException error) {
                    break;
                }
            }
        }
        if (!ok[0]) throw new IllegalStateException("手势超时或被取消");
    }

    /** Global navigation: back / home / recents / notifications. */
    public static void key(String name) throws Exception {
        if (!"lock".equals(name)) ScreenAwake.hold("navigating the screen");
        int displayId = VirtualDisplayController.displayId();
        if (displayId > 0) {
            String code;
            switch (name == null ? "" : name) {
                case "back": code = "KEYCODE_BACK"; break;
                case "home": code = "KEYCODE_HOME"; break;
                case "recents": case "recent": code = "KEYCODE_APP_SWITCH"; break;
                case "notifications": case "shade": code = "KEYCODE_NOTIFICATION"; break;
                case "lock": code = "KEYCODE_SLEEP"; break;
                default: throw new IllegalArgumentException("不认识的键：" + name);
            }
            VirtualDisplayController.injectKey(displayId, code);
            return;
        }
        int action;
        switch (name == null ? "" : name) {
            case "back": action = GLOBAL_ACTION_BACK; break;
            case "home": action = GLOBAL_ACTION_HOME; break;
            case "recents": case "recent": action = GLOBAL_ACTION_RECENTS; break;
            case "notifications": case "shade": action = GLOBAL_ACTION_NOTIFICATIONS; break;
            case "lock": action = GLOBAL_ACTION_LOCK_SCREEN; break;
            default: throw new IllegalArgumentException("不认识的键：" + name + "（back/home/recents/notifications/lock）");
        }
        if (!require().performGlobalAction(action)) {
            throw new IllegalStateException("系统拒绝了 " + name + "（锁屏或前台不是可操作窗口？）");
        }
    }

    /**
     * Type into the focused editable field.
     *
     * Uses the accessibility ACTION_SET_TEXT path rather than synthetic key
     * events: it works with any IME, including Chinese input, and cannot leak
     * keystrokes into a different field than the caller intended.
     */
    public static void type(String value) throws Exception {
        ScreenAwake.hold("typing into an app");
        AccessibilityNodeInfo root = root();
        AccessibilityNodeInfo target = findEditable(root, 0);
        if (target == null) throw new IllegalStateException("当前没有可输入的文本框");
        Bundle arguments = new Bundle();
        arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
        if (!target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) {
            throw new IllegalStateException("文本框拒绝了输入");
        }
    }

    /** Click the node whose text/label matches, so no coordinates are needed. */
    public static String click(String label) throws Exception {
        if (label == null || label.isEmpty()) throw new IllegalArgumentException("要点哪个？（按文字匹配）");
        ScreenAwake.hold("clicking in an app");
        AccessibilityNodeInfo root = root();
        AccessibilityNodeInfo hit = findLabel(root, label, 0, new int[]{MAX_NODES});
        if (hit == null) throw new IllegalStateException("屏幕上没有找到「" + label + "」");
        AccessibilityNodeInfo target = clickable(hit);
        if (target == null) throw new IllegalStateException("「" + label + "」不能点击");
        if (!target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
            throw new IllegalStateException("「" + label + "」拒绝了点击");
        }
        return "clicked " + label;
    }

    private static AccessibilityNodeInfo clickable(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo cursor = node;
        for (int depth = 0; depth < 6 && cursor != null; depth++) {
            if (cursor.isClickable()) return cursor;
            cursor = cursor.getParent();
        }
        return null;
    }

    private static AccessibilityNodeInfo findEditable(AccessibilityNodeInfo node, int depth) {
        if (node == null || depth > MAX_DEPTH) return null;
        if (node.isEditable() && node.isEnabled()) return node;
        if (node.isFocused()) {
            AccessibilityNodeInfo focused = findEditable(node, depth + 1);
            if (focused != null) return focused;
        }
        for (int index = 0; index < node.getChildCount(); index++) {
            AccessibilityNodeInfo hit = findEditable(node.getChild(index), depth + 1);
            if (hit != null) return hit;
        }
        return null;
    }

    private static AccessibilityNodeInfo findLabel(AccessibilityNodeInfo node, String label,
                                                   int depth, int[] budget) {
        if (node == null || depth > MAX_DEPTH || budget[0] <= 0) return null;
        budget[0]--;
        String text = text(node);
        if (text != null && text.contains(label)) return node;
        for (int index = 0; index < node.getChildCount(); index++) {
            AccessibilityNodeInfo hit = findLabel(node.getChild(index), label, depth + 1, budget);
            if (hit != null) return hit;
        }
        return null;
    }

    /** Launch an app by package name, or by the label on its launcher icon. */
    public static String launch(String what, Context ctx) throws Exception {
        if (what == null || what.isEmpty()) throw new IllegalArgumentException("要打开哪个应用？");
        ScreenAwake.hold("launching " + what);
        android.content.pm.PackageManager packages = ctx.getPackageManager();
        Intent intent = packages.getLaunchIntentForPackage(what);
        String packageName = what;
        if (intent == null) {
            List<String> matches = new ArrayList<>();
            for (android.content.pm.ApplicationInfo info
                    : packages.getInstalledApplications(android.content.pm.PackageManager.GET_META_DATA)) {
                CharSequence label = packages.getApplicationLabel(info);
                if (label != null && label.toString().equalsIgnoreCase(what)) {
                    matches.add(info.packageName);
                }
            }
            if (matches.isEmpty()) throw new IllegalStateException("找不到应用「" + what + "」");
            packageName = matches.get(0);
            intent = packages.getLaunchIntentForPackage(packageName);
            if (intent == null) throw new IllegalStateException("「" + what + "」没有可启动的界面");
        }
        if (VirtualDisplayController.enabled()) {
            return VirtualDisplayController.launchApp(ctx, packageName);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(intent);
        return "launched " + what;
    }

    // --------------------------------------------------------------- handover

    /**
     * Hand a spoken or typed instruction to the harness.
     *
     * The floating ball is a shortcut into the same conversation the Web UI is:
     * the text lands in the composer of a fresh session, so the agent picks it up
     * with the full tool surface it already has. MainActivity owns the WebView;
     * this only proves the two halves can find each other.
     */
    static void deliver(String text) {
        MainActivity.deliverPrompt(text);
    }

    /**
     * Hand the ball's words to its own conversation.
     *
     * The app only queues them; the plugin drains the queue into a dedicated
     * session (installBallInbox). If nothing claims them within a few seconds — an
     * older shell, a harness that is not running, a plugin that did not load — they
     * fall back to the old path, pasting into the conversation on screen, rather
     * than being swallowed.
     */
    static void deliverToBall(String text) {
        if (text == null || text.trim().isEmpty()) return;
        final int id = BallInbox.add(text);
        if (id < 0) return;
        BallService.onDeliveryResult("ball");
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            if (BallInbox.claimed(id)) return;
            BallInbox.drop(id);
            App.log("ball inbox: nobody claimed it in time, pasting instead");
            deliver(text);
        }, 10000);
    }
}

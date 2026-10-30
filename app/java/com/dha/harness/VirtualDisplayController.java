package com.dha.harness;

import android.annotation.SuppressLint;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.PixelFormat;
import android.graphics.Point;
import android.hardware.display.DisplayManager;
import android.hardware.display.IDisplayManager;
import android.hardware.display.IVirtualDisplayCallback;
import android.hardware.display.VirtualDisplayConfig;
import android.media.ImageReader;
import android.media.projection.IMediaProjection;

import org.lsposed.hiddenapibypass.HiddenApiBypass;

import rikka.shizuku.ShizukuBinderWrapper;
import rikka.shizuku.SystemServiceHelper;

/** Creates one reusable task display through Shizuku's system-display binder. */
final class VirtualDisplayController {
    static final String PREF_ENABLED = "useVirtualDisplayForTasks";
    private static final String DISPLAY_NAME = "DHA 任务副屏";

    private static final int FLAG_SUPPORTS_TOUCH = 1 << 6;
    private static final int FLAG_ROTATES_WITH_CONTENT = 1 << 7;
    private static final int FLAG_TRUSTED = 1 << 10;
    private static final int FLAG_OWN_DISPLAY_GROUP = 1 << 11;
    private static final int FLAG_ALWAYS_UNLOCKED = 1 << 12;
    private static final int FLAG_TOUCH_FEEDBACK_DISABLED = 1 << 13;
    private static final int FLAG_OWN_FOCUS = 1 << 14;
    private static final int FLAG_DEVICE_DISPLAY_GROUP = 1 << 15;

    private static ActiveDisplay active;

    private VirtualDisplayController() {
    }

    static boolean enabled() {
        return App.i().prefs.getBoolean(PREF_ENABLED, false);
    }

    static synchronized int setEnabled(Context context, boolean enabled) throws Exception {
        App.i().prefs.edit().putBoolean(PREF_ENABLED, enabled).apply();
        if (enabled) {
            try {
                return ensureCreated(context);
            } catch (Throwable error) {
                App.i().prefs.edit().putBoolean(PREF_ENABLED, false).apply();
                release();
                throw error;
            }
        }
        release();
        return 0;
    }

    static synchronized int ensureCreated(Context context) throws Exception {
        if (active != null) return active.displayId;
        if (!ShizukuBridge.available()) throw new IllegalStateException("使用虚拟副屏需要先启动 Shizuku");
        if (!ShizukuBridge.granted()) throw new IllegalStateException("使用虚拟副屏需要授予 Shizuku 权限");

        HiddenApiBypass.addHiddenApiExemptions(
                "Landroid/hardware/display/",
                "Landroid/media/projection/");
        IDisplayManager manager = IDisplayManager.Stub.asInterface(
                new ShizukuBinderWrapper(SystemServiceHelper.getSystemService(Context.DISPLAY_SERVICE)));
        DisplayManager displayManager =
                (DisplayManager) context.getSystemService(Context.DISPLAY_SERVICE);
        android.view.Display physical = displayManager == null
                ? null : displayManager.getDisplay(android.view.Display.DEFAULT_DISPLAY);
        Point natural = new Point();
        if (physical != null) physical.getRealSize(natural);
        int naturalWidth = physical == null
                ? context.getResources().getDisplayMetrics().widthPixels : Math.min(natural.x, natural.y);
        int naturalHeight = physical == null
                ? context.getResources().getDisplayMetrics().heightPixels : Math.max(natural.x, natural.y);
        int width = Math.max(720, Math.min(naturalWidth, 1080));
        int height = Math.max(1280, Math.min(naturalHeight, 2400));
        int density = Math.max(240, context.getResources().getDisplayMetrics().densityDpi);
        ImageReader reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        IVirtualDisplayCallback callback = new IVirtualDisplayCallback.Stub() {
            @Override public void onPaused() { }
            @Override public void onResumed() { }
            @Override public void onStopped() { }
        };
        int flags = DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC
                | DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY
                | FLAG_SUPPORTS_TOUCH
                | FLAG_ROTATES_WITH_CONTENT
                | FLAG_TRUSTED
                | FLAG_OWN_DISPLAY_GROUP
                | FLAG_ALWAYS_UNLOCKED
                | FLAG_TOUCH_FEEDBACK_DISABLED
                | FLAG_OWN_FOCUS
                | FLAG_DEVICE_DISPLAY_GROUP;
        VirtualDisplayConfig config = new VirtualDisplayConfig.Builder(
                DISPLAY_NAME, width, height, density)
                .setSurface(reader.getSurface())
                .setFlags(flags)
                .setRequestedRefreshRate(30f)
                .build();
        int id;
        try {
            id = manager.createVirtualDisplay(
                    config,
                    callback,
                    (IMediaProjection) null,
                    "com.android.shell");
        } catch (Throwable error) {
            reader.close();
            throw error;
        }
        if (id <= 0) {
            reader.close();
            throw new IllegalStateException("系统没有返回有效的虚拟副屏编号");
        }
        active = new ActiveDisplay(id, manager, callback, reader);
        App.log("virtual display created: id=" + id + " " + width + "x" + height);
        return id;
    }

    static synchronized int ensureIfEnabled(Context context) {
        if (!enabled()) return 0;
        try {
            return ensureCreated(context);
        } catch (Throwable error) {
            App.log("virtual display unavailable: " + error);
            return 0;
        }
    }

    static synchronized void release() {
        ActiveDisplay previous = active;
        active = null;
        if (previous == null) return;
        try {
            previous.manager.releaseVirtualDisplay(previous.callback);
        } catch (Throwable ignored) {
        }
        previous.reader.close();
        App.log("virtual display released: id=" + previous.displayId);
    }

    static synchronized int displayId() {
        return active == null ? 0 : active.displayId;
    }

    static String launchApp(Context context, String packageName) throws Exception {
        int displayId = ensureCreated(context);
        PackageManager packages = context.getPackageManager();
        Intent launch = packages.getLaunchIntentForPackage(packageName);
        if (launch == null) throw new IllegalStateException("应用没有可启动入口");
        ComponentName component = launch.getComponent();
        if (component == null) throw new IllegalStateException("无法解析应用启动组件");
        String command = "am start --display " + displayId
                + " -f 0x18000000 -n " + quote(component.flattenToString());
        ShizukuBridge.Result result = ShizukuBridge.exec(command, 15000);
        String output = result.stdout + result.stderr;
        if (result.exitCode != 0 || output.contains("Error:") || output.contains("Exception")) {
            throw new IllegalStateException("副屏启动失败：" + output.trim());
        }
        App.log("virtual display launch: " + packageName + " on " + displayId);
        return "已在虚拟副屏打开 " + packageName;
    }

    static void injectTap(int displayId, float x, float y) throws Exception {
        ShizukuBridge.Result result = ShizukuBridge.exec(
                "input -d " + displayId + " tap " + Math.round(x) + " " + Math.round(y), 5000);
        if (result.exitCode != 0) throw new IllegalStateException(result.stderr.trim());
    }

    static void injectSwipe(int displayId, float x1, float y1, float x2, float y2, long ms)
            throws Exception {
        ShizukuBridge.Result result = ShizukuBridge.exec(
                "input -d " + displayId + " swipe " + Math.round(x1) + " " + Math.round(y1)
                        + " " + Math.round(x2) + " " + Math.round(y2) + " " + Math.max(80, ms),
                7000);
        if (result.exitCode != 0) throw new IllegalStateException(result.stderr.trim());
    }

    static void injectKey(int displayId, String key) throws Exception {
        ShizukuBridge.Result result = ShizukuBridge.exec(
                "input -d " + displayId + " keyevent " + key, 5000);
        if (result.exitCode != 0) throw new IllegalStateException(result.stderr.trim());
    }

    private static String quote(String value) {
        return "'" + value.replace("'", "'\\''") + "'";
    }

    private static final class ActiveDisplay {
        final int displayId;
        final IDisplayManager manager;
        final IVirtualDisplayCallback callback;
        final ImageReader reader;

        ActiveDisplay(int displayId, IDisplayManager manager,
                      IVirtualDisplayCallback callback, ImageReader reader) {
            this.displayId = displayId;
            this.manager = manager;
            this.callback = callback;
            this.reader = reader;
        }
    }
}

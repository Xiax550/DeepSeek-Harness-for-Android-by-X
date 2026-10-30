package com.dha.harness;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Space;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import java.util.List;

/**
 * The app's only native surface: a control panel for the sandbox.
 *
 * It is a slide-in drawer rather than a screen with a title bar, because the
 * harness Web UI is the application; this exists for the things a Web UI
 * cannot do for itself (install/import rootfs, start/stop the PRoot process,
 * read the server log, set the API key).
 */
public final class Panel {

    public interface Host {
        /* Deliberately not named onStart/onStop/onRestart: those are Activity
         * lifecycle methods, and a same-named interface method would silently
         * become an override that skips super — which is exactly what crashed
         * the first build. */
        void startServer();

        void stopServer();

        void restartServer();

        void onOpenInBrowser();

        void onImport();

        void onSelectDistro(String id);

        void onDeleteDistro(String id);

        void onSaveSettings();

        void onClose();

        /**
         * One of the grants the phone-assistant feature needs. The activity owns
         * the dialogs and the settings pages; the bridge only names what is
         * missing (`/a11y/request`, `/overlay/request`, `/mic/request`).
         *
         * @param which one of {@link Assist#PERMISSION_ACCESSIBILITY},
         *              {@link Assist#PERMISSION_OVERLAY},
         *              {@link Assist#PERMISSION_MICROPHONE}
         */
        void onAssistPermission(int which);

        /** Open the file picker so the user can apply a hot package by hand. */
        void onHotPickRequested();

        /** Open the file picker for the floating ball's picture. */
        void onBallImageRequested();

        /** Re-push the page-enhancement switches into the page. */
        void onAppearanceChanged();

        /**
         * Recovery mode: the way in when the harness itself is what broke.
         *
         * Four calls instead of one, because each does something different to the
         * sandbox (start it as a shell host, go back to the harness, mint a new
         * secret, or just show the console) and the panel should own nothing but
         * the labels.
         */
        void enterRecovery();

        void exitRecovery();

        void rotateRecoveryToken();

        void openRecoveryConsole();
    }

    // Resolved from resources, so values-night/ decides light vs dark. The app
    // follows the system theme rather than forcing one of its own.
    private final int BG;
    private final int CARD;
    private final int TEXT;
    private final int MUTED;
    private final int ACCENT;
    private final int DANGER;
    private final int OK;

    public final View view;

    private final Context ctx;
    private final Host host;
    private final LinearLayout body;
    private final TextView status;
    private final TextView address;
    private final LinearLayout distroList;
    private final EditText command;
    private final EditText port;
    private final EditText apiKey;
    private final TextView logView;
    private final TextView progress;
    private final TextView recoveryStatus;
    private final TextView recoveryCommand;
    private final Button recoveryEnter;
    private final Button recoveryExit;
    private final Button recoveryConsole;
    private final EditText updateUrl;
    private Switch virtualDisplaySwitch;
    private Switch edgeTtsSwitch;

    private String editingDistro = App.BUNDLED_ID;

    public Panel(Context ctx, Host host) {
        this.ctx = ctx;
        this.host = host;
        this.BG = ctx.getResources().getColor(R.color.console_background);
        this.CARD = ctx.getResources().getColor(R.color.console_card);
        this.TEXT = ctx.getResources().getColor(R.color.console_text);
        this.MUTED = ctx.getResources().getColor(R.color.console_muted);
        this.ACCENT = ctx.getResources().getColor(R.color.console_accent);
        this.DANGER = ctx.getResources().getColor(R.color.console_danger);
        this.OK = ctx.getResources().getColor(R.color.console_ok);

        LinearLayout column = new LinearLayout(ctx);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setBackgroundColor(BG);

        // --- header: status + close, no app title -------------------------
        LinearLayout header = new LinearLayout(ctx);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(16), dp(14), dp(8), dp(10));
        status = new TextView(ctx);
        status.setTextSize(15);
        status.setTypeface(Typeface.DEFAULT_BOLD);
        status.setTextColor(TEXT);
        header.addView(status, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Button close = ghost("✕");
        close.setOnClickListener(v -> host.onClose());
        header.addView(close);
        column.addView(header);

        address = new TextView(ctx);
        address.setTextSize(12);
        address.setTextColor(MUTED);
        address.setPadding(dp(16), 0, dp(16), dp(10));
        column.addView(address);

        ScrollView scroll = new ScrollView(ctx);
        body = new LinearLayout(ctx);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(dp(16), 0, dp(16), dp(24));
        scroll.addView(body);
        column.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // --- server controls ---------------------------------------------
        LinearLayout row = row();
        row.addView(action("启动", () -> host.startServer()), weight());
        row.addView(action("停止", () -> host.stopServer()), weight());
        row.addView(action("重启", () -> host.restartServer()), weight());
        body.addView(row);
        LinearLayout row2 = row();
        row2.addView(action("在浏览器打开", () -> host.onOpenInBrowser()), weight());
        row2.addView(action("导入 rootfs", () -> host.onImport()), weight());
        body.addView(row2);

        // --- recovery -------------------------------------------------------
        // First thing under the server buttons, because the states that need it
        // are the states where nothing else on this screen can help.
        body.addView(section("恢复模式（harness 起不来时用）"));
        recoveryStatus = hint("");
        recoveryStatus.setTextSize(12);
        body.addView(recoveryStatus);

        LinearLayout recoveryRow = row();
        recoveryEnter = action("进入恢复模式", () -> host.enterRecovery());
        recoveryExit = action("退出恢复模式", () -> host.exitRecovery());
        recoveryConsole = action("手机内控制台", () -> host.openRecoveryConsole());
        recoveryRow.addView(recoveryEnter, weight());
        recoveryRow.addView(recoveryExit, weight());
        recoveryRow.addView(recoveryConsole, weight());
        body.addView(recoveryRow);

        recoveryCommand = new TextView(ctx);
        recoveryCommand.setTextSize(11);
        recoveryCommand.setTextColor(MUTED);
        recoveryCommand.setTypeface(Typeface.MONOSPACE);
        recoveryCommand.setTextIsSelectable(true);
        recoveryCommand.setPadding(dp(10), dp(10), dp(10), dp(10));
        recoveryCommand.setBackground(rounded(CARD, 8));
        body.addView(recoveryCommand);

        LinearLayout recoveryRow2 = row();
        recoveryRow2.addView(action("复制 SSH 信息", () -> copyRecovery()), weight());
        recoveryRow2.addView(action("换新令牌", () -> host.rotateRecoveryToken()), weight());
        body.addView(recoveryRow2);
        body.addView(toggle("harness 连续失败后自动进入恢复模式", "recoveryAuto"));
        body.addView(hint("恢复模式不加载 harness：沙箱里只有 sshd 和一个 shell，"
                + "用来把 profile、依赖或磁盘修回来。令牌只在本次会话有效，退出即失效。"));

        progress = new TextView(ctx);
        progress.setTextSize(12);
        progress.setTextColor(ACCENT);
        progress.setPadding(0, dp(8), 0, 0);
        body.addView(progress);

        // --- distros -------------------------------------------------------
        body.addView(section("发行版"));
        distroList = new LinearLayout(ctx);
        distroList.setOrientation(LinearLayout.VERTICAL);
        body.addView(distroList);

        body.addView(section("启动命令"));
        command = field("", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        command.setMinLines(2);
        body.addView(command);
        body.addView(action("保存并应用", () -> {
            Distros.setCommand(editingDistro, command.getText().toString());
            host.onSaveSettings();
        }));

        // --- settings ------------------------------------------------------
        body.addView(section("设置"));
        body.addView(hint("端口（dsh Web UI 监听端口）"));
        port = field("3080", InputType.TYPE_CLASS_NUMBER);
        body.addView(port);
        body.addView(hint("DeepSeek API Key（以环境变量 DEEPSEEK_API_KEY 注入沙箱，可留空）"));
        apiKey = field("", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        LinearLayout apiKeyRow = row();
        apiKeyRow.addView(apiKey, weight());
        // Keys are long and impossible to retype from memory, so pasting has to be one tap
        // instead of relying on the field's own long-press menu.
        apiKeyRow.addView(action("粘贴", this::pasteApiKey));
        body.addView(apiKeyRow);
        body.addView(toggle("共享手机存储到 /sdcard", "shareStorage"));
        body.addView(toggle("后台保活（持续持有 WakeLock，会增加耗电）", "keepAwake"));
        body.addView(toggle("异常退出后自动重启服务", "autoRestart"));
        body.addView(toggle("无障碍掉线后自动恢复（保留 GKD）",
                AccessibilityGuardian.PREF_AUTO_REPAIR));
        body.addView(hint("需要 Shizuku 已授权。后台只补回 DHA，GKD 和其他无障碍服务保持原样；"
                + "关闭此开关后不再自动写入系统设置。"));
        virtualDisplaySwitch = new Switch(ctx);
        virtualDisplaySwitch.setText("启用虚拟副屏（需要 Shizuku）");
        virtualDisplaySwitch.setTextSize(13);
        virtualDisplaySwitch.setTextColor(TEXT);
        virtualDisplaySwitch.setPadding(0, dp(6), 0, dp(6));
        virtualDisplaySwitch.setChecked(VirtualDisplayController.enabled());
        body.addView(virtualDisplaySwitch);
        body.addView(hint("开启后创建后台任务屏幕；应用启动、读屏、点击和滑动都在副屏执行，主屏保持可用。"));
        edgeTtsSwitch = new Switch(ctx);
        edgeTtsSwitch.setText("完成、需授权或失败时播放 Edge 语音提示");
        edgeTtsSwitch.setTextSize(13);
        edgeTtsSwitch.setTextColor(TEXT);
        edgeTtsSwitch.setPadding(0, dp(6), 0, dp(6));
        edgeTtsSwitch.setChecked(EdgeTts.enabled());
        body.addView(edgeTtsSwitch);
        body.addView(action("测试 Edge 朗读", () -> EdgeTts.speak(ctx, EdgeTts.testText())));
        body.addView(hint("Edge 朗读需要联网；语音由 Microsoft Edge 的在线 Read Aloud 服务生成。"));
        body.addView(action("保存设置", () -> {
            if (saveSettings()) host.onSaveSettings();
        }));

        body.addView(hint("更新源（可留空）。本分支默认不跟随上游：上游的包签名与本应用不同，"
                + "检查它只会得到装不上的 APK。若你把自己的 update.json 发布出来，填在这里。"));
        updateUrl = field(Updates.configuredUrl() == null ? "" : Updates.configuredUrl(),
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        updateUrl.setHint("https://…/update.json");
        body.addView(updateUrl);
        body.addView(action("保存更新源", () -> {
            String value = updateUrl.getText().toString().trim();
            if (!value.isEmpty() && !value.startsWith("https://")) {
                Toast.makeText(ctx, "只接受 https 地址", Toast.LENGTH_SHORT).show();
                return;
            }
            Updates.setConfiguredUrl(value);
            Toast.makeText(ctx, value.isEmpty() ? "已清空更新源" : "更新源已保存", Toast.LENGTH_SHORT)
                    .show();
        }));

        // --- appearance -----------------------------------------------------
        body.addView(hint("配色请在 harness 里改：「设置 → 通用设置 → 外观」有浅色 / 深色 / 跟随系统。"
                + "那是 harness 自己的实现，本应用不再重复提供一套覆盖。"));
        body.addView(hint("（早先这里有过一套实验性的外观覆盖：把 harness 的设计变量以 !important "
                + "写进页面。它能用，但属于对页面内部的深度干预，且实测曾让 WebView 渲染进程崩溃，"
                + "而 harness 自带的外观已经完全够用，因此已移除。）"));

        body.addView(section("页面增强"));
        Switch pasteSwitch = new Switch(ctx);
        pasteSwitch.setText("在密钥输入框旁加「粘贴」按钮");
        pasteSwitch.setTextSize(13);
        pasteSwitch.setTextColor(TEXT);
        pasteSwitch.setPadding(0, dp(6), 0, dp(6));
        pasteSwitch.setChecked(PageTools.pasteButton());
        pasteSwitch.setOnCheckedChangeListener((v, checked) -> {
            PageTools.setPasteButton(checked);
            host.onAppearanceChanged();
        });
        body.addView(pasteSwitch);

        Switch shortcutsSwitch = new Switch(ctx);
        shortcutsSwitch.setText("隐藏「通用设置」里的快捷键项");
        shortcutsSwitch.setTextSize(13);
        shortcutsSwitch.setTextColor(TEXT);
        shortcutsSwitch.setPadding(0, dp(6), 0, dp(6));
        shortcutsSwitch.setChecked(PageTools.hideShortcuts());
        shortcutsSwitch.setOnCheckedChangeListener((v, checked) -> {
            PageTools.setHideShortcuts(checked);
            host.onAppearanceChanged();
        });
        body.addView(shortcutsSwitch);
        body.addView(hint("手机没有物理键盘，快捷键设置没有意义，默认隐藏。"));

        body.addView(hint("harness 的这个按钮在安卓上必然失败：它最后要调用 Linux 的 xdg-open，"
                + "而沙箱里没有这个程序、也没有桌面环境，所以只会报「无法打开配置文件」。"
                + "因此已固定隐藏。"));

        // Theme mode as pills rather than a RadioGroup: the default radio drawable is a
        // light-mode widget and reads as a foreign control inside this dark panel.
        body.addView(hint("主题模式"));
        // --- log -----------------------------------------------------------
        body.addView(section("日志"));
        logView = new TextView(ctx);
        logView.setTextSize(10);
        logView.setTextColor(MUTED);
        logView.setTypeface(Typeface.MONOSPACE);
        logView.setTextIsSelectable(true);
        logView.setPadding(dp(10), dp(10), dp(10), dp(10));
        logView.setBackground(rounded(CARD, 8));
        body.addView(logView);
        body.addView(action("清空日志", () -> {
            App.i().clearServerLog();
            refresh();
        }));

        body.addView(section("关于 DHA"));
        body.addView(hint("作者：" + ctx.getString(R.string.app_author)));
        body.addView(hint("基于 dsh-android 与 DeepSeek Harness；第三方组件保留各自署名和许可证。"));

        view = column;
    }

    // ---------------------------------------------------------------- actions

    /**
     * Put the clipboard's text into the API-key field.
     *
     * Android 10+ hides clipboard contents from background apps but still allows a focused
     * app to read them, and the panel is on screen when this runs, so a plain read is enough.
     * No trimming happens here: whatever is pasted stays visible so the user can see they got
     * the right key, and the trailing whitespace is stripped when the settings are saved.
     */
    private void pasteApiKey() {
        try {
            ClipboardManager manager =
                    (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = manager == null ? null : manager.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) {
                Toast.makeText(ctx, "剪贴板是空的", Toast.LENGTH_SHORT).show();
                return;
            }
            CharSequence text = clip.getItemAt(0).coerceToText(ctx);
            String value = text == null ? "" : text.toString().trim();
            if (value.isEmpty()) {
                Toast.makeText(ctx, "剪贴板里没有文字", Toast.LENGTH_SHORT).show();
                return;
            }
            apiKey.setText(value);
            apiKey.setSelection(value.length());
            Toast.makeText(ctx, "已粘贴 " + value.length() + " 个字符", Toast.LENGTH_SHORT).show();
        } catch (Throwable error) {
            App.log("clipboard paste failed: " + error);
            Toast.makeText(ctx, "读取剪贴板失败：" + error.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private boolean saveSettings() {
        int value;
        try {
            value = Integer.parseInt(port.getText().toString().trim());
        } catch (NumberFormatException ignored) {
            Toast.makeText(ctx, "端口必须是 1 到 65535 的数字", Toast.LENGTH_SHORT).show();
            return false;
        }
        if (value < 1 || value > 65535) {
            Toast.makeText(ctx, "端口必须是 1 到 65535 的数字", Toast.LENGTH_SHORT).show();
            return false;
        }
        try {
            VirtualDisplayController.setEnabled(ctx,
                    virtualDisplaySwitch != null && virtualDisplaySwitch.isChecked());
        } catch (Throwable error) {
            Toast.makeText(ctx, "虚拟副屏启用失败：" + error.getMessage(), Toast.LENGTH_LONG).show();
            if (virtualDisplaySwitch != null) virtualDisplaySwitch.setChecked(false);
            return false;
        }
        App.i().prefs.edit()
                .putInt("port", value)
                .putString("apiKey", apiKey.getText().toString().trim())
                .putBoolean(EdgeTts.PREF_ENABLED,
                        edgeTtsSwitch != null && edgeTtsSwitch.isChecked())
                .apply();
        EdgeTts.setEnabled(edgeTtsSwitch != null && edgeTtsSwitch.isChecked());
        return true;
    }

    // ------------------------------------------------------------------- view


    public void refresh() {
        ServerBus.State state = ServerBus.state();
        String label;
        switch (state) {
            case RUNNING:
                label = "运行中";
                break;
            case STARTING:
                label = "启动中…";
                break;
            case ERROR:
                label = "启动失败";
                break;
            default:
                label = "已停止";
        }
        status.setText(label);
        status.setTextColor(state == ServerBus.State.ERROR ? DANGER
                : state == ServerBus.State.RUNNING ? OK : TEXT);
        address.setText(ServerBus.url() == null
                ? (ServerBus.error() == null ? "尚未就绪" : ServerBus.error())
                : ServerBus.url());

        App app = App.i();
        if (port.getText().length() == 0) port.setText(String.valueOf(app.port()));
        apiKey.setText(app.prefs.getString("apiKey", ""));

        distroList.removeAllViews();
        for (Distros.Distro distro : Distros.list(ctx)) {
            LinearLayout card = new LinearLayout(ctx);
            card.setOrientation(LinearLayout.VERTICAL);
            card.setPadding(dp(12), dp(10), dp(12), dp(10));
            card.setBackground(rounded(CARD, 10));

            TextView name = new TextView(ctx);
            name.setTextSize(14);
            name.setTextColor(TEXT);
            name.setText((distro.id.equals(app.activeDistroId()) ? "● " : "○ ") + distro.name
                    + (distro.isUsable() ? "" : "（rootfs 不完整）"));
            card.addView(name);

            TextView meta = new TextView(ctx);
            meta.setTextSize(11);
            meta.setTextColor(MUTED);
            meta.setText(distro.id + " · " + distro.root.getAbsolutePath());
            card.addView(meta);

            LinearLayout actions = row();
            actions.setPadding(0, dp(8), 0, 0);
            actions.addView(action("选中", () -> host.onSelectDistro(distro.id)), weight());
            if (!distro.bundled) {
                actions.addView(action("删除", () -> host.onDeleteDistro(distro.id)), weight());
            }
            card.addView(actions);

            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.bottomMargin = dp(8);
            distroList.addView(card, lp);

            if (distro.id.equals(editingDistro)) {
                command.setText(distro.command);
            }
        }

        StringBuilder log = new StringBuilder();
        List<String> lines = ServerBus.log();
        int from = Math.max(0, lines.size() - 120);
        for (int i = from; i < lines.size(); i++) {
            log.append(lines.get(i)).append('\n');
        }
        logView.setText(log.length() == 0 ? "（无输出）" : log.toString());

        Switch share = view.findViewWithTag("shareStorage");
        if (share != null) share.setChecked(app.prefs.getBoolean("shareStorage", true));
        Switch awake = view.findViewWithTag("keepAwake");
        if (awake != null) awake.setChecked(app.prefs.getBoolean("keepAwake", false));
        Switch restart = view.findViewWithTag("autoRestart");
        if (restart != null) restart.setChecked(app.prefs.getBoolean("autoRestart", true));

        // Recovery.
        boolean recovery = Recovery.active();
        recoveryStatus.setText(Recovery.describe());
        recoveryStatus.setTextColor(recovery ? (Recovery.sshReady() ? OK : ACCENT) : MUTED);
        recoveryEnter.setVisibility(recovery ? View.GONE : View.VISIBLE);
        recoveryExit.setVisibility(recovery ? View.VISIBLE : View.GONE);
        recoveryConsole.setVisibility(recovery ? View.VISIBLE : View.GONE);
        recoveryCommand.setVisibility(recovery ? View.VISIBLE : View.GONE);
        recoveryCommand.setText(recovery ? recoveryText(app) : "");
        Switch autoRecovery = view.findViewWithTag("recoveryAuto");
        if (autoRecovery != null) autoRecovery.setChecked(Recovery.auto());
        if (virtualDisplaySwitch != null) {
            virtualDisplaySwitch.setChecked(VirtualDisplayController.enabled());
        }
        if (edgeTtsSwitch != null) edgeTtsSwitch.setChecked(EdgeTts.enabled());
    }

    /**
     * The block the user reads off the screen — or copies — to get in.
     *
     * Three routes, in the order they are worth trying: the same Wi-Fi (no cable,
     * no computer-side setup), USB through adb (works when the phone is on
     * mobile data), and the on-phone console for when the phone is all there is.
     * The tunnel line is included because restarting the harness from the shell
     * and then reaching it in a *computer's* browser is the faster repair when
     * the phone's own WebView is the thing misbehaving.
     */
    private String recoveryText(App app) {
        String lan = Recovery.lanAddress();
        int port = Recovery.port();
        StringBuilder text = new StringBuilder();
        text.append("密码（本次会话有效）\n  ").append(Recovery.token()).append('\n');
        text.append("用户 root · 端口 ").append(port).append('\n');
        text.append("\n同一 Wi-Fi（在电脑上）\n  ")
                .append(lan == null ? "（没有局域网地址，用下面的 USB 方式）"
                        : RecoveryPlan.sshCommand(lan, port, "root")).append('\n');
        text.append("\nUSB（在电脑上）\n  ").append(RecoveryPlan.adbForward(port)).append('\n');
        text.append("  ").append(RecoveryPlan.sshCommand("127.0.0.1", port, "root")).append('\n');
        if (lan != null) {
            text.append("\n修好 harness 后，从电脑浏览器打开它（端口转发）\n  ")
                    .append(RecoveryPlan.forwardCommand(lan, port, "root", app.activePort()))
                    .append('\n');
        }
        text.append("\n或者直接点「手机内控制台」，在这台手机上开一个 shell。");
        return text.toString();
    }

    private void copyRecovery() {
        try {
            ClipboardManager clipboard =
                    (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
            if (clipboard == null) return;
            clipboard.setPrimaryClip(ClipData.newPlainText("dsh recovery", recoveryText(App.i())));
            Toast.makeText(ctx, "已复制", Toast.LENGTH_SHORT).show();
        } catch (Throwable error) {
            Toast.makeText(ctx, "复制失败：" + error, Toast.LENGTH_SHORT).show();
        }
    }

    public void setEditing(String id) {
        editingDistro = id;
        refresh();
    }

    public void setProgress(String text) {
        progress.setText(text == null ? "" : text);
    }

    // ------------------------------------------------------------------ widgets

    private LinearLayout row() {
        LinearLayout layout = new LinearLayout(ctx);
        layout.setOrientation(LinearLayout.HORIZONTAL);
        return layout;
    }

    private LinearLayout.LayoutParams weight() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        lp.rightMargin = dp(6);
        return lp;
    }

    private TextView section(String text) {
        TextView view = new TextView(ctx);
        view.setText(text);
        view.setTextSize(12);
        view.setTextColor(MUTED);
        view.setPadding(0, dp(18), 0, dp(6));
        return view;
    }

    private TextView hint(String text) {
        TextView view = new TextView(ctx);
        view.setText(text);
        view.setTextSize(11);
        view.setTextColor(MUTED);
        view.setPadding(0, dp(6), 0, dp(2));
        return view;
    }

    private Button action(String label, Runnable run) {
        Button button = new Button(ctx);
        button.setText(label);
        button.setAllCaps(false);
        button.setTextSize(13);
        button.setBackground(rounded(CARD, 8));
        button.setTextColor(TEXT);
        button.setPadding(dp(8), dp(6), dp(8), dp(6));
        button.setOnClickListener(v -> run.run());
        return button;
    }

    private Button ghost(String label) {
        Button button = action(label, () -> {
        });
        button.setBackgroundColor(Color.TRANSPARENT);
        button.setMinWidth(dp(40));
        return button;
    }

    private EditText field(String value, int inputType) {
        EditText edit = new EditText(ctx);
        edit.setText(value);
        edit.setTextSize(13);
        edit.setInputType(inputType);
        edit.setTextColor(TEXT);
        edit.setHintTextColor(MUTED);
        edit.setBackground(rounded(CARD, 8));
        edit.setPadding(dp(10), dp(8), dp(10), dp(8));
        return edit;
    }

    private View toggle(String label, String key) {
        Switch toggle = new Switch(ctx);
        toggle.setText(label);
        toggle.setTextSize(13);
        toggle.setTextColor(TEXT);
        toggle.setTag(key);
        toggle.setPadding(0, dp(6), 0, dp(6));
        boolean defaultValue = !"keepAwake".equals(key);
        toggle.setChecked(App.i().prefs.getBoolean(key, defaultValue));
        toggle.setOnCheckedChangeListener((v, checked) -> {
            App.i().prefs.edit().putBoolean(key, checked).apply();
            if ("keepAwake".equals(key)) DshService.refreshWakeLockSetting();
        });
        return toggle;
    }

    private GradientDrawable rounded(int color, int radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radiusDp));
        return drawable;
    }

    private int dp(int value) {        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value,
                ctx.getResources().getDisplayMetrics());
    }

    public static View spacer(Context ctx, int heightDp) {
        Space space = new Space(ctx);
        space.setLayoutParams(new LinearLayout.LayoutParams(1, heightDp));
        return space;
    }
}

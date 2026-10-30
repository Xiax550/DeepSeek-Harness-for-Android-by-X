package com.dha.harness;

import org.json.JSONArray;
import org.json.JSONObject;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;
import org.xml.sax.InputSource;

import java.io.ByteArrayInputStream;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.xml.parsers.DocumentBuilderFactory;

/**
 * Selects the phone-input transport per action.
 *
 * Accessibility is the only source of semantic labels, so tree reads, label
 * clicks and text replacement prefer it. Direct taps, swipes and keys prefer
 * Shizuku's adb-shell channel when it is granted. Automatic mode falls back to
 * the other channel after an action failure; explicit modes do not.
 */
final class PhoneInput {
    static final String PREF_BACKEND = "phone_input_backend";
    static final String MODE_AUTO = "auto";
    static final String MODE_ACCESSIBILITY = "accessibility";
    static final String MODE_ADB = "adb";

    private static final int MAX_TREE_NODES = 800;
    private static final int MAX_TREE_DEPTH = 50;
    private static final Pattern BOUNDS =
            Pattern.compile("\\[(-?\\d+),(-?\\d+)\\]\\[(-?\\d+),(-?\\d+)\\]");

    private PhoneInput() {
    }

    interface Action {
        String run() throws Exception;
    }

    static final class Output {
        final String backend;
        final String message;

        Output(String backend, String message) {
            this.backend = backend;
            this.message = message;
        }
    }

    static String requestedMode() {
        return normalizeMode(App.i().prefs.getString(PREF_BACKEND, MODE_AUTO));
    }

    static String normalizeMode(String value) {
        return MODE_ACCESSIBILITY.equals(value) || MODE_ADB.equals(value)
                ? value : MODE_AUTO;
    }

    static void setMode(String value) {
        App.i().prefs.edit().putString(PREF_BACKEND, normalizeMode(value)).apply();
    }

    static JSONObject statusJson() {
        JSONObject answer = new JSONObject();
        try {
            boolean accessibility = Assist.available();
            boolean adbGranted = ShizukuBridge.granted();
            boolean virtualDisplay = VirtualDisplayController.displayId() > 0;
            boolean adb = adbGranted;
            answer.put("ok", true);
            answer.put("requested", requestedMode());
            answer.put("accessibility", accessibility);
            answer.put("adb", adb);
            answer.put("adbGranted", adbGranted);
            answer.put("adbInstalled", ShizukuBridge.available());
            answer.put("virtualDisplayActive", virtualDisplay);
            answer.put("effective", effectiveMode(requestedMode(), accessibility, adb));
            answer.put("tapPreference", preferred(MODE_AUTO, "tap", accessibility, adb));
        } catch (Throwable ignored) {
        }
        return answer;
    }

    static JSONObject tree(boolean withText) throws Exception {
        String mode = requestedMode();
        boolean accessibility = Assist.available();
        boolean adb = adbReady();
        List<String> failures = new ArrayList<>();
        for (String backend : ordered(mode, "tree", accessibility, adb)) {
            try {
                JSONObject answer = MODE_ADB.equals(backend)
                        ? adbTree(withText) : accessibilityTree(withText);
                answer.put("backend", backend);
                answer.put("requestedBackend", mode);
                return answer;
            } catch (Exception error) {
                failures.add(backendName(backend) + ": " + errorMessage(error));
                if (!MODE_AUTO.equals(mode)) break;
            }
        }
        throw new IllegalStateException(failureMessage(mode, failures,
                "无障碍服务和 ADB（Shizuku）都不可用"));
    }

    static Output tap(float x, float y) throws Exception {
        if (!Float.isFinite(x) || !Float.isFinite(y) || x < 0 || y < 0) {
            throw new IllegalArgumentException("点击坐标必须是非负有效数字");
        }
        final int px = Math.round(x);
        final int py = Math.round(y);
        return execute("tap",
                () -> {
                    Assist.tap(px, py);
                    return "已点击 " + px + "," + py;
                },
                () -> {
                    runAdb(inputCommand("tap " + px + " " + py), 12000);
                    return "已点击 " + px + "," + py;
                });
    }

    static Output swipe(float x1, float y1, float x2, float y2, long ms) throws Exception {
        if (!Float.isFinite(x1) || !Float.isFinite(y1)
                || !Float.isFinite(x2) || !Float.isFinite(y2)
                || x1 < 0 || y1 < 0 || x2 < 0 || y2 < 0) {
            throw new IllegalArgumentException("滑动坐标必须是非负有效数字");
        }
        final int ax = Math.round(x1);
        final int ay = Math.round(y1);
        final int bx = Math.round(x2);
        final int by = Math.round(y2);
        final long duration = Math.min(30000, Math.max(80, ms));
        return execute("swipe",
                () -> {
                    Assist.swipe(ax, ay, bx, by, duration);
                    return "已滑动";
                },
                () -> {
                    runAdb(inputCommand("swipe " + ax + " " + ay + " " + bx + " " + by
                            + " " + duration), 15000);
                    return "已滑动";
                });
    }

    static Output key(String name) throws Exception {
        final String value = name == null ? "" : name;
        return execute("key",
                () -> {
                    Assist.key(value);
                    return "已发送 " + value;
                },
                () -> {
                    runAdb(inputCommand("keyevent " + keyCode(value)), 10000);
                    return "已发送 " + value;
                });
    }

    static Output type(String text) throws Exception {
        final String value = text == null ? "" : text;
        return execute("type",
                () -> {
                    Assist.type(value);
                    return "已输入";
                },
                () -> {
                    String adbText = value.replace("\r", " ").replace("\n", " ").replace(" ", "%s");
                    runAdb(inputCommand("text " + shellQuote(adbText)), 15000);
                    return "已输入";
                });
    }

    static Output click(String label) throws Exception {
        final String value = label == null ? "" : label;
        if (value.trim().isEmpty()) {
            throw new IllegalArgumentException("要点哪个？（按文字匹配）");
        }
        return execute("click",
                () -> Assist.click(value),
                () -> {
                    int[] point = findAdbClickPoint(value);
                    if (point == null) {
                        throw new IllegalStateException("ADB 界面树里没有找到「" + value + "」");
                    }
                    runAdb(inputCommand("tap " + point[0] + " " + point[1]), 12000);
                    return "已点击「" + value + "」";
                });
    }

    private static Output execute(String action, Action accessibility, Action adb) throws Exception {
        String mode = requestedMode();
        boolean accessibilityReady = Assist.available();
        boolean adbAvailable = adbReady();
        List<String> failures = new ArrayList<>();
        for (String backend : ordered(mode, action, accessibilityReady, adbAvailable)) {
            try {
                return new Output(backend, MODE_ADB.equals(backend)
                        ? adb.run() : accessibility.run());
            } catch (Exception error) {
                failures.add(backendName(backend) + ": " + errorMessage(error));
                if (!MODE_AUTO.equals(mode)) break;
            }
        }
        throw new IllegalStateException(failureMessage(mode, failures,
                "没有可用的手机输入通道，请开启无障碍或授权 Shizuku/ADB"));
    }

    private static List<String> ordered(String mode, String action,
                                        boolean accessibility, boolean adb) {
        List<String> answer = new ArrayList<>();
        if (MODE_AUTO.equals(mode)) {
            String first = preferred(mode, action, accessibility, adb);
            if (first != null) answer.add(first);
            if (MODE_ACCESSIBILITY.equals(first) && adb) answer.add(MODE_ADB);
            else if (MODE_ADB.equals(first) && accessibility) answer.add(MODE_ACCESSIBILITY);
            return answer;
        }
        if (MODE_ACCESSIBILITY.equals(mode) && accessibility) answer.add(MODE_ACCESSIBILITY);
        if (MODE_ADB.equals(mode) && adb) answer.add(MODE_ADB);
        return answer;
    }

    private static String preferred(String mode, String action, boolean accessibility, boolean adb) {
        if (MODE_ACCESSIBILITY.equals(mode)) return accessibility ? MODE_ACCESSIBILITY : null;
        if (MODE_ADB.equals(mode)) return adb ? MODE_ADB : null;
        boolean semantic = "tree".equals(action) || "click".equals(action) || "type".equals(action);
        if (semantic) {
            if (accessibility) return MODE_ACCESSIBILITY;
            if (adb) return MODE_ADB;
        } else {
            if (adb) return MODE_ADB;
            if (accessibility) return MODE_ACCESSIBILITY;
        }
        return null;
    }

    private static String effectiveMode(String mode, boolean accessibility, boolean adb) {
        if (!MODE_AUTO.equals(mode)) {
            if (MODE_ACCESSIBILITY.equals(mode) && accessibility) return MODE_ACCESSIBILITY;
            if (MODE_ADB.equals(mode) && adb) return MODE_ADB;
            return "unavailable";
        }
        if (adb) return MODE_ADB;
        if (accessibility) return MODE_ACCESSIBILITY;
        return "unavailable";
    }

    private static String failureMessage(String mode, List<String> failures, String fallback) {
        if (failures.isEmpty()) {
            if (MODE_ACCESSIBILITY.equals(mode)) {
                return "无障碍服务未开启，请在 设置 → 安卓沙箱 → 手机助手 中开启";
            }
            if (MODE_ADB.equals(mode)) {
                return "Shizuku/ADB 未授权，请在 设置 → 安卓沙箱 中授权";
            }
            return fallback;
        }
        return String.join("；", failures);
    }

    private static boolean adbReady() {
        return ShizukuBridge.granted();
    }

    private static String backendName(String backend) {
        return MODE_ADB.equals(backend) ? "ADB" : "无障碍";
    }

    private static String errorMessage(Throwable error) {
        String value = error == null ? "" : error.getMessage();
        return value == null || value.trim().isEmpty() ? String.valueOf(error) : value.trim();
    }

    private static JSONObject accessibilityTree(boolean withText) throws Exception {
        JSONObject answer = new JSONObject(Assist.describe(withText));
        if (!answer.optBoolean("ok", false)) {
            throw new IllegalStateException(answer.optString("error", "无障碍读屏失败"));
        }
        answer.put("source", "accessibility");
        return answer;
    }

    private static JSONObject adbTree(boolean withText) throws Exception {
        Document document = adbDocument();
        Element root = document.getDocumentElement();
        JSONObject answer = new JSONObject();
        JSONArray nodes = new JSONArray();
        collectNodes(root, nodes, withText, 0, new int[]{MAX_TREE_NODES});
        NodeList all = document.getElementsByTagName("node");
        String packageName = "";
        for (int index = 0; index < all.getLength() && packageName.isEmpty(); index++) {
            Element node = (Element) all.item(index);
            packageName = node.getAttribute("package");
        }
        answer.put("ok", true);
        answer.put("source", "uiautomator");
        answer.put("package", packageName);
        answer.put("count", nodes.length());
        answer.put("nodes", nodes);
        return answer;
    }

    private static Document adbDocument() throws Exception {
        if (VirtualDisplayController.displayId() > 0) {
            throw new IllegalStateException("虚拟副屏的界面树需要无障碍；ADB 仅用于副屏坐标操作");
        }
        String command = "P=/data/local/tmp/.dha-ui-$$.xml; "
                + "uiautomator dump \"$P\" >/dev/null 2>&1 && cat \"$P\"; rm -f \"$P\"";
        String xml = runAdb(command, 20000);
        if (!xml.contains("<hierarchy")) {
            throw new IllegalStateException("ADB uiautomator 没有返回界面树");
        }
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        try {
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        } catch (Throwable ignored) {
        }
        javax.xml.parsers.DocumentBuilder builder = factory.newDocumentBuilder();
        builder.setEntityResolver((publicId, systemId) ->
                new InputSource(new StringReader("")));
        return builder.parse(new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8)));
    }

    private static void collectNodes(Element node, JSONArray output, boolean withText,
                                     int depth, int[] budget) {
        if (depth > MAX_TREE_DEPTH || budget[0] <= 0) return;
        budget[0]--;
        String text = nodeText(node);
        boolean actionable = bool(node, "clickable") || bool(node, "long-clickable")
                || bool(node, "scrollable") || bool(node, "checkable")
                || "true".equals(node.getAttribute("enabled")) && isEditableClass(node);
        if (actionable || (withText && !text.isEmpty())) {
            try {
                JSONObject row = new JSONObject();
                if (!text.isEmpty()) row.put("text", text);
                row.put("class", shortClass(node.getAttribute("class")));
                String id = node.getAttribute("resource-id");
                if (!id.isEmpty()) row.put("id", id);
                int[] box = bounds(node.getAttribute("bounds"));
                if (box != null) {
                    row.put("at", new JSONArray(new int[]{
                            (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
                    }));
                    row.put("box", new JSONArray(box));
                }
                JSONArray can = new JSONArray();
                if (bool(node, "clickable")) can.put("click");
                if (bool(node, "long-clickable")) can.put("long");
                if (isEditableClass(node)) can.put("edit");
                if (bool(node, "scrollable")) can.put("scroll");
                if (bool(node, "checkable")) can.put("check");
                if (bool(node, "enabled")) can.put("enabled");
                if (bool(node, "focused")) can.put("focused");
                row.put("can", can);
                output.put(row);
            } catch (Throwable ignored) {
            }
        }
        NodeList children = node.getChildNodes();
        for (int index = 0; index < children.getLength() && budget[0] > 0; index++) {
            Node child = children.item(index);
            if (child instanceof Element) {
                collectNodes((Element) child, output, withText, depth + 1, budget);
            }
        }
    }

    private static int[] findAdbClickPoint(String label) throws Exception {
        Element root = adbDocument().getDocumentElement();
        int[] best = new int[]{Integer.MIN_VALUE, Integer.MIN_VALUE};
        long[] area = new long[]{Long.MAX_VALUE};
        findLabel(root, label, 0, best, area);
        return best[0] == Integer.MIN_VALUE ? null : best;
    }

    private static void findLabel(Element node, String label, int depth,
                                  int[] best, long[] bestArea) {
        if (depth > MAX_TREE_DEPTH) return;
        String text = nodeText(node);
        if (text.contains(label)) {
            Element target = node;
            Element cursor = node;
            for (int level = 0; level < 6 && cursor != null; level++) {
                if (bool(cursor, "clickable")) {
                    target = cursor;
                    break;
                }
                Node parent = cursor.getParentNode();
                cursor = parent instanceof Element ? (Element) parent : null;
            }
            int[] box = bounds(target.getAttribute("bounds"));
            if (box != null) {
                long candidateArea = (long) (box[2] - box[0]) * (box[3] - box[1]);
                if (candidateArea > 0 && candidateArea < bestArea[0]) {
                    bestArea[0] = candidateArea;
                    best[0] = (box[0] + box[2]) / 2;
                    best[1] = (box[1] + box[3]) / 2;
                }
            }
        }
        NodeList children = node.getChildNodes();
        for (int index = 0; index < children.getLength(); index++) {
            Node child = children.item(index);
            if (child instanceof Element) {
                findLabel((Element) child, label, depth + 1, best, bestArea);
            }
        }
    }

    private static String runAdb(String command, long timeoutMs) throws Exception {
        ShizukuBridge.Result result = ShizukuBridge.exec(command, timeoutMs);
        if (result.error != null && !result.error.trim().isEmpty()) {
            throw new IllegalStateException(result.error);
        }
        if (result.exitCode != 0) {
            String detail = result.stderr == null ? "" : result.stderr.trim();
            if (detail.isEmpty()) detail = "exit " + result.exitCode;
            throw new IllegalStateException(detail);
        }
        return result.stdout == null ? "" : result.stdout.trim();
    }

    private static String inputCommand(String arguments) {
        int displayId = VirtualDisplayController.displayId();
        return "input " + (displayId > 0 ? "-d " + displayId + " " : "") + arguments;
    }

    private static String keyCode(String name) {
        switch (name) {
            case "back": return "4";
            case "home": return "3";
            case "recents":
            case "recent": return "187";
            case "notifications":
            case "shade": return "83";
            case "lock": return "26";
            default: throw new IllegalArgumentException(
                    "不认识的键：" + name + "（back/home/recents/notifications/lock）");
        }
    }

    private static String shellQuote(String value) {
        return "'" + value.replace("'", "'\\''") + "'";
    }

    private static String nodeText(Element node) {
        String text = node.getAttribute("text");
        if (text.isEmpty()) text = node.getAttribute("content-desc");
        if (text.isEmpty()) text = node.getAttribute("hint");
        return text;
    }

    private static boolean bool(Element node, String name) {
        return "true".equals(node.getAttribute(name));
    }

    private static boolean isEditableClass(Element node) {
        String name = node.getAttribute("class");
        return name.contains("EditText") || name.contains("AutoCompleteTextView");
    }

    private static String shortClass(String name) {
        int dot = name == null ? -1 : name.lastIndexOf('.');
        return dot < 0 ? (name == null ? "" : name) : name.substring(dot + 1);
    }

    private static int[] bounds(String value) {
        Matcher match = BOUNDS.matcher(value == null ? "" : value);
        if (!match.matches()) return null;
        return new int[]{
                Integer.parseInt(match.group(1)),
                Integer.parseInt(match.group(2)),
                Integer.parseInt(match.group(3)),
                Integer.parseInt(match.group(4))
        };
    }
}

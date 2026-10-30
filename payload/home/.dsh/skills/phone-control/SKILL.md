---
name: phone-control
description: Use when the user asks for something that happens on the phone itself rather than inside the sandbox — opening or switching an app, taking a screenshot, seeing what is on screen, changing brightness / volume / Do Not Disturb / rotation, reading notifications, sending text or taps to another app, installing an APK, listing installed apps, reading device state, or reaching any Android system service. Also use for requests phrased as 操作手机 / 看我现在屏幕 / 打开某应用 / 调亮度 / 装这个 APK / 静音 / 截图.
---

# 从沙箱里操作这台手机

沙箱是一个 Linux guest：能读写 `/sdcard`，但碰不到 Android 本身。优先使用统一的
`ui` 通道：自动模式会用无障碍读取语义控件，并在 Shizuku 已授权时用 ADB shell 的
`input` 执行坐标点击、滑动和按键；某个通道失败时会自动切换。`ui status` 会显示当前选择。
只有需要 `pm`、`am`、`settings`、安装 APK 或读系统通知时才用 `shiz`，它把命令交给
**Android 的 shell 用户（uid 2000）** 执行，能力等同于 `adb shell`，但需要用户另装并授权 Shizuku。

## 先确认通道可用

```sh
shiz --status          # installed=true granted=true version=13
```

`granted=false` 时，**让用户去** DSH 应用 → 设置 → 安卓沙箱 → Shizuku → 请求授权。
沙箱里没有任何办法自己拿到这个授权，别尝试绕过，也别反复重试。

## 一条会坑到人的规则

`shiz` 的命令跑在 **Android 上、以 shell 身份**，不是跑在沙箱里：

- 路径是 Android 路径：`/sdcard/Download/x.png`，不是 guest 路径
- 但 guest 的 `/sdcard` **就是**手机的共享存储 —— 在沙箱里 `cp` 过去的文件，Android 工具立刻能看见，
  反过来也一样。这是两边交换文件的唯一通道。
- 没有交互式会话：命令是一次性的，输出被捕获回来。保持命令**简短、非交互**
  （有 20 秒超时；长任务把输出重定向到 `/sdcard` 下的文件再轮询读取）

## 优先用能力，而不是用像素

三层，越靠前越好：

1. **AppFunctions**（Android 16+）—— 意图级别，后台执行，完全不碰屏幕：

   ```sh
   shiz cmd app_function list-app-functions --package com.example
   shiz cmd app_function execute-app-function --package com.example \
     --function doSomething --parameters '{"key":"value"}'
   ```

2. **平台命令** —— `am`、`cmd`、`settings`、`pm`、`dumpsys`。
3. **UI 自动化**（`input tap/swipe/text`、`screencap`）—— 慢、脆，而且**会把屏幕从用户手里抢走**。
   用之前先说明。

## 常用配方（都在这台设备上验过）

| 想做什么 | 命令 |
|---|---|
| 看用户屏幕上是什么 | 优先 `ui screenshot /sdcard/Download/shot.png`；Android 10 及以下再退回 `shiz screencap -p /sdcard/Download/shot.png` |
| 屏幕尺寸（算点击坐标） | `shiz wm size` → `Physical size: 1272x2800` |
| 打开一个 App | `shiz monkey -p com.tencent.mm -c android.intent.category.LAUNCHER 1` |
| 打开链接 / 交给某个 App | `shiz am start -a android.intent.action.VIEW -d 'https://example.com'` |
| 调亮度 | `shiz cmd display get-brightness` / `shiz cmd display set-brightness 0.4`（0–1 浮点） |
| 勿扰开关 | `shiz cmd notification set_dnd on` / `off` / `priority` / `alarms` |
| 机型与系统 | `shiz getprop ro.product.model`、`shiz getprop ro.build.version.release` |
| 电量 | `shiz dumpsys battery` |
| 装了哪些应用 | `shiz pm list packages -3`（第三方）、`shiz pm path <pkg>` |
| 安装 APK | `shiz pm install -r /sdcard/Download/x.apk` |
| 读通知（含标题全文） | `shiz dumpsys notification --noredact \| grep -E "pkg=\|android.title="` |
| 点一下 / 滑动 / 输入文字 | `shiz input tap 636 930`、`shiz input swipe 500 1800 500 400 300`、`shiz input text 'hello%sworld'`（空格写成 `%s`） |
| 按键 | `shiz input keyevent 3`（HOME）、`4`（BACK）、`26`（电源）、`KEYCODE_MEDIA_PLAY_PAUSE` |
| 自己找更多能力 | `shiz cmd -l`、`shiz dumpsys -l`、`shiz cmd <service> help` |

**亮度有个坑**：不要用 `settings put system screen_brightness`。那是设备私有刻度（这台是 0–2047，
而且 `screen_brightness_mode=1` 时——自动亮度开着——写进去根本不生效）。`cmd display set-brightness`
是 0–1 浮点，跨设备一致。改之前先 `get-brightness` 读一下原值，改完告诉用户怎么调回去。

## 分寸（这是用户的手机）

- **不要在用户正用手机的时候抢屏幕**。截图和点击会打断他们 —— 先说清楚要做什么。
- 改了状态（亮度、勿扰、音量）要说明，并给出恢复办法。
- 没有明确要求就不做的：`pm uninstall`、`pm clear`、动锁屏/安全类设置、移动或删除用户文件。
- 用户让你装的 APK 才装。
- 需要 root 的命令会失败 —— 直接说明，不要反复重试。

## 常犯的错

- 把 guest 路径当 Android 路径用。`/root/1/note.md` 是沙箱里的文件，`shiz` 看不到它；
  先 `cp` 到 `/sdcard/...` 再交给 `shiz`。
- `input text` 里的空格要写 `%s`，中文和特殊字符要先转义；能不用 UI 输入就别用。
- 拿 `pm install` 装 `/sdcard` 上的 APK 时忘了 `-r`，覆盖安装会失败。
- 以为可以 `su`。不行，这里没有 root，需要 root 的命令直接说明做不了。
- 跑交互式命令（`top`、`vim`、`adb shell` 之类）。`shiz` 不是终端，一次一条、跑完返回。

## 边界

- 每条命令 20 秒超时；长任务重定向到文件里再读。
- 没有 root，`su` 不存在。
- Shizuku 必须活着：用户重启手机或强停它之后，命令会失败，直到他们重新授权。
- `dumpsys` 输出很大，**永远 grep**，别整段读回来。

## 统一通道：`ui`（自动选择无障碍或 ADB）

`shiz` 快、能装 APK、能改系统设置，但它**看不见界面**。`ui` 在它外面统一了策略：

- `ui tree`、按文字点击和中文输入优先走无障碍，因为只有它能稳定读取语义、设置文本；
- `ui tap`、`ui swipe`、`ui key` 在 Shizuku 已授权时优先走 ADB shell，速度快且不依赖手势回调；
- 自动模式失败时会换另一条通道；也可用 `ui backend` 固定通道。

```sh
ui status                # 输入通道、无障碍/ADB 状态、悬浮球和屏幕尺寸
ui backend auto          # auto / accessibility / adb
ui virtual on|off        # 启用或关闭虚拟副屏
ui tree                  # 当前屏幕的可点/可输入控件（含坐标、控件 id、能做什么）
ui click "发送"           # 按文字点，比坐标稳
ui tap 540 1200          # 按坐标点（坐标从 ui tree 里取）
ui type "晚饭吃啥"        # 往当前输入框输入（不经过输入法，中文安全）
ui key back              # back / home / recents / notifications / lock
ui swipe 540 1800 540 600 300
ui open "微信"            # 按应用名或包名启动
```

用它的顺序建议：

1. `ui tree` 看一眼，别凭猜测坐标；
2. 有文字就用 `ui click "文字"`；
3. 只有图标没有文字时（比如返回箭头、垃圾桶），用 `ui tree` 给出的坐标 `ui tap`；
4. 点完再 `ui tree` 确认结果 —— 界面变了才说明点对了。

**无障碍没开启时**：`ui status` 会显示 `无障碍服务：未开启`。如果 Shizuku/ADB 已授权，
自动模式仍可通过 `uiautomator` 读树并点击；实在需要无障碍时，让用户去
**DSH 应用 → 设置 → 安卓沙箱 → 手机助手 → 开启**，或执行 `ui permission a11y`
（同理 `ui permission overlay` 是悬浮窗、`ui permission mic` 是麦克风）。
不要假装能自己拿到这个权限。

**自动选择规则**：坐标点击、滑动和按键优先 ADB（Shizuku）；读屏、按文字点击和中文输入优先无障碍。
两者都不可用时，`ui status` 会明确显示“不可用”。装 APK、`pm`、`settings`、读系统通知等仍直接
使用 `shiz`。如果用户固定了 `ui backend adb`，ADB 不可用就应说明原因，不要假装已点击。

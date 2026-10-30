# DeepSeek Harness for Android by X

**作者及二次开发维护者：夏侯玲文。** 原项目与第三方组件的作者署名继续保留，见 [AUTHORS.md](AUTHORS.md) 和 [NOTICE.md](NOTICE.md)。

## 开发说明与致谢

本 App 使用 AI 辅助开发。如遇报错，欢迎提交 Issue，但不保证一定修复。作者最近较忙，可能要等以后有时间再处理。

在此感谢 DeepSeek、ChatGPT 大模型在开发过程中提供的协助。

## 项目介绍

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 原样装进安卓手机。
**界面就是 harness 自己的 Web UI，不是重做的客户端。**

- **应用名**：DHA（DeepSeek Harness Android）
- **包名**：`com.dha.harness`
- **版本**：1.2.50（versionCode 10263）
- **底座**：基于 [itiswdwa/dsh-android](https://github.com/itiswdwa/dsh-android) v1.2.1 二次开发
- **签名**：`CN=DHA`（独立正式签名，非 debug）
- **上游与依赖**：包含 DeepSeek Harness、Coopanion 衍生悬浮角色、Shizuku、Vosk 等第三方组件；来源、版本、用途、许可证和未解决事项见 [`DEPENDENCIES.md`](DEPENDENCIES.md) 与 [`THIRD_PARTY.md`](THIRD_PARTY.md)

## 源码与许可

自有代码采用 MIT；APK 同时包含 Apache-2.0、GPL-2.0-or-later、GPL-3.0 和
AGPL-3.0-or-later 组件。PRoot 对应的 OpenMinis 应用提交、PRoot 子模块和
构建脚本已固定在 [`docs/BUILD-PROOT.md`](docs/BUILD-PROOT.md)，发布时同时提供
`proot-src-8cf13e99.tar.gz`。完整的发布边界和仍待生成的最终 payload SBOM
见 [`OPEN_SOURCE_COMPLIANCE.md`](OPEN_SOURCE_COMPLIANCE.md)。

## 这是什么

官方 harness 在电脑上是 `npx @deepseek-ai/dsh web`。本工程把整套运行时
（Ubuntu rootfs + Node + harness）打进一个 APK，用 **PRoot** 在手机里启动，
再用 **WebView** 打开它的界面 —— 所以手机上得到的就是**原样的 harness**：
会话、工具调用、子代理、Agent Teams、workflow、计划模式、技能，与桌面端同一套代码。

另外还带手机本机能力（上游已内置）：

- **手机助手**（无障碍服务）：让 agent 读屏、点击、输入、滑动
- **悬浮球**：常驻语音/文字入口；角色渲染参考 Coopanion，第三方来源和许可证见 [`DEPENDENCIES.md`](DEPENDENCIES.md)
- **内置离线语音**：Vosk 中文 small model 随 APK 提供，不依赖手机系统语音服务
- **喵记忆**：插件市场的跨会话项目记忆已作为本地插件预装
- **手机控制**：`ui` 自动选择无障碍与 Shizuku/ADB：读屏和文字操作优先无障碍，坐标点击、滑动和按键优先 ADB，失败时自动回退
- **沙箱终端**：左侧 `>_` 图标，真 PTY
- **挂载手机文件夹 / 导出文件到 Download**
- **恢复模式**：harness 起不来时也能进沙箱（SSH + shell）

## 架构

```
MainActivity ─ WebView ──HTTP──► 127.0.0.1:3080   harness (node, 沙箱内)
     │
     │  HTTP 127.0.0.1:8399  控制桥（每次启动生成 token）
     ▼
  DshService（前台服务 + WakeLock）─► libproot.so ─► Ubuntu rootfs
                                        ├─ /opt/dsh/node_modules  harness
                                        ├─ /opt/dsh/android/start-dsh.sh
                                        └─ /opt/dsh/android/pty-server.mjs ─► 127.0.0.1:3099
```

PRoot 不建网络命名空间，所以沙箱里的服务对 WebView 就是 `127.0.0.1`。
三个端口都在回环上，各带一个每次启动随机生成的 token。

`targetSdk 28` 是**刻意的**：Android 10 起 SELinux 域由 targetSdk 决定，
只有 legacy 域允许 `execve()` 应用私有目录里的二进制。整套载荷必须从
`filesDir` 执行，所以现代 targetSdk 会换来无法运行。

## 本次二次开发做了什么

| 项目 | 说明 |
|---|---|
| 换包名 | `dev.dsh.android` → `com.dha.harness`（含 Shizuku provider authority、所有 Java 包路径） |
| 换应用名 | `DSH` → `DHA`；无障碍服务名 → `DHA 手机助手`；悬浮球全部文案同步 |
| 换图标 | 使用维护者提供的 `assets/dha-icon-source.png` 生成各密度、亮色/暗色、自适应与通知图标，并移除旧鲸鱼图标引用 |
| 换签名 | 生成独立 `CN=DHA` keystore，不再用上游的 `dshandroid` 口令 |
| Windows 构建 | 上游只有 Linux 版 `build_apk.sh`；本工程新写 `scripts/build_apk.ps1`，在 Windows 上直接驱动 SDK 的 `aapt2.exe`/`javac`/`d8.jar`/`apksigner`，无需 Gradle、无需 WSL |
| 图标生成 | 上游 `render_icon.py` 依赖 `rsvg-convert`；本工程新写 `scripts/make_icons.py` 纯 Python 实现 |
| **原生面板加粘贴按钮** | API Key 太长记不住，面板里给输入框加了「粘贴」按钮（`Panel.pasteApiKey`），一键读剪贴板填入 |
| **修好更新源** | 上游的 update.json 地址指向它自己的仓库；改名时被误改成不存在的仓库，检查更新必然 404。现在默认留空（不跟随上游，避免提示安装签名不同、装不上的包），可在面板里填自己的 update.json |
| **外观覆盖（实验，默认关闭）** | 深色 / 浅色 / 跟随系统 / 自定义背景图 / 主题色。见下 |

**未改动**：harness 本体、Ubuntu rootfs、启动脚本、控制桥（`BridgeServer`）的既有端点、恢复模式、
手机助手（`Assist`/`BallService`）逻辑、载荷版本化与热更新机制。

载荷（`assets/payload.zip`、`assets/payload.manifest`）取自官方发布的 APK，其 sha256
与 `BuildInfo.PAYLOAD_VERSION` 完全一致，因此解包/版本化行为与上游完全相同。

## 外观覆盖：为什么默认关闭

harness 的配色由**内联写在 `<body>` 上的设计变量**决定（见 `dsh-client-ui-layout` 的
`ThemePresenter`），内联样式压过任何样式表，所以要覆盖只能用
`setProperty(name, value, 'important')` 从脚本写，并同步它读的两个属性：

```
data-ds-theme-source  在 <html>   "light" | "dark" | "system"
data-ds-dark-theme    在 <body>   存在即深色
```

同时必须监听这两个属性、在 harness 自己改主题后重新压回去。

这套做法属于**对页面内部的干预**：第一版没有防重入，`paint()` 写内联样式 → 触发监听
`style` 的 observer → 再 `paint()`，无限递归直接把 WebView 渲染进程打崩（安卓侧看到的
是 `Fatal signal 5 (SIGTRAP)` in `Chrome_IOThread`），而且是启动即崩。

现已加上两道保险（`painting` 防重入标志 + 每次触发重置的 `paintBudget` 上限），并且
**默认关闭**：不启用时行为与上游完全一致，只有主动打开「启用外观覆盖」才注入脚本。

自定义背景图同样是干预式的：界面各层本来都是不透明表面，图片会被完全挡住，所以启用背景图时
会把 frame / sidebar / card 等表面改成半透明。图片由控制桥新增的 `GET /background?token=…`
提供（页面源是 `http://127.0.0.1`，`file://` 子资源会被 WebView 拦掉）。

> 状态：内置开关与面板 UI 已完成并编译通过；**启用后的实际观感未在真机上验证**——
> 上一版启用即崩溃，修复后为避免再次崩溃，我没有在验证时打开它。你要用的话请自己打开试，
> 如果又崩，把它关掉即可恢复（设置项存在 SharedPreferences 里，不影响启动）。

## 页面增强（默认开启）

`PageTools.java` 注入两处**很小、纯增量**的 DOM 改动，与 `Appearance` 的深度覆盖分开，
各自的失败路径都被包住（改不动就退化成"没有这个按钮"，不会弄坏页面）：

1. **密钥输入框旁的「粘贴」按钮**。harness 自己的 API 密钥输入框只有长按菜单，
   而密钥没法凭记忆敲。识别规则：`type=password`，或 id/name/placeholder/aria-label
   里含 `api key / secret / token / password / 密钥 / 口令`。
   写入用**原生 setter + 冒泡 input 事件**——React 把值记在节点上，直接赋 `.value`
   会让框架状态留在旧值，看起来粘贴成功、下一次渲染又变回去。
2. **隐藏「通用设置 → 快捷键」**。手机没有物理键盘，这一项没有意义，默认隐藏。

真机日志确认：`page-tools: "page-tools:paste:hide-shortcuts"`，
截图确认「添加一个 API Key 开始使用」弹窗里输入框下方出现了「粘贴」按钮。

## 已知未修复

- **自定义背景图**：`Appearance` 里的图片选择、透明度预设都在，但外观覆盖默认关闭，
  且未在真机验证过启用后的观感。
- **返回键**：已接线（见下），但**未在真机手动按过**——面板/弹窗的判定逻辑只做了静态推演。

## 页面增强的两个后续项（本轮加入）

| 项 | 做法 |
|---|---|
| 隐藏「打开配置文件」 | 该功能在安卓上必然失败（见上），按按钮文字精确匹配后隐藏整行，不再留一个总是报错的入口 |
| 返回键回到上一层 | `MainActivity.onBackPressed` 本来就会调用 `window.__dshmBack`，但**页面上从来没人实现它**，所以永远落到"退出 App"。现在 `PageTools` 注册了这个钩子：检测 harness 的模态层（`[role=dialog][aria-modal=true]` / `[role=menu]`，即 `useModalLayer` 注册的那些），有就发送 Escape 关掉并返回 `true`，没有则返回 `false` 让 App 退出 |

真机日志：`page-tools: "page-tools:paste,hide-shortcuts,hide-config"` —— 三项都生效且未崩溃。

## 本轮真机实测记录（全部由 adb 操作 + 截图核对）

| 项 | 结果 |
|---|---|
| 安装 / 启动 / 不崩溃 | ✅ 无 `Fatal signal`、无 `FATAL EXCEPTION`；PRoot + Node 全栈在跑 |
| 三条注入规则生效 | ✅ `page-tools: "page-tools:paste,hide-shortcuts,hide-config"` |
| **粘贴按钮** | ✅ 截图确认出现在「添加一个 API Key 开始使用」弹窗的输入框**右侧内部** |
| **返回键** | ✅ 在「通用设置」按返回 → 弹层关闭、回到主界面、**App 未退出** |
| harness 原生外观 | ✅ 发现 harness「通用设置」**自带** 浅色/深色/跟随系统 + 字号 + 工作步骤展示 |
| 原生面板主题 | ✅ 面板整体沿用 harness 配色，文字与卡片一致 |

### 粘贴按钮为什么会"消失"，以及真正的修法

第一版把按钮 **append 到输入框自己的容器里**。那个容器是 React 管的，下一次渲染就被整个
替换掉——按钮出现一下又没了，正是用户看到的现象。

现在改成：按钮 **挂在 `<body>` 上、用 `position:fixed` 定位到输入框右内侧**。它在 React
树之外，所以渲染不会带走它；`positionAll()` 跟着输入框的 `getBoundingClientRect()` 走，
滚动和重排都能跟上；只有当整个子树被替换时，`scan()` 才会重新补一个。

> 原生面板的 pill 按钮（外观模式、背景强度）**未能在真机上看到**：面板按钮在 harness
> 运行时会被刻意隐藏（`syncConsoleVisibility`），只剩启动那一两秒的窗口，多次尝试都没赶上。

## 已移除：实验性的外观覆盖

实测发现 harness 的「通用设置 → 外观」**自带** 浅色 / 深色 / 跟随系统（还有字号、工作步骤
展示），功能完整且由上游维护。本工程那套「外观覆盖」是重复造轮子，而且它的实现方式
（把设计变量以 `!important` 写进页面 + 监听主题变化）实测**曾让 WebView 渲染进程崩溃**。

因此本轮把它整块删掉了：面板里的「启用外观覆盖 / 主题模式 / 背景图片 / 背景强度 / 主题色」
UI 全部移除，`applyAppearance()` 现在只注入 `PageTools`。`Appearance.java` 暂时保留为
**未被引用的死代码**（下一轮可一并删除），判据是真机日志：

```
page-tools: "page-tools:paste,hide-shortcuts,hide-config"   ← 生效
appearance: 0 条                                             ← 覆盖已不再注入
```

面板里改为留一段说明，指引用户去 harness 自己的外观设置。

## 默认工作区：根因已确认，修法已在真机验证

巡检时页面出现错误提示：

> **无法创建默认工作区，请通过"选择工作区"选择文件夹**

### 根因（确证）

harness 解析首次使用的目录时，在 Linux 分支调用 **`xdg-user-dir DOCUMENTS`**：

```
@deepseek-ai/dsh-client-ui-workspace  initializeDefaultWorkspace()
  → @deepseek-ai/dsh-api-workspace-controller  initializeDefault()
    → defaultWorkspaceDirectory()  →  run("xdg-user-dir", ["DOCUMENTS"])
      → @deepseek-ai/dsh-workspace  initializeDefault()
        → mkdir(path) / realpathNormalize(path) 抛错
  → 通知 defaultWorkspaceFailed  → 界面弹出上面那条提示
```

**PRoot 沙箱里没有 `xdg-user-dir`**（没有桌面会话、没有 xdg-user-dirs），这条调用必然 ENOENT。
与「打开配置文件」是**同一类问题**：harness 走了桌面 Linux 的路径，而这里是安卓。

> 更正一次误判：我一度以为 `dsh-home-seed` 没被应用。实际 `run/home/.dsh/profiles/web/`
> 是完整的（含 `package.json` / `cordis.yml` / `node_modules`），是我第一次 `ls` 输出被截断。
> 结论以本条为准。

### 修法

新增 `payload/usr/local/bin/xdg-user-dir`：把已知目录名映射到应用沙箱中的 `/root`，
即应用存储的 bind mount，可写且持久）。选它而不是配置覆盖，因为它修的是**一类**问题
（其他依赖 xdg 工具的功能同样受益），harness 也继续走自己的正常代码路径。
`usr/local/bin/` 本就在热更新白名单内。

### 实测结果（应用等价替身后重启）

```json
"workspaceIds": ["af0abf66-2b0a-4a77-8299-1ab1a17c9c7b"],
"defaultWorkspaceId": "af0abf66-2b0a-4a77-8299-1ab1a17c9c7b",
"path": "/root/deepseek-harness/default-workspace"
```

目录创建成功、会话建立、**错误提示消失**，界面进入正常的首次引导（深色主题）。
根因与修法均已确证。

### 打包通道已修复（本轮）

上一轮替身送不到设备，是**两个问题叠加**，都已修掉：

**① 热包版本戳不随内容变化**

`make_hot_zip.py` 的 `next_sp()` 在 `--base` 模式下**恒定返回 0**，而应用判断
"是否已应用"用的是**版本号相等**（见 `HotVersion.shouldReplay`）。于是同一 app 版本内
重打的 base 热包，内容变了但版本号仍是 `<app>-t<terminal>-sp0`，应用判定"APK 已经带了"
→ **跳过，改动静默丢失**。

修法：`scripts/make_hot_zip_windows.py` 把基包的 `sp` **由内容哈希推导**
（`1000 + int(sha256[:8],16) % 9000`）。同一内容 → 同一版本号（重建不会被当成新更新）；
内容一变 → 版本号必变。顺带让基包 `sp` 大于设备上旧的 `sp0` 记录，
`shouldReplay` 于是正确丢弃过期外部包。本次打出 `version 1.2.1-t3-sp6363`。

**② 构建脚本用的是从官方 APK 抽出来的陈旧 hot.zip**

`build_apk.ps1` 的 `-HotZip` 默认指向 `D:\AI\dsh-ref\official-assets\hot.zip`
（官方那份：300 个文件、`sp0`、时间戳 06:27）。所以即使生成了新热包，打进 APK 的
**仍然是官方旧包**——这正是我第一次核对 APK 内 `hot.json` 看到 `sp0 / 300 files` 的原因。

修法：构建流程现在**每次都从本仓库重新生成**热包（`build/hot-generated.zip` → `assets/hot.zip`）。

### ✅ 端到端验证：替身终于经正常通道送达

```
-rwxr-xr-x 1 u0_a369 u0_a369 2081 2026-10-17 00:33
  .../distros/ubuntu/usr/local/bin/xdg-user-dir
```

文件到位、**可执行**、由修好的热通道写入（无需 root 手工干预），App 无崩溃，
PRoot + Node 正常，端口 3080/8399 在听。

> 仍未完成的一项验证：把设备上的配置绕过移除后，**只靠替身**是否也能建出工作区。
> 工作区初始化由**页面**在首次引导时触发，而用 adb 点那些弹窗没能稳定走到那一步。
> 替身已就位且可执行，机制上一轮用等价配置验证过；这一条需要你点一下「继续」或
> 「选择工作区」来确认。

### 附带修掉

- 设备上残留一个**嵌套的 `run/home/.dsh/.dsh/`**（早期手工播种 `cp -a seed/. target/` 造成），已删除。
- `make_hot_zip.py` 在 Windows 上会先调 `sh scripts/build_linkfix.sh`；Windows 没有 `sh`，
  整条打包流程中断。新增 `scripts/make_hot_zip_windows.py`：复用上游 `add_tree`
  （保证包含规则与执行位不漂移），跳过只属于 Linux 的 linkfix 重建（`liblinkfix.so` 已是仓库成品），
  并**断言**替身确实进包，避免"静默什么都没打进去"。
## 快捷键隐藏：第一版选择器是错的（已修）

第一版用元素自己的 `textContent` 去精确匹配「快捷键」。但那一行的结构是：

```
div.setting
  div.settingText
    div.settingTitle        → 文本正好是「快捷键」
    p.settingDescription    → 还有一段说明
  button                    → 「查看」
```

标题那个 div 的 `textContent` 正好是「快捷键」，而它的每个祖先都是「快捷键 + 说明文字」。
精确匹配标题 → 拿不到「行」；精确匹配行 → 永远不成立。**所以那一行根本没被隐藏。**

**验证手段的限制（重要）**：注入脚本无法用 `uiautomator` 核对——`dump` 只拿到 WebView
的外壳节点，页面 DOM 一律为空（连本来就在的「语言」「外观」都读不到），所以"dump 里没有
快捷键"**不构成证据**。注入逻辑是否生效，只能用**肉眼在设置页确认**，或让脚本把结果回传
（`page-tools` 那行日志只证明脚本执行成功，不证明某一项真的藏住了）。
现在改用 `TreeWalker` 直接定位文本节点，再向上找**最近一个仍含 `button` 的祖先**
作为整行隐藏（harness 的每个设置行都带一个按钮）。

## 悬浮球语音：根因不是设备缺识别服务

设备侧事实：`RECORD_AUDIO` 已授权，但
`cmd package query-services -a android.speech.RecognitionService` 返回 **No services found**，
`voice_recognition_service` 为 `null`。`BallService.startListening()` 第一句就是
`SpeechRecognizer.isRecognitionAvailable()`，为假时提示「这台设备没有可用的语音识别」
——日志里实测到这条。这台 OnePlus 没有 Google 语音服务。

但**更重要的发现：harness 自带离线语音识别，只是没被启用。** 沙箱里已装整套：

```
@deepseek-ai/dsh-experimental-speech-to-text              服务
@deepseek-ai/dsh-experimental-speech-to-text-sensevoice   SenseVoiceSmall + Silero VAD，纯 CPU
@deepseek-ai/dsh-experimental-api-speech-to-text          接口
@deepseek-ai/dsh-experimental-client-ui-voice-input       Web UI 语音输入
@deepseek-ai/dsh-experimental-voice-input-bundle          组装用的 bundle
sherpa-onnx-linux-arm64/libonnxruntime.so                  运行时（自带 ONNX Runtime）
```

而 profile 的 `package.json` 里 `dsh.profile.bundles` **没有列这个 bundle**，整套插件都没被加载。
模型**无需预置**：插件首次启用时自行下载并校验（大小 + SHA-256，多源回退含 hf-mirror）。

修法：把 `@deepseek-ai/dsh-experimental-voice-input-bundle` 加进
`payload/home/.dsh/profiles/web/package.json` 的 `bundles`。真机确认已生效，App 无崩溃。

> **注意**：这修的是 **harness 自己的语音输入**（Web UI 里的录音）。悬浮球长按走的是
> `BallService` 里的安卓 `SpeechRecognizer`，是另一条代码路径，**本次没有改**。
> 要让球上也用离线识别，需要让 `BallService` 改走 harness 的语音服务或
> `/transcriptions` 接口——那是下一步的工作。
## 关于「API Key 弹窗每次都出现」

查了设备上的凭证存储，**不是 bug**：

```
/data/.../run/home/.dsh/.credentials.yaml   →  只有 client-connection/browser-session 一条授权
                                                没有任何 API key 记录
```

也就是说**从来没有保存过 key**（我从没点过「保存并继续」，你那边可能也没成功保存过），
所以引导弹窗每次都出现是正确行为。另外，把 key 填在**原生面板**的
「DeepSeek API Key」里也会生效——它由应用注入沙箱环境变量 `DEEPSEEK_API_KEY`，而
`dsh-credentials-local` 的设计正是**环境变量优先**。所以两条路任选其一：

- harness 里填（写进 `.credentials.yaml`），或
- 原生面板里填（注入环境变量，且不必重启沙箱就能被新会话读到）


## 构建

前置：Android SDK（`build-tools/35.0.0`、`platforms/android-35`）、JDK 17、Python 3 + Pillow。

```powershell
$env:JAVA_HOME    = "<path-to-jdk-17>"
$env:ANDROID_HOME = "<path-to-android-sdk>"
cd <DHA-repository>

# 快速验证工具链（约 2 MB，不带 rootfs）
& (Get-Content scripts\build_apk.ps1 -Raw) -Slim

# 完整 APK（约 320 MB，需先备好载荷，见下）
& (Get-Content scripts\build_apk.ps1 -Raw)
```

> Windows PowerShell 默认禁止运行 `.ps1`。上面用 `Get-Content ... -Raw` 读成
> scriptblock 执行可绕开执行策略；或自行 `Set-ExecutionPolicy -Scope Process RemoteSigned`。

产物：`out\DHA.apk`（完整）/ `out\DHA-slim.apk`（精简壳）

### 载荷来源

完整版需要三个外部文件。默认从 `D:\AI\dsh-ref\official-assets\` 读取：

| 文件 | 大小 | 来源 |
|---|---|---|
| `payload.zip` | 329.85 MB | Ubuntu rootfs + Node + harness，从官方 `dsh-android.apk` 解出 |
| `payload.manifest` | 2.54 MB | zip 里没有 unix 权限与符号链接，单独存一份 |
| `hot.zip` | 1.57 MB | 热更新包 |
| `libproot.so` | 0.25 MB | PRoot arm64 二进制 |

从官方 APK 抽取：

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead("D:\AI\dsh-ref\dsh-android-v1.2.1.apk")
foreach ($n in @("assets/payload.zip","assets/payload.manifest","assets/hot.zip","lib/arm64-v8a/libproot.so")) {
  $e = $z.Entries | Where-Object FullName -eq $n
  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, "D:\AI\dsh-ref\official-assets\" + (Split-Path $n -Leaf), $true)
}
$z.Dispose()
```

官方 APK 与校验值见 <https://github.com/itiswdwa/dsh-android/releases>。

## 首次使用

1. 安装 APK。**首次启动要解包约 400 MB 载荷，约 2 分钟**（本机实测约 65 秒），只此一次。
2. （可选）授权 Shizuku：设置 → 安卓沙箱 → Shizuku。
3. （可选）开启无障碍：让 agent 能直接操作手机。
4. 配置模型：设置 → 模型，填 DeepSeek API Key。
5. 点「选择工作区」选一个目录，然后开始对话。

## 实测结果（OnePlus PLF110 · Android 16 · arm64-v8a）

| 检查项 | 结果 |
|---|---|
| 安装 | ✅ 成功（320 MB，74.5s） |
| 包身份 | ✅ `com.dha.harness` 1.2.1 (10201)，arm64-v8a |
| 签名 | ✅ `CN=DHA` |
| 载荷解包 | ✅ `files/distros` 达 1.0 GB |
| PRoot + Node | ✅ `libproot.so` + 2 个 `node` 进程运行 |
| 三个端口 | ✅ 3080 / 3099 / 8399 均在监听 |
| SELinux 域 | ✅ `untrusted_app_27` |
| **harness UI** | ✅ **WebView 显示原版 harness 界面** |

## 许可与来源

- 上游 [itiswdwa/dsh-android](https://github.com/itiswdwa/dsh-android)，MIT。
  原始版权声明保留在 `LICENSE` 中，二次开发部分见 `NOTICE.md`。
- DHA 自有代码和图标素材按 MIT 发布；APK 内还包含 Apache-2.0、GPL 和 AGPL 组件，
  因此安装包整体不是单一 MIT 作品。完整清单见 `THIRD_PARTY.md` 和 `LICENSES/README.md`。
- 发布、修改与安全报告规范见 `CONTRIBUTING.md`、`SECURITY.md` 和
  `OPEN_SOURCE_COMPLIANCE.md`。
- DeepSeek Harness 本体版权归其作者所有，随 rootfs 一起分发。
- 本应用为独立社区作品，与 DeepSeek 官方及上述项目作者无隶属关系。

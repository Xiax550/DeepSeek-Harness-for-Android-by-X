# 来源与二次开发声明

本 DHA 分支的作者及二次开发维护者：**夏侯玲文**。该署名不替代上游作者或第三方组件的版权与许可声明，详见 `AUTHORS.md`。

## 1. 本工程来源

**DHA**（DeepSeek Harness Android，`com.dha.harness`）是一个把 **DeepSeek Harness 原样**装进安卓手机的
应用，基于上游 **[itiswdwa/dsh-android](https://github.com/itiswdwa/dsh-android) v1.2.1** 二次开发。

上游做法：把 Ubuntu rootfs + Node + harness 打进 APK，用 PRoot 在手机本地启动，
再用 WebView 打开 harness 自己的 Web UI —— 所以手机上得到的是**原样的 harness，不是重做的客户端**。
本工程沿用这套架构，只做品牌与构建工具的改造。

## 2. 本工程实际改动

| 类别 | 改动 |
|---|---|
| 包名 | `dev.dsh.android` → `com.dha.harness`（含 Java 包路径、Shizuku provider authority、User-Agent） |
| 应用名 | `DSH` → `DHA`；`DSH 手机助手` → `DHA 手机助手`；悬浮球全部文案 |
| 图标 | 改用维护者提供的 DHA 原图 `assets/dha-icon-source.png`，生成各密度、亮暗主题、自适应图标和通知图标 |
| 签名 | 新建独立 keystore（`CN=DHA`），不使用上游示例口令 |
| 构建脚本 | 新增 `scripts/build_apk.ps1`（Windows，无需 Gradle/WSL）；上游仅有 Linux 版 `build_apk.sh` |
| 图标脚本 | 新增 `scripts/make_icons.py`（纯 Python）；上游 `render_icon.py` 依赖 Linux 的 `rsvg-convert` |

**未改动**：harness 本体、Ubuntu rootfs、启动脚本、控制桥（`BridgeServer`）、恢复模式、
手机助手（`Assist`/`BallService`）逻辑、载荷版本化与热更新机制。

载荷（`assets/payload.zip`、`assets/payload.manifest`）取自官方发布的 APK，其 sha256
与 `BuildInfo.PAYLOAD_VERSION` 完全一致，因此解包/版本化行为与上游完全相同。

## 3. 许可

上游为 **MIT License**。MIT 允许修改、改名、再分发，但要求保留原始版权声明 ——
因此 `LICENSE` 中**同时保留**上游版权行与本工程改动声明：

```text
Copyright (c) 2026 itiswdwa
Copyright (c) 2026 LanFeiYu (蓝肥鱼) modifications
Copyright (c) 2026 夏侯玲文, DHA modifications
```

请勿删除上游那一行。

## 4. 第三方组件

| 组件 | 用途 | 许可 |
|---|---|---|
| DeepSeek Harness | 主要 agent runtime 和 Web UI | 见上游项目及其 npm 包声明 |
| Ubuntu 24.04 arm64 + Node.js | PRoot 沙箱和运行时 | Ubuntu 包分别许可；Node.js 为 MIT |
| PRoot | 无 root 的 Linux 用户态 | 二进制报告 GPL-2.0-or-later；精确源码仍待确认 |
| Coopanion 衍生代码 | 浮动角色渲染 | AGPL-3.0-or-later；贴图另有权利限制 |
| Shizuku API | Android 特权通道和虚拟显示 | MIT（RikkaW；见 `LICENSES/Shizuku-API-MIT.txt`） |
| HiddenApiBypass | Android 虚拟显示所需的隐藏 API 访问 | Apache-2.0 |
| OkHttp / Okio | Edge 在线语音合成网络客户端 | Apache-2.0 |
| Vosk Android / JNA / 中文模型 | 内置中文离线语音识别 | Apache-2.0；JNA 也提供 LGPL-2.1 选项，本项目按 Apache-2.0 使用 |
| dshmarket / meow-memory | 插件市场 / 内置记忆插件 | MIT |

依赖的准确版本、文件路径、下载方式、哈希和完整来源链接见
[`DEPENDENCIES.md`](DEPENDENCIES.md) 与 [`THIRD_PARTY.md`](THIRD_PARTY.md)。

## 5. 免责声明

本应用为独立社区作品，与 DeepSeek 官方、上游 dsh-android 作者均无隶属关系。
应用内含完整 Linux 用户态与 SSH 恢复通道，请自行评估风险后安装。

# 第三方组件与来源

本仓库包含或依赖以下第三方内容，版权归各自所有者：
完整依赖版本、用途、来源和哈希见 [`DEPENDENCIES.md`](DEPENDENCIES.md)。

## 仓库内

| 内容 | 来源 | 许可 |
|---|---|---|
| `assets/dha-icon-source.png` | DHA 维护者提供的项目原图（原文件名 `222.png`，sha256 `e56a54b35dffe941d2623debb42474ebcbd0fd335e25cb7b096a7a2370003799`），生成记录见 `assets/README.md` | 项目 MIT 素材（以维护者有权授权的范围为准） |
| `assets/whale.svg` | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web 前端 favicon（品牌标识） | MIT（标识本身是 DeepSeek 的商标） |
| `app/libs/shizuku-*.jar` | `dev.rikka.shizuku:api|aidl|shared|provider:13.1.5`，从 Maven Central 取（经 aliyun 镜像）；四个 artifact 的 POM 均指向 Shizuku-API 的 MIT 声明 | MIT，版权声明和文本见 [`LICENSES/Shizuku-API-MIT.txt`](LICENSES/Shizuku-API-MIT.txt) |
| `app/libs/hiddenapibypass-6.1.jar` | `org.lsposed.hiddenapibypass:hiddenapibypass:6.1` | Apache-2.0 |
| `app/libs/okhttp-3.14.9.jar` | `com.squareup.okhttp3:okhttp:3.14.9`，Edge 在线语音合成的 HTTP/WebSocket 客户端 | Apache-2.0 |
| `app/libs/okio-1.17.2.jar` | `com.squareup.okio:okio:1.17.2`，OkHttp I/O 依赖 | Apache-2.0 |
| `app/libs/vosk-android-0.3.47.jar` + `libvosk.so` | `com.alphacephei:vosk-android:0.3.47`，从 Maven Central 取 | Apache-2.0 |
| `app/libs/jna-5.13.0.jar` + `libjnidispatch.so` | `net.java.dev.jna:jna:5.13.0`，从 Maven Central 取 | Apache-2.0 / LGPL-2.1（双许可，本项目按 Apache-2.0 使用） |
| `app/assets/vosk-model-small-cn.zip` | Vosk `vosk-model-small-cn-0.22`，官方模型经 HF 镜像取得；sha256 `2b34e3c3eb2c61105b1affc4863407965dbf968c63ceb5cd46685f9bd627434a` | Apache-2.0 |
| `payload/etc/bash.bashrc` | Ubuntu 24.04 的 `/etc/bash.bashrc`，只改了一处（`$(groups)` → `id -Gn 2>/dev/null`） | GPL-3.0 |
| `payload/opt/dsh/android/ball-web/coo/` | [Pal-AI-Lab/Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 的鲸鱼分层网格渲染器、模型参数和基础贴图，按用户要求接入悬浮玩偶 | 代码 AGPL-3.0-or-later；`web/whale/` 贴图的额外权利限制见该目录 `THIRD_PARTY_NOTICES.md` |
| `libproot.so`（**不进 git；作为 release 资产按固定 sha256 取**） | 266,152 B，sha256 `f6b0381ab9a066fa620fef0001737fd3cfaf9d22474f013ac48d7861411374ac`。二进制字符串报告 PRoot / GPL v2 or later，且含 OpenMinis 路径；**这只能说明二进制线索，不能确认准确源码版本、构建选项或对应源码归档**。见 `scripts/fetch-proot.sh` | **按 GPL-2.0-or-later 处理；精确对应源码待确认，当前是包含该二进制的 APK 发布阻塞项** |
| `payload/home/.dsh/profiles/web/node_modules/dshmarket/`（vendor，固定 1.66.21） | npm [`dshmarket@1.66.21`](https://www.npmjs.com/package/dshmarket)（仓库 [github.com/dsh-market/dsh-market](https://github.com/dsh-market/dsh-market)）—— 插件市场。tarball sha256 `f75bfc1206c91b0d82b939334f1457a5c515cb0cadde75e69b15f8ee87e3da38`，解包内容与 npm tarball `diff -r` 零差异。原始 npm 包含 `LICENSE`；裁剪 vendor 未保留，因此已将对应文本另存于 [`LICENSES/dshmarket-MIT.txt`](LICENSES/dshmarket-MIT.txt) | MIT |
| `payload/opt/dsh/android/builtin-meow-memory/`（vendor，种子版本 0.31.0） | npm [`meow-memory@0.31.0`](https://www.npmjs.com/package/meow-memory)（仓库 [github.com/Phant0Meow/dsh-meow-memory](https://github.com/Phant0Meow/dsh-meow-memory)）—— 插件市场中的“喵记忆”，首次安装时播种；profile 中已有更高版本时不覆盖 | MIT |
| `payload/home/.dsh/profiles/web/node_modules/@local/agent-browser-viewer/` | DHA 项目本地插件，版本 1.0.0；源码、配置、截图素材与语言文件已从本地构建载荷恢复到源码目录 | 项目 MIT；`package.json` 明确声明 MIT |
| `payload/home/.dsh/profiles/web/node_modules/@local/dsh-ball-summarizer/` | DHA 项目本地插件，版本 2.0.0；源码、配置、README 和测试已从本地构建载荷恢复到源码目录 | 项目 MIT；`package.json` 明确声明 MIT |
| 同上的 `undici@7.30.0` / `js-yaml@4.3.2` / `argparse@2.0.1` | npm（`dshmarket` 的运行时依赖；argparse 是 js-yaml 的依赖）—— vendor 进来是为了**安装时不联网**。sha256 见 §vendor 记录 | MIT / MIT / Python-2.0 |
| `payload/usr/local/bin/pnpm`（**按需下载，不进 git**） | `@pnpm/exe.linux-arm64` 12.11.2 —— pnpm 的自包含单文件 arm64 可执行（43,403,704 B），由 `scripts/fetch-pnpm.sh` 按固定版本 + npm 的 sha512 + 二进制的 sha256 校验后下载（`.gitignore` 排除，41 MB 不进 git 历史）。只进 payload，**不发热包**（见 `scripts/make_hot_zip.py` 的 `HOT_EXCLUDED`） | MIT |

## 其他上游项目与构建依赖

- Android 工程基于 [`itiswdwa/dsh-android`](https://github.com/itiswdwa/dsh-android) v1.2.1 二次开发，原工程 MIT 声明保留在根目录 `LICENSE`。DHA 的改动和当前代码状态以本仓库为准。
- 沙箱主体使用 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 的 `@deepseek-ai/dsh`（默认 `0.2.0-rc.2`）及上游 npm 依赖。
- 浮动角色渲染代码来自 [`Pal-AI-Lab/Coopanion`](https://github.com/Pal-AI-Lab/Coopanion)，采用 AGPL-3.0-or-later；角色贴图与标志的额外权利限制见其目录下 `THIRD_PARTY_NOTICES.md`。该声明不表示对贴图或商标享有所有权。
- Ubuntu 24.04.5 arm64、Node.js 22.23.2、xterm 5.5.0 / addon-fit 0.10.0 / addon-canvas 0.7.0、`dshmarket` 的运行依赖，以及构建工具和固定版本，见 [`DEPENDENCIES.md`](DEPENDENCIES.md)。
- Ubuntu apt 包和 DeepSeek Harness 的完整 npm 传递依赖树由构建时取得，仓库没有统一锁定所有传递版本。每次二进制发布应对最终 payload 生成并附上 SBOM；不要把此文件当作完整传递依赖 SBOM。
`app/libs/` 里放预编译 jar 是刻意的：这样构建不需要联网取 Maven 依赖。

**第三方站点（用户应知情）**：`dshmarket` 运行时的目录有**三条来源** —— 站点
`https://awesome-dsh-plugin.com/plugins.json`、以及两条 npm 镜像（实测回退到
`mirrors.cloud.tencent.com/npm/dsh-plugin-catalog`）；更新说明取 `updates.json`。
Android 启动脚本默认把 `DSHM_REGISTRY_URL` 指向
`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog@latest/plugins.json`：真机实测 npm 镜像的
包元数据正常，但目录 tarball 在当前移动网络下 20 秒超时；jsDelivr 直链约 2 秒。
**实测表现**（独立环境）：
- **只封站点、npm 能通** → 目录接口**仍 200 / 约 1.0 秒 / 4.4 MB**（自动走 npm 镜像回退），**市场照常可用**；
- **完全断网** → Harness 正常启动、其它接口 5–42ms 照常；目录接口**约 27ms** 返回 502 与一句
  列明"试过哪些源、走了哪个代理、各自为何失败"的可读错误（面板仍能打开）。

可用环境变量 `DSHM_UPDATES_ORIGIN` 换源。**这是插件自身的运行时行为**，本发行版只负责预装它；
面向用户的说明（默认连哪些主机、离线表现、如何停用、以及它注册的
`/restart`·`/rollback`·`/backup`·`/restore`·`/approve-builds` 等写能力）见
[`docs/preinstalled-plugins.md`](docs/preinstalled-plugins.md)。

## 许可文本与发布边界

完整许可证文本放在 [`LICENSES/`](LICENSES/README.md)。项目自有部分采用 MIT，但 APK 是包含
Apache-2.0、GPL-2.0-or-later、GPL-3.0 和 AGPL-3.0-or-later 组件的组合发行版。
发布前必须同时提供对应源码、版权声明和必要的安装说明；具体检查表见
[`OPEN_SOURCE_COMPLIANCE.md`](OPEN_SOURCE_COMPLIANCE.md)。

## 构建时下载

| 内容 | 来源 | 许可 |
|---|---|---|
| Ubuntu base rootfs (arm64) | cdimage.ubuntu.com | 各软件包各自的许可（主要为 GPL 与 MIT 系） |
| Node.js 官方 arm64 构建 | nodejs.org | MIT |
| `@deepseek-ai/dsh` 及其依赖 | npm | MIT（各依赖见其自身许可；其中 `@deepseek-ai/libreoffice-kit-wasm` 被打包脚本裁掉） |

## 本项目

非官方移植，与 DeepSeek 无隶属关系。「DeepSeek」「DeepSeek Harness」及其标识为 DeepSeek 的商标，
本项目使用它们仅用于说明兼容对象。

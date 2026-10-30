# DSH Android — 交接文档

> 写于 2026-10-14。作者：终端/发布线（本会话）。**标注约定**：✅=我在本会话亲自验证过（附命令/输出）；🔶=由其他线口述或来自代码阅读但**我未复验**；❓=未验证/待确认。
> 本文件只写文件，**没有** commit / push / release。

> **本文件是唯一交接文档。** 仓库里曾同时存在 `handoff.md`（2026-09-30 上一会话的版本，含 §11.14/§11.15
> 两条 2026-10-14 的补充）。两者只差大小写，在大小写不敏感的文件系统（Windows/macOS 检出、
> `core.ignorecase`）上会互相覆盖，git 也会把这种路径当异常。现在它的内容已按主题并入本文件
> **第二部分（编号带 `A` 前缀：A1…A15）**，小写文件已删除。**不要再新建 `handoff.md` 或任何与
> 本文件只差大小写的名字**；新内容直接写进本文件。


---

## 1. 项目是什么 / 三条更新通道

**是什么**：把 DeepSeek Harness 装进 Android 的发行版。App 是一个 WebView 壳 + 一个 PRoot Ubuntu 沙箱；沙箱里跑官方 Node + harness（`dsh web`），WebView 打开 `http://127.0.0.1:3080/?token=…`。App 侧的 Java 负责 rootfs 安装、HTTP 桥（给页面调原生能力）、悬浮球、无障碍助手。

**代码在哪**（✅已核）：

| 路径 | 角色 |
|---|---|
| `/root/dsh-full/dsh-android` | **构建工作树**：源码 + `build/` + `out/` + `lab/` + `keystore/`。**不是 git 仓库** |
| `/root/dsh-full/dsh-android-repo` | **唯一的 git checkout**：branch `main`，remote `git@github.com:itiswdwa/dsh-android.git`，HEAD `c2f6c1a`（✅`git remote -v`/`git log`），工作区干净 |
| `/mnt/Documents/dsh-plugins/` | 用户自己的两个插件源码（`ball-summarizer`、`agent-browser-viewer`），profile 里以软链 `@local/...` 安装 |
| `/opt/dsh` | **设备上的 harness 安装**（rootfs 内）。`/opt/dsh/node_modules/@deepseek-ai/*` 是发布包，无源码 |
| `/root/.dsh/profiles/web/` | 设备上真正生效的 profile（用户数据，只在首次播种时来自 payload） |

**三条通道**（✅读脚本 + 实测产物）：

| 通道 | 产物 | 大小（实测） | 代价 / 何时用 |
|---|---|---|---|
| 全量 APK | `out/dsh-android.apk`（内含 `assets/payload.zip` ≈190MB） | 189,042,701 B | 首次安装或换 terminal 线；用户要下 ~190MB |
| 瘦包 slim | `out/dsh-android-slim.apk` | 819,732 B（今日构建） | 已有 rootfs 的机器；首次用时自己下 `payload.zip` |
| 热包 hot | `out/dsh-hot.zip` / `build/hot-assets/hot.zip` | 今日 303,947 B（旧的一份 94,307 B 是 xterm 时代的，**别发**） | 插件/skill/guest 脚本/提示词；就地覆盖，不动 runtime |

**版本模型**（✅`version.py` + `HOT` + `make_hot_zip.py`）：

- `VERSION` = `1.1.5`（外壳/app），`ROOTFS_VERSION` = `2`（runtime/terminal）。
- `HOT` = `{app, terminal, sp, version, hash}`：**本机最后一次构建的热包记录**，也是 sp 递增的输入。
- 热包版本串 `<app>-t<terminal>-sp<n>`，如 `1.1.5-t2-sp2`；`--base`（`build_apk.sh` 用）恒 **sp0**，非 base 走递增规则。
- `update.json`（schema 2）= App 轮询的清单：`app.{version,versionCode,url,slim,page}`、`terminal.{version,full,tag,url,manifest}`（`url` 指向 `releases/download/t2/payload.zip`）、`hot.{version,url,manifest}`。
- Release 资产名固定（改名会破坏 app 内更新）：`dsh-android.apk`、`dsh-android-slim.apk`、`dsh-hot.zip`、`SHA256SUMS`；runtime 单独发在标签 `t<N>` 下：`payload.zip`、`payload.manifest`。

---

## 2. 版本线口径：留在 t2，只递增 sp（重点）

### 2.1 判据（✅原文引用，`plugin/dsh-plugin-android/lib/client.js`）
```js
894:  const line = (props.app ?? "") + "-t" + (props.terminal ?? "") + "-";
895:  const sameLine = (value) => value === "" || String(value).indexOf(line) === 0;
896:  const hotNew = info !== null && info.hot !== undefined && info.hot.version !== ""
897:      && sameLine(info.hot.version)
898:      && info.hot.version !== current && info.hot.version !== packaged;
```
- `current` = 已应用热包版本（`Payload.hotVersion()` → prefs `hotVersion`，`Payload.java:252`）
- `packaged` = APK 内建热包版本（`Payload.packagedHotVersion()` → 读 `assets/hot.zip` 的 `hot.json`，`Payload.java:262`）
- 结论：热包版本必须**与这两个都不相等**才会出现更新卡片。设备现状 ✅：`hotVersion=1.1.5-t2-sp1`、`packagedHotVersion=1.1.5-t2-sp0`（bridge `/snapshot`）。
  - 发 **sp2** → 与 sp1、sp0 都不同 → 卡片出现 ✅
  - 发 **sp1**（=已应用）或 **sp0**（=内建）→ 不出现 ✗

### 2.2 sp 递增规则（✅`make_hot_zip.py:115-123`）
```python
if base: return 0
if same_line and tracker.hash == digest: return tracker.sp     # 同内容 → 保持
if not same_line: return 1                                     # 换线 → sp1
return tracker.sp + 1                                          # 同线新内容 → +1
```
**准备 sp2 的正确做法**：把 `HOT` 改成 `{"app":"1.1.5","terminal":"2","sp":1,"hash":""}`（hash 必须与即将构建的内容 digest 不同；只改 sp 不改 hash，若内容没变会被判成"同内容"→ 只得到 sp1）。
**顺序：先出包（`build_apk.sh`，会把 HOT 写回 sp0）→ 再改 HOT → 再 `release_hot.sh`**（✅本会话又踩了一次：`build_apk.sh` 不仅写 HOT，还会重跑 `make_update_manifest.py` 把
`update.json` 也改成 `--base` 的 sp0 —— 发布后若再打一次 APK，**必须把 `HOT` 与 `update.json` 都恢复成发布值**
（否则 `hot.version` 会退回等于内建版本，设备就再也收不到这次热更新）。恢复方法：把发布用的热包拷回
`build/hot-assets/hot.zip`，跑 `make_update_manifest.py`，再手写 `HOT` 的 sp/hash。）（该脚本自己会再构建一次热包，得到 sp2，并同步 tracker 与 `update.json`）。
✅本会话已把 `HOT` 置为 `sp=1, hash=""`（md5 `9ee8956fa1d80b5233e9ec1db6443839`），并用只读方式回放 `next_sp` 逻辑确认：下一次非 base 构建 → **sp2**。

### 2.3 为什么不开 t3
`sameLine` 以 `<app>-t<terminal>-` 为前缀：t2 设备不会收到 t3 热包（`hotNew=false`），只能走 `terminalNew` → 提示"terminal update available · t3（需要新 APK）"，也就是**每台 t2 设备都要重下 ~190MB payload**；t3 设备同样收不到 t2 包。留在 t2 + 递增 sp 才是增量。
**纪律**：`build_apk.sh` 从 `ROOTFS_VERSION` 取 terminal（当前 2，不用动）；**不要**带参数跑 `release_terminal.sh 3`（它会把 ROOTFS_VERSION 写成 3 = 认领 t3）。

---

## 3. 构建与发布

### 3.1 构建链（✅读脚本）
`scripts/build_apk.sh`（7 步，x86_64 构建沙箱里跑 aapt2）：
`0/7 icons`（`render_icon.py`/`render_ball_icons.py`）→ `1/7 resources`（aapt2 compile）→ `2/7 link`（aapt2 link，生成 R.java）→ **`hot overlay`**（`make_hot_zip.py … --base`）→ **`update manifest`**（`make_update_manifest.py`）→ `3/7 javac`（**生成 `BuildInfo.java`**：payload 内容 hash + APP_VERSION/CODE + ROOTFS_VERSION；classpath = `/tmp/platform/android-36/android.jar` + `app/libs/*.jar`）→ `4/7 d8`（`--min-api 26`）→ `5/7 pack`（`pack_apk.py`）→ `6/7 keystore` → `7/7 sign`（`scripts/Sign.java` 用 `apksig` 库，无 apksigner 依赖）。
- 版本来源：`APP_VERSION=${APP_VERSION:-$(cat VERSION)}`、`TERMINAL_VERSION=${TERMINAL_VERSION:-$(cat ROOTFS_VERSION)}`。
- **`assemble_payload.sh` 的默认 rootfs 已修**（2026-10-14）：它原本默认 `build/rootfs`，而 `prepare_rootfs.sh` 产出的是 `build/rootfs-ubuntu`（`docs/BUILD.md` 也是无环境变量调用它）→ 会拿一棵陈旧树去自检，报 `MISSING: usr/local/bin/node`。现在默认 `build/rootfs-ubuntu`，仍可用 `DSH_ROOTFS` 覆盖；改完 sanity 立刻通过。
- payload：`scripts/prepare_rootfs.sh`（Ubuntu base + 官方 Node tarball + `npm i` harness，~500MB → `trim_payload.sh` 裁到 ~175MB）→ `scripts/assemble_payload.sh`（`cp -a payload/. $ROOTFS/`；`payload/home` → `opt/dsh/dsh-home-seed/`；`profile/` → 种子的 profile；**删掉种子里的 `dsh-plugin-android`**，插件只走热包；`apply-hardlink-patch.py`）→ `make_payload_zip.py` → `assets/payload.zip`。
- 关键映射（✅）：`payload/` 的内容会**整体覆盖到 rootfs 根**（`assemble_payload.sh:29`），所以 `payload/usr/local/bin/xxx` → `/usr/local/bin/xxx`，同时 `make_hot_zip.py` 又把 `payload/usr/local/bin` 映射成热包里的 `usr/local/bin`。一个文件同时服务两条通道。

### 3.2 发布脚本（✅读全文）
| 脚本 | 职责 |
|---|---|
| `scripts/release.sh [ver]` | tag `v$(cat VERSION)`；正文 = `release_notes.py <ver> --channel app`（CHANGELOG 必有条目，否则退出 1）；上传 `dsh-android.apk` + `dsh-hot.zip` + `SHA256SUMS`（+ 存在则 `dsh-android-slim.apk`）；幂等：release 存在则 PATCH，同名资产先 DELETE 再 POST；`. scripts/_release_lock.sh` 防并发 |
| `scripts/release_hot.sh [notes]` | `make_hot_zip.py`（非 base，bump sp）→ `make_update_manifest.py` → 定位 release（`DSH_RELEASE_TAG` 或 `releases/latest`）→ 替换 `dsh-hot.zip`/`SHA256SUMS` → `hot_release_body.py` PATCH 正文 → `sync_repo.sh` 推 `update.json`；`DSH_SKIP_PUSH=1` 可只发不推 |
| `scripts/release_terminal.sh [N]` | 发布 runtime：标签 `t<N>`，资产 `payload.zip` + `payload.manifest`；**带参数即认领新的 terminal 版本**（本轮不要跑带参数的） |
| `scripts/sync_repo.sh ["msg"]` | 工作树 → checkout 镜像：复制 `app assets patches payload plugin profile scripts docs` + `README/THIRD_PARTY/.gitignore/CHANGELOG` + `VERSION ROOTFS_VERSION update.json HOT`；`git clean -qXfd`；`git config core.createObject rename`（PRoot link2symlink 会把 git 的硬链接对象变悬空软链）；`git add -A` → commit → **`git push origin main`（SSH）** |
| `scripts/make_hot_zip.py` | 热包打包 + sp 计算 + 写 `HOT`；白名单前缀见 §5.4 |
| `scripts/make_update_manifest.py` | 由 `VERSION`/`ROOTFS_VERSION`/热包生成 `update.json` |
| `scripts/release_notes.py` | 从 `CHANGELOG.md` 渲染正文（`--channel app|hot-history`）。**热包要按三段式写**（`[1.2.0-t2-sp1]`）：它按 `<app>-` 前缀 + `-sp<N>` 尾部匹配（也认旧的 `<app>-sp<n>`）—— 以前写死 `<app>-sp` 前缀，三段式一个都匹配不到，`release_hot.sh`（它就是用 `--channel hot-history` 生成正文，见 `release_hot.sh:57`）会把 release 正文 PATCH 成 `<!-- no hot package published for 1.2.0 yet -->`。回归测试：`python3 docs/release-notes-test.py`（7 checks：正例/负例/两个通道） |
| `scripts/_release_lock.sh` | `out/release.lock` 互斥 |

### 3.3 鉴权（✅只读探测；**绝不打印明文**）
- 仓库脚本一律用 **curl + GitHub API**（`gh` CLI **未安装** ✅`command -v gh` 无输出）。
- `release.sh` / `release_hot.sh` / `release_terminal.sh` 都要求环境变量 **`GITHUB_TOKEN`**（contents:write），变量名缺失即退出 1。
- 本会话可用的 token 在 **`/root/.dsh/gh-token`**（mode 600，93 字节；**文档与日志里绝不写内容**）。用法：`T=$(cat /root/.dsh/gh-token)` 然后 `-H "Authorization: Bearer $T"`。
- ✅探测结果：token 属于 `itiswdwa`；`GET /repos/itiswdwa/dsh-android` → `private=false`、`default_branch=main`、`permissions={admin,maintain,push,triage,pull}=true`（**具备写权限**，我没有用写操作验证）；rate limit 5000。
- push 走 SSH：`sync_repo.sh` 注释说沙箱里有 deploy key；**但本环境** `/root/.ssh` 为空、无 known_hosts/agent/credential helper ✅，`git ls-remote origin HEAD` → `Host key verification failed` ❓（故 push 需要用户/Lead 提供 key 或改 HTTPS+token）。

### 3.4 本轮发布范围（Lead 裁定）
- **走新 APK（baked 热包）**，不走"只发热包"；热包增量按 §2.2 准备作辅助通道。
- **不发** 9/30 的 189MB 全量 APK；这一发只发 **slim APK + 热包 + SHA256SUMS**，并更新 `update.json`（不跑 `release.sh`，因为它硬要求全量 APK 存在）。

### 3.4b 发布之后：真机核对
发布完（或用户装完包、允许重启后）跑 **`sh docs/verify-ondevice.sh`** —— 只读脚本，逐项核对
安装版本（`versionName/versionCode`）、`hotVersion`/`packagedHotVersion`、pnpm、市场版本、
profile 三行，并把需要人眼的项（热包重放六步、#3 清数据闸门、#1 侧边栏 ⋯ 菜单、触感、
市场页面与真装插件）列成带期望值的步骤。本版期望值集中在脚本顶部的 `EXPECT_*` 常量里，
**发布新版本时只改那一段**。

### 3.4c 原地替换同一版本的资产（2026-10-14 实操过：1.2.0 build 10201）
需求形态：**不改版本名、只换资产**，但设备要能察觉 → 靠 `versionCode`。
- `build_apk.sh` 新增 `APP_CODE`（默认仍按版本名推导）：`APP_CODE=10201 sh scripts/build_apk.sh`；
  `scripts/make_update_manifest.py` 同样认 `APP_CODE`，写进 `update.json` 的 `app.versionCode`。
- 实操：`APP_CODE=10201 PROOT=$PWD/build/proot/libproot.so sh scripts/build_apk.sh`（全量）+
  `… SLIM=1 sh scripts/build_apk.sh`（瘦包）→ 从 APK 里实证
  `aapt2 dump badging out/dsh-android.apk | grep package:` → `versionCode='10201' versionName='1.2.0'` ✓。
- 资产：**`tag` 不变、release id 不变、hot 不动**（热包内容 digest 没变就保持原资产），只替换
  `dsh-android.apk` + `dsh-android-slim.apk` + `SHA256SUMS`（同名替换 = 先 DELETE 再 POST）。
- ⚠️ 这条网络很会掉 TLS：上传要「重试 + 遇到 422 就重新删除再传」；422 常常是"请求发出去了、
  响应丢了"——服务器其实已经存下（本次 slim 就这么"自己好了"）。脚本化见 `/tmp/robust-upload.sh` 的做法。
- 回读清单：`/releases/<id>` 的 name/size/digest、`latest` 归属、四个 `latest/download/*` 的 200、
  以及把 slim/hot 下回来逐字节比对（全量包太大时至少比 digest + 首尾抽样）。

### 3.5 CI：在 GitHub Actions 上组全量包（已批准；**待仓库写权限后 push**）
**workflow**：`.github/workflows/release-full.yml`（`sync_repo.sh` 现在会镜像 `.github/`）。**只手动触发**
（`workflow_dispatch`，inputs：`tag` 必填 / `dry_run` 可选），**不要加 push 触发** —— 一次跑 10–15 分钟。
（顺带一条：本机 aapt2 是 x86_64 二进制、靠 `qemu-x86_64` 跑 —— 见 `docs/BUILD.md`；CI 的 x86_64 runner 反而**原生**，不需要 qemu。）

**为什么 runner 用 x86_64 而不是 arm64**：Google 的 Android build-tools（aapt2/d8）只有 x86_64；载荷里的 arm64
内容靠 `prepare_rootfs.sh` 里已有的 `npm i --os=linux --cpu=arm64 --libc=glibc` 跨平台安装 + `aarch64-linux-gnu-gcc`
交叉编译 linkfix 产出。
**为 CI 做的脚本改动（2026-10-14，已批准，本地不设变量时行为不变）**：`build_apk.sh` 的 6 个路径/别名与
`build_linkfix.sh` 的编译器都改成 `${VAR:-默认}`：
`ANDROID_JAR`、`AAPT2`、`D8`、`APKSIG`、`PROOT`、`KS_ALIAS`、`CC`（共 7 个）。
**无行为变化的证据**：同一份源码在改动前后各打一次瘦包，两条 APK 的 29 个条目里**只有 `assets/hot.zip` 不同**，
而它内部**只有 `hot.json` 的 `built` 时间戳不同**（version/hash/files 完全一致），即差异仅来自构建时间。
**Secrets（用户在仓库 Settings → Secrets and variables → Actions 里加）**：
| 名称 | 值 | 格式 |
|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | `keystore/dsh.p12` 的 base64 | `base64 -w0 keystore/dsh.p12`（单行） |
| `ANDROID_KEYSTORE_PASSWORD` | 该 keystore 的 PKCS12 密码（store 与 key 同一个） | 纯文本 |
| `ANDROID_KEY_ALIAS` | 密钥别名（本地默认 `dsh`） | 纯文本 |
**如实说明**：`build_apk.sh` 里内置了这个密码的默认值（生成现网签名密钥时用的那个），**它其实已经随仓库公开**；
而且签名身份**不能轮换**（换了老用户无法覆盖安装）。所以这三个 secret 的作用是"CI 不必把明文写进 YAML"，
**不是**保护一个未泄露的秘密。
**libproot.so（CI 硬阻塞，已定方案 ②）**：它原本来自**本机应用挂载路径** `/var/minis/mounts/Download/libproot.so`
（266,152 B），仓库里没有。方案：作为 **release 资产上传一次**（`v1.2.0` 的 `libproot.so`），CI 用
`scripts/fetch-proot.sh` 按固定 sha256 `f6b0381a…` 下载（本地默认路径不变，仍可 `PROOT=` 覆盖）。
**它的来源与许可待确认**：该文件是从上述本机挂载路径取得的，**没有核对过上游**；PRoot 本身是 GPL-2.0，
这一份的实际出处与许可**待核**（见 `THIRD_PARTY.md`）。
**本地已验证 / 必须真跑才知道**：已验 YAML 语法（PyYAML）、引用的 8 个脚本存在、7 个变量可被环境覆盖、
全量 APK 本地可产出（206,970,264 B）。待真跑：`setup-android` 的包名（`build-tools;36.0.0`）、
Maven 上 `apksig:8.7.3` 可下载、缓存命中、x86_64 上 npm 跨平台安装 arm64 optional deps 的真实结果、Actions 分钟数。
**一句实话**：CI 不省流量（200MB 资产照传），省的是"不必在手机上准备 600MB rootfs + 手工打 200MB 包"，
并让构建可复现。

### 3.6 手动发布路径（备选：用户在 GitHub 网页上传）
产物已复制到 **`/sdcard/Download/dsh-1.2.0-发布/`**（含 `照做步骤-1.2.0.txt` 与 `发布说明-1.2.0.txt`）。
**⚠️ 上传时文件名必须保持原样**：`dsh-android-slim.apk`、`dsh-android.apk`、`dsh-hot.zip`、`SHA256SUMS`、
`libproot.so` —— `update.json` 里 App 用的更新地址就是按这些名字拼的（`…/releases/latest/download/<name>`），改名会让更新 404。
两个 `.txt` 只是给人看的，不要上传；勾选 **Set as the latest release**（否则 `latest` 继续指向 `t2`，所有更新地址 404）。

### 3.7 脚本发布路径（**只准备命令，未执行**；需要可写凭据）
**⚠️ 先看这个陷阱（✅只读查证，2026-10-14）**：`GET /releases/latest` 现在是 **`t2`**（published 2026-09-30T03:49，晚于 `v1.1.5` 的 03:02），而 `update.json` 的 `app.url` / `app.slim` / `hot.url` 都写成 `releases/latest/download/<name>` →
- `releases/latest/download/dsh-android-slim.apk`、`.../dsh-hot.zip` 在 t2 上**不存在**（t2 只有 `payload.zip`/`payload.manifest`/`SHA256SUMS-terminal`）→ 下载会 404。
- 今天不会炸，只是因为版本号没变（`appNew`/`hotNew` 判据里 `versionCode` 相等、`hot.version` 相等就不提示）；一旦发新版就会踩到。
两个可选做法（发布时二选一）：
- **A（简单）**：把新资产传到 **`t2`**（它已是 latest）→ `latest/download/*` 立刻可解析；`dsh-android.apk`（全量）仍留在 v1.1.5，因为不提示 app 更新所以暂时无害。
- **B（更干净）**：`PATCH /releases/<v1.1.5 的 id>` 带 `{"make_latest":"true"}` 把 v1.1.5 重新标为 latest（不是删/改历史），再把 slim+hot+SHA256SUMS 传到 v1.1.5；t2 的 `payload.*` 因为 URL 用的是显式 tag 不受影响。
**命令骨架（`T=$(cat /root/.dsh/gh-token)`，绝不回显 token）**：
```sh
REPO=itiswdwa/dsh-android; API=https://api.github.com/repos/$REPO
TAG=t2                                    # 或改用 v1.1.5（配合 make_latest）
# 1) 目标 release id
RID=$(curl -sS -H "Authorization: Bearer $T" "$API/releases/tags/$TAG" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
UPLOAD=$(curl -sS -H "Authorization: Bearer $T" "$API/releases/$RID" | python3 -c 'import json,sys;print(json.load(sys.stdin)["upload_url"].split("{")[0])')
# 2) 校验和（slim + hot；全量不在这一发里）
cd /root/dsh-full/dsh-android
sha256sum out/dsh-android-slim.apk build/hot-assets/hot.zip > out/SHA256SUMS
# 3) 同名资产先删后传（GitHub 不允许同名重复上传）
for n in dsh-android-slim.apk dsh-hot.zip SHA256SUMS; do
  id=$(curl -sS -H "Authorization: Bearer $T" "$API/releases/$RID/assets" | python3 -c "import json,sys;[print(a['id']) for a in json.load(sys.stdin) if a['name']=='$n']")
  [ -z "$id" ] || curl -sS -X DELETE -H "Authorization: Bearer $T" "$API/releases/assets/$id"
done
curl -sS -X POST -H "Authorization: Bearer $T" -H "Content-Type: application/vnd.android.package-archive" \
  --data-binary @out/dsh-android-slim.apk "$UPLOAD?name=dsh-android-slim.apk"
curl -sS -X POST -H "Authorization: Bearer $T" -H "Content-Type: application/zip" \
  --data-binary @build/hot-assets/hot.zip "$UPLOAD?name=dsh-hot.zip"
curl -sS -X POST -H "Authorization: Bearer $T" -H "Content-Type: text/plain" \
  --data-binary @out/SHA256SUMS "$UPLOAD?name=SHA256SUMS"
# 4) update.json（热包版本由 make_update_manifest 从 zip 里读，因此必须先构建出 sp2 的包）
python3 scripts/make_update_manifest.py /root/dsh-full/dsh-android
python3 -c 'import json;print(json.load(open("update.json"))["hot"])'   # 期望 1.1.5-t2-sp2
sh scripts/sync_repo.sh "1.1.5 热更新 sp2 + slim"        # 只推 update.json 等源码（需要 SSH key）
# 5) 回读验证（不打印 token）
curl -sSI -L "$API/releases/latest" >/dev/null
curl -sS -H "Authorization: Bearer $T" "$API/releases/$RID" | python3 -c 'import json,sys;d=json.load(sys.stdin);print([(a["name"],a["size"],a["digest"][:20]) for a in d["assets"]])'
curl -sSI -L "https://github.com/itiswdwa/dsh-android/releases/latest/download/dsh-hot.zip" | head -1   # 期望 200/302 而非 404
```
**注意**：`make_update_manifest.py` 只读 `VERSION`/`ROOTFS_VERSION`/热包，`hot.version` 直接来自 zip 的 `hot.json`，因此 sp2 的包必须在它之前构建（`release_hot.sh` 就是这么排的）。
**发布正文（已在 CHANGELOG 里备好草稿）**：`## [1.1.5-sp2] - 2026-10-14`（放在 `## [1.1.5]` 之上，符合本文件"同一应用版本下热包排在前面"的约定）。`release_notes.py 1.1.5 --channel hot-history`（`release_hot.sh` 用的正文通道）会渲染它，`--channel app` 仍渲染原来的 1.1.5 段不被污染；球线改动位置留了 `<!-- 球线：… -->` 占位。段里已包含：终端重做（白底/自写渲染/输入法/标签页）、pnpm 预装、方向键光标、键盘召回、issue #3 闸门与自动补齐、@local 插件，以及下面这条**必须写清**的 注意。
**瘦包用户的 pnpm**：已经装好 rootfs 的 slim 用户**不会**自动重下 payload（`terminal.version` 仍是 2），所以他们要等下一次装全量/换线才有 pnpm；他们能立刻拿到的是热包里的插件/脚本改动（含 §6.2 闸门修复）。要覆盖这批人只能改 `update.json.terminal.version`（= 开新线，代价见 §2.3）。

---

## 4. App 架构（Java，`app/java/com/lanfeiyu/harness/`）

| 文件 | 职责 | 备注 |
|---|---|---|
| `MainActivity.java` | Activity + 设置页/加载页/设置引导 + `BridgeServer.Host` 实现 + WebView 宿主；`Payload.applyHot(this)`→`DshService.ensure(this)` | ✅已核（`:170`/`:471` 两处 applyHot） |
| `DshService.java` | 前台服务：拉起 PRoot + `start-dsh.sh`，守护 `dsh web`，`ServerBus` 抓 stdout 里的 URL/token | 🔶（未逐行读） |
| `Payload.java` | rootfs 安装（zip + `payload.manifest` 提供 mode/软链）、热包覆盖层、`/import`、slim 外壳、`hotVersion/prefp`、`BuildInfo` | ✅本会话改过（§4.1） |
| `BridgeServer.java` | 127.0.0.1 环回 HTTP 桥（token 鉴权），路由：`/snapshot /server/* /open-in-browser /import /update/check /terminal/fetch /hot/pick /hot/fetch /open-url /export* /mounts/* /distros/* /settings /log/clear /a11y/* /overlay/request /mic/request /ball/*` + **`/haptic`（本会话新增）** | ✅ |
| `BallService.java` | 悬浮球：`ball.html`(visual) / `composer.html`(bar) 两个 WebView + `DshBall`/`DshComposer` JS 桥；窗口/形变/气泡/通知 | 🔶球线负责 |
| `Assist.java` | 无障碍：读屏/点击/输入/滑动；`ui` 命令的服务端 | 🔶 |
| `ShizukuBridge.java` | 以 shell 身份执行命令（`shiz`） | 🔶 |
| `Payload.HOT_ALLOWED_PREFIXES` | 热包允许写入的前缀（§5.4） | ✅ |

### 4.1 `applyHot` 的已知致命行为 + 本会话的修法 ✅（代码已改、已编译、逻辑已测）
**问题**：`applyHot()` 每次启动都**无条件**把 APK 内建 `assets/hot.zip` 重写一遍（`Payload.java` 注释 "Runs on every launch"；`unpackHot(ctx,null,null)` 无版本判断；`writeHotEntry` 无内容/时间戳跳过），而用户导入/下载的热包只应用一次、**不保存**。于是：热包应用后 = 新文件 + `pref=spN`；下次启动文件被 baked 覆盖回旧内容而 `pref` 仍是 spN → 设置页显示"已应用 spN"、更新卡片因版本相等不再提供、手动重选同一份包被 `applyFile` 以 `version.equals(pref)` 拒绝 → **内容旧、版本新、无法自救**。
✅现场证据：热包白名单内的文件 mtime **全部等于最近一次启动时刻**（`2026-10-14 04:14:58`：`opt/dsh/android/*`、`opt/dsh/dsh-plugin-android/lib/*`、`usr/local/bin/ball`、`@home/.dsh/skills/floating-ball/SKILL.md`），而不在白名单内的文件仍是 payload 安装时间（`2026-09-30`）。

**修法**（本会话落地）：
1. 新增 `HotVersion.java`（**无 Android 依赖**，纯函数：`line/sameLine/spOf/shouldReplay`）。
2. `Payload` 新增：`storedHotPackage()` = `filesDir/hot-applied.zip`（~300KB）；`stampStoredHot(File)` 在 `applyFile` / `fetchAndApply` 成功后把 zip 存进去；`applyHot()` 顺序改为 **先 baked 覆盖层 → `replayStoredHot(ctx)` → `discardForeignHot()`**；`replayStoredHot` 的判据：
   `shouldReplay(stored, baked, app, terminal, stored.lastModified() > apkLastUpdateTime())`
   - 同线 + **应用时间晚于本 APK 安装时间** + `sp(stored) > sp(baked)` → 重放（并把 pref 写回 stored 版本）
   - 否则（另一条线 / 等于或落后 / 早于本 APK）→ **删除存档并把 pref 设为 baked 版本**（不降级）
   - `apkLastUpdateTime()` = `PackageManager.getPackageInfo(...).lastUpdateTime`，取不到时返回 0（=视为"晚于"，让版本号决定）
   - `discardForeignHot()` 额外删除存档（不属于本线的包不留）
   **为什么要"晚于本 APK"这一条**：`make_hot_zip.py --base` 让每次重新出包的 baked 恒为 `sp0`，即使它的内容比上一版热包**更新**（脚本注释明说这一点），只比 sp 会把旧热包重放成降级。
3. ✅验证：`javac -source 8 -target 8`（android.jar android-36）**exit 0，52 个 class**；`HotVersion` 纯 JVM 决策表 **31 checks / 0 failures**（含 "sp2 over baked sp0 重放"、"早于 APK 的 sp9 丢弃"、"t3 拒绝"、无 sp 回退、相等丢弃）。
4. ❓**仍未验证的**：真机行为（"应用 sp2 → 重启 → 仍是 sp2 内容"）必须在装上新 APK 后实测：`ball`… 不适用；步骤见 §10.6。App 私有目录存档 + pref 是纯 Java 逻辑，我无法在沙箱里跑 Android 运行时。

### 4.1b 运行时"已就绪"判断的 bug（2026-10-14 发现并修复）
**症状**：装了新的全量 APK，运行时**完全没更新** —— `/opt/dsh/**`、`/usr/local/bin/node` 的 mtime 还停留在
上一次解包（本机是 `2026-09-30 03:21`），只有热包白名单里的文件是新时间戳。
**根因**（✅代码 + 现场证据）：
```java
// 旧 App.isBundledReady()：任意 .payload-* 标记都算"就绪"
for (String name : markers) if (name.startsWith(".payload-")) return true;
// Payload.install() 第一行就是：
if (app.isBundledReady()) return;      // ← 于是新 APK 的载荷永远不会解包
```
现场：运行时目录里的标记是 `/.payload-d85c0d22da47889f`（1.1.5 时代解包留下的，Sep 30），
而新 APK 的 `BuildInfo.PAYLOAD_VERSION=a9001b8ed364b544` → 标记不匹配本该解包，却因为"任意标记即就绪"被跳过。
**连带后果**：①"预装 pnpm"在**任何已有运行时的设备**上都不会生效（本机 `/usr/local/bin/pnpm` 至今是
Oct-12 手工装的 29 字节软链，只是因为内容恰好相同才没暴露）；②整个 t 线（运行时）更新模型对老设备失效。
**修法**（本轮）：
- 新增 `app/java/com/lanfeiyu/harness/PayloadMarker.java`（纯函数，无 Android 依赖）：**全量壳只认自己那份载荷的
  标记** `.payload-<PAYLOAD_VERSION>`；**瘦包壳**没有载荷，保持宽松（任意标记即就绪，因为它的运行时是下载来的）。
- `App.isBundledReady()` 改为调用它；`Payload.unpack()` 成功写入新标记后**清理其它旧标记**。
- 解包本身不需要改：它先 `clearLink(target)` 再写文件，所以旧软链会被替换成真文件 ✓（这一点已读码确认）。
**验证**：`javac` 全量编译通过（53 个 class）；`PayloadMarker` 决策表 **15 checks / 0 failures**
（含回归用例"全量 APK + 别人的标记 ⇒ 不就绪，必须解包"、瘦包宽松用例）；`HotVersion` 31 checks 仍全过。
**证据（修复后的产物）**：新全量包 `out/dsh-android.apk`
sha256=`dce1756943e53632411ecc789e740825da086abacdc804687580872f0660354e`、206,982,190 B，
`BuildInfo.PAYLOAD_VERSION=8e6597008d91cf51`，其 `assets/payload.zip`（212,245,549 B）里**两份**种子市场的
`client.js` md5 都是 `d6bb2e46139ebbd3b217bc8efbd562bc`（新版）；新旧 payload 逐条目对比：条目集合完全一致
（25,892），**只有 6 个条目不同**（两处 `@local/dsh-market` 的 README/client.js/test）✓。
❓待真机验证：装这份新全量包后应触发一次完整解包（进度条），随后 `/usr/local/bin/pnpm` 变成**单文件**
43,403,704 B / md5 `f20469f02b54169cc9ed50abb5b80b7f`，且 `/.payload-*` 只剩新的那一个。

### 4.1c 安装进度 UI（2026-10-14 修：进度条看着不动）
**用户报的现象**：装全量包时"进度条不动、像卡死"。修好 §4.1b 之后更容易复现 —— 因为终于真的会解包了
（真机 13 秒、20703 个文件、765 个软链、19938 个 mode）。
**原因（读码）**：
1. **`准备载荷` 阶段完全没有回调**：把 207MB 的 `assets/payload.zip` 拷到临时文件时传的是 `copy(raw, out, null)`
   → 若干秒里一个回调都没有，进度条纹丝不动；
2. 解包阶段是"每 32 个条目一次"，且 `detail` 直接塞 zip 条目路径（一堆路径文字在跳，人看不出进度）；
3. `应用清单` 阶段没有任何上报；
4. 进度条是确定态（`setMax(1000)`），一旦没有回调就静止 —— 没有任何不确定态兜底。
（解包本来就在后台线程 `"payload-install"` 上跑，这条没问题，ANR 风险不成立 ✓。）
**改法**：
- 新增 `app/java/com/lanfeiyu/harness/UnpackPlan.java`（纯逻辑，无 Android 依赖）：**阶段**（`准备载荷` → `解包中` →
  `应用清单（软链与权限）` → `完成`）、**节流**（最快 200ms 一次 = 5Hz，或每 200 个条目，阶段切换与最终值强制上报）、
  **文案**（`解包中 1234/20703（5%）`、`准备载荷 12.0 MB / 202.0 MB`、`应用清单（软链与权限）：765 个软链 / 19938 个权限`）
  与 **permille**（`-1` 表示总数未知 → UI 用不确定态）。
- `Payload.install`：拷贝阶段按字节上报（总长用 `AssetFileDescriptor.getLength()`，拿不到就是"不确定"）；
  解包阶段改用 **`ZipFile.size()` 的条目数**做分母（可以精确到"第几个条目"）；清单阶段上报开始与结果；
  结束上报 `完成`。旧的"按压缩字节累加"分母删掉（它和实际进度不成比例）。
- `MainActivity`：`done < 0` 时切 `setIndeterminate(true)`（不确定态动画），否则确定态 + 计数文案；
  只在模式变化时切换，避免闪烁。
- 日志（验收证据，`shiz logcat -d -s dsh | grep payload`）：
  `payload staged: N bytes in Xms (N progress callbacks)` ·
  `payload extracted: 20703 files in Xms (N progress callbacks so far)` ·
  `payload manifest applied: 765 symlinks, 19938 modes in Xms` ·
  `payload install finished in Xms (N progress callbacks total)`。
**不装包怎么验**：`UnpackPlan` 是纯逻辑 → JVM 上跑 `UnpackPlanTest`（节流规则、四种阶段文案、permille、
以及一段**合成时间线**：20703 条目 / 13 秒，打印回调次数与前后几条文案，用来确认 5Hz 节流与"进度确实在动"）。
命令见 §10「Java 单元测试」。
❓真机验证归 Lead（装包 + 连拍截图看进度条在动）。

### 4.1d 注意：载荷更新会**整棵替换 runtime**（连带清掉手工 apt 装的东西）
`Payload.install` 的第一步是 `deleteTree(home)`，然后把新载荷整棵解开 ⇒ **runtime 目录里一切不在载荷里的东西都会消失**：
本会话就实测到一次 —— 用户在真机上装了新全量包（05:42 解包），
`/usr/bin/python3`、`/usr/local/bin/node`、`/.payload-8e6597008d91cf51` 的 mtime 全变成 05:42:29-30，
而**我们此前 apt 装的 JDK（`javac`/`java`/`keytool`）和 `python3-yaml` 一起没了**（要重新 `apt-get install`）。
- 用户数据不受影响：`/root`（App 存储）是 bind mount，不在 runtime 树里 ✓；`/sdcard` 同理 ✓。
- 但用户 `apt install` 到 runtime 的工具会在下次载荷更新时消失 —— 排查时**别误判成"环境坏了"**；
  要长期保留得放到 `/root` 或 `/sdcard` 下。
- 对发布的意义：改 runtime 内容的代价是"用户侧的自定义被清一次"，所以能走热包就别动载荷。
- **对本机构建的影响（本次实测）**：`build_apk.sh` 需要 `javac`/`keytool`，而它们是 apt 装的 → **载荷一更新就没了**，
  得重装：`apt-get update && apt-get install -y openjdk-21-jdk-headless`（本次 128 MB，ports.ubuntu.com 从这台机器
  只有 ~2 MB/min；换成 `mirrors.aliyun.com/ubuntu-ports` 后 ~9 MB/min，见 `/tmp/apt-mirror.py` 的做法）。
  纯逻辑测试也可以只装 `openjdk-21-jdk-headless`，跑法见 §10「Java 单元测试」。

### 4.1e 两个观察（2026-10-14）
1. **`BuildInfo.PAYLOAD_VERSION` 是 payload.zip 的「字节哈希」**，而 zip 条目带时间戳 ⇒
   **内容完全相同的重建也会换哈希**（本次实测：新旧 payload 逐条目内容 **0 处不同**、25892 条目一致，
   只有条目时间戳不同 → sha256 从 `8e659700…` 变成 `e9f05c10…`）。后果：每次出 APK，
   设备都会做一次完整的 200MB 解包（13 秒）。想让"内容没变的重新出包"不再触发解包，
   得在 `make_payload_zip.py` 里把条目时间戳固定成常量（内容哈希化）——**建议但未实施**。
   好处也有：本次 1.2.0 build 10201 因此**必然触发一次解包**，正好用来验收进度条。
2. **载荷更新会清掉 `/tmp` 与 apt 装的一切**（§4.1d），构建工具链也因此全没了；
   恢复清单见 §10（JDK / android.jar / r8 / apksig / aapt2+qemu / librsvg / python3-pil / gcc / libproot）。

### 预装插件市场的两条硬约束（Node 22.x / 升级前必须跑冒烟）

**背景**：本发行版预装第三方市场 `dshmarket@1.66.21`。它依赖 `undici@7`，而 Harness 自身网络层
（`@deepseek-ai/dsh-http-proxy`、`@deepseek-ai/dsh-web-fetch-http`）依赖 `undici@8`。上游
[dsh-market#861](https://github.com/dsh-market/dsh-market/issues/861)（open，2026-10-14）报告：
在 **Node 24.14.1 + DSH 0.2.0-rc.2** 上加载市场后，**宿主自己的出站请求与模型对话全部失败**
（`TRANSPORT` / `Connection error` / `could not reach …/models`），禁用 `- id: dsh-market` 后恢复；
根因是两套 undici 争用 `Symbol.for('undici.globalDispatcher.1'/.2')`。

**我们的实测（dsh 0.1.7-rc.2 + Node 22.23.2 + market 1.66.21 + undici 7.30.0 vs 宿主 8.11.2）：未复现。**
- 真实模型调用：对照组（纯 headless）正常；实验组（同 profile + market）**3/3 正常**，每次 5–7 秒，无传输类错误；
- dispatcher 机制：宿主 undici 8 先加载 → 插件 undici 7 后加载，符号**未被顶掉**；风险顺序（插件先、宿主后）下符号保持插件写入的 `Agent`，两种顺序下 **Node 内置 fetch / undici8.fetch / undici7.fetch 全部 HTTP 200**；
- `lib/net.js` 在 **1.66.20（报告版本）与 1.66.21（我们预装版本）逐字节相同** → 机制在我们副本里存在，差异在运行环境（**Node 大版本**是首要嫌疑）。

**约束一：App 运行时 Node 保持 22.x。**
升到 Node 24 之前必须先验证市场不会破坏宿主网络与模型对话；**症状是模型对话全挂**，属灾难级。

**约束二：升 Node / 升 DSH 到 0.2.x 之前，必须跑一次冒烟。**
仓库里已加脚本 `scripts/smoke-market-llm.sh`（约 10 秒）：临时 profile 先跑一次真实模型调用（对照组），
再把 payload 里 vendored 的 `dshmarket` + 依赖注入同一 profile 跑第二次（实验组），
只要出现 `TRANSPORT` / `Connection error` / `could not reach` 或没有输出即退出码非 0。
用法：`sh scripts/smoke-market-llm.sh`（可覆盖 `DSH_INSTALL` / `CRED` / `PAYLOAD_NM` / `TASK`）。
凭据只放在临时目录，退出即删；不联网安装任何东西（只用 payload 里已 vendor 的包）。

**用户侧规避（已写进 `docs/preinstalled-plugins.md` §5 与用户说明）**：出现模型/网络异常时，
在 profile patch 里加

```yaml
- id: dsh-market
  disabled: true
```

并重启，即可恢复宿主网络与模型对话（市场界面与它的服务不再加载，包文件留在磁盘上）。

**参考链接**：上游 issue #861 <https://github.com/dsh-market/dsh-market/issues/861>；
我们的实测原始输出见 `dsh-market-evidence/A-peer-and-runtime-audit.md` 与本次审计记录。

### 4.2 悬浮球 overlay 窗口（🔶球线素材）
单窗口形变方案（收起=球矩形/展开=条/气泡=自适应矩形）+ `dsh-ball-visual` 空壳层；"不可触摸"约束（visual 层不接收触摸，交互在 bar 层）。待决策：`dsh-ball-visual` 空壳是否删除。

---

## 5. 插件与移动端补丁

### 5.1 `plugin/dsh-plugin-android`（**权威源**：仓库这份）
- **client 半** `lib/client.js`（**当前三份一致：md5 `0a48c6ff41ead4f8091bf1eff4af9d73`** —— 页面线做完 issue #2 引导后的版本；上一版 `61f55198f5eb3020cd8f3b9c81b92b1d`）：终端面板（重写，§7）、设置页「安卓沙箱」+ issue #2 的「下载运行时」兜底地址与一屏引导、悬浮球提示段与 `ball_doing`、`@ball-inbox` 自愈、权限预置、`POST /haptic` 调用与兜底、`/ball/state` 轮询。
- **host 半** `lib/index.js`：系统提示词的环境段（手机/PRoot/`/sdcard`/`shiz`）、`app:ball-surface` 会话识别等。
- 三份同步规则（✅）：仓库 `plugin/dsh-plugin-android/lib/*` = `/opt/dsh/dsh-plugin-android/lib/*` = `/root/.dsh/profiles/web/node_modules/dsh-plugin-android/lib/*`（profile 那份是**设备上真正被加载的**，我已用 module rev 反推确认）。**改 client.js 前先打招呼**（多人并行时它是热点文件）。
- 生效方式：`@deepseek-ai/dsh-client-hmr` 每 500ms stat 轮询插件 bundle，变化即 `clientModules.rebuilt()` + SSE `/plugins/events` → 浏览器热重载（✅实测：改文件后 index/SSE 的 `rev` 立刻变，服务端发出的字节 = 磁盘文件，除 sourceMappingURL 一行外逐字节相同）。**不需要重启 server，不需要刷新页面**。

- **运行时 `inject` 必须显式列出要用到的服务**（🔶作者 2026-10-14，未在真机复验）：Cordis 客户端 context 上
  能拿到什么，由模块返回的 `inject` 数组决定。写 pluginManager 这一类插件时 **`remote` 必须写**，否则拿不到
  Remote 网关（页面永远显示"没有 pluginManager"，严重时 `apply` 直接崩）。对照 shipped 的
  `@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js`，它的 inject 是
  `["slots","locale","remote","remote.pluginManager","remote.pluginInventory","remote.pluginRegistryProbe","configForms","layout"]`。
  两个容易混的点：①`package.json` 里的 `dsh.client.inject`（**包名**，管模块加载顺序）与模块返回的 `inject`
  （**服务名**，管 ctx 上能拿到什么）是两回事，都要写；②**具体命名空间（如 `remote.pluginManager`）最好不要写进
  inject** —— 写了而该 profile 没挂 plugin-manager 时，模块会永远 pending、标签页静默消失；不写、改用
  `try { ctx.remote?.pluginManager } catch {}` 再降级成"无管理器"提示，页面至少能出来（`@local/dsh-market` 就这么做）。
- **"重启前把 client 半注入真机页面看渲染"这条路走不通**（🔶作者实测）：GUI 的模块系统处于 `mode:"live"`，
  临时 `window.__ModuleLoader__.load()` 的注册不会被 apply（`pendingQueue:0`，也不在 `__DSH_BOOT__.entries` 里）。
  预验证只能靠"逐条对照 shipped 客户端代码 + 离线用例"，页面观感必须等重启。

### 5.2 移动端补丁（**前端 assets，必须随新 APK**）
- `patches/android-mobile.css` + `patches/android-mobile.js`：手机布局（窄屏侧栏=全屏抽屉、scrim、抽屉内选会话即收起、`window.__dshmBack()` 硬件返回钩子）。
- 注入方式：`patches/apply-ui-patch.py <node_modules-root>` 把两个文件拷进 `@deepseek-ai/dsh-web-frontend/dist/assets/` 并写进 `dist/index.html`（幂等）。✅已确认 built rootfs 里注入的 js md5 = 仓库那份 `cdfcaa729d918500eb8510302624f8ea`。
- **限制**：`opt/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/**` **不在热包白名单** → 这类补丁只能随新 APK/payload 发（issue #1 的修复也在此列）。
- issue #1 根因（✅我定位）：`patches/android-mobile.js:76-90` 用 capture 阶段监听，点击落在 `[class*="_sessionRow"]` 内就把抽屉收起 → ⋯ 菜单锚点被卸载（闪现消失）而行的选择照常进入会话。

### 5.3 skill 与 @local 插件
- `floating-ball` skill：✅仓库 `payload/home/.dsh/skills/floating-ball/SKILL.md` 与设备 `/root/.dsh/skills/floating-ball/SKILL.md` **逐字节一致**；`payload/home` → seed → `~/.dsh`，同时 `make_hot_zip` 以 `@home/...` 发热包。
- **三个**本地插件（✅已落进仓库，真文件非软链，**21 个文件**逐字节一致）：`payload/home/.dsh/profiles/web/node_modules/@local/`
  · `dsh-ball-summarizer/`（7 文件）· `agent-browser-viewer/`（8 文件）· **`dsh-market/`（6 文件，作者 2026-10-14 定稿）**
  目录名必须与包名一致（`ball-summarizer` 的包名是 `@local/dsh-ball-summarizer`，市场是 `@local/dsh-market`）。
  `dsh-market` 定稿 md5：`client.js afcf53391e8632a0dc482552b74f970e`、`index.js a426aaffcba99d890a1be7a681460425`、`package.json 5d6eb12b7f2702bb71474d0636fef967`、`cordis.patch.yml 9dd00dcd72c5093455f8d1d0e068d8fc`、`README.md b8172a89dbb8adc31e6e825591a1a9ac`、`test/market.test.mjs 9417624797f7e6a908e9b9cbd7195db4`。
- 让它们**真正被加载**需要 profile 依赖 + bundle 行（✅`profile/package.json`，md5 `6b0d55a2b2855275ce0b0bfc0553a2ec`）：
  `"@local/<name>": "file:./node_modules/@local/<name>"` 三条 + 并入 `dsh.profile.bundles`。
  ✅验证（2026-10-14）：临时 profile（仓库 `profile/*` + payload 三个包 + `dsh-plugin-android`）跑 `DSH_HOME=/tmp/handoff-home … dsh web --dump-config` → **exit 0，skipping/skip/cannot resolve/error 命中数 = 0**，输出里有 `- id: dsh-market / name: '@local/dsh-market'`（config `online: true`、`searchText: keywords:dsh-plugin`）与 `- id: android-sandbox`；Node 解析四个包全部 `resolved`。故意删一个包时 loader 只打印 `skipping profile bundle … cannot resolve` 并继续（exit 0，**不会 brick**）。
- **老设备**由 `repair-profile.mjs` 的 `BUNDLES` 表补（三条，见 §6.2）；热包自动带这三个包（实测 8 + 7 + 6 个文件会进包）。
- **插件市场的 5 条真机教训**（🔶作者在隔离实例上实测：临时 `DSH_HOME` + 3177 端口，没碰在跑的 3080；证据截图在
  `/mnt/Documents/dsh-plugins/dsh-market-evidence/`。离线用例覆盖不到的坑，写客户端插件的人都会踩）：
  1. **`inject` 里光写 `remote` 不够，命名空间也要写**：`remote` 提供网关，但 `remote.pluginManager` 这个**名字**
     也要在 `inject` 里，否则网关拒绝该名字 —— 页面能渲染，**34 个按钮全变 disabled**（最难查的一种失败）。
  2. **Remote 返回的是信封**：成功 `{ok: true, value}`、失败 `{ok: false, error: {code, diagnostic}}`。当成数组用会
     `bundles.map is not a function` → React 卸载整棵子树 → **面板空白且没有任何报错**。
  3. **`meta.description` 可能是 `{en, zh}` 对象**：直接当 React child 会抛 **React error #31**，同样白屏。
  4. **所以必须加错误边界**：把任何渲染异常变成面板里一句可读的话（第 3 条正是被它抓出来的）。
  5. **装 app 类 bundle 会改变 CLI 的参数面**：在 web profile 里装上 `@deepseek-ai/dsh-acp-app` 之后，
     `dsh web --no-open` 会报 `unknown option '--no-open'` —— 用原 argv 重启会起不来。`start-dsh.sh` 不带这些 flag，
     现网不受影响；**以后若做"装完自动重启"，不要照抄原 argv**。
- **市场改用公开包（2026-10-14，Lead 拍板；热包 `1.2.0-t2-sp2`）**：预装的是 npm 上的 **`dshmarket`**
  而不是我们自建的 `@local/dsh-market`。
  - **vendor**：`payload/home/.dsh/profiles/web/node_modules/dshmarket/`（1.66.21，177 文件）+ 它的运行时依赖
    `undici@7.30.0` / `js-yaml@4.3.2` / `argparse@2.0.1`（真文件、非软链；每个 tarball 都按 npm 的
    `dist.integrity`(sha512) 校验过，tarball sha256 记在 `THIRD_PARTY.md`）。**安装时不联网**。
  - **profile**：`profile/package.json` 依赖用 `"dshmarket": "file:./node_modules/dshmarket"`，
    `dsh.profile.bundles` 里是 `dshmarket`；`@local/dsh-market` 的依赖行与 bundle 行都已移除。
  - **老设备迁移**（`repair-profile.mjs`）：新增 `dshmarket` 的依赖行与 bundle 行；把 `@local/dsh-market` 的
    **bundle 行**去掉（**只改行**：依赖行与 `node_modules/@local/dsh-market/` 目录都保留，可手工回退）。
    **保守规则**：只有当 `dshmarket` 的 `package.json` **真的在磁盘上**时才加它的行、也才退役旧行
    —— 否则原样不动（"能用但列表不整洁" 好过 "列表整洁但市场没了"）。这依赖热包先落地，所以迁移是自愈的：
    文件到了的下一次启动才生效。**两行同 id 会撞车**：自建包的 patch 行 id 与公开包一样都是 `dsh-market`，
    所以"两个 bundle 同时在"这种状态必须避免 —— 这正是退役旧行是硬要求的原因（作者确认）。
  - **回退**：把 `@local/dsh-market` 加回 `dsh.profile.bundles`（文件都还在）→ 下次启动 `repair-profile`
    又不会退役它（因为退役只在"旧行在 + 新包在"时才做 ✗ 嗯：那它会再次退役 ✗ —— 真回退要同时把
    `dshmarket` 从 bundles 里去掉，或者直接改 `BUNDLES`/`RETIRED` 常量）。**注意别在发行版里同时挂两个**。
  - **产物卫生**：`assemble_payload.sh` 现在会 `rm -rf` 掉 seed 里的 `@local/dsh-market` 并**断言**
    它不在、且 `dshmarket/package.json` 在（overlay 是"合并"不是"替换"，老构建留在
    `build/rootfs*` 里的旧包会被悄悄带上 —— 作者提醒的坑，已用断言兜住）。
  - **验证**（都在隔离环境，没碰用户实例）：`--dump-config` → **0 处 skipping**，合成结果里有
    `- id: dsh-market / name: dshmarket`（**只有一行**）；临时 `DSH_HOME` + 端口 3188 起隔离实例 →
    `GET /dsh-market/api/v1/capabilities` = **200**，正文含 `"marketVersion":"1.66.21"`；
    `GET /dsh-market/api/v1/updates/summary` = 200（`{"checked":4,"updatable":0}`）；
    不带会话时是 401（鉴权栅栏 ✓）。离线用例：`node docs/repair-profile-test.mjs` → **24 checks / 0 failures**
    （只有公开包 / 两者都在 / 只有自建 / 文件缺失的保守路径 / 坏 JSON 五种情形）。
  - **风险（如实记录）**：① 公开包声明 `@deepseek-ai/dsh-settings` 的 peer 范围与本机 `0.1.7-rc.2` **不满足**
    （作者用 semver 实测 `satisfies=false`）—— 但隔离实例上**没有任何 peer 报错、也没被兼容性自检拒绝**，
    capabilities 正常响应；真机再确认一次；② 它默认访问第三方站点（见 `THIRD_PARTY.md` 的说明）；
    ③ 体积：payload 212.2MB → **216.7MB**，热包 559KB → **2.75MB**；④ `tar xzf` 在这台沙箱里建不了目录
    （作者遇到；我这次没遇到 —— 用 `tar xzO` 或 node 解包更稳）。
- ❓**待重启验证**（作者明确：新增 bundle **不会**被运行中的 `dsh web` 热加载，刷新页面也不够）：右侧栏出现「插件市场」标签页、`GET /dsh-market/catalog` 返回目录、从市场里真装一个插件生效、失败路径的可读报错。

### 5.4 热包白名单（✅`make_hot_zip.py` + `Payload.HOT_ALLOWED_PREFIXES`）
`opt/dsh/android/`、`opt/dsh/dsh-plugin-android/`、`etc/`、`@home/`、`usr/local/bin/`。
**不含** `opt/dsh/node_modules/**`（前端 assets 就在里面）与 `usr/local/lib/node_modules/**`。

---

## 6. 本轮落地与待办（我这条线）

### 6.1 `Payload.applyHot` 重放修复 ✅（§4.1）
### 6.2 issue #3 种子闸门 ✅ + 现有设备的"外科式补齐" ✅
**闸门**：`payload/opt/dsh/android/start-dsh.sh` 由
`[ ! -d "$DSH_HOME/.dsh/profiles/web" ]` 改为
`[ ! -f "$DSH_HOME/.dsh/profiles/web/package.json" ]`。
**选它的理由**：①最小改动；②内置热包在 `start-dsh.sh` 之前（`MainActivity:170` applyHot → `:171` ensure）就写出了 `profiles/web/node_modules/dsh-plugin-android/**`，目录闸门必然被跳过；③**自带自愈**：坏掉的设备仍缺 `package.json` → 下次启动补齐种子；④不用从热包里去掉 `@home/.dsh/profiles/web/**`，保留"插件代码走热包、profile 配置走 payload"的设计。

**外科式补齐**（新增 `payload/opt/dsh/android/repair-profile.mjs`，md5 `403bea6d993cded9e1f0be368cd72cf6`，由 `start-dsh.sh` 在播种块之后调用，`sh -n` + `node --check` 通过 ✅）：
- 起因：种子只在 `package.json` **缺失**时整体复制，而那个文件是**用户数据**（bundle 列表是用户自己的）。所以"新增 bundle 行 / 补回插件行"永远到不了已安装的设备。
- 做法：**只补缺的**——缺文件就从种子复制；`package.json` 缺 `@local/...` 依赖行或 bundle 行就追加（`JSON.parse`→补键→2 空格缩进写回，**已有键值/顺序全部保留**）；`cordis.patch.yml` 缺 `android-sandbox` 就把种子里的那一整条 entry **原样追加**（用户内容作为前缀原封不动）。
- 失败静默降级：顶层 try/catch + 每个子步骤独立 try，坏 JSON 只打日志、**绝不 brick 启动**（实测 exit 0）。
- 实测（`/tmp/repair-test/test_repair_profile.mjs` → **22 checks / 0 failures**）：①用户 profile 有自己的 bundles（含 experimental）+ 自己的 `cordis.patch.yml` → 只追加我们缺的行，用户行顺序/内容不变（`bundles[0]`/`bundles[2]` 断言通过）、patch 文件以用户内容为前缀；②只有 `node_modules/` 的空 profile → 补齐两个文件且不扰动 app 写的插件目录；③`package.json` 是坏 JSON → 文件逐字节不变、exit 0，且 patch 行仍被补上（两个修复互相独立）；④已修好的 profile 再跑 → "nothing to repair" 且 mtime 不变（幂等）。
- ❓未验证：真机（下次启动的 `start-dsh: repair-profile: …` 日志）。
**seed 的派生关系**（免得改错地方）：`assemble_payload.sh:37` 把 `payload/home` 复制进 `opt/dsh/dsh-home-seed/`，`:49` 把仓库 `profile/` 复制进种子（`assemble_payload.sh:52` 再删掉种子里 `node_modules/dsh-plugin-android`）。所以**仓库 `profile/package.json` 是唯一权威**，设备上的 `/opt/dsh/dsh-home-seed/profiles/web/package.json` 只是它的副本。
### 6.3 pnpm 预装 —— **已按 Lead 裁定的 B 方案落地** ✅
**落地内容**：
- `payload/usr/local/bin/pnpm` = 41MB 自包含二进制（`43,403,704 B`，md5 `f20469f02b54169cc9ed50abb5b80b7f`，sha256 `a6829768356de066…`），`cmp` 与 `@pnpm/exe.linux-arm64@12.11.2` 装出来的那份逐字节相同，`./payload/usr/local/bin/pnpm -v` → `12.11.2` ✅。`assemble_payload.sh` 把 `payload/` 整体覆盖到 rootfs 根 → `/usr/local/bin/pnpm`；payload 的 `payload.manifest` 记录 mode（755）✅。
- `scripts/make_hot_zip.py`（md5 `4cb25051c8274684640c06b375e87bb2`）新增 `HOT_EXCLUDED = ("usr/local/bin/pnpm",)`，在 `add_tree` 里按 arcname 跳过 → **热包不含 pnpm**（不动 allowlist）。验证（无副作用：模块 `main()` 有 `__main__` 保护，测试不写 `HOT`/`update.json`）：`/tmp/hot-excl-test/test_exclusion.py` → **9 checks / 0 failures**，热包 `usr/local/bin` 只剩 3 项（ball/shiz/ui），payload 侧文件仍在且可执行。
- `THIRD_PARTY.md` 登记来源与 MIT 许可。
- **后来改成「按需下载」（Lead 2026-10-14 批准）**：新增 `scripts/fetch-pnpm.sh` —— 固定 `12.11.2` + npm 的 `dist.integrity`(sha512) + 二进制 sha256 双重校验，实测 **3.6 秒**、幂等；`.gitignore` 排除 `payload/usr/local/bin/pnpm`；`assemble_payload.sh` 里自动调用（并进 sanity 清单）。**仓库因此完全不含这 41MB**。
- **41MB 曾经真的进了 git，是靠 reflog 藏着的**：先前的临时提交带上过该 blob，`git gc --prune=now` 也没清掉（reflog 仍引用它，默认保留 30 天）。`git reflog expire --expire=now --all` + `gc --prune=now` 之后才真正消失：pack 从 21.11 MiB 降到 **1.13 MiB**，`.git` 1.5M，且 `git rev-list --objects HEAD` 里任何提交都查不到该路径。**结论：以后加二进制前先确认 `.gitignore`，并检查 `git verify-pack` 里有没有「看不见的大对象」。**
- **代价（要写进 release notes）**：payload 189MB → ~230MB，瘦包用户首次下载多 ~41MB（+20%）。
- 另两条代价，知情即可：①`.gitignore` 不排除它（无扩展名，只有 `*.apk/*.zip` 之类），所以 **41MB 会进 git 历史**（每次升级 pnpm 多一份；GitHub 单文件上限 100MB，41MB 安全）；②41MB 在 `payload.manifest` 里记 mode，安装时是逐文件拷贝，首次解包时间略增。
**为什么否掉另外两条（实测原因，别再走弯路）**：
- `pnpm@12.11.2` npm 包只有 **4MB**，但它的 `bin/pnpm` 是占位符，入口 `bin/pnpm.mjs` 会在**首次使用**时联网下载 `@pnpm/exe.<platform>`（`native-binary.mjs` 注释明说）→ 离线预装不成立。
- 本机 `npm i -g pnpm` 的完整安装是 **213MB**（含多平台二进制）；把白名单扩到 `usr/local/lib/node_modules/pnpm/**` 要么带 213MB，要么带那个联网版 → 否。
- corepack 方案最终仍要落回同一个 41MB 的 `@pnpm/exe.linux-arm64`，只是多一层复杂度 → 否。
**未验证**：真机装新 APK 后 `command -v pnpm && pnpm -v`（我无法装 APK）；`dsh plugin --profile web add <spec>` 端到端（需要设备上跑）。

### 6.4 `dsh-market` —— **形态由 Lead 定：一个插件市场（实现中，未验证）** 🔶
- **定位（Lead 口径，用户只说"是一个插件"）**：DSH 界面里的**插件市场**（页面/面板）：列出可安装的插件
  （名称 / 描述 / 版本 / 来源），支持一键安装 / 启用 / 停用；安装走 harness 官方 API
  （`@deepseek-ai/dsh-plugin-manager` 那条路），失败给可读报错。
- **打包**：`@local/dsh-market`，随 payload/profile 预装 —— 这是 issue #4 承诺里的"预装 pnpm 与 dsh-market"。
- **状态**：✅**已落地**（作者 2026-10-14 定稿；三个契约字符串与 §5.3/§6.2 完全一致：`@local/dsh-market` / `file:./node_modules/@local/dsh-market` / `BUNDLES` 同名）；❓GUI 端到端**待重启验证**（新增 bundle 不会被热加载）。
- **落地方式（等包就绪，照 §5.3 的同一条路）**：①包放进 `payload/home/.dsh/profiles/web/node_modules/@local/dsh-market/`（真文件）；
  ②`profile/package.json` 加 `"@local/dsh-market": "file:./node_modules/@local/dsh-market"` 并加入 `dsh.profile.bundles`；
  ③`payload/opt/dsh/android/repair-profile.mjs` 的 `BUNDLES` 表补一条（老设备才会自动生效）；
  ④热包会自动带上（`payload/home` → `@home`），但要 `profile/package.json` 行到位才会被加载。
**排查结论（我做的部分）** ✅：工作树/仓库/`/mnt/Documents/dsh-plugins` 无命中；harness 安装包无 market 页面
（`@deepseek-ai/dsh-plugin-manager` 只导出 `./registry`）；npm registry `GET /dsh-market` → **404**；
用户 5 个公开仓库（`arc_randommaker`/`a_simple_homework`/`dsh-android`/`iconPenguins`/`itiswdwa`）里没有 market 项目。
- 工作树/仓库/`/mnt/Documents/dsh-plugins` 无 `dsh-market`（唯一 grep 命中是 python `platform.py`）。
- harness 安装包里没有（`@deepseek-ai/dsh-plugin-manager` 只有 registry 导出，无 market 页面）。
- npm registry `GET /dsh-market` → **404 not found** ✅。
- 用户 GitHub 5 个公开仓库里没有 market 项目（`arc_randommaker`/`a_simple_homework`/`dsh-android`/`iconPenguins`/`itiswdwa`）✅。
→ 结论：需要用户说明"dsh-market 是什么"（插件市场的 UI？一个新的 @local 插件？还是应用内页面）。**不要凭空造**。
### 6.5 HOT 准备 ✅（§2.2，已置 `sp=1, hash=""`）
### 6.6 终端未落地的小改（等发布后）：把亮/暗判定 `detectTerminalTheme()` 提成可测块（行为不变，仅补 5 条测试；已在 `/tmp` 跑通）。

---

## 7. 终端重写（我这条线，✅已上线到设备）

**为什么弃用 xterm**：xterm 自带隐藏 textarea 与 Android IME 抢事件（中文候选/剪贴板被当按键回显），canvas/DOM 渲染又把文本从浏览器选中里拿走（手机只有原生长按选择/复制）；旧版还并存"底部整行输入框 + xterm onData"两条输入路径，方向键在输入框里**一个字节都不发**，光标自然不动。

**实现**（`plugin/dsh-plugin-android/lib/client.js` 内四个可测标记块）：
- `@vt-core` 自写 VT：UTF-8 跨包增量解码、C0/ESC/CSI/OSC/SGR、光标/擦除/插删行列/滚动区/备用屏/宽字符（CJK+emoji 簇）/DEC 图形/制表位/save-restore/DSR·DA 回包/OSC 4·10·11·12 调色板与 104·110·111·112 复位/`?25l` 光标隐藏/`?1049` 备用屏；**未覆盖**：鼠标上报、六派图、Kitty 键盘协议、超长行 reflow、冷门 CSI。
- `@vt-input` 单一输入路径：`beforeinput(insertText)` 吞掉插入并原样发一次；组合期（IME）**什么都不做**，`compositionend` 才发；回删=DEL、长按删除=`Ctrl+W`、方向键=`ESC[A..D`（尊重 DECCKM）、Ctrl 组合与功能键行共享映射；同 tick 去重（compositionend 回显）；**键盘收起后能稳定唤回**（`requestKeyboard`：先判 `visualViewport` 是否真收起 → 强制 blur+focus → 4 次 × 90ms 有界重试，仅在点击后 1.5s 窗口内 → 失败给可见提示）。
- `@vt-view` DOM 行渲染：真实文本节点（长按选择/复制走系统）、按 `rev` 复用行、光标与 IME 预编辑画在文本流里、`setScreen()` 支撑标签页、行内 60ms 去抖的触感钩子。
- `@vt-store` 标签页/会话复用：插件级 store（不在面板里）→ 侧边栏「终端」重复点只**激活**已有终端；最多 4 个 tab；关闭/插件卸载时 `DELETE /sessions/<id>` 交还 pty。
- `@vt-haptic` 触感：优先 `POST /haptic`（App 侧 `performHapticFeedback(KEYBOARD_TAP)`），失败退 `navigator.vibrate(12)`，60ms 去抖。
- **亮/暗判定**：`detectTerminalTheme()` 读 `<html data-ds-theme-source>`，回退 `<body data-ds-dark-theme>`，最后才 `prefers-color-scheme`。旧 bug：读错了节点（暗色属性写在 body）+ 回退到"手机的系统深色"，于是手机深色+App 亮色 → 终端黑底；观察者也在盯错节点 → 运行中切主题不跟随。
- 测试：`plugin/dsh-plugin-android/test/` 7 套 **282 checks / 0 failures**（对部署后的 bundle 跑）：`vt-core`(72，含 11 个真 pty 场景与 `@xterm/headless` 逐格对拍 + DSR 回包一致)、`vt-input`(43)、`vt-view`(69)、`vt-store`(30)、`vt-haptic`(13)、`vt-plugin`(27，整包 apply() fake host)、`vt-e2e`(28，键事件→PTY→bash→模拟器→DOM 光标位置全链)。跑法见 §10.4。
- 修复过的两个真 bug（都被测试抓到）：① 只移动光标的行不重绘（painted caret 停在原地）；② `resize` 锚点错（终端变矮时把内容推到错的一边）。
- `AbortSignal.any`（WebView 114/华为）❓未修（工作树无任何命中；归"待用户确认优先级"）。

---

## 8. Issue 清单与承诺（✅逐条读过正文+全部评论；4 个 issue 共 2 条评论，均 itiswdwa 本人）

| issue | 承诺原文（逐字） | 出处 | 状态 |
|---|---|---|---|
| **#4** 不能安装插件/找不到 pnpm | 「这似乎是由pnpm未安装导致的，对您造成的麻烦深表歉意 我们将在下个版本修复此问题，即预装pnpm与dsh-market，谢谢您的理解」 | itiswdwa @ 2026-10-14T03:50:23Z | **未实现**：pnpm 见 §6.3（选项待定）；`dsh-market` 无现成来源（§6.4） |
| **#2** 无法安装 | 「在下次更新中，我们将强化引导payload.zip的下载与安装，再次对您造成的不便深表歉意」 | itiswdwa @ 2026-10-14T04:00:35Z | ✅**已修**（页面线，只改 `client.js` → md5 `0a48c6ff…`，`MainActivity` 仍是 `aa14b295…`）：清单给不出地址时回退到 release 资产 `releases/latest/download/payload.{zip,manifest}`；文案改成一屏可照做的中文引导（自动下到 App 私有目录、下完自动导入、失败给原因并可重试）；❓真机待验（无 rootfs 机器上的入口、230MB 下载/断网/空间不足提示） |
| **#3** 1.1.5 全新安装种子被跳过 | 无维护者评论（报告者 sanmaoAI1432 @ 2026-10-06T14:58:10Z 给出根因与三条修法 + WebView 114 兼容问题） | — | ①闸门 **✅已修**（§6.2）；②`AbortSignal.any` ❓未修（优先级待定） |
| **#1** 侧边栏 ⋯ 菜单闪现消失 | 无维护者评论（报告者 wanfooo @ 2026-10-03T18:00:50Z） | — | 根因已定位（§5.2）；**修复归另一条线**（我未改，避免与补丁那位写同一文件） |

---

## 9. 已知未完成 / 待决策（汇总）

| 项 | 状态 | 谁定 |
|---|---|---|
| 把新 payload 烘进 APK（市场已换公开包） | **待做**：热包 `1.2.0-t2-sp2` 已发，现有设备立刻换成公开市场；新装设备仍拿到旧 baked 市场（含已退役的自建包）→ 下次出包时用 `versionCode` 10202 重建全量/瘦包。裁剪已就绪：`scripts/trim_vendor.sh`（7.3MB→4.0MB，实测隔离实例通过）已接进 `assemble_payload.sh`，但**当前 payload.zip 与两个 APK 未重建**（仍是 10201 的旧内容）。⚠️ 载荷更新会清掉构建工具链：先 `dpkg --configure -a`，再 `sh scripts/restore-build-toolchain.sh` | Lead / CI |
| `applyHot` 重放修复 | ✅代码+编译+决策表测试完成；真机验证待装包 | — |
| #3 种子闸门 | ✅已改；全新安装真机待验 | — |
| pnpm 预装 | ✅已按 **B 方案**落地（41MB payload 二进制 + 热包排除）（§6.3）；真机 `pnpm -v` 待验 | — |
| `dsh-market` | ✅已落地（payload 真文件 + profile 行 + repair 表 + 解析验证）；❓GUI 待重启 | — |
| profile @local 依赖行 | ✅已加并验证解析；✅老设备由 `repair-profile.mjs` 外科式补齐（§6.2） | — |
| HOT sp 准备 | ✅已置 sp=1/hash=""（下次非 base 构建 → sp2） | — |
| 终端 `detectTerminalTheme` 可测化 | 未落地（等发布后） | 我 |
| `AbortSignal.any` WebView 114 | 未修 | 用户优先级 |
| `dsh-ball-visual` 空壳是否删 / 环 90°·180° 取舍 / 3 行 72dp（Java 上限需同步） | 🔶球线待决（素材来自球线） | 球线/Lead |
| 本环境 SSH push 能力 | ❌无 key/known_hosts（§3.3） | 用户/Lead |
| 发布（slim + hot + SHA256SUMS + update.json） | **命令已备好未执行**（§3.5，含 `releases/latest`=t2 的陷阱与两种做法） | Lead 发话 |

---

## 10. 常用命令速查

```sh
# 0a) Java 纯逻辑单元测试（不装包、不需要设备、不看 Android SDK）
sh docs/run-unit-tests.sh
#     HotVersion 31 + PayloadMarker 15 + UnpackPlan 30（含 20703 条目/13s 的合成时间线）
#     需要 javac：apt-get install -y openjdk-21-jdk-headless
# 类型检查（只编译、不打包；用来在装包前发现笔误）：
#     javac -encoding UTF-8 -source 8 -target 8 -nowarn \
#       -classpath "/tmp/platform/android-36/android.jar:$(ls app/libs/*.jar | tr '\n' ':')" \
#       -d /tmp/javac-out @sources.txt      # sources.txt = find app/java build/r -name '*.java'
#
# ⚠️ 构建工具链一半在 /tmp、一半是 apt 装的，而载荷更新会整棵替换 runtime（§4.1d）
#    → 每次在设备上装了新 APK 之后都会被清空。**一条命令恢复**：
sh scripts/restore-build-toolchain.sh
#    它会：换 aliyun 镜像 → apt 装 JDK21/librsvg/PIL/gcc/qemu-user-static/交叉 libc/python3-yaml
#    → 下 android.jar(platform-36_r02) / r8.jar / apksig.jar / aapt2(Maven 的 linux jar，2.4MB)
#    → 重建 /opt/android/root64 这个 QEMU_LD_PREFIX 树与 /usr/bin/qemu-x86_64 软链 → 自检
#    还差 libproot.so：`sh scripts/fetch-proot.sh`，出包时 PROOT=$PWD/build/proot/libproot.so
#
# 体积卫生：vendor 进来的插件按 `sh scripts/trim_vendor.sh` 裁掉运行时用不到的东西
#    （实测 7.3MB → 4.0MB；`package.json` 的 main/module/browser/types/exports 指向的路径一律保留）。
#    注意：overlay 是"合并"不是"替换"，所以 assemble_payload.sh 里对 seed 也再裁一次。
#
# 退役包门禁：`node scripts/check-legacy-market-residue.mjs --root <产物目录>`
#    （assemble_payload.sh 已接线；热包/payload zip/APK 解出的目录也可以单独跑）。

# 0b) 发布后真机验证（**只读**：不装包/不重启/不写 prefs；--haptic 才会震一下）
sh docs/verify-ondevice.sh            # 每项给「期望 / 实际 / 结果」，末尾汇总 PASS/FAIL/MANUAL/SKIP
sh docs/verify-ondevice.sh --haptic   # 额外验 POST /haptic（手机轻震一次）
#    本版期望值都写在脚本顶部的 EXPECT_* 常量里（发布新版本时改那一段即可）

# 0) 环境事实
pwd=/mnt/Documents · 沙箱=PRoot Ubuntu（无 systemd）· node v22.23.2
python3 / git / curl **有**（环境说明里说没有是旧的）· gh **没有** · java/javac 有（/usr/bin）
android.jar: /tmp/platform/android-36/android.jar（类型检查用）

# 1) 构建 APK（会覆盖 HOT 为 sp0；会生成 BuildInfo.java）
cd /root/dsh-full/dsh-android && sh scripts/build_apk.sh
#    产物：out/dsh-android.apk、out/dsh-android-slim.apk、build/hot-assets/hot.zip、out/SHA256SUMS

# 2) Java 类型检查（不装 APK、不动设备；等价于构建的第 3 步）
find app/java -name '*.java' > /tmp/sources.txt && find build/r -name '*.java' >> /tmp/sources.txt
javac -encoding UTF-8 -source 8 -target 8 -nowarn \
  -classpath "/tmp/platform/android-36/android.jar:$(ls app/libs/*.jar | tr '\n' ':')" \
  -d /tmp/classes @/tmp/sources.txt        # exit 0 = OK

# 3) 热包（非 base：按 §2.2 bump sp；会写 update.json 与 HOT）
python3 scripts/make_hot_zip.py /root/dsh-full/dsh-android build/hot-assets/hot.zip
python3 scripts/make_update_manifest.py /root/dsh-full/dsh-android
python3 scripts/version.py --field hot      # 查看当前热包版本串

# 4) 注入前端补丁（手机布局；改完 patches/android-mobile.* 必须重跑）
python3 patches/apply-ui-patch.py <node_modules 根，如 build/rootfs-ubuntu/opt/dsh/node_modules>

# 4b) 两个无副作用的自测（不写 HOT/update.json、不动设备）
python3 /tmp/hot-excl-test/test_exclusion.py      # 热包排除 pnpm：9 checks
node /tmp/repair-test/test_repair_profile.mjs     # profile 外科式补齐：22 checks
#    （脚本本体在 payload/opt/dsh/android/repair-profile.mjs；测试用临时 home 目录）

# 5) 终端测试（7 套 282 checks，对 lib/client.js 里的标记块跑；core/e2e 需要 node-pty）
cd plugin/dsh-plugin-android/test
for t in vt-core vt-input vt-view vt-store vt-haptic vt-plugin; do node $t.test.mjs; done
node vt-e2e.test.mjs          # DSH_INSTALL 可覆盖 /opt/dsh
# 球冒烟 341 项、总结器 35 项（🔶数字由对应线提供，命令请找那两位）

# 6) 发布（**需要 GITHUB_TOKEN，且纪律上必须先得到 Lead/用户许可**）
cp build/hot-assets/hot.zip out/dsh-hot.zip         # 否则 release.sh 会发旧的 out/ 那份
python3 - <<'PY'                                    # 把 sp 从 0 抬到 1（hash 必须与即将构建的内容不同）
import json, pathlib; p = pathlib.Path("HOT"); d = json.loads(p.read_text())
d.update({"sp": 1, "hash": "", "version": f'{d["app"]}-t{d["terminal"]}-sp1'})
p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n")
PY
T=$(cat /root/.dsh/gh-token); GITHUB_TOKEN=$T sh scripts/release_hot.sh   # 热包：sp2 + update.json + sync_repo
GITHUB_TOKEN=$T sh scripts/release.sh                                     # app 版本（需要 out/dsh-android.apk）
sh scripts/sync_repo.sh "说明"                                            # 只推源码（SSH，需 key）
# 回读验证（不打印 token）
curl -sS -H "Authorization: Bearer $T" https://api.github.com/repos/itiswdwa/dsh-android/releases/latest \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["tag_name"], [(a["name"],a["size"]) for a in d["assets"]])'

# 7) 回滚
#    · 热包：把上一份 dsh-hot.zip 重新作为当前 release 的 dsh-hot.zip 资产上传（同名替换），或手动选包应用
#      ⚠️ 注意 §4.1 的新语义：比 baked 更旧的包在下次启动会被丢弃（不会把新 APK 降级）；要真回滚请装旧 APK
#    · app：把上一版 out/dsh-android.apk（或 release 里的历史资产）同名替换上传，update.json 指向 releases/latest
#    · runtime：release_terminal.sh <旧N> 重新发布 t<旧N>（会改 ROOTFS_VERSION；跨线会影响设备可见性）
```
### 10.6 "应用 sp2 → 重启 → 仍是 sp2 内容" 的验证步骤（装上新 APK 后）
1. 拿一份 sp2 热包（`build/hot-assets/hot.zip`，`hot.json.version` 应为 `1.1.5-t2-sp2`），在设置页「检查更新」里应用，或手动选包。
2. `adb`/`shiz` 侧读 `/root/.dsh/profiles/web/node_modules/dsh-plugin-android/lib/client.js` 的 md5（记为 A）。
3. 完全退出 App（从最近任务划掉，确保 `MainActivity.onCreate` 再跑一次）后重开。
4. 再读同一文件 md5：应仍为 A（旧行为会变回 APK 内建那份 = B）。
5. 交叉核对：`bridge /snapshot` 的 `hotVersion` 仍为 `1.1.5-t2-sp2`，且 App 日志里能看到 `hot replay: re-applied 1.1.5-t2-sp2 (N files) after the baked overlay`（`App.log`）。
6. 反向用例：先装新 APK（baked 更新）再启动 → 日志应出现 `hot replay: dropped <旧版本> (baked <新版本>)`，文件为新 APK 那份。

---

## 11. 接手须知

1. **权威来源与同步规则**
   - 插件代码：仓库 `plugin/dsh-plugin-android/**` 是权威；三份副本（仓库 / `/opt/dsh/dsh-plugin-android` / `~/.dsh/profiles/web/node_modules/dsh-plugin-android`）**保持字节一致**。设备上真正被加载的是 **profile 那份**（✅用 module rev 反推确认）；`/opt` 那份每次启动会被 baked 热包覆盖。
   - 手机布局补丁：仓库 `patches/android-mobile.{js,css}` 是权威；生效副本在 rootfs 的 `dsh-web-frontend/dist/assets/`（**不在热包白名单**）。
   - profile 配置：仓库 `profile/` 是权威（`assemble_payload.sh` 复制进 seed 的 `profiles/web/`）；设备上的 `~/.dsh/profiles/web/*` 是**用户数据**，只在缺失时被 seed 覆盖。
   - 版本：`VERSION`（app）、`ROOTFS_VERSION`（terminal）、`HOT`（sp/hash）、`update.json`（清单）——四者口径见 §1/§2。
2. **改动后怎么验证**：Java → §10.2 类型检查（+ 纯逻辑类写 JVM 测试，如 `HotVersion`）；插件 → §10.5 七套测试（它们读 `lib/client.js` 的标记块，测的就是要发的那份）；shell → `sh -n`；前端补丁 → 重跑 `apply-ui-patch.py`；发布 → §10.6 的回读验证。
3. **协作约定**：`plugin/dsh-plugin-android/lib/client.js` 是并行热点（球线也改它）→ **动手前打招呼**，改完跑七套测试；`patches/android-mobile.js` 归补丁/页面线；不要改 `Payload.HOT_ALLOWED_PREFIXES`（安全边界，需 Lead 决定）；不要在日志/文档/回报里出现 token 内容。
4. **本环境的坑**：`web_fetch` 遇 fake-IP（198.18.0.0/15）会 WEB_BLOCKED → 用 `node -e 'fetch(...)'`；`/opt/dsh/dsh-plugin-android/**` 每次启动被热包覆盖；Android 无 `link()` → git 需 `core.createObject rename`；`shiz` 只能在 Shizuku 授权时用；注入点击/输入受审查限制（需 Lead）。
5. **文件名只有一个**：`HANDOFF.md` 是本仓库唯一的交接文档。历史上曾有一份只差大小写的
   `handoff.md`（2026-09-30 上一会话版），它在本文件第二部分（A 前缀编号）里保留全文后已删除 ——
   大小写不敏感的文件系统会把两个名字当成同一个文件互相覆盖，git 检出也会视作异常。**不要再新建
   与小写/大写变体同名的文档**；要补充就写进本文件对应章节。
6. **接手第一件事建议**：跑一遍 §10.5（插件七套）+ §10.2（Java 编译）+ `python3 scripts/version.py`，确认基准绿；再看 §9 的待决策表拿任务。

---

## 12. 悬浮球实现要点与坑（🔶由球线口述、Lead 转述，**我未逐条复验**；接手球相关改动前请找球线或复验）

1. **单窗口形变**：收起=球矩形、展开=条、气泡=自适应矩形；`dsh-ball-visual` 是空壳层，交互在 bar 层；visual 层不接收触摸。
2. **`bubbleSize` 桥**：页面量好文字后回报所需尺寸（`DshBall.bubbleSize`），原生按这个尺寸调整窗口 —— 尺寸口径两边必须一致，否则气泡被裁。
3. **JS 桥按参数个数严格匹配**：`addJavascriptInterface` 的方法签名是固定 arity，页面多传一个 `undefined` 会被**静默丢弃**（不报错），表现为"调了但没反应"。
4. **visual 层被 ROM 压 0.8 alpha**：某些 ROM 对 overlay 窗口做透明压缩，纯色/边框看起来发灰 —— 需要实测确认（🔶未复验）。
5. **"两条胶囊"的两次成因**：历史上出现过两次双胶囊/双条，成因分别与"两个 WebView 同时可见"和"窗口尺寸未同步"有关。
6. **✓ 徽标被圆裁**：圆形窗口/圆角裁剪会切掉贴边的徽标，需要给徽标留内边距。
7. **多行排版高度 40/52/72dp**：Java 侧对窗口高度有上限常量，**必须与页面的三档行数同步改**，否则第三行被裁。
8. **SVG 上的 CSS 动画在 WebView 不生效**：球的旋转/等待动画不要用 SVG + CSS animation，要用 **HTML border spinner**。
9. **`morph()` 空回调导致 App 崩溃**：桥方法回调为 `null`/空时不要直接调用（会 NPE 崩 App）。
10. **热包会覆盖 `/opt`**：球相关的 `/opt/dsh/android/ball*`、`assets/ball` 都在热包白名单里，改完记得同步三份并确认覆盖顺序（每次启动 baked 覆盖层先写，再按 §4.1 重放用户包）。


---

# 第二部分：上一版交接文档（2026-09-30，上一会话 Minis）

_本部分是小写 `handoff.md` 的**全文**，只有标题被加上 `A` 前缀（`A1`…`A15`、`A11.x`），正文一字未改，
以便它写的"坑"和接口表一字不少地留下来。两处需要对照着读：_

| 本部分章节 | 讲什么 | 已被本文件第一部分取代/更新的地方 |
|---|---|---|
| A1 项目是什么 / A2 代码在哪 | 项目定位、路径、跑起来 | §1（含真实 checkout 位置）、§11 |
| A3 版本模型 | 三段式版本号规则 | **§2（t2 + sp 递增的判据与顺序，更新）** |
| A4 发布：三条通道 / A5 release note 规范 | 通道与文案规范 | **§3（含 `latest` 陷阱、手动发布骨架、回读验证）** |
| A6 应用架构 / A7 控制桥接口表 | Java 侧与桥的完整路由表 | §4（含 `applyHot` 重放修复）、§4 的桥表；**`/haptic` 为本轮新增** |
| A8 客户端插件 / A9 沙箱内部 / A10 构建流水线 | 插件与 guest、构建链 | §5、§3.1（构建链已按当前脚本核实） |
| A11 踩过的坑（A11.1–A11.15） | "下次还会踩"的清单 | 前半部分仍有效；**A11.10 移动端布局、A11.14 npm 搜名、A11.15 新 bundle 不热加载 为本轮/近期新增**；§9 是仍未完成项 |
| A12 测试与验证手册 | 手工验收集 | §10（命令速查）、插件 `test/` 七套与 HotVersion/repair 自测 |
| A13 当前状态快照 / A14 待办 / A15 工作约定 | 状态与协作 | **§9（待决策表最新）、§11（接手须知，含文件名唯一这条）** |
| 附：常用命令速查 | 上一版命令 | §10（已并入本轮新增命令） |

## A1. 项目是什么

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 dsh）装进安卓手机：
**一个 APK，不需要 Termux、不需要 root、不依赖其他应用**。应用自带一套 Ubuntu 运行时
（rootfs + Node + dsh 及其全部依赖），用 PRoot 在手机里跑起来，再用 WebView 打开 dsh 自己的
Web UI —— 所以手机上是**原样的 harness**，不是重做的客户端。

在这之上，这个项目还做了两件上游没有的事：

- **手机助手**：应用内置无障碍服务 + 常驻悬浮球（"大肥鱼"）。按住球说话 / 点一下弹出输入框，
  说完交给会话，agent 用 `ui` 命令去看屏幕、点按钮、在别的应用里输入 —— 也就是"豆包手机"那种形态。
- **可运维的发布体系**：应用 / 终端（rootfs）/ 热包三条独立通道，见 §3 §4。

---

## A2. 代码在哪、怎么跑起来

### A2.1 路径（**会变，先确认**）

工作树被清空过两次，所以路径不一定和以前一样。当前：

| 用途 | 路径 |
|---|---|
| 源码工作树（在这里构建） | `/var/minis/shared/dsh-android/` |
| git 检出（只有源码，没有构建产物） | `/var/minis/shared/dsh-android-repo/` |
| 手机 Download（与设备共享） | `/var/minis/mounts/Download/` |
| 本沙箱的 lab（跑一份 harness 用来试插件 UI） | `<工作树>/lab/` |
| 构建产物 | `<工作树>/build/`（中间）、`out/`（APK/热包） |

工作树的清理在 `scripts/sync_repo.sh` 里做，**默认值就是上面这两个路径**；
需要时用 `DSH_SRC_DIR` / `DSH_REPO_DIR` 覆盖。

```sh
# 一条命令：工作树 → 检出 → commit → push
sh scripts/sync_repo.sh "这次改了什么"
```

`sync_repo.sh` 顺手处理三个本沙箱特有的坑（原因见 §11.9）：
`git config core.createObject rename`、`git clean -Xfd`（大写，别删未 add 的新文件）、remote 用 SSH。

### A2.2 沙箱里有什么

- Alpine（musl）PRoot guest，root，有网络（**没有 ICMP**：`ping` 会一直挂着，用 `curl` 测连通）。
- `apk add` 可用（gcc 也在，用来编 `linkfix.c`）。
- JDK 11：`javac` / `java` / `keytool`。
- 安卓构建工具（**路径写死在 `scripts/build_apk.sh` 顶部**）：
  `/tmp/platform/android-36/android.jar`、`/tmp/aapt2dir/aapt2`（x86_64，经 `qemu-x86_64`
  + `QEMU_LD_PREFIX=/opt/android/root64` 跑）、`/tmp/r8.jar`（d8）、`/tmp/apksig.jar`。
- `libproot.so`：从 `/var/minis/mounts/Download/libproot.so` 拷进 APK。
- GitHub 凭据：`$GITHUB_TOKEN`（contents:write）；推送用 `~/.ssh/id_ed25519`（部署密钥）。
- 设备访问：`android-shizuku-cli exec '<shell 命令>'`（Android shell 身份，uid 2000）。

### A2.3 三条命令启动一份 lab（用来试插件 UI，不碰手机上的 app）

手机上正跑着 app，**占着 3080（harness）和 8399（控制桥）**，而沙箱与设备共享网络命名空间，
所以 lab 必须换端口：

```sh
LAB=<工作树>/lab
mkdir -p $LAB/dsh-home/profiles/web/node_modules
cp <工作树>/profile/* $LAB/dsh-home/profiles/web/
ln -sfn <工作树>/plugin/dsh-plugin-android $LAB/dsh-home/profiles/web/node_modules/
cd $LAB && DSH_HOME=$PWD/dsh-home setsid nohup node --expose-internals \
  ./node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port 3180 > /tmp/lab.log 2>&1 &
DSH_TOKEN=test-token DSH_BRIDGE_PORT=8488 setsid nohup python3 \
  <工作树>/scripts/stub_bridge.py > /tmp/stub.log 2>&1 &
```

然后 `browser_use` 打开 `http://127.0.0.1:3180/?token=<日志里那串>`，
先注入 `window.DshAndroid={base:"http://127.0.0.1:8488",token:"test-token",pty:null}`，
再点设置 → 安卓沙箱。**改完插件必须重启 lab 进程**（客户端模块表按 mtime 取 revision）。

---

## A3. 版本模型（三段式，必须遵守）

```
1.1.5 - t2 - sp0
  │      │    └─ 热包序号；sp0 = 这一版没有热更新
  │      └────── 终端（沙箱运行时：rootfs / node / dsh / 装进去的工具）
  └───────────── 应用（APK：Java、资源、内置载荷的构建来源）
```

- 三个记账文件（都在仓库根，**随源码提交**）：`VERSION`（应用）、`ROOTFS_VERSION`（终端）、
  `HOT`（`{app, terminal, sp, version, hash}`，上一次在这里打的热包）。
- **渲染/比较/拼版本串一律走 `scripts/version.py`**，别处不要再手拼：

  ```sh
  python3 scripts/version.py --field full      # 1.1.5-t2-sp0
  python3 scripts/version.py --field core      # 1.1.5-t2
  python3 scripts/version.py --field code      # 10105（versionCode）
  ```

- **终端版本不跟着应用版本走**：只改界面/Java 不动运行时，`t` 不变（`1.1.6-t2`）；
  换了 rootfs（新装的包、新的补丁、新的运行时文件）才 `+1`（`1.1.7-t3`）。
- **热包只在它那条线上生效**：`<应用>-t<终端>-sp<n>`。应用版本或终端版本一变，热包序号从 `sp1` 重算。
  插件里有 `sameLine` 保护，应用侧有 `Payload.discardForeignHot()`（启动时把跨线的已应用热包作废）。
- **所有热包的内容必须归并进下一个版本**（应用版本或终端版本都算）：发新外壳时，之前热包的改动
  必须已经在 `plugin/`、`payload/`、rootfs 里；新外壳内置那份记作 `sp0`。
  否则会出现"装了新 APK 反而回到旧插件"。

序号推进规则（`scripts/make_hot_zip.py` 的 `next_sp`）：

| 情况 | 结果 |
|---|---|
| 应用构建（`--base`） | **恒为 `sp0`** —— 内置那份就是这条线的基准 |
| 同线、内容没变 | 沿用原号（重复构建不跳号，否则每台设备都会被重新提示） |
| 同线、内容变了 | `sp+1`（号只能涨：应用判断"已应用过"靠版本串相等） |
| 线变了 | 热包 `sp1` |

---

## A4. 发布：三条通道

**先想清楚是哪一种，选错一次就是几十分钟白跑。**

| 改了什么 | 走哪条 | 命令 | 代价 |
|---|---|---|---|
| 插件（`plugin/`）、技能、`payload/opt`、`payload/etc`、`payload/home` | **热更新** | `sh scripts/release_hot.sh` | ~1 分钟，90 KB |
| 应用 Java / 资源 / 图标 / `app/` 下任何东西 | **外壳** | `build_apk.sh`（+`SLIM=1`）→ `sh scripts/release.sh` | ~8 分钟，180 MB + 0.57 MB |
| rootfs 本体（`scripts/prepare_rootfs.sh` 装的包、`patches/` 打的上游补丁） | **终端** | 重出载荷 → `sh scripts/release_terminal.sh` | ~10 分钟，186 MB |

**三条通道各自的产物与指向**（都在 `update.json` / GitHub release 里）：

| 资产 | 挂在哪个 release | 谁在用 |
|---|---|---|
| `dsh-android.apk`（完整，180 MB） | `v<应用>` | 全新安装 |
| `dsh-android-slim.apk`（瘦，0.57 MB） | `v<应用>` | 已有运行时的设备更新外壳 |
| `dsh-hot.zip`（~90 KB） | `v<应用>` | 应用内「检查更新 → 应用热更新」 |
| `payload.zip` + `payload.manifest`（186 MB） | **`t<终端>`**（独立 tag） | 瘦包首次启动时下载运行时 |

`update.json`（schema 2，由 `scripts/make_update_manifest.py` 生成）形如：

```json
{
  "schema": 2,
  "app":      { "version": "1.1.5", "versionCode": 10105,
                "url": ".../releases/latest/download/dsh-android.apk",
                "slim": ".../releases/latest/download/dsh-android-slim.apk",
                "page": ".../releases/latest" },
  "terminal": { "version": "2", "full": "1.1.5-t2", "tag": "t2",
                "url": ".../releases/download/t2/payload.zip",
                "manifest": ".../releases/download/t2/payload.manifest" },
  "hot":      { "version": "1.1.5-t2-sp0",
                "url": ".../releases/latest/download/dsh-hot.zip",
                "manifest": "https://raw.githubusercontent.com/itiswdwa/dsh-android/main/update.json" }
}
```

**三条脚本都幂等**，中途断了重跑即可（会先删同名资产再上传）。
`release.sh` 会把 release 正文设为 CHANGELOG 里该版本的条目；`release_hot.sh` 维护
`<!-- hot-notes -->` 之后的段落（**该应用版本下所有热包条目，按 sp1、sp2… 顺序**，不是只留最新）。
`scripts/refresh_release_notes.sh` 用来重刷已发布 release 的正文。

---

## A5. 变更日志（release note）规范

**唯一事实来源是仓库根的 `CHANGELOG.md`**；release 正文由 `scripts/release_notes.py` 从它渲染，
**版本在 CHANGELOG 里没有条目就发不出去**（脚本会非零退出）。别处不要再写第二份说明。

写作规则（两条外部规范，已被用户明确要求）：

- [Keep a Changelog](https://keepachangelog.com/1.1.0/) 管**格式**：`## [版本] - YYYY-MM-DD`、
  分组用 `Added / Changed / Fixed / Removed / Security`、应用版本之间新的在前、
  **同一应用版本下的热包按发布先后（sp1、sp2…）排列**、底部放引用式链接定义。
- [Common Changelog](https://common-changelog.org/) 管**内容**：一条一行、写"对用户意味着什么"
  （坏在哪 / 现在怎样）、相关改动合并、互相抵消的不写、**删掉噪音**（构建脚本、重构、dotfile、
  文档格式不进发布说明）、破坏性改动 `**Breaking:**` 开头。

**用户在这个点上骂过两次**，两个方向都错：
① 写成日记/调试过程（自造结构、讲"我一开始搞错了什么"）；
② 只剩骨架（把 1500 字压成 307 字）。条目要**有实质**：至少写清触发条件与现在的行为。

---

## A6. 应用架构（Java 侧）

包名 `com.lanfeiyu.harness`，`minSdk 26 / targetSdk 28`（**targetSdk 必须是 28**：Android 10+ 只有
legacy 域允许从应用私有目录 `execve()`，而整个载荷就跑在那里）。无 Gradle，
`aapt2 + javac + d8 + 手写 zip + apksig` 出包。

| 类 | 职责 |
|---|---|
| `App` | 单例、目录（`distrosDir/tmpDir/runDir/logsDir`）、`prefs`、端口分配、就绪判定 `isBundledReady()`、`terminalVersion()` |
| `MainActivity` | 整个 UI：全屏 WebView + 首次安装进度 + 原生面板宿主；`injectBridge()` 注入 `window.DshAndroid`；`deliverPrompt()` 把文字交给页面 |
| `BridgeServer` | 环回控制桥（默认 8399，token 鉴权，`X-Dsh-Token`）；`/snapshot` 是所有状态的汇总 |
| `Panel` | 应用自带的原生控制面板（服务/挂载/发行版/设置/日志），`Panel.Host` 是它的回调契约 |
| `Payload` | 载荷解包（zip + manifest）、热包应用（内置 asset / 线上 / 本地文件）、**运行时按需下载** |
| `Proot` | PRoot 启动参数（**故意不传 `--link2symlink`**）、`PROOT_TMP_DIR`、bind 列表 |
| `Distros` | 发行版列表/选择/导入（tar 归档） |
| `Mounts` | 挂载管理：**源路径不存在则跳过（否则 proot 直接死），存在但没权限照绑并报告原因** |
| `DshService` | 前台服务 + 常驻通知（产品图标、状态+端口、通知栏内「停止/启动」） |
| `ServerBus` | 启动/停止 guest 内的服务，状态机（STARTING/RUNNING/ERROR/STOPPED） |
| `ShizukuBridge` | Shizuku 客户端（特权 shell 通道），`/shizuku/exec` 走它 |
| `Assist` | **无障碍服务**：读屏 `describe()`、`tap/swipe/key/type/click/launch`；屏幕描述**有界**（节点数/深度） |
| `BallService` | **悬浮球**（大肥鱼）：按住说话、点按弹输入框、拖动贴边、球上方气泡；外观（大小/图标）可配置 |
| `Updates` | 更新检查（服务端拉 `update.json`，页面不跨域） |
| `Exports` | 沙箱文件导出到 `Download` |
| `BuildInfo` | **构建时生成**（`build_apk.sh` 写）：`PAYLOAD_VERSION` / `APP_VERSION` / `APP_VERSION_CODE` / `ROOTFS_VERSION` |

### A6.1 启动顺序（**别打乱**）

```java
if (Payload.isReady()) {
    Payload.applyHot(this);        // ① 内置热覆盖（每次启动都做）
    DshService.ensure(this);
} else {
    installPayload();              // ② 首次：解包载荷 → 然后也必须 applyHot()（已修）→ 再看 ①
}
```

`applyHot()` 做三件事：写内置热覆盖、**作废跨线的已应用热包**（`discardForeignHot`）、
（新增）不做别的了 —— **不再扫描 Download 目录**（见 §11.11）。

---

## A7. 控制桥的完整接口表

`BridgeServer`，token 在 `X-Dsh-Token`，全部 POST（`/snapshot` 也支持 GET）。
guest 侧通过 `/etc/dsh-android/bridge.env`（app 启动前写）拿到 url+token，
`shiz` / `ui` 两个命令就是这么连上的。

| 端点 | 作用 |
|---|---|
| `/snapshot` | 一切状态：服务、发行版、挂载、设置、日志、版本（app/terminal/hot）、`payloadBundled`/`terminalReady`/`terminalBusy`/`terminalProgress`、`ball{size,image}`、`hotMessage`、shizuku、pty |
| `/server/start` `/stop` `/restart` | 服务控制 |
| `/settings` | 写应用设置（端口 / API key / 共享存储 / 保活 / 自动重启） |
| `/log/clear` | 清日志 |
| `/distros/select` `/delete` `/command` | 发行版 |
| `/mounts/pick` `/add` `/remove` `/toggle` `/test` | 挂载（`/test` 让沙箱真列一次目录） |
| `/export` `/export/recent` | 导出文件到 Download |
| `/import` | 选 rootfs 归档导入（新发行版） |
| `/open-in-browser` `/open-url` | 交给系统浏览器 |
| `/update/check` | 服务端拉 `update.json`（页面不跨域） |
| `/hot/fetch` | 从 URL 下载并应用热包 |
| `/hot/pick` | **选本地的 dsh-hot.zip 应用** |
| `/terminal/fetch` | **按需下载运行时**（瘦包用），进度看 `/snapshot` |
| `/ball/start` `/stop` `/config` `/pick-image` `/say` | 悬浮球：开关、外观（大小/图标）、**让外部往气泡里写一行** |
| `/a11y/status` `/request` `/tree` `/tap` `/swipe` `/key` `/type` `/click` `/open` | 无障碍：状态、去开启、读屏、点、滑、返回键、输入、按文字点、启动应用 |
| `/overlay/request` `/mic/request` | 悬浮窗、麦克风授权页 |
| `/shizuku/request` `/exec` | Shizuku 授权与执行 |

**约定**：`Assist` 抛的 `IllegalStateException` 里的文案是**写给用户看的**（"无障碍服务未开启：设置 → 安卓沙箱 → 手机助手"），
`BridgeServer.route()` 会把任何异常转成 `{ok:false,error:...}` 给页面。

---

## A8. 客户端插件（Web 侧）

`plugin/dsh-plugin-android/`，两个文件：`lib/index.js`（宿主侧，注入系统提示词）+ `lib/client.js`（浏览器侧）。

### A8.1 加载与插槽

- `package.json` 里 `dsh.client = {platform:"web", immediately:true}`，`exports["./client"] → lib/client.js`。
- **必须导出服务名**：`exports.inject = ["slots","locale"]`（写包名会永远 pending；不写则 apply 时崩）。
- 用到的插槽：`settings.section`（安卓沙箱设置页）、`main`（终端面板）、
  `sidebar.panellist`（左侧栏终端按钮）、`sidebar.right.tab.document.action`（文件预览的导出按钮）。
- 槽位注册的选项里 `label` 是函数、`inject` 返回组件 props。

### A8.2 可用的原生资源（**这是把设置页做成"原生观感"的关键**）

外壳的冻结模块表（`PLATFORM_MODULES`，在 `dsh-web-frontend/dist/assets/index-*.js` 里）含：
`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、
`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
**`@deepseek-ai/dsh-client-ui-primitives`**、`@deepseek-ai/dsh-client-ui-dockkit`。

在 `client.js` 里直接 `require("@deepseek-ai/dsh-client-ui-primitives")` 就能拿到
`Button / Switch / StateDot / Tag / Input / Pill / Modal / …` —— 它们是**静态表键**，
不加图边、不需要写 `dsh.client.external`。

> **坑（花了半小时）**：`Button` 是 `forwardRef(...)` 返回的**对象**，
> `typeof primitives.Button === "function"` 恒为 false → 会静默降级到自己的 fallback。
> 判存在要用 `obj[name] != null`。

**原生设置页的视觉规范**（照抄这些就对了，来源见 `scripts/extract_css.py`）：

- 页头：`h2 18px/600` + `p 13px label-tertiary`
- 分组标题：`15px/600`
- 字段：`padding:12px 0`，相邻字段 `border-top:0.5px solid --dsw-alias-border-l2`，
  label `13px/500`，hint `12px label-tertiary`
- 输入框：`height:34px; padding:0 12px; border:0.5px solid --dsw-alias-border-l4;
  border-radius:var(--dsw-radius-md); background:var(--dsw-alias-bg-layer-3)`
- 开关行：标题+说明在左、`Switch` 在右，`padding:12px 0`
- 卡片：`border:0.5px solid --dsw-alias-settings-card-stroke;
  border-radius:var(--dsw-radius-xl); background:var(--dsw-alias-settings-card-fill)`
- 主按钮是**黑底**（`--dsw-alias-button-primary-fill`），不是蓝色；次级用 ghost/outline

### A8.3 页面结构（`AndroidSection`）

服务 → 发行版 → 热更新包（含"运行时未安装→下载"行）→ 导出到手机 → 挂载 → Shizuku →
**手机助手**（三项授权 + 悬浮球：开关/大小/图标）→ 设置 → 日志。
样式用一段注入的 CSS（`.dsa-*` 前缀，挂在 `.dsa-root` 下），随插件生命周期挂载/卸载。

### A8.4 两条关键交互（都不在 Java 里，**所以能热更新**）

**(a) 把文字交给会话 —— `window.__dshAndroidPrompt(text)`**

- harness 的输入框**不是 textarea**，是受控的 `div[role=textbox][contenteditable]`
  （空会话时 `contenteditable=false`）。实测：写 `textContent`、派发 `input`、
  `document.execCommand("insertText")` **全都无效**（编辑器不回读 DOM）。
- **唯一可靠的做法**：合成一个 `ClipboardEvent('paste')`，带 `DataTransfer` 的 `text/plain`：
  ```js
  const data = new DataTransfer();
  data.setData("text/plain", value);
  box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  ```
  然后**等发送按钮 enabled**（编辑器异步更新状态）再 `click()`（60ms 轮询，最多 12 次）。
- 返回值只能是**同步字符串**（`evaluateJavascript` 读不到 Promise）：`pasted` / `clipboard` /
  `no-composer` / `empty`。应用把它转成气泡文案（找输入框失败就复制到剪贴板并如实说）。

**(b) 气泡显示"当前操作" —— 插件 → `/ball/say`**

插件用 `MutationObserver` 观察会话新增节点，把最后一行文字（节流 1.2s + 去重 + 过滤按钮文案）
推给 `/ball/say`，应用把它显示在球上方气泡里。
**这是权宜之计**：更干净的做法是接 harness 的会话状态服务（`ctx.sessions` / `ctx.conversation`
确实存在，`@deepseek-ai/dsh-client-ui-session` 里有 `ISessions`），但没摸清 API 前不要乱改。

---

## A9. 沙箱内部（guest 侧）

rootfs = Ubuntu 24.04（glibc 2.39）+ 官方 Node + dsh + 常用工具。
**关键路径**（都在 `$DSH_INSTALL` = `/opt/dsh` 下）：

| 路径 | 是什么 |
|---|---|
| `/opt/dsh/node_modules` | dsh 及其依赖（打过硬链接补丁） |
| `/opt/dsh/android/start-dsh.sh` | **guest 入口**：解析 node → **调用 `repair-dsh.mjs` 自修复** → 播种 profile → 起 pty 服务 → exec `dsh web` |
| `/opt/dsh/android/pty-server.mjs` | 终端服务（node-pty + 手写 WS，3099），同时伺服 xterm 资源 |
| `/opt/dsh/android/linkfix.c` / `liblinkfix.so` | **硬链接/chown 兼容层**（见 §11.1） |
| `/opt/dsh/android/repair-dsh.mjs` | **开机自修复**：修掉被旧补丁写坏的 `linkOrCopy` 自递归 |
| `/etc/ld.so.preload` | 一行 `/opt/dsh/android/liblinkfix.so` —— 让 guest 内每个动态程序都加载兼容层 |
| `/usr/local/bin/shiz` | 走 Shizuku 的 Android shell（pm/am/settings/screencap…） |
| `/usr/local/bin/ui` | 走无障碍的屏幕操作（tree/click/tap/type/key/swipe/open/ball/permission） |
| `/opt/dsh/dsh-home-seed/profiles/web/` | 预置 profile（**只有配置，没有插件代码**） |
| `$HOME/.dsh/` | 运行时 home（**bind 自 app 存储**，所以热包用 `@home/` 前缀能写到这里） |

**profile 与插件的分工**（重要）：
payload 里只有 profile 的**配置**（`package.json` 的 `file:` 依赖、`cordis.patch.yml` 的 insert 行）；
插件的**代码**只由热覆盖提供（`@home/.dsh/profiles/web/node_modules/dsh-plugin-android/**`
和 `opt/dsh/dsh-plugin-android/**`），应用**每次启动**都会应用一次内置热覆盖。
好处：改插件 = 重发 90 KB 热包，不用重传 186 MB rootfs。

**随包的技能**：`/root/.dsh/skills/` 下有 `phone-control`（写清了 `shiz` 与 `ui` 两条通道怎么选）、
`cordis-plugin-development`、`cordis-composition-reference` 等。

---

## A10. 构建流水线

### A10.1 载荷（rootfs → payload.zip）

```sh
# 1) 准备 rootfs（只做一次 / 换终端版本时；约 10 分钟，网络依赖 ubuntu-base + node tarball）
sh scripts/prepare_rootfs.sh

# 2) 装配：payload/ 覆盖进 rootfs、装 profile、打上游补丁、构建 linkfix、完整性自检
DSH_ROOTFS=$PWD/build/rootfs-ubuntu sh scripts/assemble_payload.sh

# 3) 打包 + manifest（app 用 java.util.zip 自己解，权限/符号链接走 manifest）
python3 scripts/make_payload_zip.py build/rootfs-ubuntu build/payload-assets/payload.zip
```

`assemble_payload.sh` 的自检列表是**故意会失败**的：少任何一个关键文件（`pty.node`、`xterm.js`、
`android-mobile.css`、`linkfix.so`、`etc/ld.so.preload`、profile…）都直接退出。

### A10.2 APK

```sh
sh scripts/build_apk.sh        # → out/dsh-android.apk（~180 MB，含载荷）
SLIM=1 sh scripts/build_apk.sh # → out/dsh-android-slim.apk（~0.57 MB，不含 assets/payload.zip）
```

`build_apk.sh` 依次：渲染图标 → `aapt2 compile/link`（**versionCode/versionName 从这里注入**）→
生成 `BuildInfo.java`（载荷 hash + 应用版本 + 终端版本）→ `javac` → `d8` → `pack_apk.py`
（`resources.arsc` 必须 STORED 且 4 字节对齐、`.so` 4096 对齐）→ 生成 hot.zip 与 update.json →
签名（**只签 v2+v3**，v1 会重写 zip 破坏对齐）。
`keystore/dsh.p12` 是应用身份：**绝不入库、绝不外传**；换了它＝换了应用身份，旧版本无法覆盖安装。

---

## A11. 踩过的坑（按"下次还会踩"排序）

### A11.1 Android 不允许应用建硬链接 → 包管理器/发布路径全炸

**症状**：guest 里 `apt install` 报 `dpkg was interrupted`；`dpkg --configure -a` 报
`error creating new backup file '/var/lib/dpkg/status-old': Permission denied`（提示符是 root）。
应用里则是 `Unable to persist attachment`、图片存不下来。

**根因**：Android 的 SELinux 不给应用进程 `link` 权限。dpkg 每次写数据库都要 `link(status, status-old)`；
dsh 的发布路径（附件、会话日志、fs 写入）也用硬链接做"原子替换"。
`-0` 只是**假装 root**：内核检查仍用应用自己的 uid/SELinux，所以 root 提示符不代表有特权。

**修法**：`payload/opt/dsh/android/linkfix.c` 编译成 `liblinkfix.so`，由 `/etc/ld.so.preload`
全局加载。拦截 `link/linkat`（真调用优先，EACCES/EPERM 时**退回复制**，保留"目标已存在则失败"、
权限位、软链照抄）、`chown` 家族（沙箱内即 root，报告成功）、`stat` 家族（复制不会让链接数增加，
而 `groupadd` 靠 `st_nlink == 2` 判断锁被占 → 对给过第二个名字的 inode 多报一个链接）。
**不依赖 libc**（只有原始系统调用 + `__errno_location`），因为它是 preload 进每个进程的：
少一个符号就少一种"整个沙箱起不来"的可能。

### A11.2 文本替换式补丁会咬到自己（**这次真栽了**）

`patches/apply-hardlink-patch.py` 注入 `linkOrCopy()` helper 后，用
`"await link(source, target)" → "await linkOrCopy(source, target)"` 改调用点 ——
**这条文本也出现在刚注入的 helper 自己体内**，于是：

```js
async function linkOrCopy(source, target) {
    try { await linkOrCopy(source, target); }   // 爆栈 → 上层包装成 Unable to persist attachment
```

**修法**：helper 内部的真调用先写成占位符 `LINKFIX_REAL_LINK(source, target);`，
所有调用点替换完再还原；并加 `repair()` 就地修复已坏的模块（幂等）。
**规则**：注入的代码里绝不能含有后续替换规则会命中的字符串。替换前先问"这条 pattern 还会出现在哪"。

### A11.3 已经装出去的沙箱怎么修（rootfs 里的文件热包写不到）

热包允许的前缀只有 `opt/dsh/android/`、`opt/dsh/dsh-plugin-android/`、`etc/`、`@home/`。
rootfs 里的 `node_modules/**` 不在其中 → **改不了文件就让启动脚本改**：
`payload/opt/dsh/android/repair-dsh.mjs` 由 `start-dsh.sh` 开机调用，幂等、会打日志。
这是"rootfs 里小修"的标准做法；下次终端版本（t3）应把修好的文件本体烘进 rootfs，修复脚本留作保险。

### A11.4 PRoot 的两个开关

- **不要传 `--link2symlink`**：它把 `link()` 变成一个指向隐藏临时对象的软链，
  报成功但对象一删就悬空（dsh 的原子写正是这个形状）。应用故意不传。
- **必须设 `PROOT_TMP_DIR`**（应用设为 `filesDir/tmp/proot`）：Android 没有可写的 `/tmp`，
  否则 proot 报 `can't create temporary directory`，紧接着一个**误导性的** `execve: Function not implemented`。
- **不要设 `PROOT_NO_SECCOMP=1`**：会退回纯 ptrace 慢路径，普通 `chdir` 都返回 ENOSYS。

### A11.5 应用"假死"先看端口

启动卡住/界面空白时，先用 `android-shizuku-cli exec 'ss -ltn'` 看三个端口：
3080（harness）、8399（控制桥）、3099（guest 终端）—— 能二分出卡在 onCreate 还是卡在 guest。
历史原因：`Application.onCreate` 里做旧树清理（一万多个删不掉的悬空软链）→ 每次启动都卡在主线程。
现在清理在后台、只做一次、删不掉就 `renameTo("alpine.orphan")` 挪开。

### A11.6 挂载：静默丢弃不可接受，绑定不存在的路径会死

- 源路径**不存在** → 必须跳过（PRoot 的 `-b` 对不存在的源路径是致命的，整个沙箱起不来），
  但要在 UI 上报"为什么"。
- 源路径存在但**没权限** → 照绑（guest 得到空目录，可诊断），同时报原因。
- 每条挂载都有「测一下」（让沙箱真列一次目录）。

### A11.7 Alpine/musl 与 glibc 的边界

- `node-addon-require-builtin` 没有 musl 版：启动 node 加 `--expose-internals`，
  再把该包 `lib/index.js` 换成 `createRequire(process.execPath)(id)` 的纯 JS 桩
  （**必须是真实例**：dsh-app-boot 会 patch `Module._resolveFilename`）。
- `node-pty` 没有 musl 预编译：包内自带 src，`node-gyp rebuild --arch=arm64`
  → 放到 `prebuilds/linux-arm64/pty.node`（它按 `build/Release → build/Debug → prebuilds/<平台>-<架构>` 找，**不区分 libc**）。
- **现在是 Ubuntu（glibc）rootfs**，上面两条是历史包袱，但桩文件仍在载荷里。

### A11.8 前端：一个插件挂掉会白屏

客户端插件必须 `exports.inject = ["slots","locale"]`（服务名，不是包名）。
写包名 → 永远 `pending`；不写 → apply 时 `ctx.locale` 是 undefined → `failed` →
**一个 entry 挂掉，整个前端 boot 都白屏**。

### A11.9 本沙箱自身也在 PRoot 里（`--link2symlink`）

- `git` 写 loose object 用 `link()` 保证不覆盖 → 被换成软链 → 临时文件一删对象悬空
  → `fatal: bad object HEAD`。**必须 `git config core.createObject rename`**（`sync_repo.sh` 已固化）。
- `rm -rf` **删不掉**这些悬空软链（`rm` 先 stat，stat 就 EPERM）→ 用 `scripts/force_rmtree.py`（`os.unlink` 不先 stat）。
- `git clean -xfd` 会连**未 add 的新文件**一起删 → 要的是 `-X`（只清生成物）。

### A11.10 移动端布局（外壳补丁，不是插件）

dsh 的 `ui-layout` **没有任何宽度 media query**，三栏全由 JS 算 `grid-template-columns`，
`SIDEBAR_AUTO_COLLAPSE=1024`。补丁（`patches/android-mobile.{css,js}` + `apply-ui-patch.py`）
只重新解释 CSS：窄屏把侧栏变成全屏抽屉 + scrim，**并且必须显式给主列/右栏补 `grid-column`**
（侧栏脱离文档流后网格会自动重排，主列被塞进 0px 轨道）。
class 名是 CSS-module 哈希 → 选择器一律用 `[class*="_sidebarCol"]` 这种稳定后缀。

### A11.11 热包：不再自动扫描 Download

**用户明确要求**（旧行为是每次启动都扫 `Download/dsh-hot.zip`，结果一个残留的旧包会悄悄盖掉新版本）。
现在只有两条路：应用内「检查更新 → 应用热更新」（线上），或「选择本地热包…」（文件选择器）。
跨线的已应用热包在启动时自动作废（`Payload.discardForeignHot`）。

### A11.12 GitHub 相关（都真踩过）

- **`raw.githubusercontent.com` 有几分钟 CDN 缓存**：`update.json` 推上去后立刻 curl 可能还是旧值 →
  要确认仓库状态用 `git fetch origin main` 或 API `contents?ref=main`。
- **PATCH release 正文必须是 JSON**（`{"body": "..."}`）；把 Markdown 当请求体发会 400，
  被 `> /dev/null` 吞掉还以为是成功了。反复"取现有正文→追加"会把 `---` 堆起来 →
  现在**每次重新合成整段**（app 条目 + marker + hot-history），marker 幂等。
- **删掉 release 再建，`releases/latest` 会短暂指向旧版本** → 应用可能把旧 APK 当成新版本下载。
  所以重发同一版本时，要么别删，要么一次跑完。
- **release 资产有 `digest`（sha256）字段**：不用下载 180 MB 就能比对线上是不是你要的那份。
- **`pm install` 不能读 `/sdcard`**（FUSE 上下文，system_server 读不到）：
  先 `cp /sdcard/... /data/local/tmp/` 再从那里装。应用日志里的原话是
  `Consider using a file under /data/local/tmp/`。
- **DNS 会间歇性抽风**（api.github.com 时好时坏）：发行脚本要写成带重试的循环；
  必要时把 `api.github.com` / `uploads.github.com` / `github.com` 的 IP 固定进 `/etc/hosts`
  （**注意格式是 `IP 主机名`**，写反了 glibc 直接忽略）。

### A11.13 中文 IME 与 `input text`（做真机自动化时会遇到）

`android-shizuku-cli exec 'input text "a%sb"'` 会被中文输入法当**拼音候选**吞掉（落在候选条里，
不进 EditText）。要再 `input keyevent 66`（回车）提交候选才行。
终端里也一样：xterm 的隐藏 textarea 是 IME 的磁铁 → 所以终端配了独立命令输入栏。

---

### A11.14 找现成的 npm 包时，别只搜带连字符的名字（`dsh-market` vs `dshmarket`）

**症状**：issue #4 承诺"预装 pnpm 与 dsh-market"，于是全仓库、全 npm、用户名下 5 个公开仓库都查过，
结论是"没有任何现成来源，得从零实现"。**这个结论是错的。**

**根因**：包名**没有连字符**。真实存在的是 **`dshmarket`**，仓库在
`github.com/dsh-market/dsh-market`（org 带连字符、包名不带）。按 `dsh-market` 搜，npm 与 GitHub
都不会命中它。它是社区做的成熟插件：**160 个版本**、2026-08-13 首发、2026-10-13 仍在更新，
自带 `dsh.bundle.patch` + `dsh.client`（bundle 与浏览器半都齐），描述就是
"Visual plugin market inside DeepSeek Harness — browse, search, and one-click install community plugins."

**修法**：搜生态至少试三种形态：`<name>`、`<name-with-hyphens>`、以及**按关键词搜**
（`https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin&size=25` —— 一次返回 25 个真实社区插件：
`dshmarket`、`dsh-plugin-model-proxy`、`dsh-whale-widget`、`dsh-pet`、`dsh-cost-meter`、
`@nanmicoder/dsh-agent-teams` …）。关键词搜索现在就是 `dsh-market` 在线目录的来源，随时可复现。

**决策记录**：预装**我们自己的 `@local/dsh-market`**（可审、离线也能列官方随包目录）；
社区版 **`dshmarket` 不预装**（第三方代码跑在用户设备上，这个决定归用户），
但它在市场页面里一眼可见、一键可装（按 `keywords:dsh-plugin` 搜它排第一）。要改主意，证据在这里。

### A11.15 新增 bundle **不会**在运行中的 harness 里热加载（profile 文件层装好 ≠ 已加载）

**症状**：`dsh plugin --profile web add <dir>` 成功、`--dump-config` 也能看到那一行，
但插件毫无动静（日志文件不出现、没有它的服务/页面）。改 `package.json` 后 touch 两次、等 30 秒也没用。

**根因**：profile 的 bundle 列表是**启动时**合成的；`dsh-hmr` 虽然在 profile 里（`id: hmr`），
但它监听的是既有层的补丁/配置内容，**新增一个 bundle** 不在它的生效路径上（本机实测两次：
ball-summarizer 与 dsh-market）。

**修法**：新增 bundle 一律按"**要重启 `dsh web`/App**"记账；页面上还要再**刷新**。
只有**已加载 bundle 的 client 半**改动才可能走 client HMR（`dsh-client-hmr` 500ms 轮询）。
验收流程把"落地（文件+行）"和"生效（重启后）"分开写，别把前者当成后者。

---

## A12. 测试与验证手册

### A12.1 改插件（不需要动 APK）

1. 改 `plugin/dsh-plugin-android/lib/client.js`；
2. `node --check` 语法检查；
3. 起 lab（§2.3），浏览器 412×915 打开，注入 `window.DshAndroid`，点开设置页看效果；
4. 深浅色都看一眼（设置 → 通用设置 → 外观）；
5. 发版：`sh scripts/release_hot.sh`（会重打热包、更新 update.json、更新 release 正文、推清单）。

### A12.2 改 Java

1. **快速编译检查**（不用出整包，约 1 分钟）：
   ```sh
   QEMU_LD_PREFIX=/opt/android/root64 qemu-x86_64 /tmp/aapt2dir/aapt2 compile --dir app/res -o /tmp/ctest/res.zip
   QEMU_LD_PREFIX=/opt/android/root64 qemu-x86_64 /tmp/aapt2dir/aapt2 link \
     -I /tmp/platform/android-36/android.jar --manifest app/AndroidManifest.xml \
     --min-sdk-version 26 --target-sdk-version 28 --java /tmp/ctest/r -o /tmp/ctest/base.apk /tmp/ctest/res.zip
   javac -encoding UTF-8 -source 8 -target 8 -nowarn \
     -classpath "/tmp/platform/android-36/android.jar:$(ls app/libs/*.jar | tr '\n' ':')" \
     -d /tmp/ctest/classes $(find app/java /tmp/ctest/r -name '*.java')
   ```
2. 出瘦包并装到真机（**573 KB，秒装**，会重启 app 与会话）：
   ```sh
   SLIM=1 sh scripts/build_apk.sh
   cp out/dsh-android-slim.apk /var/minis/mounts/Download/
   android-shizuku-cli exec 'cp /sdcard/Download/dsh-android-slim.apk /data/local/tmp/s.apk && pm install -r /data/local/tmp/s.apk'
   ```
3. 装机后**必须在真机上验证**（用户明确要求"试好了再传"）。可用的手段：
   - 拉前台：`am start -n com.lanfeiyu.harness/.MainActivity`
   - 截图：`screencap -p /sdcard/Download/x.png`（沙箱里就能读 `/var/minis/mounts/Download/x.png`）
   - 点击/输入：`input tap X Y` / `input text ...`（中文要先 `input keyevent 66` 提交候选）
   - 窗口检查：`dumpsys window windows | grep -A 12 com.lanfeiyu.harness`
     （悬浮球/面板都是 `ty=APPLICATION_OVERLAY` 的窗口，`mAttrs={(x,y)(w x h)}` 能看出位置对不对）
   - 日志：应用自己的日志在 guest 里（`files/logs/server.log`），
     页面上的入口是 设置 → 安卓沙箱 → 日志；`logcat` 里只有一点系统信息。

### A12.3 验证一个热包真的能用（不看页面也信得过）

```sh
curl -sSL -o /tmp/hot.zip <release 的 dsh-hot.zip>
python3 - <<'PY'
import json, zipfile, hashlib
z = zipfile.ZipFile('/tmp/hot.zip')
print(json.loads(z.read('hot.json')))                      # 版本/hash/文件数对不对
inside = z.read('opt/dsh/dsh-plugin-android/lib/client.js')
outside = open('<工作树>/plugin/dsh-plugin-android/lib/client.js','rb').read()
print('客户端与工作树一致:', hashlib.sha256(inside).hexdigest() == hashlib.sha256(outside).hexdigest())
PY
```

### A12.4 在 sandbox 里验 guest 侧的东西（不用真机）

rootfs 是 arm64、沙箱也是 arm64，**`chroot` 在沙箱里可用**（PRoot 模拟）：

```sh
R=<工作树>/build/rootfs-ubuntu
chroot $R /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root \
  /usr/local/bin/node -e '...'                      # 直接跑 guest 的 node
LINKFIX_FORCE_COPY=1 chroot $R ...                  # 强制走 link 的复制分支（模拟"内核拒绝硬链接"）
```

`LINKFIX_FORCE_COPY=1` 是专门为验证兼容层加的：它让每次 `link()` 都走复制路径，
于是"在真机上才失败的路径"在这里也能被端到端跑到（当初就是这么验出 `addgroup` 的 nlink 问题）。

---

## A13. 当前状态快照

| 项 | 值 |
|---|---|
| 线上应用版本 | `1.1.5`（versionCode 10105），tag `v1.1.5` |
| 线上终端版本 | `t2`，独立 release `t2`（`payload.zip` 185.8 MB + `payload.manifest` + `SHA256SUMS-terminal`） |
| 线上热包 | `1.1.5-t2-sp0`（96 KB，挂在 `v1.1.5` 上） |
| `v1.1.5` 资产 | `dsh-android.apk` 180.3 MB、`dsh-android-slim.apk` 0.55 MB、`dsh-hot.zip`、`SHA256SUMS`（与本地构建逐字节一致 ✓） |
| 手机上的状态 | 装的是**瘦包**（13:29），沙箱已自修复（用户确认读图正常 ✓） |
| 工作树记账 | `VERSION=1.1.5`、`ROOTFS_VERSION=2`、`HOT={app:1.1.5, terminal:2, sp:0, hash:aa2752f796650931}` |
| 载荷 | 186 MB（Ubuntu + Node + dsh + git/curl/python3/openssh/sudo/tmux/htop/less + linkfix + 自修复脚本） |
| 已知**未**在真机验证 | 无障碍的动作类接口（`ui click/type/swipe/open` 没实跑过；`ui tree` 与投递链路已验证）；语音（SpeechRecognizer）没实跑过 |

---

## A14. 待办与下一步（给集群的任务清单）

按优先级，每条都写了"怎么算做完"：

1. **终端 t3**：把修好的 `linkOrCopy` 本体烘进 rootfs（现在靠开机自修复兜着），
   `repair-dsh.mjs` 保留。做完的标准：`ROOTFS_VERSION=3`、重发 `t3` 运行时、更新 `update.json`、
   `assemble_payload.sh` 自检通过；装机后日志里不再出现 `repair-dsh: fixed`（说明本来就是好的）。
2. **无障碍动作真机验证**：`ui tree` → `ui click "文字"` → `ui type` → `ui swipe` → `ui open 微信`，
   在真机上逐条跑一遍，把失败的模式（哪些控件点不动、文字匹配不到）记进 FINDINGS。
3. **悬浮球的"当前操作"换成正经数据源**：现在靠 MutationObserver 抓 DOM 文本，
   应该接 harness 的会话状态（`ctx.sessions` / `ctx.conversation`，`ISessions` 在
   `@deepseek-ai/dsh-client-ui-session` 里）。做完的标准：气泡显示的是结构化的当前工具调用/阶段，
   而不是页面里碰巧新增的一行字。
4. **通知再往前走一步**：现在有图标/状态/端口/「停止·启动」。可加：进度（下载运行时、解包载荷）、
   "悬浮球已开启"合并进同一条通知（现在两条）。
5. **`ui` 与 `shiz` 的返回契约**：现在 `ui` 出错只打印一句话；给 agent 用时最好带
   `{ok:false, reason, hint}` 结构，并在 `phone-control` 技能里写清什么时候该换另一条通道。
6. **文档同步**：`README.md`（功能列表/已知限制）、`docs/ARCHITECTURE.md`（现在还没写手机助手与三条发布通道）、
   `docs/images/settings.jpg`（设置页改版过）都需要跟上 1.1.5。
7. **`Panel.java`（原生面板）没有手机助手入口**：现在只能在 Web 设置页里开悬浮球，
   应用自带面板里加一行会更顺手（也方便在 harness 起不来时救急）。
8. **瘦包的运行时下载需要真机验证一次**：在"没有运行时的设备"上装瘦包 → 让它下载 186 MB →
   解包 → 起服务。现在只验证过"已有运行时的设备装瘦包"。
9. **发版脚本的并发保护**：`release.sh` 幂等但没有锁，两次同时跑会互相删资产（我踩过，
   出现线上缺资产的中间态）。加个 `flock` 之类的互斥。

---

## A15. 给代理集群的工作约定

**用户在这个项目上的明确要求（别再被骂一遍）**：

1. **别乱写 release note**：格式见 §5，正文只来自 `CHANGELOG.md`；条目要有实质，
   既不要写成日记，也不要只剩骨架。
2. **先想清楚是哪条通道**（外壳 / 终端 / 热包），只改插件就不要动 `VERSION`、不要出 APK。
3. **所有热包的内容要归并进下一个版本**；发新外壳时确保之前热包的东西已经在载荷里。
4. **终端版本独立**，不跟着应用版本走。
5. **在真机上验证过再发**（尤其是 Java 侧的新功能）。出包 ≠ 能用。
   出包前至少：`javac` 全量通过、`aapt2 dump badging` 里能看到新 service/权限、
   插件 `node --check` 通过、载荷自检通过、热包内容与工作树逐字节一致。
6. **改别人的既有设计前先读 §11** —— 那里每一条都是真金白银换来的。
   特别是：不要给 PRoot 加 `--link2symlink`、不要在 `Application.onCreate` 里做耗时 IO、
   不要手写 tar 解析器、不要在文本替换补丁里让注入代码包含替换 pattern。
7. **提交信息写清楚"为什么"**（`sync_repo.sh "..."` 的第一句就是 commit subject），
   代码注释写"为什么这样做"而不是"做了什么"。

**工作节奏建议**：
先读 §3 §4 §11（半小时），再挑 §14 里的一条动手。
每条改完：局部验证（§12）→ 真机验证（§12.2）→ 发对应通道 → 更新 `CHANGELOG.md` → 提交。
拿不准就先在 lab（§2.3）里跑，别直接改设备上的沙箱。

---

## 附：常用命令速查

```sh
# 版本
python3 scripts/version.py --field full            # 1.1.5-t2-sp0

# 改插件 → 热包
node --check plugin/dsh-plugin-android/lib/client.js
sh scripts/release_hot.sh

# 改 Java → 瘦包（快）+ 完整包（正式）
SLIM=1 sh scripts/build_apk.sh && sh scripts/build_apk.sh
cp out/dsh-android-slim.apk /var/minis/mounts/Download/
android-shizuku-cli exec 'cp /sdcard/Download/dsh-android-slim.apk /data/local/tmp/s.apk && pm install -r /data/local/tmp/s.apk'

# 改 rootfs → 终端
DSH_ROOTFS=$PWD/build/rootfs-ubuntu sh scripts/assemble_payload.sh
python3 scripts/make_payload_zip.py build/rootfs-ubuntu build/payload-assets/payload.zip
sh scripts/release_terminal.sh

# 发外壳（完整 + 瘦 + 热包 + 正文）
sh scripts/release.sh
sh scripts/sync_repo.sh "这次改了什么"

# 真机
android-shizuku-cli exec 'am start -n com.lanfeiyu.harness/.MainActivity'
android-shizuku-cli exec 'screencap -p /sdcard/Download/x.png'
android-shizuku-cli exec 'dumpsys window windows | grep -A 12 com.lanfeiyu.harness'
```

---

_文档结束。如果这一轮又踩到新坑，**回来把它写进 §11 再下班** —— 这个项目的知识全在这份文件里，
不在任何人的脑子里。_


## 附：球的窗口与设置（两个窗各加载谁）

预装后球的 UI 是**两个 window**，改东西前先看清落在哪个文件上（这一步踩过一次）：

| window（`BallService` 常量） | 页面 | 内容 |
|---|---|---|
| `dsh-ball-visual`（`WINDOW_VISUAL`，不可点/不可聚焦） | `payload/opt/dsh/android/ball-web/ball.html`（约 2 KB） | **空壳/兼容层** —— 合并后只留 no-op 的 `BallUI`，**不画任何东西**；不要往这里加开关 |
| `dsh-ball-bar`（`WINDOW_BAR`，可点） | `payload/opt/dsh/android/ball-web/composer.html`（约 43 KB） | **唯一渲染球、环（`#ring`）、气泡（`#bubbleText`）、徽标（`#badge`）与「思考中」** 的窗口；设置项都落在这里 |

**球页面不轮询**（`composer.html` 里没有 `setInterval`/`fetch`）：状态与设置都由 **Java 侧推**。
`BallService.applySettings()` 用 `barWebView.evaluateJavascript("window.ComposerUI.settings(<json>)")` 推，
页面里的钩子是 `window.__dshBallSettings(settings)`（入口 `ComposerUI.settings`）。**启动时由 App 推一次**；
设置页写入后**即时生效**；推送不可用时的兜底是**下次球页面重载生效**。页面每次应用会打一行
`ball settings applied: status=on think=on ring=on lines=3`。

**`ball*` 键表（都在 App 侧 SharedPreferences；协议是扁平 map，加项不改协议）**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `ballEnabled` | bool | `false`（状态位） | **由服务自己写**：UI 开关必须走 `/ball/start` · `/ball/stop`，**绝不直接写 prefs** |
| `ballSizeDp` | int | `58`（`DEFAULT_SIZE_DP`） | 32–96 之间被服务接受；设置页动态并入当前值 |
| `ballImagePath` | string | `""` | 自定义图片；空 = 内置鲸鱼 |
| `ballShowStatus` | bool | `true` | 气泡文字显隐（`body.no-status`） |
| `ballShowThink` | bool | `true` | 「思考中」文案显隐 |
| `ballShowRing` | bool | `true` | 进度环显示与转圈（`body.no-ring`） |
| `ballBubbleLines` | int | `3`（1–3） | 气泡行数，联动 `--lines` 高度（Java 侧上限 `3×20+12`） |
| `ballX` / `ballY` | int | `dp(12)` / `dp(220)` | **内部维护，不进 UI**；只提供 `POST /ball/reset-position` |

桥：`GET/POST /ball/settings`（无字段=读全部、带字段=按项写并返回完整 settings）、`POST /ball/reset-position`。

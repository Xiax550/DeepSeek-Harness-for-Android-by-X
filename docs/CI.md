# 在 GitHub 上出全量包（CI）

这个仓库里只有一个 workflow：`.github/workflows/release-full.yml`。它做的事是**在 GitHub 的
机器上**（不是手机上）组装 rootfs + payload + 全量 APK，然后挂到你指定的那个 release 上。

它有两种触发方式，**共用同一段构建**：

| 触发 | 什么时候用 |
|---|---|
| **手动**（Actions → release-full → Run workflow） | 想主动出一版全量包。手动跑**总是重建**，所以「再跑一次」就是可靠的重试方式 |
| **release: published** | 发布后自动补全量包 —— 也就是下面这条「瘦包先行」的流程 |

## 为什么是「release 发布后」而不是「检测到 slim 上传」

GitHub Actions **没有**「release 资产被上传」这个事件，所以没法真的去"检测上传"。能用的钩子是
`release: published` —— `release.sh` 创建 release 时是非草稿，会触发它。判断逻辑放在
`scripts/ci_plan.py`（不写在 YAML 里，这样能单独测）：

| release 里的资产 | 决定 |
|---|---|
| 有 `dsh-android-slim.apk`、没有 `dsh-android.apk` | **构建全量包**并传上去（瘦包先行的那种） |
| 已经有 `dsh-android.apk` | 跳过（重跑工作流是幂等的） |
| 既没有 slim 也没有 hot（例如 `t2` 那种只有 payload.zip 的终端 release） | 跳过（**不会**为一个终端 release 白跑 15 分钟） |
| 手动触发 | 总是构建 |

## 完整流程（瘦包先行 → CI 补全量）

```
手机：出瘦包（2 MB）                      sh scripts/build_apk.sh          # 默认 SLIM=1 的场合
        │
        ├─ DSH_SLIM_ONLY=1 sh scripts/release.sh
        │      → 创建/更新 release，传 slim + dsh-hot.zip + SHA256SUMS
        │        （全量 APK 还没有，脚本会在 DSH_SLIM_ONLY=1 时允许缺）
        ▼
GitHub：release 被 published → workflow 触发
        │  plan：有 slim、没 full → build=true
        ├─ 取已发布瘦包的 versionCode（全量包不能比它小，否则设备拒绝安装）
        ├─ prepare_rootfs → assemble_payload → make_payload_zip      （约 10 分钟，有缓存时更快）
        ├─ build_apk.sh（全量）→ 必要时再 build_apk.sh（SLIM=1）
        ├─ release.sh（DSH_RELEASE_TAG=<触发的 tag>）：补齐 dsh-android.apk 等资产
        ├─ ci_patch_update_json.py：把 main 的 update.json 的 app.version/app.versionCode 指到这一版
        └─ 回读验证：资产 HTTP 200、update.json 与 VERSION 一致
        ▼
设备：设置 → 检查更新 → 看到「有新外壳」→ 下载 190 MB 全量包
```

**为什么最后那步不能省**：应用比的是 `update.json` 里的 `app.versionCode` 和自己已装的版本
（`App.appVersionCode()`）。CI 只上传资产、不动这个文件的话，**这一版对所有设备都是不可见的** ——
看起来发布成功了，实际上没人能更新。

## 需要配的 Secrets

仓库 Settings → Secrets and variables → Actions，三个都要：

| 名字 | 是什么 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `keystore/dsh.p12` 的 base64（`base64 -w0 keystore/dsh.p12`） |
| `ANDROID_KEYSTORE_PASSWORD` | 那个 p12 的口令 |
| `ANDROID_KEY_ALIAS` | 别名（本仓库是 `dsh`） |

`GITHUB_TOKEN` 不用配，Actions 自带（workflow 里已声明 `permissions: contents: write`）。
签名身份**必须**和线上一致：换了密钥就等于换了应用身份，旧版本无法覆盖安装。

> ⚠️ `keystore/dsh.p12` 是这个应用的身份，**不要**放网盘、不要发人、更不要提交（`.gitignore` 已排除）。
> 谁拿到它，谁就能签出系统认可的"升级包"。

## 本地能做哪些等价验证

CI 跑不起来的时候，这些在手机上就能确认大半：

```sh
# 1) 决策逻辑（四种情形，含"终端 release 要跳过"）
python3 scripts/ci_plan.py --event release --tag v1.2.1 --assets-json /tmp/assets.json
python3 scripts/ci_plan.py --event workflow_dispatch --tag v1.2.1

# 2) update.json 补丁（纯函数路径，不联网、不写回）
python3 scripts/ci_patch_update_json.py --document update.json --version 1.2.1 --code 10213 --check

# 3) 手机布局补丁：正常应成功，上游改了 index.html 格式应**报错退出**
python3 patches/apply-ui-patch.py <某个 node_modules 根>

# 4) 真机打包（和 CI 同一套脚本，只是 aapt2 走 qemu）
SLIM=1 PROOT=$PWD/build/proot/libproot.so sh scripts/build_apk.sh

# 5) workflow 自身的语法：YAML 能解析 + 每个 run 块过 bash -n
```

## 这个 workflow 修掉了什么（2026-10-16）

它以前是「手动、只会构建全量包」，而且**按当时的代码跑不起来**：

| 原来 | 现在 |
|---|---|
| `build_apk.sh` 无条件用 `qemu-x86_64` 跑 aapt2，而 runner 上没装 qemu | 按宿主架构决定（x86_64 原生、arm64 走 qemu），`AAPT2_RUNNER` 可覆盖 |
| `assemble_payload.sh` 要求 `android-mobile.css`，但**没有任何脚本调用**产出它的 `apply-ui-patch.py` | `assemble_payload.sh` 里调用它；而且补丁脚本改成**写不进去就报错退出**（原来会静默什么都不做，页面就退回桌面布局） |
| 只构建全量包，`update.json` 里的瘦包地址 404 | release 里没有瘦包时会一起构建 |
| 构建后又跑一次**非 `--base`** 的 `make_hot_zip.py`：内容没变 → 还是 sp0 → 发一个和内置版同号的热包 | 只发 `build/hot-assets/hot.zip`（`--base` 那份），并断言它的 `app` 等于 `VERSION` |
| `DSH_RELEASE_TAG` 传了但被忽略，tag 会重算成 `v<VERSION>`，缺 tag 时建在默认分支 HEAD 上 | `release.sh` 认这个变量，并要求它与 `VERSION` 一致，不一致直接拒绝 |
| 版本号靠 `APP_CODE` 环境变量 | 记在仓库的 `VERSION_CODE`，`version.py` 读它；CI 还会拿已发布瘦包的 versionCode 做校验 |
| 从不更新 `update.json` | 发布后自动把 `app.version`/`app.versionCode` 指到这一版（只动这两个字段，`terminal`/`hot` 归各自的通道管） |
| rootfs 缓存把**覆盖之后**的树存下来，旧文件会活到下一次构建 | 缓存键带上 `payload/**`、`profile/**`、`patches/**`、`plugin/**` |

## 还没验证的部分（诚实说明）

- **这个 workflow 一次都没在 GitHub 上真跑过。** 上面每一条都是本地逐段核过的：YAML 能解析、
  14 个 `run` 块全过 `bash -n`、`ci_plan.py` 四种情形全对、`ci_patch_update_json.py` 幂等且只动
  app 字段、`apply-ui-patch.py` 的失败路径会退出 1。但**真正的端到端**只有推上去、配好 Secrets、
  点一次 Run 才知道。
- `prepare_rootfs.sh`（约 10 分钟：下 ubuntu-base + 官方 node + `npm i`）在 runner 上的行为、
  以及 `actions/cache` 的实际命中率，都还没观察过。
- 一次运行约 **10–15 分钟** Actions 时间；`workflow_dispatch` 有 `dry_run` 可以只构建不发布。

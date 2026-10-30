# 升级沙箱里的 dsh（走恢复模式，可回滚）

> 一句话：**在恢复模式里升级**，因为要替换的正是当前正在运行的那个进程；脚本会先备份，
> 装完逐项校验并跑市场冒烟，任何一步失败就自动回滚。回滚也可以手动触发：`upgrade-dsh.sh rec`。

脚本：`scripts/upgrade-dsh.sh`（会在第一次运行时把自己和补丁、冒烟脚本复制到
`$HOME/.dsh-upgrade/`，因为恢复模式里手机存储不一定挂着）。

## 先纠正一个名字

npm 上**没有 `0.2.0`** 这个版本。`@deepseek-ai/dsh` 的现状（2026-10-16 查 registry）：

| dist-tag | 版本 |
|---|---|
| `latest` / `next` | **`0.2.0-rc.2`** |
| `alpha` | `0.2.1-alpha.4` |
| 已装的 | `0.1.7-rc.2` |

所以"升级到 0.2.0"实际就是 **`0.2.0-rc.2`**，这也是脚本的默认值；要别的版本用
`--version=0.2.1-alpha.4`。

## 离线升级（推荐）：先把包下好

`$HOME/.dsh-upgrade/bundle-<版本>/`（目录里有 `node_modules`）或 `bundle-<版本>.tar.gz`
存在时，阶段 B **跳过 npm** 直接把那棵树换上去 —— **恢复模式里不需要网络**。没有预下载包时才退回
`npm i`（npm 缓存热过的话也很快）。

在网络好的时候（普通模式即可）下好：

```sh
cd "$HOME/.dsh-upgrade" && mkdir -p bundle-0.2.0-rc.2
cp /opt/dsh/package.json /opt/dsh/package-lock.json bundle-0.2.0-rc.2/
cd bundle-0.2.0-rc.2
HOME="$HOME/.dsh-upgrade/npmhome" npm i --no-audit --no-fund \
  --os=linux --cpu=arm64 --libc=glibc "@deepseek-ai/dsh@0.2.0-rc.2"
```

**补丁不用提前打**：阶段 B 每次都会重新跑 `apply-hardlink-patch.py` 并校验锚点。
这台设备上已经下好了（527MB / 543 个包），并且离线路径实测 `EXIT=0`（换树 + 补丁 4 处命中 + 四项校验）。

## 怎么用

```sh
# 1) 在应用里打开沙箱终端（普通模式即可），跑：
sh /mnt/Documents/_repo_probe/repo/scripts/upgrade-dsh.sh
#    → 它检查环境、复制工具、写下待办标记，然后问你是否进入恢复模式（y）
#    → 这一步之后当前会话会断，这是预期的

# 2) 在恢复模式的终端里（手机内控制台 / SSH）再跑一次：
sh /root/.dsh-upgrade/upgrade-dsh.sh
#    → 备份 → 安装 → 重新打硬链接补丁 → 校验 → 市场冒烟
#    → 成功：自动退出恢复模式，harness 用新版本起来

# 3) 想回滚（任何时候，恢复模式里）：
sh /root/.dsh-upgrade/upgrade-dsh.sh rec
```

同一条命令重复运行是安全的：有没有"待办标记"决定它走阶段 A 还是阶段 B。

其他参数：`--version=X`、`--dry-run`（只检查）、`--skip-smoke`、`--keep-broken`
（失败时保留现场不回滚，用来抓日志）、`--stay`（成功后留在恢复模式）、`--force`（harness
还在跑也继续 —— 会当场打断当前会话，不建议）、`-y`（不问）。

## 它会逐项检查什么，以及为什么

| 检查 | 不做会怎样 |
|---|---|
| **硬链接补丁**（4 个发布点：fs-local、session-persistence 的 index.js 与 worker.cjs、attachment-local） | Android 不给应用进程 `link()` 权限（[FINDINGS.md §1](FINDINGS.md)）。载荷里那棵树是打过补丁的，新装的不是 —— 不打就会留下悬空软链：`write` 工具"成功"但文件是坏的、附件与子会话发布失败。补丁脚本匹配不上时**拒绝静默放过**。 |
| **CLI 参数面**：`web --no-open --host --port --trusted-host` | `start-dsh.sh` 就是用这四个参数 exec 的；少一个，harness 起不来。与其等下次启动失败（那时你只剩恢复模式），不如在升级时就挡下并回滚。 |
| **入口 `lib/bin.js`** | 同上：`start-dsh.sh` 写死了这条路径。 |
| **Node 主版本必须是 22** | 市场（`dshmarket`）带 `undici@7`、harness 带 `undici@8`。上游 [dsh-market#861](https://github.com/dsh-market/dsh-market/issues/861) 在 **Node 24.14.1 + DSH 0.2.0-rc.2** 上复现了"加载市场后宿主模型调用全挂"。脚本**不动 node 二进制**，只校验。 |
| **市场冒烟**（`scripts/smoke-market-llm.sh`，一次真实模型调用） | 就是上面那条灾难级回归的唯一有效测试。失败即回滚。 |
| 空间 ≥ 900MB、版本在 npm 上存在 | 备份 + 新树，以及避免把版本名打错。 |

## 我已经做过的验证（都在副本上，真树没动）

2026-10-16，在这台设备上：

1. **补丁锚点预检**：把 `0.2.0-rc.2` 的三个包的 tarball 拉下来逐一比对 —— 三处 import 行、
   四个调用点、注入锚点 `//#region` **全都在**（所以补丁会成功，不会触发"上游改了"的拒绝）。
2. **完整彩排**（`DSH_INSTALL=/tmp/rehearsal`，即把真实树复制一份）：备份 234MB → `npm i` →
   补丁 **4 处全部命中**（2+2+1+1 call sites）→ 版本/入口/四个 flag/补丁标记全部通过 →
   **市场冒烟通过**（加载市场后宿主仍能完成真实模型调用）。
3. **回滚彩排**：`rec` 把树恢复成 `0.1.7-rc.2`，补丁完好，校验通过；坏树被挪到
   `node_modules.broken-<时间戳>` 留作现场。
4. **真实 profile 的启动对比**：把 `/root/.dsh/profiles/web`（含预装市场与两个 `@local` 插件）
   复制到隔离 HOME，分别用 0.1.7-rc.2 与 0.2.0-rc.2 起 `dsh web` —— 两边都 HTTP 200、
   页面 **35334 字节逐字节相同**、日志零错误行。也就是说**现有 profile 能直接在 0.2.0-rc.2 上跑**。

**没验证到的**：真机上"升级完由应用退出恢复模式、harness 用新版本起来并跑一次真实对话"这一段 ——
那必须真的升级一次才知道（也就是上面那两步命令）。以及 `@local` 两个插件在 0.2.x 下的功能细节。

## 升级之后，什么会保留、什么会冲掉

| 事件 | 对升级的影响 |
|---|---|
| 重启应用 / 应用热更新（`hot.zip`） | **不影响**：热覆盖只写 `opt/dsh/android/`、`opt/dsh/dsh-plugin-android/`、`etc/`、`@home/`，不碰 `opt/dsh/node_modules/` |
| 装一个带新载荷的 APK | **冲掉**：载荷更新会整棵替换 runtime（见 HANDOFF §4.1d），升级回到载荷里的版本。要让它成为默认，得改 `prepare_rootfs.sh` 并出一个新的终端版本（`t3`）与新 APK |
| 备份 | 留在 `/opt/dsh-backups/<时间戳>-<版本>/`，脚本把最近一次记在 `$HOME/.dsh-upgrade/last-backup`。确认新版本没问题后可以删掉（每个约 234MB） |

## 真机实录（2026-10-16，本机）

**0.1.7-rc.2 → 0.2.0-rc.2，离线完成**（用预下载的 527MB 树，恢复模式里没联网）。日志里逐条通过：

```
· 用预下载的包：/root/.dsh-upgrade/bundle-0.2.0-rc.2（跳过 npm，不需要网络）
✓ 已换上：0.2.0-rc.2          patched …jsonl/lib/index.js (2 call sites)
✓ 版本 0.2.0-rc.2             patched …attachment-local/lib/index.js (2 call sites)
✓ 入口 lib/bin.js             patched …fs-local/lib/index.js (1 call sites)
✓ web 仍支持 --host/--port/--no-open/--trusted-host
✓ 四个发布点都带硬链接补丁
== 1/2 对照组：纯 headless profile（未加载市场）      ✓ control：正常
== 2/2 实验组：同一 profile 加上 dshmarket            ✓ market：正常
== 冒烟通过：加载市场前后，宿主都能完成一次真实模型调用
```

**第一次真机跑踩到的两个 bug**（都在脚本里，已修，commit `53b91c4`）：

1. 从 `$HOME/.dsh-upgrade/` 那份重跑时必然失败：`cp "$0" 自己` 报 "same file"、附属脚本按
   `$here/../patches/` 找变成 `/root/patches/` → 「✗ 工具复制失败 2」。现在源目标同一个文件就跳过
   自拷贝，附属脚本优先用状态目录里已有的。
2. 阶段判定被**孤儿进程**骗了：应用没能收掉旧的 PRoot 树（残留一个 harness 仍占 3080、两个恢复树、
   一个 sshd 还在 8022 上），端口探针因此判成"harness 在跑"，于是人在恢复模式的终端里却走了阶段 A。
   现在先问桥的 `/recovery/status`，`active=true` 就直接走阶段 B。

**顺带发现的应用侧问题**（要装 1.2.1 的 APK 才能根治）：`ServerBus` 在连续重启时丢掉了旧进程的引用，
留下 2 个孤儿恢复树 + 1 个孤儿 harness；而这台设备装的 10211 还没有"正常启动时锁一次 root 密码"
那行自愈，所以恢复模式退出后 `/etc/shadow` 里留着密码哈希、而 8022 上的 sshd 还活着 —— 那段时间是
真实的暴露面（密码只有看过面板的人知道）。已手工清理并锁回 `*`。

**升级留下的磁盘**：备份 `234M` + 挪开的旧树 `234M` + 预下载包 `527M` + npm 缓存 `246M`。
确认新版本没问题后，后三项可以删（备份建议留着，`rec` 靠它）。

## 日志

全过程写在 `$HOME/.dsh-upgrade/upgrade.log`（npm 的输出也在里面）。失败时把这段发出来就能定位。

# 恢复模式（Recovery mode）

**一句话**：当 DeepSeek Harness 起不来时，应用可以**不加载 harness**，直接把沙箱启动成一个
SSH + shell 的环境，用一次性令牌登录进去修东西。

它解决的是一个反复出现的死锁：**这个项目所有的修复入口都在 harness 的 Web UI 里** —— 沙箱终端是
那儿的一个面板，「检查更新 / 应用热包 / 选择本地热包 / profile 修复」也都在那儿。于是 harness 一旦
起不来（profile 坏了、依赖装崩了、磁盘满了、热包只应用了一半），用户就失去了唯一能自救的工具。
issue #3 与 1.1.5 的「全新安装没有安卓沙箱设置页」都是这个形状：坏掉的东西和修它的东西是同一个。

---

## 1. 怎么用

### 进入

三条路，按需要的条件从少到多：

| 触发 | 条件 | 说明 |
|---|---|---|
| **自动** | 默认开启 | harness 连续 3 次「进程退出但从未就绪」后自动进入（`RecoveryPlan.shouldEnter`，窗口 10 分钟）。看门狗每 15 秒判断一次，所以大约是 45 秒后的事 |
| **控制台面板** | 服务已停止/失败时右上角有 `≡` | 「恢复模式」区的「进入恢复模式」按钮 |
| **桥接口** | 从 Web UI / 脚本 | `POST /recovery/start`（带 token 鉴权，见 §4） |

进入时会**新生成一个令牌**（旧的立刻作废），并重启沙箱 —— 启动命令从 `start-dsh.sh` 换成
`recovery.sh`，进去的是 sshd 和 shell，不是 harness。

### 三条进沙箱的路

面板上会直接列出（可一键复制）：

```
密码（本次会话有效）
  <32 字符的实时令牌>
用户 root · 端口 8022

同一 Wi-Fi（在电脑上）
  ssh -p 8022 root@192.168.x.x

USB（在电脑上）
  adb forward tcp:8022 tcp:8022
  ssh -p 8022 root@127.0.0.1

修好 harness 后，从电脑浏览器打开它（端口转发）
  ssh -p 8022 -L 3080:127.0.0.1:3080 root@192.168.x.x
```

- **同一 Wi-Fi**：PRoot 不建网络命名空间，沙箱里绑的 `0.0.0.0:8022` 就是手机自己的 8022，所以
  同一局域网上的电脑能直接连，不需要数据线。
- **USB**：`adb forward` 之后按 `127.0.0.1` 连。
- **这台手机上**：面板里的「手机内控制台」按钮把 WebView 指向
  `http://127.0.0.1:<pty 端口>/recovery?token=…` —— 一个**行模式**控制台（`<pre>` 输出 + 普通
  `<input>` 输入，PTY 的 `TERM=dumb`），不需要 harness、不需要电脑，也不需要 xterm。
  全屏程序（vim / htop / tmux）请走 SSH，那边是完整 PTY。

### 退出

面板上的「退出恢复模式」（或 `POST /recovery/stop`）：令牌作废、root 密码恢复为锁定、沙箱按正常
入口重启，harness 回来。**修好之后一定要走这一步**，否则下次启动还是恢复模式。

---

## 2. 安全模型

**「实时令牌」不是宣传语，是三层约束：**

1. **每次进入重新生成**（24 字节 `SecureRandom`，base64url）。昨天能用、截图里出现过、日志里留下的
   那个令牌，对今天这次会话无效。
2. **生命周期 = 这个进程的生命周期**。令牌被写进 guest 的 `/etc/shadow` 当 root 密码，退出时改回
   `*` 锁定。这件事有**三道**，而且只有第三道是保证 —— 前两道都是尽力而为，实测会漏：

   | 层 | 在哪 | 覆盖 | 为什么会漏 |
   |---|---|---|---|
   | 1 | `recovery.sh` 的 EXIT trap | 脚本正常退出、收到 INT/TERM | 应用停沙箱是**杀** PRoot 进程，`--kill-on-exit` 给的是信号，shell 未必有机会执行 trap |
   | 2 | `ServerBus` 在进程退出后补跑一次 `chpasswd -e` | 第 1 层漏掉的那种 | 它只在「还没有更新的一次启动发生」时才写；而「退出恢复模式」800 ms 后就启动下一个 guest，实测确实被跳过（第一次装机后 `/etc/shadow` 里留下了哈希，见下方「实测记录」） |
   | 3 | **`start-dsh.sh` 每次正常启动都锁一次** | 全部情况 | 不会漏：不依赖信号、不依赖时序；恢复模式**不跑**这个脚本，所以它永远不可能锁掉一个正在使用的密码 |

   第 2 层之所以要判断「有没有更新的启动」，是为了不覆盖**新的**恢复会话刚设好的密码；有第 3 层兜底
   之后，它跳过就是安全的。

   **实测记录（2026-10-16，本机）**：装完 10211 后进了一次恢复模式再退出，`/etc/shadow` 的 root 字段
   停在 `$y$j9T$…`（恢复模式启动那一刻的 mtime，之后没有再次写入），说明第 1、2 层都没生效 —— 这正是
   加第 3 层的原因。当时 `sshd` 已停、8022 已关，所以没有可利用的入口；残留本身只是「一个没人认领的
   哈希」，但「退出即失效」这句话要么做到，要么就别写，所以现在由第 3 层保证。
3. **令牌不写进日志**。服务器日志会被用户复制进 issue，所以 `recovery.sh` 只打印
   `token-sha256=<8 位>` 摘要；两端的摘要一致就说明面板和正在跑的 sshd 用的是同一个秘密。

其他几条：

- sshd 的**主机密钥是每台设备自己的**，生成一次后存在 `/root/.dsh-recovery/ssh/`（root 是 bind
  mount，能跨载荷更新存活）。载荷里 `/etc/ssh/ssh_host_*` 是**所有安装都一样**的，用它等于没有身份。
- 恢复模式**不加载 harness**，所以这期间 Web UI 里那些第三方插件（包括插件市场装的）都不在运行；
  但反过来，**能读到页面上 `window.DshAndroid` 的东西仍然拿得到桥令牌** —— 恢复模式并没有改变这一点，
  见 §5 的已知限制。
- 令牌的字符集与长度在两端各写一份、必须一致：`RecoveryPlan.validToken`（Java，`[A-Za-z0-9_-]{8,128}`）
  与 `recovery.sh` 里的一个 `case` 通配符。guest 拒绝而应用接受，用户就会拿到一个装不上去的密码，且
  完全看不出为什么 —— 这正是 JVM 单测（`RecoveryPlanTest`，48 checks）盯住的东西。

---

## 3. 实现

```
MainActivity / Panel（原生控制台：令牌、连接命令、进入/退出/换令牌/打开控制台）
      │
      ├── Recovery（Android 侧：prefs、实时令牌、局域网地址、状态 JSON）
      │        └── RecoveryPlan（纯逻辑，JVM 可测：令牌规则、端口范围、自动进入判据、命令文本）
      │
      ├── ServerBus ── 启动命令换成 recovery.sh；注入 DSH_RECOVERY_{TOKEN,PORT,BIND}
      │        ├── onLine() 看到 "dsh-recovery: ready" → RUNNING（沙箱在服务，但不是 harness）
      │        └── 进程退出 → 若是 recovery 那次启动 → 后台重锁 root 密码
      │
      ├── DshService ── 看门狗：连续失败 → Recovery.enter() 后重启；通知文案区分恢复模式
      │
      └── BridgeServer ── /recovery/{status,start,stop,token}；/snapshot 带 recovery 对象
                                  │
guest:  /opt/dsh/android/recovery.sh ──┬── sshd -D -e（0.0.0.0:8022，密码 = 令牌）
                                       ├── pty-server.mjs（127.0.0.1:3099，手机内控制台）
                                       └── EXIT trap：杀子进程 + 把 root 密码改回锁
        /opt/dsh/android/recovery-console.html（pty-server 在 /recovery 上伺服的行模式控制台）
```

**为什么是这两个都留着**：SSH 给的是完整 PTY，适合在电脑上干活；手机内控制台是「只有手机」时的
兜底，而且它复用的 `pty-server.mjs` 本来就在跑（`start-dsh.sh` 里那条），只是换了个页面。

**行模式为什么不用 xterm**：xterm 在这台设备上因为和 Android 输入法抢隐藏 `textarea` 已被弃用
（见 [FINDINGS.md §6](FINDINGS.md)），而恢复模式恰恰是最不该再引入这个问题的场合。`TERM=dumb`
让 shell 不再重绘屏幕，输出里的转义序列在页面侧统一剥掉；代价是没有全屏程序。

### 顺带修掉的两个问题

- `pty-server.mjs` 的会话**从不回收**：WebSocket 断开只把 socket 从集合里删掉，PTY 和 `/bin/bash`
  都留着。客户端每次 WebView 重载都会重新握手，于是每次重载攒下孤儿 shell，8 个之后
  `POST /sessions` 永久 429。现在隐式创建（WS 无 `id`）的会话带一个回收计时（默认 90 秒，
  `?reap=<秒>` 可覆盖，`DSH_PTY_REAP_MS` 改默认；`POST /sessions` 建的**不回收**，那是标签页的）。
- `new URL(request.url)` 在请求处理里未加保护：一行畸形请求就能让整个服务抛异常退出。恢复模式下
  这是**唯一**的入口，所以现在整个 handler 有 try/catch。

---

## 4. 接口

都需要桥令牌（`X-Dsh-Token`，和设置页同一套）。

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/recovery/status` | `{active, ready, port, bind, user, token, auto, failures, reason, lan, sshReady, consoleUrl, lanCommand, loopbackCommand, forwardCommand, adbForward}` |
| `POST` | `/recovery/start` | `{port?, auto?}` → 进入并重启（约 1 秒后 sshd 起来） |
| `POST` | `/recovery/stop` | 退出并重启回 harness |
| `POST` | `/recovery/token` | 换新令牌（**重启后生效**：密码在 guest 的 shadow 里） |

`GET /snapshot` 额外带一个 `recovery` 对象（同一份状态），所以给 Web UI 加一张卡片时不需要新接口。

guest 侧环境变量（由 `ServerBus` 注入）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_RECOVERY_TOKEN` | 必填 | 本次会话的 root 密码；缺失则脚本拒绝启动 sshd |
| `DSH_RECOVERY_PORT` | `8022` | sshd 端口（1024–65535） |
| `DSH_RECOVERY_BIND` | `0.0.0.0` | 监听地址 |
| `DSH_PTY_*` | — | 与 `start-dsh.sh` 同一套；未设 `DSH_PTY_TOKEN` 时不做手机内控制台 |

就绪判定：`recovery.sh` 打印 `dsh-recovery: ready port=<n> bind=<addr> user=root token-sha256=<8 hex>`，
`ServerBus` 见到这行就把状态置为 `RUNNING`（harness 那条 URL 之外的第二条就绪通道）。

---

## 5. 已知限制

- **恢复模式期间 harness 不在运行**，所以手机上看不到会话列表、也不能对话。它是在「修」而不是「用」。
- **令牌在会话期间是明文可见的**（面板上、剪贴板上）。这是有意的 —— 用户得把它念给另一台机器；
  所以它是短命的，而不是隐身的。
- **`/shizuku/exec` 与 `/a11y/*` 仍然只有一颗静态桥令牌**。能读到页面 `window.DshAndroid` 的代码
  （任何客户端插件、任何页面内 XSS）本来就等于拿到 adb shell 级别的能力；恢复模式没有放大也没有
  缩小这个问题。要真正收紧，得给高危路由加原生确认 + 审计，那是另一件事（见审计报告 A5/S2）。
- **SSH 主机密钥的信任**：第一次连接会看到「未知主机」提示。指纹可以在 `recovery.sh` 的日志里核对，
  但面板暂未显示指纹 —— 需要的话可以加一行。
- **没有端口转发之外的反向通道**：手机在纯移动数据、又没有电脑时，只能走手机内控制台。
- **载荷太旧时恢复模式也起不来**：`recovery.sh` 由热包/载荷交付，脚本不存在时启动命令会打印一行
  说明并以 code 3 退出（面板显示为「启动失败」），这是有意让用户看到「要更新」，而不是无声重启。

---

## 6. 怎么验证

**不需要设备**（这几条在 CI 里也应该跑）：

```sh
sh docs/run-unit-tests.sh          # 含 RecoveryPlanTest：48 checks（令牌/端口/自动进入/命令文本）
sh -n payload/opt/dsh/android/recovery.sh    # dash 语法（bash 能过、dash 不一定 —— 踩过）
node --check payload/opt/dsh/android/pty-server.mjs
sh scripts/assemble_payload.sh     # 已接入：构建期对 guest 脚本做 sh -n
```

**需要设备**（`shiz` 或 adb）：

```sh
# 1) 面板：服务停掉 → ≡ → 进入恢复模式，记下面板上的令牌
# 2) 同一 Wi-Fi
ssh -p 8022 root@<手机 IP>     # 密码 = 令牌；应直接进 shell，/sdcard 可见
# 3) USB
adb forward tcp:8022 tcp:8022 && ssh -p 8022 root@127.0.0.1
# 4) 手机内控制台：面板 →「手机内控制台」，应出现行模式 shell，能跑 ls / cat
# 5) 隧道：ssh -p 8022 -L 3080:127.0.0.1:3080 root@<IP>，然后在 shell 里
#    /opt/dsh/android/start-dsh.sh &，电脑浏览器打开 http://127.0.0.1:3080
# 6) 退出恢复模式，确认：root 密码回到锁定（cat /etc/shadow 里 root 是 *）、8022 已关闭、
#    harness 正常启动
```

改动这三处时尤其要重跑 6：`recovery.sh` 的 trap/cleanup、`ServerBus` 的重锁、`Recovery` 的令牌生成。

---

## 7. 发布

发布说明写在 **CHANGELOG.md** 里，别处不写第二份 —— 所以这一节不再重复内容，只记两件事实：

- 条目是 **[`1.2.0-t2-sp16`](../CHANGELOG.md)**。序号不是拍的：`make_hot_zip.py` 的数就是它 ——
  `HOT` 账本里上一包 sp15 的内容摘要是 `6406cc63…`，这份树是 `5c73527d…`，同一条线上内容变了就 +1
  （`next_sp()` 返回 16，已核对）。将来真要发布时按 `docs/BUILD.md` 的热包流程走一遍，
  `release_hot.sh` 会用同一个摘要算出同一个号。
- 这一包只覆盖**沙箱侧**（`recovery.sh`、手机内控制台、`pty-server.mjs`）。面板、桥接口、自动进入
  都在 App 的 Java 里，属于**应用通道**：装了新 APK 才生效，只应用热包的设备看不到任何界面变化。
  CHANGELOG 的条目里已经用「说明」写明了这一点。

## 8. 这次改到的文件

| 文件 | 说明 |
|---|---|
| `payload/opt/dsh/android/recovery.sh`（新） | guest 侧入口：主机密钥、密码、sshd、控制台、cleanup |
| `payload/opt/dsh/android/recovery-console.html`（新） | 手机内行模式控制台（pty-server 在 `/recovery` 伺服） |
| `payload/opt/dsh/android/pty-server.mjs` | `/recovery` 路由、`?term=`、会话回收、请求异常兜底 |
| `app/java/com/lanfeiyu/harness/RecoveryPlan.java`（新） | 纯逻辑：令牌/端口/自动进入/命令文本（JVM 可测） |
| `app/java/com/lanfeiyu/harness/Recovery.java`（新） | Android 侧状态、令牌、局域网地址、状态 JSON |
| `app/java/com/lanfeiyu/harness/Proot.java` | `recoveryCommand()`；`exec` 支持指定 rootfs |
| `app/java/com/lanfeiyu/harness/ServerBus.java` | 恢复模式启动命令与环境、就绪标记、退出后重锁密码 |
| `app/java/com/lanfeiyu/harness/DshService.java` | 看门狗自动进入恢复模式；通知文案 |
| `app/java/com/lanfeiyu/harness/BridgeServer.java` | `/recovery/*` 路由；`/snapshot` 带 recovery |
| `app/java/com/lanfeiyu/harness/Panel.java` | 恢复模式分区：状态、令牌与命令、四个动作 |
| `app/java/com/lanfeiyu/harness/MainActivity.java` | 面板回调接线、恢复模式下的横幅/按钮/控制台加载 |
| `app/java/com/lanfeiyu/harness/App.java` | `randomToken()` 开放给恢复模式复用 |
| `scripts/assemble_payload.sh` | `recovery.sh` 可执行位、健全性检查、guest 脚本 `sh -n` |
| `docs/run-unit-tests.sh` | 纳入 `RecoveryPlanTest` |
| `docs/unit/com/lanfeiyu/harness/RecoveryPlanTest.java`（新） | 48 checks |

热包会自动带上新文件：`make_hot_zip.py` 整棵打包 `payload/opt/dsh/android`，而 `Payload.java` 与
`make_hot_zip.py` 的白名单本来就允许 `opt/dsh/android/`。

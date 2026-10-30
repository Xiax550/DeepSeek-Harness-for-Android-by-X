# dsh-plugin-android

App 侧的 harness 插件：一半是 host（`lib/index.js`），一半是浏览器里的 settings 页
（`lib/client.js`）。

## host 段贡献了什么

| 段名 | 作用 |
| --- | --- |
| `app:android-surface` | 告诉模型这台机器是手机、PRoot 沙箱、`/sdcard`、`shiz` 通道等环境事实 |
| `app:ball-surface` | **只对悬浮球会话生效**（其它会话渲染成空串被丢弃），见下 |
| `android-bridge` shell 变量 | 把 App 的环回控制桥地址/令牌发布给 shell 工具 |

## 悬浮球会话（app:ball-surface）

球上只有一行气泡 + 一条一行输入条，用户通常在别的 App 里，**点不到 DSH 的任何卡片**。
所以这里不做"提示词请求"，做**结构性移除**：

1. `ask_user_question` / `request_user_input` 从该会话的工具表里被过滤掉
   （挂在 `system-prompt/assemble` 瀑布里，过滤的是最终工具表——也就是 harness 记进
   request header、模型真正收到的那一份）。球上不可能再弹卡片。
2. 该会话的权限预设被钉成 `danger-full-access`（`permissionPresets.set`），
   **approval 卡片也就不会出现**：球上没人能点"允许"。
3. 剩下的行为规范交给 `floating-ball` skill + 那段 prompt 段：纯文本提问 + 编号选项、
   先一句话结论、能自己拍板就别问、任务期间自主推进。

### 会话是怎么认出来的

球的消息由本包 client 半的 `installBallInbox()` 送进一个**专属会话**：
`remote.session.create()` → `rename("悬浮球")` → `prompt(...)`。识别走三条路：

1. **`session-ball-` id 前缀**（client 半建会话时自己铸的 id）——最硬的一条，
   第一回合就成立，不依赖任何服务或事件；
2. **`session/title` 事件**（`source.kind === "user"`、标题 `悬浮球`）——client 的
   rename 就是这条，新建会话在第一条 prompt 之前就被认出来；
3. 标题投影 `sessionProjections.stateOf(session, 'title')` 兜底读回。

**不要**用"自动生成的标题"当标记：`session-title-first-prompt-llm` 会用第一句话覆盖它。
`test/ball-surface.test.mjs` 覆盖这三条路径（含"普通会话不被影响"）。

⚠️ **本机实测（2026-10-14）：第 3 条在这台机器上读不到。** `/root/.dsh/ball-surface/diag.jsonl`
里 `section` 行永远 `"title":""`（连确实有标题的会话也是空串），所以**改造前建的旧球会话
（不带前缀）在这台机器上认不出来**，能用的就是第 1、2 条。诊断开关：行 config 的
`diagFile`（默认 `/root/.dsh/ball-surface/diag.jsonl`，`''` 关掉）。

### 会话被删（归档）以后会怎样

用户在侧栏删掉球会话 = **归档**。归档会话的投递是 **accepted**，但回合会在第一步被
`dsh-api-session-controller` 的 `underArchivedSession` 网关拒掉，日志里就是
`turn/end {"kind":"blocked"}`——一句话都不执行，球上没有任何反应。所以 client 半在每次
投递后回读该会话最后一个回合（`remote.session.page` + `turn/end.reason.kind`）：
**blocked 就 `forget()` → 用 `session-ball-…` 新建一条 → 把刚那句重发过去**（用户的话
不丢）；拿不到 `page` 就静默维持原行为——只在有正面证据时才换线程。
`test/ball-inbox.test.mjs` 覆盖"死线程重发 / 正常回合不动 / 没有 page 也不崩"三条。

### ⚠️ 权限那条的后果与回退

球会话拿到 `danger-full-access` = **用户在球上打的任何一句话都免审批执行**，
包括改文件、装东西、调外部命令。这是刻意的：用户不在 DSH 里，`ask` 策略要么把任务
挂住、要么静默失败。代价是**球这条通道要当成可信通道**（谁能往球里打字，谁就能让
harness 全权限跑东西）。

回退方式（改 profile 里这一行的 config，位置：
`/root/.dsh/profiles/web/cordis.patch.yml`）：

```yaml
- id: android-sandbox
  name: 'dsh-plugin-android'
  config:
    permissionPreset: ''      # 空串 = 不动会话自己的权限（回到 workspace-write + ask）
    withheldTools: []         # 想连"删工具"也一起关掉（不推荐）
    enabled: false            # 整段球面都关掉
```

`title` / `sessionPrefix` / `agentPreset` 可以改识别标记，`promptText` 可以整段替换
那段提示词。

## 测试

`test/ball-surface.test.mjs` 用假的 Cordis context 驱动 host 段，覆盖上面 1/2/3 三条
（含"普通会话不被影响"）。终端相关的 `vt-*.test.mjs` 见 `test/README.md`。

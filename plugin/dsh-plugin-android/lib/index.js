/**
 * dsh-plugin-android — host half.
 *
 * Two seams this uses, both public:
 *
 *   systemPrompt.section()  adds an ordered block to the model-visible system
 *                           prompt. The stock Web bundle already contributes
 *                           `app:web-surface` describing the browser GUI; this
 *                           plugin slots in right after it and describes what
 *                           the session actually is here — a phone, inside a
 *                           PRoot sandbox, with a mobile-sized screen and an
 *                           Android control channel.
 *   shellEnv.register()     publishes the loopback control-bridge address so
 *                           shell tools and the model can address it by name.
 *
 * plus one more, for the floating ball's own conversation (`app:ball-surface`):
 *
 *   The ball's thread is created by this package's client half
 *   (`installBallInbox`: `remote.session.create` → `rename("悬浮球")` →
 *   `prompt`). The user is in another app with a one-line bubble and a one-line
 *   input bar, so anything that needs the DSH GUI cannot be answered at all.
 *   Rather than asking the model to remember that, the two things that would
 *   need the GUI are removed structurally for those sessions:
 *
 *     * the GUI question tools are withheld from the tool assembly
 *       (`system-prompt/assemble`), so no card can be rendered;
 *     * the session's permission preset is pinned to full access, so no
 *       approval card can appear mid-task. See BALL_DEFAULTS.permissionPreset
 *       for the consequence of that and how to turn it off.
 *
 *   What is left — how to ask in plain text with numbered options, how to reply
 *   into a bubble — is the `floating-ball` skill plus the prompt section below,
 *   which is contributed only for a ball session (an empty section is dropped
 *   from the prompt by the registry).
 *
 * The browser half (exports["./client"]) adds the matching settings page.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ANDROID_SURFACE_SECTION = "app:android-surface";

/** The section name for the floating ball's own conversation. */
const BALL_SURFACE_SECTION = "app:ball-surface";

/** The title this package's client half pins on the ball's session. */
const BALL_SESSION_TITLE = "悬浮球";
const SCREEN_WATCH_TITLE = "屏幕观察";
const SCREEN_WATCH_MARKER = "[DHA_SCREEN_WATCH_V1]";

/** Session-id prefix reserved for ball sessions, if one is ever minted. */
const BALL_SESSION_PREFIX = "session-ball-";

/** Agent preset name reserved for the ball, if a composition ever declares one. */
const BALL_AGENT_PRESET = "ball";

/**
 * Tools that can only be answered in the DSH GUI.
 *
 * `ask_user_question` renders a card with options and waits for a click;
 * `request_user_input` is the same shape under another name. Both are dead
 * weight in a ball session: the user has no card to click, so a call to either
 * one hangs until it is aborted. The list is config, not a constant, so an
 * install that gains another such tool can extend it without a new build.
 */
const BALL_WITHHELD_TOOLS = ["ask_user_question", "request_user_input"];

/**
 * Written for the model, not the user. Kept short: it is the *reminder* next to
 * the skill, not a replacement for it. No `{{` may appear here — a registered
 * section is scanned for prompt variables, and a malformed reference throws.
 */
const BALL_SURFACE_PROMPT = `这次对话是悬浮球（floating ball）自己的对话，不是 DSH 窗口里的会话。

用户很可能正在别的 App 里，眼前只有球上那一行气泡，回话只能靠球下面那条一行输入条。任何"要点一下才能回答"的东西都到不了他手上。

- 需要澄清时写成一条普通消息：一句话问一件事，下面给编号选项，例如「1 按日期分（默认） 2 按类型分 3 先别动」。用户回一个数字就能继续。
- 能自己拍板就别问：选一个合理默认值往下做，做完在结论里说明你按什么做的。只有不可逆、会误解、或只有用户知道的事才停下来问。
- 一个任务里不要每步都问用户；先说一句「我开始做了」，然后自己把活干完，最后给结论。
- 回复适配球上的气泡：默认展示 5 行，更长的结果可以上下滚动，**第一条和最后一条消息的前几行必须能独立读懂**（问题、结论、"还差什么"都写在那里）；细节可以展开，但不要大表格、长代码块、重 markdown 排版。
- 球上的状态行由外部总结器维护，不要为了汇报进度去调用 ball；把消息本身写好就行。
- 作业规范全文在 skill floating-ball 里：开工前先调用 skill 工具加载它并遵守。`;

/**
 * Defaults for the ball surface; the Loader row's `config` overrides them.
 *
 * `permissionPreset: "danger-full-access"` is the one setting with a real
 * consequence, so it is stated plainly here and in the README: a ball session
 * runs with the sandbox unconfined and the approval policy at `never`, i.e.
 * anything the user types into the ball executes without a confirmation card.
 * That is the *point* — the user cannot confirm anything from another app, so
 * an `ask` policy would either hang the task or silently fail it closed — but
 * it means the ball's thread must be treated as a trusted channel. To turn the
 * behaviour back to asking (a card in the DSH GUI, as before this change), set
 * this key to `""` in the plugin row's config:
 *
 *     - id: android-sandbox
 *       name: 'dsh-plugin-android'
 *       config:
 *         permissionPreset: ''
 *
 * With `""` the session keeps whatever preset it was created with; a new ball
 * session then starts at the deployment default (`workspace-write` + `ask` on
 * this phone) and its approval cards land in the DSH GUI again. `withheldTools`
 * and `title`/`sessionPrefix`/`agentPreset` are the other knobs; `enabled:
 * false` removes the whole ball surface.
 */
const BALL_DEFAULTS = {
	/** Master switch for the ball surface. */
	enabled: true,
	/** Session title the client half pins on the ball's thread. */
	title: BALL_SESSION_TITLE,
	/** Session-id prefix that also marks a ball session. */
	sessionPrefix: BALL_SESSION_PREFIX,
	/** Agent preset name that also marks a ball session. */
	agentPreset: BALL_AGENT_PRESET,
	/** GUI-only tools withheld from a ball session's tool assembly. */
	withheldTools: BALL_WITHHELD_TOOLS,
	/** Permission preset pinned on a ball session; '' keeps the session's own. */
	permissionPreset: "danger-full-access",
	/** The prompt section's text; a string replaces it wholesale. */
	promptText: undefined,
	/**
	 * Where the ball hooks record why they fired or did not. One line per
	 * session, so a device-side "it didn't work" can be answered from the file
	 * instead of a guess; `''` turns it off.
	 */
	diagFile: `${process.env.DSH_HOME ?? "/root/.dsh"}/ball-surface/diag.jsonl`
};

/**
 * Written for the model, not the user. Keeps to facts that change behaviour:
 * where files are, what the screen is, what is slow, what can be reached.
 */
const ANDROID_SURFACE_PROMPT = `You are running on the user's Android phone, inside a PRoot sandbox — not on a desktop, not in the cloud.

Environment facts:
- The sandbox is an Ubuntu rootfs (glibc, aarch64) owned by the DSH Android app. It is a minimal base: \`node\` (official build, /usr/local/bin/node), \`npm\`, \`bash\`, \`apt\`/\`dpkg\`, \`tar\`, \`gzip\` and \`perl\` are present; \`python3\`, \`git\`, \`curl\`, \`make\` and compilers are NOT. Install what you need with \`apt update && apt install -y <pkg>\` — the first update downloads the index and takes a minute. There is no systemd, no display server, and no root beyond the faked uid 0 inside the sandbox.
- \`/root\` is the harness home and persists across restarts. \`/opt/dsh\` holds the harness installation and \`/opt/dsh/android\` the app's own guest-side services; treat both as read-only unless the user asks otherwise.
- \`/sdcard\` is the phone's shared storage (Downloads, Documents, DCIM) bind-mounted read-write, but only once the user has granted storage access to the app. Extra folders the user mounted appear at their own paths (listed under 挂载/Mounts in the app's settings page). If a path is missing or unreadable, say so rather than retrying.
- Control the phone through \`ui\`: \`ui tree\`, \`ui click "label"\`, \`ui tap x y\`, \`ui type "text"\`, \`ui open "app"\`, and \`ui screenshot path\`. Auto mode reads semantic labels through accessibility, but sends direct taps, swipes and keys through Shizuku's adb-shell channel when it is granted; it falls back to the other channel on failure. \`ui status\` reports the selected channel and \`ui backend auto|accessibility|adb\` overrides it. Use \`shiz\` directly for shell-only work such as \`pm\`, \`settings\`, notifications, or installing APKs.
- Network works, but the phone may be on mobile data or behind a VPN in "fake-IP" mode where every public hostname resolves into 198.18.0.0/15. \`web_fetch\` refuses non-public addresses by design, so it reports WEB_BLOCKED_URL for hosts that are perfectly reachable. When that happens, fetch with \`node -e 'fetch(url).then(r => r.text()).then(console.log)'\` from \`bash\` instead of retrying web_fetch.
- Android's filesystem refuses hard links, so file creation goes through a copy-based publish path locally. If a newly written file ever shows up as a dangling symlink, that is a sandbox bug worth reporting rather than working around.
- Files opened through the Web UI (attachments, workspace picks) live inside the sandbox; /sdcard is the path that reaches the user's own storage.
- The floating ball is the only thing the user sees while they are in another app. Its status field is \`ball_doing\`: one short line saying what is running right now, and an empty \`ball_doing\` means "nothing running, fold the bubble away". You do NOT report to it — a separate summarizer watches the work and keeps that line up to date, so there is nothing to remember and nothing to do per step. The \`ball\` command still exists for scripts and for anything that wants to put one line on the ball itself: \`ball "<line>"\`, \`ball --doing "<line>"\`, \`ball --json '{"ball_doing":"<line>"}'\`, \`ball think\`, \`ball done "<line>"\`, \`ball idle\`. A reply is never expected to call it.`;

/** Loopback bridge of the DSH Android app; the app exports these on launch. */
const BRIDGE_URL_VAR = "DSH_ANDROID_BRIDGE_URL";
const BRIDGE_TOKEN_VAR = "DSH_ANDROID_BRIDGE_TOKEN";

function bridgeUrl() {
  return process.env[BRIDGE_URL_VAR] ?? "";
}

function bridgeToken() {
  return process.env[BRIDGE_TOKEN_VAR] ?? "";
}

/** Tell the app which sessions are running, so task-created screenshots can be swept. */
async function pushTaskImages(action, sessionId) {
  const url = bridgeUrl();
  const token = bridgeToken();
  if (!url || !token || typeof sessionId !== "string" || sessionId === "") return;
  try {
    await fetch(`${url}/task/images/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dsh-Token": token },
      body: JSON.stringify({ sessionId })
    });
  } catch {
    /* cleanup bookkeeping must never affect task execution */
  }
}

/** Whether the floating observer is still active right now. */
async function screenWatchRunning() {
  const url = bridgeUrl();
  const token = bridgeToken();
  if (!url || !token) return false;
  try {
    const response = await fetch(`${url}/screen-watch/status`, {
      method: "GET",
      headers: { "X-Dsh-Token": token }
    });
    if (!response.ok) return false;
    const answer = await response.json();
    return answer?.active === true;
  } catch {
    return false;
  }
}

/** Keep the display awake for the lifetime of a harness turn. */
async function pushTaskAwake(action, sessionId) {
  const url = bridgeUrl();
  const token = bridgeToken();
  if (!url || !token || typeof sessionId !== "string" || sessionId === "") return;
  try {
    await fetch(`${url}/task/awake/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dsh-Token": token },
      body: JSON.stringify({ sessionId })
    });
  } catch {
    /* screen-awake bookkeeping must never affect task execution */
  }
}

/**
 * Screenshot cleanup applies to every session, not only the floating ball.
 * A separate listener also keeps it working when the ball surface is disabled.
 */
function installTaskImageCleanup(ctx) {
  ctx.on("session/event", (session, event) => {
    const headerId = session?.header?.id;
    const id = typeof headerId === "string" && headerId !== ""
      ? headerId
      : (typeof session?.id === "string" ? session.id : "");
    if (typeof id !== "string" || id === "") return;
    if (event?.type === "turn/start") {
      void pushTaskImages("begin", id);
      void pushTaskAwake("begin", id);
    } else if (event?.type === "turn/end") {
      void pushTaskImages("end", id);
      void pushTaskAwake("end", id);
    }
  });
}

/** Drop the tools a ball session cannot use; other sessions are untouched. */
function withoutTools(assembly, names) {
  const tools = assembly?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return assembly;
  const withheld = new Set(names ?? []);
  if (withheld.size === 0) return assembly;
  const kept = tools.filter((tool) => !withheld.has(tool?.name));
  return kept.length === tools.length ? assembly : { ...assembly, tools: kept };
}

/**
 * The floating ball's own conversation.
 *
 * Identity is by *title* first: this package's client half renames the ball's
 * session to {@link BALL_SESSION_TITLE} as a user title, and a user title is
 * durable in the session log and pins the title against the automatic
 * title-generator — so it is still readable after a harness restart, which is
 * when a client-only marker would be lost. A session-id prefix and an agent
 * preset are accepted as additional markers for a deployment that adds them.
 *
 * Every hook is error-contained: this plugin is loaded for the whole profile,
 * and a throw here would take the session's prompt down with it.
 *
 * @param ctx - Cordis context of the plugin row.
 * @param cfg - resolved {@link BALL_DEFAULTS}.
 */
function installBallSurface(ctx, cfg) {
  if (cfg.enabled === false) return;
  /** Session ids already recognised as the ball's own conversation. */
  const ballSessions = new Set();
  const screenWatchSessions = new Set();
  /** Session ids whose permission preset this plugin has already pinned. */
  const pinned = new Set();
  /** session id -> delegating parent session id, for the descendant walk. */
  const parentOf = new Map();
  /** The `permissionPresets` service, once it is available. */
  let permissionPresets = null;
  /**
   * Why the ball hooks are or are not firing, on the device.
   *
   * Identification has three inputs — a session-id prefix, an agent preset, and
   * a session title that arrives as an event or is read back through a
   * projection — and a silent "not a ball session" is indistinguishable from a
   * hook that never ran. One capped JSONL file makes that difference visible
   * without a debugger; `diagFile: ''` turns it off.
   */
  const diagSeen = new Set();
  const diag = (entry) => {
    if (typeof cfg.diagFile !== "string" || cfg.diagFile === "") return;
    try {
      mkdirSync(dirname(cfg.diagFile), { recursive: true });
      appendFileSync(cfg.diagFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
    } catch {
      /* a diagnostic is never worth failing a prompt for */
    }
  };
  const diagOnce = (key, entry) => {
    if (diagSeen.has(key)) return;
    diagSeen.add(key);
    diag(entry);
  };

  /** The non-empty prompt text for a ball session. */
  const permissionLine = (canPin) => (canPin
    ? `- 这个会话的权限已经钉成「${cfg.permissionPreset}」：直接干活，不要发起提权审批，也不要把 sandbox_permissions 当第一步；真做不到就直说。`
    : "- 需要审批的动作在球上无法确认：换成不需要审批的做法，或者一句话告诉用户这件事得他回 DSH 点一下。");
  /**
   * The section text. The permission sentence follows what is actually true at
   * render time: claiming a pinned preset before `permissionPresets` exists
   * would tell the model to skip an approval it will really be asked for.
   */
  const promptFor = (canPin) => (typeof cfg.promptText === "string" && cfg.promptText.length > 0
    ? cfg.promptText
    : `${BALL_SURFACE_PROMPT}\n${permissionLine(canPin)}`);

  const idOf = (session) => {
    const id = session?.header?.id;
    if (typeof id === "string" && id.length > 0) return id;
    return typeof session?.id === "string" ? session.id : "";
  };
  /** The session's current title, out of the title projection. */
  const titleOf = (session) => {
    try {
      const title = ctx.sessionProjections?.stateOf?.(session, "title");
      if (typeof title === "string") return title.trim();
    } catch {
      /* no projection service, or the session is gone: fall back to the marks */
    }
    return "";
  };
  /**
   * Whether this session is the floating ball's own conversation.
   *
   * Three inputs, because each covers a different history:
   *   * the `session-ball-` id prefix the client half mints (durable, and
   *     visible on the very first assembly — no event has to arrive first);
   *   * a `session/title` event whose source is the user and whose title is
   *     {@link BALL_SESSION_TITLE} — how a thread created before this plugin
   *     loaded is recognised again after a restart (see the listener below);
   *   * the title projection read back out of the session log, for a thread
   *     whose title event predates the process *and* whose projection is warm.
   */
  const isBall = (session) => {
    if (session === null || session === undefined) return false;
    const id = idOf(session);
    if (id !== "" && ballSessions.has(id)) return true;
    const marked = (cfg.sessionPrefix !== "" && id.startsWith(cfg.sessionPrefix))
      || (cfg.agentPreset !== "" && session?.header?.agentPreset === cfg.agentPreset)
      || (cfg.title !== "" && titleOf(session) === cfg.title);
    if (!marked) return false;
    // Recorded however it was recognised: a teammate is traced back through
    // these ids; a prefix or preset match that never lands here would leave the
    // descendant walk blind.
    if (id !== "") ballSessions.add(id);
    return true;
  };
  /** Remember one session's delegation parent, for the descendant walk below. */
  const rememberFamily = (session) => {
    const id = idOf(session);
    const parent = session?.header?.parentSession;
    if (id !== "" && typeof parent === "string" && parent !== "") parentOf.set(id, parent);
  };
  /**
   * Whether this session is a teammate spawned by a ball session.
   *
   * A subagent gets its own session and its own tool list, and a question asked
   * there is just as unanswerable from the ball — worse, since the parent's
   * task waits on it. Descendants therefore lose the GUI tools too; they keep
   * their own prompt, because their replies go back to the parent model, not to
   * the ball.
   */
  const isDerived = (session) => {
    let cursor = session?.header?.parentSession;
    for (let depth = 0; typeof cursor === "string" && cursor !== "" && depth < 8; depth += 1) {
      if (ballSessions.has(cursor)) return true;
      cursor = parentOf.get(cursor);
    }
    return false;
  };
  /** Pin the ball session's permission preset, once per session. */
  const pinPermission = (session) => {
    const preset = cfg.permissionPreset;
    if (permissionPresets === null || preset === "" || preset === null || preset === undefined) return;
    const id = idOf(session);
    if (id === "" || pinned.has(id)) return;
    pinned.add(id);
    try {
      permissionPresets.set(session, preset);
      ctx.logger?.info?.(`ball-surface: session ${id} pinned to permission preset "${preset}"`);
    } catch (error) {
      pinned.delete(id);
      ctx.logger?.warn?.(`ball-surface: could not pin ${id} to "${preset}": ${error}`);
    }
  };

  // The service arrives when its own plugin row activates; until then the hooks
  // below simply skip the pin and keep withholding tools.
  ctx.inject(["permissionPresets"], (scope) => {
    permissionPresets = scope.permissionPresets;
    diag({ ev: "permission-service", available: permissionPresets !== null });
  });

  // A title arriving as an event is the one mark that needs no service and no
  // warm projection: the client half renames the thread it just created, so the
  // next prompt of that session already sees it. A user-source title also pins
  // the title against the automatic titler, so this mark stays true.
  const replies = new Map();
  /**
   * A session can receive the same turn/end event again after its first result
   * bubble has already expired. Without a turn-level receipt, the committed-log
   * fallback reads the same assistant reply and displays it a second time.
   */
  const lastEndedTurn = new Map();
  const claimTurnEnd = (id, data) => {
    const turn = data?.turn;
    if (typeof turn !== "number") return true;
    if (lastEndedTurn.get(id) === turn) return false;
    if (lastEndedTurn.size >= 256 && !lastEndedTurn.has(id)) {
      lastEndedTurn.delete(lastEndedTurn.keys().next().value);
    }
    lastEndedTurn.set(id, turn);
    return true;
  };
  /**
   * Text out of the shapes an assistant content block can arrive in.
   *
   * The live event is normally `data.message.content: [{ type: "text", ... }]`,
   * but the controller also exposes string and nested-content forms. Keeping
   * this tolerant matters because a malformed or older event used to pass the
   * whole turn silently and leave the ball on "任务已完成".
   */
  const messageText = (value) => {
    if (typeof value === "string") return value.trim();
    if (Array.isArray(value)) {
      return value
        .map((part) => messageText(part))
        .filter(Boolean)
        .join("\n")
        .trim();
    }
    if (value !== null && typeof value === "object") {
      const partType = String(value.type ?? value.kind ?? "").toLowerCase();
      if (/^(reasoning|thinking|analysis|thought)(?:$|[-_])/.test(partType)) {
        return "";
      }
      if (/^(tool[-_]?call|tool[-_]?result|function[-_]?call|function[-_]?result)$/
          .test(partType)) {
        return "";
      }
      if (typeof value.text === "string") return value.text.trim();
      if (value.content !== undefined) return messageText(value.content);
    }
    return "";
  };
  const assistantText = (data) => {
    const candidates = [
      data?.message?.content,
      data?.message?.text,
      data?.message,
      data?.content,
      data?.text
    ];
    for (const candidate of candidates) {
      const text = messageText(candidate);
      if (text !== "") return text;
    }
    return "";
  };
  /**
   * Screen observation gets a deliberately narrow view of an assistant reply:
   * the final Chinese sentence, never the model's visible chain of thought.
   * Upstream image models sometimes put analysis and an English draft in the
   * same assistant message; the ball has room for one short result, not that.
   */
  const screenWatchText = (value, fallback) => {
    const text = typeof value === "string" ? value.trim() : "";
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].replace(/^[-*#>\s]+/u, "");
      const han = (line.match(/[\u3400-\u9fff]/gu) ?? []).length;
      const latin = (line.match(/[A-Za-z]/g) ?? []).length;
      if (han < 4 || latin > Math.max(6, line.length * 0.2)) continue;
      return line.slice(0, 300);
    }
    const runs = text.match(/[\u3400-\u9fff，。！？、；：“”‘’（）《》\s]{8,}/gu) ?? [];
    for (let index = runs.length - 1; index >= 0; index -= 1) {
      const run = runs[index].trim();
      if ((run.match(/[\u3400-\u9fff]/gu) ?? []).length >= 4) return run.slice(0, 300);
    }
    return fallback;
  };
  const screenWatchMarked = (value) => {
    if (typeof value === "string") return value.includes(SCREEN_WATCH_MARKER);
    if (Array.isArray(value)) return value.some((part) => screenWatchMarked(part));
    if (value !== null && typeof value === "object") {
      if (typeof value.text === "string" && value.text.includes(SCREEN_WATCH_MARKER)) return true;
      if (value.content !== undefined && screenWatchMarked(value.content)) return true;
      if (value.message !== undefined && screenWatchMarked(value.message)) return true;
    }
    return false;
  };
  /** Last-resort lookup after the live event, using the committed session log. */
  const latestAssistantText = (session, turn) => {
    if (session === null || session === undefined || typeof session.snapshotEvents !== "function") return "";
    try {
      const events = session.snapshotEvents();
      if (!Array.isArray(events)) return "";
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type !== "assistant/message" || event.data?.interrupted === true) continue;
        if (typeof turn === "number" && event.data?.turn !== turn) continue;
        const text = assistantText(event.data);
        if (text !== "") return text;
      }
    } catch {
      /* an older session object has no log read: the live cache still works */
    }
    return "";
  };
  const pushBall = async (phase, text, cue = "", eventId = "") => {
    const url = bridgeUrl();
    const token = bridgeToken();
    if (!url || !token) return;
    try {
      await fetch(`${url}/ball/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Dsh-Token": token },
        body: JSON.stringify({
          phase,
          text,
          cue,
          ball_doing: text,
          ...(eventId ? { eventId } : {})
        })
      });
    } catch {
      /* status delivery is best-effort */
    }
  };
  const resultEventId = (sessionId, event, data) => {
    if (typeof data?.turn === "number") return `${sessionId}:result:turn:${data.turn}`;
    const sequence = event?.seq ?? event?.id;
    if (typeof sequence === "string" || typeof sequence === "number") {
      return `${sessionId}:result:event:${sequence}`;
    }
    return "";
  };
  ctx.on("session/event", (session, event) => {
    try {
      const id = idOf(session);
      if (event?.type === "session/title") {
        const title = event.data?.title;
        if (typeof title === "string" && title.trim() === cfg.title && id !== "") {
          ballSessions.add(id);
          diagOnce(`title:${id}`, { ev: "title-event", session: id, title: title.trim(), source: event.data?.source?.kind ?? null });
        } else if (typeof title === "string" && title.trim() === SCREEN_WATCH_TITLE && id !== "") {
          screenWatchSessions.add(id);
        }
      }
      const type = event?.type;
      const data = event?.data ?? {};
      if (id !== "" && type === "turn/end" && !claimTurnEnd(id, data)) {
        diagOnce(`turn-end:${id}:${data.turn}`, {
          ev: "turn-end-duplicate",
          session: id,
          turn: data.turn
        });
        return;
      }
      // Every session runs under a task turn, including the main UI and
      // subagents. Record that lifetime before narrowing the remaining hooks
      // to the floating ball's own conversation.
      if (id !== "" && type === "turn/start") {
        void pushTaskImages("begin", id);
        void pushTaskAwake("begin", id);
      } else if (id !== "" && type === "turn/end") {
        void pushTaskImages("end", id);
        void pushTaskAwake("end", id);
      }
      if (type === "user/message" && screenWatchMarked(data)) {
        screenWatchSessions.add(id);
      }
      // Approval prompts can come from any session, including one the user is
      // watching in the main UI. Alert for those globally; completion speech
      // stays scoped to the ball so background subagents cannot become noisy.
      if (type === "approval/asked") {
        const tool = typeof data.toolName === "string" && data.toolName !== ""
          ? "：" + data.toolName
          : "";
        const approvalId = typeof data.id === "string" && data.id !== ""
          ? "approval:" + data.id
          : "";
        void pushBall("permission", "需要你确认授权" + tool, "permission", approvalId);
        return;
      }
      if (id === "") return;
      const subagent = typeof session?.header?.parentSession === "string"
        && session.header.parentSession !== "";
      if (type === "user/message" && data.source?.kind === "user") {
        replies.delete(id);
        return;
      }
      if (type === "assistant/message") {
        const text = assistantText(data);
        if (text !== "") replies.set(id, text);
        return;
      }
      if (!isBall(session)) {
        if (subagent || type !== "turn/end") return;
        const reply = replies.get(id) || latestAssistantText(session, data.turn);
        replies.delete(id);
        const reason = typeof data.reason?.kind === "string" ? data.reason.kind : "";
        const stopped = reason === "aborted" || reason === "interrupted" || reason === "blocked";
        const fallback = stopped
          ? "任务已中断"
          : reason === "error" ? "任务执行失败" : "任务已完成";
        const cue = stopped
          ? "interrupted" : reason === "error" ? "error" : "complete";
        if (screenWatchSessions.has(id) || titleOf(session) === SCREEN_WATCH_TITLE) {
          const eventId = resultEventId(id, event, data);
          void screenWatchRunning().then((running) => {
            if (running) {
              void pushBall("result",
                screenWatchText(reply, "屏幕出现变化，但模型未返回可显示的中文结果"),
                cue, eventId);
            }
          });
          return;
        }
        void pushBall("result", reply || fallback, cue, resultEventId(id, event, data));
        return;
      }
      if (type === "tool/call"
          && (data.name === "ask_user_question" || data.name === "request_user_input")) {
        void pushBall("permission", "需要你做出选择", "question");
        return;
      }
      if (type === "turn/end" && !subagent) {
        const reply = replies.get(id) || latestAssistantText(session, data.turn);
        replies.delete(id);
        const reason = typeof data.reason?.kind === "string" ? data.reason.kind : "";
        const stopped = reason === "aborted" || reason === "interrupted" || reason === "blocked";
        const fallback = stopped
          ? "任务已中断"
          : reason === "error" ? "任务执行失败" : "任务已完成";
        const cue = stopped
          ? "interrupted" : reason === "error" ? "error" : "complete";
        void pushBall("result", reply || fallback, cue, resultEventId(id, event, data));
      }
    } catch {
      /* never throw from a listener */
    }
  });

  // The ball's prompt section. Registered globally and empty for every other
  // session — the registry drops empty sections, so nothing is added to them.
  ctx.inject(["systemPrompt"], (scope) => {
    let order = 10165;
    try {
      order = scope.systemPrompt.getSectionOrder("WEB_SURFACE") + 65;
    } catch {
      // Order table moved upstream: keep the fixed slot after the web surface,
      // the Android surface (+50) and the summarizer's hint (+60).
    }
    scope.systemPrompt.section({
      name: BALL_SURFACE_SECTION,
      order,
      text: (context) => {
        try {
          const session = context?.agent?.session;
          rememberFamily(session);
          const ball = isBall(session);
          const id = idOf(session);
          if (id !== "") diagOnce(`section:${id}`, { ev: "section", session: id, ball, title: titleOf(session), preset: session?.header?.agentPreset ?? null });
          if (!ball) return "";
          return promptFor(permissionPresets !== null && cfg.permissionPreset !== "");
        } catch {
          return "";
        }
      }
    });
  });

  // Delegation parents, recorded as sessions appear, so a teammate's session
  // can be traced back to a ball session. Best effort: a missing event only
  // means an old teammate keeps the GUI tools it already had.
  ctx.on("session/created", (session) => {
    try {
      rememberFamily(session);
    } catch {
      /* never throw from a listener */
    }
  });

  // The structural half: a ball session never sees a tool it cannot answer, and
  // neither does a teammate it spawns (a question in the child is just as
  // unanswerable — and the parent's task waits on it).
  // Runs inside the assembly waterfall, so it filters the final tool list — the
  // one the harness logs and the model receives.
  ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    const result = await next();
    try {
      const session = context?.agent?.session;
      rememberFamily(session);
      const ball = isBall(session);
      const id = idOf(session);
      if (id !== "") diagOnce(`assemble:${id}`, { ev: "assemble", session: id, ball, tools: Array.isArray(result?.tools) ? result.tools.length : null });
      if (!ball && !isDerived(session)) return result;
      if (ball) pinPermission(session);
      return withoutTools(result, cfg.withheldTools);
    } catch (error) {
      ctx.logger?.warn?.(`ball-surface: assembly filter skipped: ${error}`);
      return result;
    }
  }, { global: true });
}

export function apply(ctx, config = {}) {
  ctx.inject(["systemPrompt"], (scope) => {
    let order = 10150;
    try {
      order = scope.systemPrompt.getSectionOrder("WEB_SURFACE") + 50;
    } catch {
      // Order table moved upstream: a fixed slot after the web surface keeps
      // the two deployment blocks adjacent.
    }
    scope.systemPrompt.section({
      name: ANDROID_SURFACE_SECTION,
      order,
      text: () => ANDROID_SURFACE_PROMPT
    });
  });

  ctx.inject(["shellEnv"], (scope) => {
    scope.shellEnv.register({
      name: "android-bridge",
      variables: {
        [BRIDGE_URL_VAR]: {
          description: "Loopback HTTP control bridge of the DSH Android app (server start/stop, distro management, Shizuku)."
        },
        [BRIDGE_TOKEN_VAR]: {
          description: "Bearer token for the DSH Android control bridge; send it as the X-Dsh-Token header."
        }
      },
      resolve: () => ({
        [BRIDGE_URL_VAR]: bridgeUrl(),
        [BRIDGE_TOKEN_VAR]: bridgeToken()
      })
    });
  });

  const resolved = { ...BALL_DEFAULTS, ...config };
  installBallSurface(ctx, resolved);
  // The normal listener above already owns task image bookkeeping. If the ball
  // surface itself is off, install the small standalone lifecycle listener.
  if (resolved.enabled === false) installTaskImageCleanup(ctx);
}

/**
 * The floating ball's host half, driven with a fake Cordis context.
 *
 * The ball's thread is the one place a prompt reaches a user who has no DSH GUI
 * in front of them, so the two GUI-only escape hatches are removed structurally
 * rather than requested in prose:
 *
 *   - `ask_user_question` / `request_user_input` are filtered out of the tool
 *     assembly for that session (and only that session);
 *   - the session's permission preset is pinned, so no approval card can block
 *     a task the user cannot confirm.
 *
 * The prompt section is registered globally but renders empty for every other
 * session (the registry drops empty sections), so a normal DSH session keeps
 * its cards and its `ask` policy.
 *
 * Run: node ball-surface.test.mjs
 */

import { apply } from '../lib/index.js';

const sections = [];
const listeners = new Map();
const logs = [];
const ctx = {
	logger: {
		info: (...args) => logs.push(['info', ...args]),
		warn: (...args) => logs.push(['warn', ...args]),
	},
	sessionProjections: {
		stateOf: (session, key) => key === 'title' ? session.__title
			: key === 'modelSelection' ? session.__modelSelection
				: undefined,
	},
	on(name, handler, options) {
		listeners.set(name, { handler, options });
	},
	inject(_services, callback) {
		callback({
			systemPrompt: {
				getSectionOrder: () => 10100,
				section: (definition) => sections.push(definition),
			},
			permissionPresets: {
				set: (session, name) => {
					session.__permission = name;
				},
			},
			shellEnv: { register: () => {} },
		});
	},
};

// `diagFile: ''` keeps a test run out of the device's own diagnostic file.
apply(ctx, { diagFile: '' });

const ball = { header: { id: 'session-ball-a', agentPreset: 'standard' }, __title: '悬浮球' };
const legacy = { header: { id: 'session-legacy', agentPreset: 'standard' }, __title: '悬浮球' };
const byPreset = { header: { id: 'session-preset', agentPreset: 'ball' }, __title: '随便什么' };
const normal = { header: { id: 'session-normal', agentPreset: 'standard' }, __title: '远程登录并打开程序设计基础' };

let failures = 0;
function check(label, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures += 1;
	console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(actual)}`);
}

const ballSection = sections.find((section) => section.name === 'app:ball-surface');
const androidSection = sections.find((section) => section.name === 'app:android-surface');
const assemble = listeners.get('system-prompt/assemble');

check('both prompt sections are registered', sections.map((s) => s.name).sort(), ['app:android-surface', 'app:ball-surface']);
check('android surface keeps its slot', androidSection.order, 10150);
check('ball surface sorts after android surface and the summarizer hint', ballSection.order, 10165);

const ballText = ballSection.text({ agent: { session: ball } });
check('ball prompt is contributed for a ball session', ballText.length > 100, true);
check('ball prompt names the skill to load', /floating-ball/.test(ballText), true);
check('ball prompt requires numbered options', /编号选项/.test(ballText), true);
check('ball prompt states the pinned permission', /danger-full-access/.test(ballText), true);
check('ball prompt carries no prompt-variable brace', ballText.includes('{{'), false);
check('normal session renders an empty section (dropped by the registry)', ballSection.text({ agent: { session: normal } }), '');
check('no context renders nothing', ballSection.text(undefined), '');

const toolNames = ['bash', 'ask_user_question', 'read', 'request_user_input'];
async function assembleFor(session) {
	return assemble.handler(
		{ tools: toolNames.map((name) => ({ name })) },
		{ agent: { session } },
		async () => ({ tools: toolNames.map((name) => ({ name })) }),
	);
}

check('ball session loses the GUI question tools', (await assembleFor(ball)).tools.map((t) => t.name), ['bash', 'read']);
check('ball session permission is pinned', ball.__permission, 'danger-full-access');
check('a legacy ball session is recognised by its title alone', (await assembleFor(legacy)).tools.map((t) => t.name), ['bash', 'read']);
check('a preset-marked session is recognised too', (await assembleFor(byPreset)).tools.map((t) => t.name), ['bash', 'read']);
const normalResult = await assembleFor(normal);
check('a normal session keeps every tool', normalResult.tools.map((t) => t.name), toolNames);
check('a normal session keeps its own permission preset', normal.__permission, undefined);
check('the assembly filter is registered globally', assemble.options?.global, true);
check('an assembly without tools is left alone', (await assemble.handler({}, { agent: { session: ball } }, async () => ({}))), {});
const broken = {
	header: { id: 'session-broken' },
	get __title() {
		throw new Error('boom');
	},
};
const brokenResult = await assemble.handler(
	{ tools: toolNames.map((name) => ({ name })) },
	{ agent: { session: broken } },
	async () => ({ tools: toolNames.map((name) => ({ name })) }),
);
check('a throwing projection never breaks the assembly', brokenResult.tools.length, 4);
check('each ball session is pinned once', logs.filter(([level]) => level === 'info').length >= 2, true);

// A teammate spawned by the ball: its session has no ball title, but its parent
// does. It must lose the GUI tools (its question is just as unanswerable, and
// the parent waits on it) while keeping its own prompt.
const mate = { header: { id: 'session-mate', agentPreset: 'standard', parentSession: 'session-ball-a' }, __title: '子会话' };
check('a teammate of a ball session loses the GUI tools too', (await assembleFor(mate)).tools.map((t) => t.name), ['bash', 'read']);
check('a teammate of a ball session gets no ball prompt', ballSection.text({ agent: { session: mate } }), '');
const mateOfNormal = { header: { id: 'session-mate-2', agentPreset: 'standard', parentSession: 'session-normal' }, __title: '子会话' };
check('a teammate of a normal session keeps every tool', (await assembleFor(mateOfNormal)).tools.map((t) => t.name), toolNames);
check('a teammate of a normal session gets no ball prompt', ballSection.text({ agent: { session: mateOfNormal } }), '');

// The path a *new* ball thread takes: the client renames it right after
// creating it, so the title arrives as an event — no warm projection needed.
const renamed = { header: { id: 'session-renamed', agentPreset: 'standard' }, __title: '' };
listeners.get('session/event').handler(renamed, { type: 'session/title', data: { title: '悬浮球', source: { kind: 'user' } } });
check('a user title event marks the session without any projection', (await assembleFor(renamed)).tools.map((t) => t.name), ['bash', 'read']);
check('the event-marked session gets the ball prompt', ballSection.text({ agent: { session: renamed } }).length > 100, true);
check('another title does not mark a session', (await assembleFor({ header: { id: 'session-other' }, __title: '别的' })).tools.map((t) => t.name), toolNames);

// Final assistant text must reach the native result bubble. The first case is
// the live event shape; the second is the committed-log fallback used when the
// message event was missed or arrived in an older wrapper.
const pushes = [];
const originalFetch = globalThis.fetch;
const oldUrl = process.env.DSH_ANDROID_BRIDGE_URL;
const oldToken = process.env.DSH_ANDROID_BRIDGE_TOKEN;
let fetchStub = async (url, init) => {
	if (String(url).endsWith('/screen-watch/status')) {
		return {
			ok: true,
			json: async () => ({ active: globalThis.__screenWatchActive === true })
		};
	}
	pushPayload(url, init);
	return { ok: true, json: async () => ({ ok: true }) };
};
function pushPayload(url, init) {
	pushes.push({ url: String(url), body: JSON.parse(init.body) });
}
globalThis.fetch = (url, init) => fetchStub(url, init);
process.env.DSH_ANDROID_BRIDGE_URL = 'http://127.0.0.1:8399';
process.env.DSH_ANDROID_BRIDGE_TOKEN = 'test-token';

const cleanupSession = { header: { id: 'session-main-cleanup' } };
const onSessionEvent = listeners.get('session/event').handler;
onSessionEvent(cleanupSession, { type: 'turn/start', data: { turn: 1 } });
onSessionEvent(cleanupSession, {
	type: 'turn/end',
	data: { turn: 1, reason: { kind: 'completed' } }
});
await new Promise((resolve) => setTimeout(resolve, 10));
check('a normal session starts screenshot tracking',
	pushes.some((push) => push.url.endsWith('/task/images/begin')
		&& push.body.sessionId === 'session-main-cleanup'), true);
check('a normal session ends screenshot tracking',
	pushes.some((push) => push.url.endsWith('/task/images/end')
		&& push.body.sessionId === 'session-main-cleanup'), true);

onSessionEvent(normal, {
	type: 'assistant/message',
	data: { turn: 2, message: { content: [{ type: 'text', text: '软件里的结果也会出现在球上。' }] } }
});
onSessionEvent(normal, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
await new Promise((resolve) => setTimeout(resolve, 10));
check('a normal top-level turn result reaches the ball',
	pushes.at(-1)?.body?.text, '软件里的结果也会出现在球上。');
check('a normal top-level result uses the result phase',
	pushes.at(-1)?.body?.phase, 'result');
check('a normal result carries its stable turn identifier',
	pushes.at(-1)?.body?.eventId, 'session-normal:result:turn:2');

const observer = { header: { id: 'session-screen-observer' }, __title: '' };
onSessionEvent(observer, {
	type: 'session/title',
	data: { title: '屏幕观察', source: { kind: 'user' } }
});
globalThis.__screenWatchActive = true;
onSessionEvent(observer, {
	type: 'assistant/message',
	data: { turn: 20, message: { content: [{ type: 'text', text: '观察结果仍然有效' }] } }
});
onSessionEvent(observer, { type: 'turn/end', data: { turn: 20, reason: { kind: 'completed' } } });
await new Promise((resolve) => setTimeout(resolve, 10));
check('screen-watch results reach the ball while observation is active',
	pushes.at(-1)?.body?.text, '观察结果仍然有效');

globalThis.__screenWatchActive = true;
onSessionEvent(observer, {
	type: 'assistant/message',
	data: { turn: 21, message: { content: [{
		type: 'text',
		text: 'I need to compare the previous screenshot and answer in Chinese.\n'
			+ 'The safest output is one short Chinese sentence.\n'
			+ '终端窗口中显示了新的设置页面，底部的按钮没有变化。'
	}] } }
});
onSessionEvent(observer, { type: 'turn/end', data: { turn: 21, reason: { kind: 'completed' } } });
await new Promise((resolve) => setTimeout(resolve, 10));
check('screen-watch hides reasoning and English drafts',
	pushes.at(-1)?.body?.text, '终端窗口中显示了新的设置页面，底部的按钮没有变化。');

const markedObserver = { header: { id: 'session-screen-marked' }, __title: '自动标题失败' };
onSessionEvent(markedObserver, {
	type: 'user/message',
	data: { message: { content: [{
		type: 'text',
		text: '[DHA_SCREEN_WATCH_V1] 观察当前画面变化'
	}] } }
});
onSessionEvent(markedObserver, {
	type: 'assistant/message',
	data: { turn: 30, message: { content: [{
		type: 'text',
		text: 'Reasoning in English.\n设置页面向上滚动，出现了新的选项。'
	}] } }
});
onSessionEvent(markedObserver, { type: 'turn/end', data: { turn: 30, reason: { kind: 'completed' } } });
await new Promise((resolve) => setTimeout(resolve, 10));
check('screen-watch marker identifies a session even when rename failed',
	pushes.at(-1)?.body?.text, '设置页面向上滚动，出现了新的选项。');

const beforeCancelledObserverResult = pushes.filter(
	(push) => push.url.endsWith('/ball/state')
).length;
globalThis.__screenWatchActive = false;
onSessionEvent(observer, {
	type: 'assistant/message',
	data: { turn: 22, message: { content: [{ type: 'text', text: '停止后不应出现的结果' }] } }
});
onSessionEvent(observer, { type: 'turn/end', data: { turn: 22, reason: { kind: 'aborted' } } });
await new Promise((resolve) => setTimeout(resolve, 10));
check('screen-watch cancellation does not overwrite the stopped bubble',
	pushes.filter((push) => push.url.endsWith('/ball/state')).length,
	beforeCancelledObserverResult);
delete globalThis.__screenWatchActive;

const live = { header: { id: 'session-ball-live-result' } };
onSessionEvent(live, {
	type: 'assistant/message',
	data: {
		turn: 3,
		message: {
			content: [
				{ type: 'reasoning', text: 'Private English reasoning must not reach the ball.' },
				{ type: 'reasoning_summary', text: 'Summarized private reasoning.' },
				{ type: 'tool-call', name: 'bash', text: 'Process text must be hidden.' },
				{ type: 'text', text: '结论：已经完成。\n第二段也保留。' },
			]
		}
	}
});
onSessionEvent(live, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } });
await new Promise((resolve) => setTimeout(resolve, 10));
check('assistant block text becomes the final ball result', pushes.at(-1)?.body?.text, '结论：已经完成。\n第二段也保留。');
check('assistant reasoning blocks are excluded from the ball',
	pushes.at(-1)?.body?.text.includes('Private English reasoning'), false);
check('the final result uses the result phase', pushes.at(-1)?.body?.phase, 'result');
check('a completed turn requests the completion cue', pushes.at(-1)?.body?.cue, 'complete');
check('a floating-ball result carries its stable turn identifier',
	pushes.at(-1)?.body?.eventId, 'session-ball-live-result:result:turn:3');

const completedPushes = pushes.filter((push) => push.url.endsWith('/ball/state')).length;
onSessionEvent(live, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } });
await new Promise((resolve) => setTimeout(resolve, 10));
check('a repeated turn/end does not show the completed result again',
	pushes.filter((push) => push.url.endsWith('/ball/state')).length, completedPushes);

onSessionEvent(live, {
	type: 'approval/asked',
	data: { id: 'approval-1', toolName: 'bash' }
});
await new Promise((resolve) => setTimeout(resolve, 10));
check('an approval request owns the bubble', pushes.at(-1)?.body?.phase, 'permission');
check('an approval request selects the permission cue', pushes.at(-1)?.body?.cue, 'permission');

onSessionEvent(normal, {
	type: 'approval/asked',
	data: { id: 'approval-normal', toolName: 'write' }
});
await new Promise((resolve) => setTimeout(resolve, 10));
check('a normal session approval also alerts', pushes.at(-1)?.body?.cue, 'permission');

const interrupted = { header: { id: 'session-ball-interrupted' } };
onSessionEvent(interrupted, {
	type: 'turn/end',
	data: { turn: 5, reason: { kind: 'interrupted' } }
});
await new Promise((resolve) => setTimeout(resolve, 10));
check('an interrupted turn falls back to an interruption', pushes.at(-1)?.body?.text, '任务已中断');
check('an interrupted turn selects the interruption cue', pushes.at(-1)?.body?.cue, 'interrupted');

const fallback = {
	header: { id: 'session-ball-log-result' },
	snapshotEvents: () => [
		{ type: 'turn/start', data: { turn: 4 } },
		{ type: 'assistant/message', data: { turn: 4, message: { content: '从会话日志回读的结果' } } },
		{ type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } }
	]
};
onSessionEvent(fallback, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } });
await new Promise((resolve) => setTimeout(resolve, 10));
check('turn/end falls back to the committed assistant message', pushes.at(-1)?.body?.text, '从会话日志回读的结果');

globalThis.fetch = originalFetch;
if (oldUrl === undefined) delete process.env.DSH_ANDROID_BRIDGE_URL;
else process.env.DSH_ANDROID_BRIDGE_URL = oldUrl;
if (oldToken === undefined) delete process.env.DSH_ANDROID_BRIDGE_TOKEN;
else process.env.DSH_ANDROID_BRIDGE_TOKEN = oldToken;

console.log(failures === 0 ? '\nall ball-surface checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

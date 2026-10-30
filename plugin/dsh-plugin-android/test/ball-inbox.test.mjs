/**
 * The ball's own thread: queue drain, identity, and recovery from a deleted one.
 *
 * `installBallInbox` ships between `@ball-inbox:begin/end` markers in
 * `../lib/client.js`, so this suite drives the bytes that run in the WebView —
 * with the app's bridge stubbed out and a fake `remote.session`.
 *
 * The case that matters: a session the user deleted from the sidebar is
 * *archived*, and the harness then accepts the prompt and refuses the turn. The
 * ball must notice, open a fresh thread, and hand it the same words — never
 * leave them in a thread nobody reads. A healthy turn must not be disturbed,
 * and neither must an install that cannot answer the question at all.
 *
 * Usage: node test/ball-inbox.test.mjs
 */
import { readFileSync } from 'node:fs';

const SOURCE = process.env.DSH_VT_SOURCE ?? new URL('../lib/client.js', import.meta.url).pathname;
const text = readFileSync(SOURCE, 'utf8');
const BEGIN = '/* ==== @ball-inbox:begin';
const END = '@ball-inbox:end ==== */';
const start = text.indexOf(BEGIN);
if (start === -1) throw new Error('ball-inbox: marker block missing');
const stop = text.indexOf(END, start);
if (stop === -1) throw new Error('ball-inbox: unterminated marker block');
const block = text.slice(start, stop + END.length);

// `call` is the block's only outside dependency — the app bridge helper, which
// the plugin supplies when it installs the function.
const build = (call) => new Function('call', `${block}\nreturn { ballDoing, installBallInbox };`)(call);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(label, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures += 1;
	console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(actual)}`);
}

/** localStorage, per scenario: the ball's stored thread id lives here. */
function fakeStorage(seed = {}) {
	const map = new Map(Object.entries(seed));
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => { map.set(key, String(value)); },
		removeItem: (key) => { map.delete(key); },
		read: (key) => (map.has(key) ? map.get(key) : null),
	};
}

/**
 * One scenario: queue one item, answer the session questions, run the drain.
 *
 * @param options.turnEnd - `turn/end` reason the fake page reports.
 * @param options.noPage - omit `api.page`, as an older controller would.
 */
async function scenario({ turnEnd = { kind: 'completed' }, noPage = false } = {}) {
	const calls = [];
	const prompts = [];
	const creates = [];
	const acks = [];
	let created = 0;
	let createdId = '';
	const queued = [{ id: 7, text: '下载目录有点乱，帮我规整一下' }];

	const api = {
		create: async (request) => {
			creates.push(request);
			created += 1;
			createdId = request.sessionId ?? `session-plain-${created}`;
			return { ok: true, value: { sessionId: createdId } };
		},
		prompt: async (request) => {
			prompts.push({ sessionId: request.sessionId, text: request.content[0].text });
			return { ok: true, value: { accepted: true } };
		},
		rename: async () => ({ ok: true, value: { title: '悬浮球', seq: 1 } }),
		list: async () => ({
			ok: true,
			value: {
				items: [
					{ sessionId: 'session-other', cwd: '/mnt/Documents', updatedAt: 9, projections: { asOfSeq: 12, values: { title: '别的会话' } } },
					{ sessionId: createdId, cwd: '/opt/dsh', updatedAt: 8, projections: { asOfSeq: 42, values: { title: '悬浮球' } } },
				],
			},
		}),
	};
	if (!noPage) {
		api.page = async (request) => ({
			ok: true,
			value: { records: [{ type: 'event', event: { type: 'turn/start', seq: request.throughSeq - 1, time: 1, data: { turn: 1 } } }, { type: 'event', event: { type: 'turn/end', seq: request.throughSeq, time: 2, data: { turn: 1, reason: turnEnd } } }], hasMore: false },
		});
	}

	const storage = fakeStorage();
	const restoreStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
	Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });

	const call = async (path, body) => {
		calls.push({ path, body });
		if (path === '/ball/inbox') {
			const items = queued.splice(0, queued.length);
			return { ok: true, items };
		}
		if (path === '/ball/inbox/ack') {
			acks.push(...(body.ids ?? []));
			return { ok: true, items: [] };
		}
		return { ok: true };
	};

	const { installBallInbox } = build(call);
	const ctx = { remote: { session: api } };
	const inbox = installBallInbox(ctx);
	await sleep(2400);                       // the drain plus its 700 ms look-back
	inbox.disconnect();
	if (restoreStorage === undefined) delete globalThis.localStorage;
	else Object.defineProperty(globalThis, 'localStorage', restoreStorage);
	return { calls, prompts, creates, acks, storage };
}

/* ------------------------------------------------- deleted thread: recover -- */

const blocked = await scenario({ turnEnd: { kind: 'blocked' } });

check('死线程：先按正常路径建了一条球会话', blocked.creates.length, 2);
check('死线程：第二次 create 用的是带前缀的新 id', blocked.creates[1].sessionId.startsWith('session-ball-'), true);
check('死线程：第一句投给了旧线程', blocked.prompts[0].text, '下载目录有点乱，帮我规整一下');
check('死线程：同一句话被重发到新线程', blocked.prompts.length, 2);
check('死线程：重发落在新建的那条 id 上', blocked.prompts[1].sessionId, blocked.creates[1].sessionId);
check('死线程：新线程 id 也记进了 localStorage', blocked.storage.read('dsh.android.ballSession') !== blocked.prompts[0].sessionId, true);
check('死线程：话没丢，队列被 ack 了', blocked.acks, [7]);
check('死线程：球上说明了为什么换线程', blocked.calls.some((entry) => entry.path === '/ball/state' && String(entry.body?.text ?? '').includes('换一条新的')), true);
check('建会话时带上了别的工作目录（不是 /opt/dsh）', blocked.creates[0].cwd, '/mnt/Documents');

/* ------------------------------------------------- healthy thread: leave it -- */

const healthy = await scenario({ turnEnd: { kind: 'completed' } });

check('正常回合：只建了一条会话', healthy.creates.length, 1);
check('正常回合：没有重发', healthy.prompts.length, 1);
check('正常回合：正常 ack', healthy.acks, [7]);
check('正常回合：球上没出现换线程的提示', healthy.calls.every((entry) => !String(entry.body?.text ?? '').includes('换一条新的')), true);

/* --------------------------------------- no page API: degrade, never break -- */

const degraded = await scenario({ noPage: true });

check('拿不到 session.page 时：照常投递、不换线程、不崩', [degraded.creates.length, degraded.prompts.length, degraded.acks.length], [1, 1, 1]);

/* ------------------------------------------------------------ field parse -- */

const { ballDoing } = build(async () => ({}));
check('ball_doing 仍能从 JSON 里挑出来', ballDoing('{"ball_doing":"正在整理下载目录"}'), '正在整理下载目录');
check('ball_doing 空值仍是空（气泡收起）', ballDoing(''), '');

console.log(failures === 0 ? '\nall ball-inbox checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

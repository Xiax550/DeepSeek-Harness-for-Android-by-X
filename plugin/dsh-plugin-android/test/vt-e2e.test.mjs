/**
 * End-to-end interactive test: the whole input path, against a real shell.
 *
 *   key event -> input controller -> PTY -> bash/Readline echo -> emulator -> painted caret
 *
 * This is the test for the reported bug "after pressing ←/→ you cannot see where
 * the cursor really is". It presses the arrow keys through the same handlers a
 * phone keyboard hits, lets the real pty answer, and then asserts three things
 * agree at every step:
 *
 *   the bytes that went out      (ESC[D per press)
 *   the cursor the emulator holds and the cursor @xterm/headless holds
 *   the caret the DOM actually paints, read back out of the rendered row
 *
 * Chinese input goes through the same path in the last scenario: an IME
 * composition has to reach the shell intact.
 *
 * Usage: node test/vt-e2e.test.mjs [--verbose]
 */
import { createRequire } from "node:module";
import { loadVtCore, DEFAULT_SOURCE } from "./vt-loader.mjs";
import { createVtInputFactory } from "./vt-input-loader.mjs";
import { createVtViewFactory } from "./vt-view-loader.mjs";
import { createFakeDocument, createElement, findClass, textOf } from "./fake-dom.mjs";

const require = createRequire(import.meta.url);
const DSH = process.env.DSH_INSTALL ?? "/opt/dsh";
const { Terminal: HeadlessTerminal } = require(`${DSH}/node_modules/@xterm/headless/lib-headless/xterm-headless.js`);
const pty = require(`${DSH}/node_modules/node-pty`);

const core = loadVtCore(DEFAULT_SOURCE);
const createVtInput = createVtInputFactory(DEFAULT_SOURCE);
const createVtView = createVtViewFactory(DEFAULT_SOURCE);

const COLS = 80;
const ROWS = 24;
const VERBOSE = process.argv.includes("--verbose");

let failures = 0;
let checks = 0;

function ok(condition, message, detail) {
	checks++;
	if (condition) return;
	failures++;
	console.error(`FAIL  ${message}`);
	if (detail !== undefined) console.error(detail);
}

function equal(actual, expected, message) {
	ok(actual === expected, message, `  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/* --------------------------------------------------------------------- session */

function startSession() {
	const proc = pty.spawn("/bin/bash", ["--noprofile", "--norc", "-i"], {
		name: "xterm-256color",
		cols: COLS,
		rows: ROWS,
		cwd: "/tmp",
		env: {
			...process.env,
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
			LANG: "C.UTF-8",
			PS1: "$ ",
			PROMPT_COMMAND: ""
		}
	});
	const term = new HeadlessTerminal({
		cols: COLS,
		rows: ROWS,
		scrollback: 0,
		allowProposedApi: true
	});
	const screen = new core.Screen({
		cols: COLS,
		rows: ROWS,
		scrollback: 200
	});
	const document = createFakeDocument();
	const textarea = createElement("textarea");
	const sent = [];
	const input = createVtInput({
		element: textarea,
		onData: (data) => {
			sent.push(data);
			proc.write(data);
		},
		onState: (name, value) => {
			if (name === "composing") view.setComposing(value);
		}
	});
	const view = createVtView({
		document,
		screen,
		input,
		textarea,
		t: (key) => key,
		flags: core,
		cellWidth: (cp) => core.cpWidth(cp),
		onResize: (cols, rows) => {
			proc.resize(cols, rows);
			term.resize(cols, rows);
		},
		onMessage: () => {},
		window: null,
		navigator: null,
		haptic: null
	});
	input.attach();
	view.applyTheme("dark");
	view.paintNow();
	proc.onData((data) => {
		screen.write(Buffer.from(data, "utf8"));
		term.write(data);
		view.paintNow();
	});
	return {
		proc,
		term,
		screen,
		view,
		document,
		input,
		textarea,
		sent,
		/** The row elements the painter produced, in buffer order. */
		rows: () => view.viewport.children[0].children.filter((child) => child !== view.textarea)
	};
}

/** Type through the controller the way a soft keyboard delivers characters. */
function typeText(session, text) {
	for (const character of text) {
		session.textarea.dispatch("keydown", {
			key: character,
			keyCode: 229,
			ctrlKey: false,
			altKey: false,
			metaKey: false,
			shiftKey: false,
			isComposing: false
		});
		session.textarea.dispatch("beforeinput", {
			inputType: "insertText",
			data: character,
			isComposing: false
		});
	}
}

function pressKey(session, key, extras = {}) {
	return session.textarea.dispatch("keydown", {
		key,
		keyCode: extras.keyCode ?? 0,
		ctrlKey: extras.ctrlKey ?? false,
		altKey: false,
		metaKey: false,
		shiftKey: extras.shiftKey ?? false,
		isComposing: false
	});
}

function compose(session, updates, final) {
	session.textarea.dispatch("compositionstart", {
		data: "",
		isComposing: true
	});
	for (const update of updates) {
		session.textarea.value = update;
		session.textarea.dispatch("compositionupdate", {
			data: update,
			isComposing: true
		});
	}
	session.textarea.value = final;
	session.textarea.dispatch("compositionend", {
		data: final,
		isComposing: false
	});
	session.textarea.dispatch("input", {
		inputType: "insertCompositionText",
		data: final,
		isComposing: false
	});
}

/** The column the caret is painted at, read back out of the rendered row. */
function paintedCaretColumn(session) {
	const rows = session.rows();
	const row = rows[session.screen.cursorAbs];
	if (row === undefined) return -1;
	let column = 0;
	for (const child of row.children) {
		if (findClass(child, "dsv-caret") !== null || findClass(child, "dsv-caret-off") !== null) return column;
		column += String(child.textContent).length;
	}
	return -1;
}

function rowTextOf(session, index) {
	const row = session.rows()[index];
	return row === undefined ? "" : textOf(row).trimEnd();
}

function report(label, session) {
	const term = session.term.buffer.active;
	const painted = paintedCaretColumn(session);
	/* Row text straight from the children, because textContent is not maintained
	 * by the fake DOM. */
	console.log(
		`      ${label}: pty/xterm=(${term.cursorX},${term.cursorY}) `
		+ `emulator=(${session.screen.cursor.x},${session.screen.cursor.y}) `
		+ `painted caret column=${painted} `
		+ `line="${rowTextOf(session, session.screen.cursorAbs)}"`
	);
	return {
		xterm: term.cursorX,
		ours: session.screen.cursor.x,
		painted
	};
}

function assertAgreement(label, session) {
	const state = report(label, session);
	equal(state.ours, state.xterm, `${label}: emulator cursor == xterm cursor`);
	equal(state.painted, state.ours, `${label}: the painted caret sits where the cursor is`);
	return state;
}

/* ----------------------------------------------------------------- scenarios */

console.log(`vt-e2e: source ${DEFAULT_SOURCE}`);
console.log(`vt-e2e: shell /bin/bash in node-pty ${COLS}x${ROWS}, reference @xterm/headless`);

const session = startSession();
await sleep(300);

/* 1. type a command line: the caret follows every character */
typeText(session, "echo hello world");
await sleep(250);
assertAgreement("typed a line", session);
equal(rowTextOf(session, 0), "$ echo hello world", "the shell echoed the command line as it was typed");

/* 2. the reported bug: press ← five times, then read the caret back */
session.sent.length = 0;
for (let i = 0; i < 5; i++) pressKey(session, "ArrowLeft");
equal(session.sent.join(""), "\u001b[D".repeat(5), "each ← press sends exactly one cursor-left sequence");
await sleep(300);
const afterLeft = assertAgreement("after 5× ←", session);
equal(afterLeft.painted, 13, "the caret is painted 5 columns left of column 18");
equal(rowTextOf(session, 0), "$ echo hello world", "the line itself is untouched by ←");

/* 3. text typed now lands where the caret is, not at the end of the line */
typeText(session, "X");
await sleep(250);
const afterType = assertAgreement("typed X at the caret", session);
equal(rowTextOf(session, 0), "$ echo hello Xworld", "readline inserted at the cursor, and the screen shows it");
equal(afterType.painted, 14, "and the caret advanced by one");

/* 4. → goes back, and the caret follows again */
session.sent.length = 0;
pressKey(session, "ArrowRight");
pressKey(session, "ArrowRight");
equal(session.sent.join(""), "\u001b[C\u001b[C", "each → press sends one cursor-right sequence");
await sleep(250);
const afterRight = assertAgreement("after 2× →", session);
equal(afterRight.painted, 16, "the caret came back two columns (14 → 16)");

/* 5. backspace deletes at the caret */
session.sent.length = 0;
pressKey(session, "ArrowRight");
pressKey(session, "ArrowRight");
await sleep(200);
const beforeDelete = rowTextOf(session, 0);
session.sent.length = 0;
pressKey(session, "Backspace", { keyCode: 8 });
pressKey(session, "Backspace", { keyCode: 8 });
equal(session.sent.join(""), "\u007f\u007f", "backspace sends DEL, once per press");
await sleep(300);
assertAgreement("after 2× backspace", session);
const afterDelete = rowTextOf(session, 0);
equal(afterDelete.length, beforeDelete.length - 2, "two characters are gone from the line");
console.log(`      backspace: "${beforeDelete}" -> "${afterDelete}"`);

/* 6. Ctrl+C interrupts and the prompt comes back */
pressKey(session, "c", { keyCode: 67, ctrlKey: true });
await sleep(300);
assertAgreement("after Ctrl+C", session);
ok(rowTextOf(session, 0).includes("^C"), "the terminal shows the interrupt where it happened", rowTextOf(session, 0));
pressKey(session, "Enter", { keyCode: 13 });
await sleep(350);

/* 7. run a real command from the same input path */
session.sent.length = 0;
typeText(session, "echo hello world");
pressKey(session, "Enter", { keyCode: 13 });
await sleep(400);
const lines = [];
for (let y = 0; y < ROWS; y++) lines.push(rowTextOf(session, y));
console.log(`      command output:${JSON.stringify(lines.filter((line) => line !== "").slice(-3))}`);
ok(lines.includes("hello world"), "Enter ran the command and its output is on screen", lines.filter(Boolean).join("\n"));

/* 8. Chinese through an IME composition reaches the shell intact */
compose(session, ["n", "ni", "nih", "niha", "nihao"], "你好");
await sleep(250);
equal(session.sent[session.sent.length - 1], "你好", "the committed composition is what goes to the PTY");
typeText(session, " 世界");
await sleep(250);
pressKey(session, "Enter", { keyCode: 13 });
await sleep(450);
const afterChinese = [];
for (let y = 0; y < ROWS; y++) afterChinese.push(rowTextOf(session, y));
console.log(`      IME line:${JSON.stringify(afterChinese.filter((line) => line !== "").slice(-3))}`);
ok(afterChinese.some((line) => line.includes("你好 世界")), "the Chinese text went out and came back on screen", afterChinese.filter(Boolean).join("\n"));

/* 9. resize: the grid, the pty and the shell agree */
session.proc.resize(100, 30);
session.screen.resize(100, 30);
session.term.resize(100, 30);
await sleep(300);
assertAgreement("after resize to 100x30", session);

try {
	session.proc.kill();
} catch {
	/* already gone */
}

console.log(`\nvt-e2e: ${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

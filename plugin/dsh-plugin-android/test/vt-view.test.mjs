/**
 * Painter tests: the DOM half of the terminal, driven through a fake document.
 *
 * There is no browser in the sandbox. The view only builds elements and reads a
 * few layout numbers, so the fake document below implements exactly that
 * surface — enough to assert the things that would actually break on the phone:
 * which rows exist, what text they contain, that unchanged rows keep their DOM
 * nodes, where the caret and the IME pre-edit land, and which bytes the key row
 * sends.
 *
 * Usage: node test/vt-view.test.mjs
 */
import { loadVtCore, DEFAULT_SOURCE } from "./vt-loader.mjs";
import { createVtInputFactory } from "./vt-input-loader.mjs";
import { createVtViewFactory } from "./vt-view-loader.mjs";

const core = loadVtCore(DEFAULT_SOURCE);
const createVtInput = createVtInputFactory(DEFAULT_SOURCE);
const createVtView = createVtViewFactory(DEFAULT_SOURCE);

let failures = 0;
let checks = 0;

function ok(condition, message, detail) {
	checks++;
	if (condition) return;
	failures++;
	console.error(`FAIL  ${message}`);
	if (detail !== undefined) console.error(detail);
}

function same(actual, expected, message) {
	checks++;
	if (actual === expected) return;
	failures++;
	console.error(`FAIL  ${message}
  expected and actual are different objects`);
}

function equal(actual, expected, message) {
	ok(actual === expected, message, `  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
}

import { createFakeDocument, createElement, textOf, classesOf, findCaret, findClass, CELL } from "./fake-dom.mjs";

const document = createFakeDocument();

/** The column the caret is painted at, read back out of the row children. */
function caretColumn(row) {
	let column = 0;
	for (const child of row.children) {
		if (findClass(child, "dsv-caret") !== null || findClass(child, "dsv-caret-off") !== null) return column;
		column += String(child.textContent).length;
	}
	return -1;
}

function makeHarness(options = {}) {
	const screen = new core.Screen({
		cols: 20,
		rows: 5,
		scrollback: 50
	});
	const sent = [];
	const resizes = [];
	const messages = [];
	const logs = [];
	const haptics = [];
	const textarea = createElement("textarea");
	const input = createVtInput({
		element: textarea,
		onData: (data) => sent.push(data),
		onState: (name, value) => {
			if (name === "composing") view.setComposing(value);
			if (name === "ctrl") view.showCtrlState(value);
		}
	});
	const t = (key) => key;
	const view = createVtView({
		document,
		screen,
		input,
		t,
		flags: core,
		cellWidth: (cp) => core.cpWidth(cp),
		onResize: (cols, rows) => resizes.push([cols, rows]),
		onMessage: (message) => messages.push(message),
		window: options.window === undefined ? null : options.window,
		navigator: options.navigator === undefined ? null : options.navigator,
		haptic: options.haptic === undefined ? null : options.haptic,
		log: (line) => logs.push(line),
		now: options.now
	});
	input.attach();
	view.applyTheme("dark");
	view.paintNow();
	return {
		screen,
		view,
		input,
		sent,
		resizes,
		messages,
		logs,
		haptics,
		textarea,
		rows: () => view.viewport.children[0].children.filter((child) => child !== view.textarea)
	};
}

/** A window whose visual viewport reports a keyboard the test controls. */
function fakeWindow(options = {}) {
	const listeners = new Map();
	const visualViewport = {
		height: options.innerHeight ?? 900,
		addEventListener(type, handler) {
			if (!listeners.has(type)) listeners.set(type, []);
			listeners.get(type).push(handler);
		},
		removeEventListener(type, handler) {
			const list = listeners.get(type) ?? [];
			const index = list.indexOf(handler);
			if (index >= 0) list.splice(index, 1);
		},
		dispatch(type) {
			for (const handler of listeners.get(type) ?? []) handler({ type });
		}
	};
	return {
		innerHeight: options.innerHeight ?? 900,
		visualViewport,
		/** Keyboard up = the visual viewport lost height. */
		setKeyboard(open) {
			visualViewport.height = open ? 520 : 900;
		}
	};
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---------------------------------------------------------------------- tests */

/* 1. rows are created for the whole buffer, in order */
{
	const harness = makeHarness();
	harness.screen.write("one\r\ntwo\r\nthree");
	harness.view.paintNow();
	const rows = harness.rows();
	equal(rows.length, harness.screen.lineCount, "one row element per buffer line");
	equal(textOf(rows[0]), "one", "first row text");
	equal(textOf(rows[1]), "two", "second row text");
	equal(textOf(rows[2]).trimEnd(), "three", "third row text");
}

/* 2. only the changed rows are repainted */
{
	const harness = makeHarness();
	harness.screen.write("stable\r\n");
	harness.view.paintNow();
	const before = harness.rows()[0];
	const beforeChildren = [...before.children];
	harness.screen.write("changing");
	harness.view.paintNow();
	const after = harness.rows()[0];
	ok(before === after, "the unchanged row keeps its element (row reuse)");
	equal(before.children.length, beforeChildren.length, "and it was not rebuilt");
	const cursorRow = harness.rows()[harness.screen.cursorAbs];
	equal(textOf(cursorRow).trimEnd(), "changing", "the changed row carries the new text");
}

/* 3. trailing blanks are not emitted as nodes */
{
	const harness = makeHarness();
	harness.screen.write("hi");
	harness.view.paintNow();
	const row = harness.rows()[harness.screen.cursorAbs];
	equal(textOf(row), "hi ", "the row text stops at the caret cell (which draws as a blank)");
	ok(row.children.length <= 3, "a short row is a couple of spans, not one per column", `  spans: ${row.children.length}`);
}

/* 4. the caret sits in the text flow at the cursor column */
{
	const harness = makeHarness();
	harness.screen.write("abc");
	harness.view.textarea.dispatch("focus");
	harness.view.paintNow();
	const row = harness.rows()[harness.screen.cursorAbs];
	const caret = findClass(row, "dsv-caret");
	ok(caret !== null, "a focused cursor row draws a block caret span");
	equal(textOf(row).indexOf(caret.textContent), 3, "the caret is the fourth cell of the row");
	equal(textOf(row), "abc ", "the caret renders as the blank it covers");
}

/* 5. an unfocused terminal draws a hollow caret instead of a block */
{
	const harness = makeHarness();
	harness.screen.write("x");
	harness.view.paintNow();
	ok(findClass(harness.rows()[harness.screen.cursorAbs], "dsv-caret-off") !== null, "an unfocused terminal draws a hollow caret");
	harness.view.textarea.dispatch("focus");
	harness.view.paintNow();
	ok(findClass(harness.rows()[harness.screen.cursorAbs], "dsv-caret") !== null, "focus turns it into a block caret");
}

/* 6. colors and attributes from SGR reach the spans */
{
	const harness = makeHarness();
	harness.screen.write("\u001b[31mred\u001b[0m \u001b[1mB\u001b[0m");
	harness.view.paintNow();
	const row = harness.rows()[harness.screen.cursorAbs];
	const spans = row.children.filter((child) => child.tagName === "SPAN");
	const red = spans.find((span) => span.textContent === "red");
	ok(red !== undefined, "the colored run has its own span");
	equal(red.style.color, harness.screen.colorOf(1, "#000"), "SGR 31 color reaches the DOM");
	const bold = spans.find((span) => span.textContent === "B");
	equal(bold.style.fontWeight, "600", "SGR 1 becomes a bold span");
}

/* 7. the IME pre-edit replaces the cells under the cursor, and leaves */
{
	const harness = makeHarness();
	harness.screen.write("ab");
	harness.view.setComposing("nihao");
	harness.view.paintNow();
	const row = harness.rows()[harness.screen.cursorAbs];
	const compose = findClass(row, "dsv-compose");
	ok(compose !== null, "composing text is drawn in the row");
	equal(compose.textContent, "nihao", "and it shows the pre-edit verbatim");
	ok(textOf(row).startsWith("abnihao"), "it starts at the cursor column");
	harness.view.setComposing("");
	harness.view.paintNow();
	ok(findClass(harness.rows()[harness.screen.cursorAbs], "dsv-compose") === null, "the pre-edit disappears when the composition ends");
	ok(findCaret(harness.rows()[harness.screen.cursorAbs]) !== null, "and the caret comes back");
}

/* 8. wide characters keep the columns after them aligned */
{
	const harness = makeHarness();
	harness.screen.write("中x");
	harness.view.paintNow();
	const row = harness.rows()[harness.screen.cursorAbs];
	equal(textOf(row), "中x ", "wide glyph and the cell after it are both in the row");
}

/* 9. fit() sizes the grid from the viewport and reports the resize */
{
	const harness = makeHarness();
	harness.view.viewport.clientWidth = 800;
	harness.view.viewport.clientHeight = 400;
	harness.view.fit();
	equal(harness.screen.cols, Math.floor((800 - 16) / CELL), "column count follows the viewport width");
	equal(harness.screen.rows, Math.floor((400 - 12) / 18), "row count follows the viewport height");
	equal(harness.resizes.length, 1, "the panel is told to resize the PTY once");
	const before = harness.screen.cols;
	harness.view.fit();
	equal(harness.resizes.length, 1, "a second fit with the same size does not re-send the PTY size");
	equal(harness.screen.cols, before, "and leaves the grid alone");
}

/* 10. following the tail, and a jump button when the user scrolls away */
{
	const harness = makeHarness();
	const lines = [];
	for (let i = 0; i < 40; i++) lines.push(`line ${i}`);
	harness.screen.write(lines.join("\r\n") + "\r\n");
	harness.view.paintNow();
	equal(harness.view.isFollowing(), true, "new output follows the tail by default");
	harness.view.viewport.scrollHeight = 2000;
	harness.view.viewport.clientHeight = 400;
	harness.view.viewport.scrollTop = 0;
	harness.view.viewport.dispatch("scroll");
	equal(harness.view.isFollowing(), false, "scrolling up stops the auto-follow");
	harness.view.scrollToBottom();
	equal(harness.view.isFollowing(), true, "the jump button resumes it");
}

/* 11. the key row sends terminal sequences without stealing focus */
{
	const harness = makeHarness();
	const root = harness.view.element;
	const buttons = [];
	const walk = (node) => {
		if (node.tagName === "BUTTON") buttons.push(node);
		for (const child of node.children) walk(child);
	};
	walk(root);
	const byLabel = (label) => buttons.find((button) => button.getAttribute("aria-label") === label);
	const esc = byLabel("termKeyEsc");
	const event = esc.dispatch("pointerdown");
	equal(event.defaultPrevented, true, "pressing a key does not move focus off the textarea");
	esc.dispatch("click");
	equal(harness.sent.join(""), "\u001b", "Esc sends the escape byte");
	harness.sent.length = 0;
	byLabel("termKeyUp").dispatch("click");
	equal(harness.sent.join(""), "\u001b[A", "the arrow key sends the cursor sequence");
	harness.sent.length = 0;
	const ctrl = byLabel("termKeyCtrl");
	ctrl.dispatch("click");
	equal(ctrl.getAttribute("aria-pressed"), "true", "the sticky Ctrl key lights up");
	byLabel("termKeyInterrupt").dispatch("click");
	equal(harness.sent.join(""), "\u0003", "the ^C key interrupts");
}

/* 12. the copy button reports an empty selection instead of copying nothing silently */
{
	const harness = makeHarness();
	const root = harness.view.element;
	const buttons = [];
	const walk = (node) => {
		if (node.tagName === "BUTTON") buttons.push(node);
		for (const child of node.children) walk(child);
	};
	walk(root);
	const copy = buttons.find((button) => button.getAttribute("aria-label") === "termCopy");
	document.selection = "";
	copy.dispatch("click");
	equal(harness.messages[0], "termCopyHint", "an empty selection explains what to do");
	document.selection = "picked text";
	copy.dispatch("click");
	ok(harness.messages.length >= 2, "a real selection takes the clipboard path");
}

/* 13. theme application writes the palette onto the root */
{
	const harness = makeHarness();
	harness.screen.setTheme("light");
	harness.view.applyTheme("light");
	const style = harness.view.element.style;
	equal(harness.view.element.getAttribute("data-dsv-theme"), "light", "the root records the theme name");
	equal(style["--dsv-bg"], "#ffffff", "light background is white");
	equal(style["--dsv-fg"], "#1f2329", "light foreground is dark");
	harness.screen.setTheme("dark");
	harness.view.applyTheme("dark");
	equal(harness.view.element.style["--dsv-bg"], "#14161a", "dark background is preserved");
	equal(style["--dsv-fg"], "#e8eaed", "dark foreground is preserved");
}

/* 14. an alternate screen swap repaints the same rows */
{
	const harness = makeHarness();
	harness.screen.write("shell\r\n");
	harness.view.paintNow();
	harness.screen.write("\u001b[?1049h\u001b[2J\u001b[Hpager");
	harness.view.paintNow();
	equal(textOf(harness.rows()[0]).trimEnd(), "pager", "the alternate screen content replaces the view");
	harness.screen.write("\u001b[?1049l");
	harness.view.paintNow();
	equal(textOf(harness.rows()[0]).trimEnd(), "shell", "and leaving it restores the shell view");
}

/* 15. tapping the screen asks for the keyboard and it lands */
{
	const win = fakeWindow();
	const harness = makeHarness({ window: win });
	harness.view.viewport.dispatch("pointerdown");
	same(document.activeElement, harness.view.textarea, "a tap on the screen focuses the input field");
	ok(harness.view.focusAttempts() >= 1, "and it took at least one attempt");
	ok(harness.logs.some((line) => line.includes("keyboard: attempt")), "the attempt is logged", JSON.stringify(harness.logs));
}

/* 16. focused but keyboard gone: a second tap must force a real transition */
{
	const win = fakeWindow();
	const harness = makeHarness({ window: win });
	const field = harness.view.textarea;
	harness.view.viewport.dispatch("pointerdown");
	win.setKeyboard(false);
	const blursBefore = field.blurCalls;
	harness.view.viewport.dispatch("pointerdown");
	ok(field.blurCalls > blursBefore, "an already-focused field is blurred so showSoftInput fires again", `  blurs: ${field.blurCalls}`);
	same(document.activeElement, field, "and it ends focused again");
}

/* 17. an unfocused field never gets the keyboard: retry, then say so */
{
	const win = fakeWindow();
	const harness = makeHarness({ window: win });
	harness.view.textarea.refuseFocus = true;
	harness.view.viewport.dispatch("pointerdown");
	await sleep(500);
	equal(harness.view.focusAttempts(), 4, "the retries are bounded");
	ok(harness.messages.includes("termKeyboardHint"), "and giving up is reported to the user", JSON.stringify(harness.messages));
	harness.view.textarea.refuseFocus = false;
	harness.view.viewport.dispatch("pointerdown");
	same(document.activeElement, harness.view.textarea, "a later tap can still succeed");
}

/* 18. the keyboard dismissed on its own is recovered inside the tap window */
{
	let clock = 1000;
	const win = fakeWindow();
	const harness = makeHarness({ window: win, now: () => clock });
	const field = harness.view.textarea;
	harness.view.viewport.dispatch("pointerdown");
	win.setKeyboard(false);
	const blursBefore = field.blurCalls;
	win.visualViewport.dispatch("resize");
	ok(field.blurCalls > blursBefore, "a keyboard that vanished right after a tap is re-requested");
	/* long after the tap, the user closing the keyboard on purpose wins */
	clock += 5000;
	const blursLater = field.blurCalls;
	win.visualViewport.dispatch("resize");
	equal(field.blurCalls, blursLater, "and a keyboard closed long after the tap is left alone");
}

/* 19. the key row ticks the haptic helper, once per press */
{
	const taps = [];
	const harness = makeHarness({ haptic: { tap: () => { taps.push(1); return true; } } });
	const buttons = [];
	const walk = (node) => {
		if (node.tagName === "BUTTON") buttons.push(node);
		for (const child of node.children) walk(child);
	};
	walk(harness.view.element);
	const esc = buttons.find((button) => button.getAttribute("aria-label") === "termKeyEsc");
	esc.dispatch("click");
	esc.dispatch("click");
	equal(taps.length, 2, "every key-row press asks for a tick");
}

/* 20. no haptic helper configured is still safe */
{
	const harness = makeHarness();
	const buttons = [];
	const walk = (node) => {
		if (node.tagName === "BUTTON") buttons.push(node);
		for (const child of node.children) walk(child);
	};
	walk(harness.view.element);
	buttons[0].dispatch("click");
	ok(true, "the key row works without a haptic helper");
}

/* 21. a cursor move with no new text still repaints the caret (the reported bug) */
{
	const harness = makeHarness();
	harness.screen.write("abcdef");
	harness.view.paintNow();
	equal(caretColumn(harness.rows()[0]), 6, "the caret starts at the end of the typed text");
	harness.screen.write("\u001b[3D");
	harness.view.paintNow();
	equal(harness.screen.cursor.x, 3, "the emulator cursor moved left");
	equal(caretColumn(harness.rows()[0]), 3, "and the painted caret moved with it (no text changed)");
	harness.screen.write("\u001b[2C");
	harness.view.paintNow();
	equal(caretColumn(harness.rows()[0]), 5, "and back to the right again");
	harness.screen.write("\u001b[?25l");
	harness.view.paintNow();
	equal(caretColumn(harness.rows()[0]), -1, "a program that hides the cursor (ESC[?25l) gets no caret");
	harness.screen.write("\u001b[?25h");
	harness.view.paintNow();
	equal(caretColumn(harness.rows()[0]), 5, "and showing it again brings the caret back");
}

/* 22. one view serves several tabs: setScreen swaps the whole screen */
{
	const harness = makeHarness();
	harness.screen.write("first tab");
	harness.view.paintNow();
	equal(textOf(harness.rows()[0]).trimEnd(), "first tab", "the first screen is painted");
	const nodesBefore = harness.rows()[0];
	const second = new core.Screen({ cols: 20, rows: 5, scrollback: 10 });
	second.write("second tab\r\nmore");
	harness.view.setScreen(second);
	equal(harness.view.screen(), second, "the view reports the new screen");
	equal(textOf(harness.rows()[0]).trimEnd(), "second tab", "and paints it");
	equal(textOf(harness.rows()[1]).trimEnd(), "more", "including every row it has");
	ok(harness.rows()[0] !== nodesBefore, "the first screen's row nodes were dropped, not reused");
	harness.view.setScreen(harness.screen);
	equal(textOf(harness.rows()[0]).trimEnd(), "first tab", "switching back restores the first screen");
}

console.log(`vt-view: ${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

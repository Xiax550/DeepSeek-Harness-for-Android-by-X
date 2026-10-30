/**
 * Input controller tests: the phone keyboard paths, simulated at event level.
 *
 * There is no browser in the sandbox, so the controller is driven through a
 * fake textarea that implements exactly the surface it uses, and fake events
 * that mirror what Android WebView + Gboard actually deliver:
 *
 *   ascii typing      keydown(keyCode 229) + beforeinput(insertText)
 *   pinyin            compositionstart -> compositionupdate -> compositionend
 *                     -> input(insertCompositionText echo)
 *   backspace         keydown(Backspace) OR beforeinput(deleteContentBackward)
 *   long-press delete beforeinput(deleteWordBackward)
 *   paste             beforeinput(insertFromPaste) + input(value)
 *   autocorrect       composition with an in-composition replacement
 *
 * Every assertion is "what bytes reached the PTY, in what order, how many
 * times" — the lost/duplicated key question, answered mechanically.
 *
 * Usage: node test/vt-input.test.mjs
 */
import { createVtInput } from "./vt-input-loader.mjs";

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

/* ------------------------------------------------------------------- harness */

/** Minimal textarea stand-in: value, selection, listeners and event dispatch. */
function fakeTextarea() {
	const listeners = new Map();
	let value = "";
	const element = {
		get value() {
			return value;
		},
		set value(next) {
			value = String(next);
			element.selectionStart = value.length;
			element.selectionEnd = value.length;
		},
		selectionStart: 0,
		selectionEnd: 0,
		focusCount: 0,
		setSelectionRange(start, end) {
			element.selectionStart = start;
			element.selectionEnd = end;
		},
		focus() {
			element.focusCount++;
		},
		addEventListener(type, handler) {
			if (!listeners.has(type)) listeners.set(type, []);
			listeners.get(type).push(handler);
		},
		removeEventListener(type, handler) {
			const list = listeners.get(type) ?? [];
			const index = list.indexOf(handler);
			if (index >= 0) list.splice(index, 1);
		},
		listenerCount() {
			let total = 0;
			for (const list of listeners.values()) total += list.length;
			return total;
		},
		/** Dispatch one event; `preventDefault` is recorded for assertions. */
		dispatch(event) {
			const payload = { defaultPrevented: false, ...event };
			payload.preventDefault = () => {
				payload.defaultPrevented = true;
			};
			for (const handler of listeners.get(payload.type) ?? []) handler(payload);
			return payload;
		}
	};
	return element;
}

function makeInput(overrides = {}) {
	const element = fakeTextarea();
	const output = [];
	const states = [];
	const input = createVtInput({
		element,
		onData: (data) => output.push(data),
		onState: (name, value) => states.push([name, value]),
		...overrides
	});
	input.attach();
	return {
		element,
		output,
		states,
		input,
		text: () => output.join(""),
		reset: () => {
			output.length = 0;
		}
	};
}

/** Gboard ASCII: keydown reports 229 for a printable key, then beforeinput. */
function typeAscii(harness, char) {
	harness.element.dispatch({
		type: "keydown",
		key: char,
		keyCode: 229,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		shiftKey: false,
		isComposing: false
	});
	harness.element.dispatch({
		type: "beforeinput",
		inputType: "insertText",
		data: char,
		isComposing: false
	});
}

/** Pinyin: composing text lives in the field, committed once at compositionend. */
function typeComposition(harness, updates, final) {
	harness.element.dispatch({
		type: "compositionstart",
		data: "",
		isComposing: true
	});
	for (const update of updates) {
		harness.element.value = update;
		harness.element.dispatch({
			type: "compositionupdate",
			data: update,
			isComposing: true
		});
		harness.element.dispatch({
			type: "beforeinput",
			inputType: "insertCompositionText",
			data: update,
			isComposing: true
		});
	}
	harness.element.value = final;
	harness.element.dispatch({
		type: "compositionend",
		data: final,
		isComposing: false
	});
	/* Chromium fires one more input event carrying the committed text. */
	harness.element.dispatch({
		type: "input",
		inputType: "insertCompositionText",
		data: final,
		isComposing: false
	});
}

/* --------------------------------------------------------------------- tests */

/* 1. plain typing: every keystroke sent once, field stays empty */
{
	const harness = makeInput();
	for (const char of "ls -la") typeAscii(harness, char);
	equal(harness.text(), "ls -la", "every typed character reaches the PTY exactly once");
	await tick();
	equal(harness.element.value, "", "the textarea is empty again after typing");
	equal(harness.element.selectionStart, 0, "and its caret sits at the start, not mid-text");
}

/* 2. no key is lost when the same character repeats */
{
	const harness = makeInput();
	typeAscii(harness, "a");
	typeAscii(harness, "a");
	await tick();
	typeAscii(harness, "a");
	equal(harness.text(), "aaa", "repeated characters are never de-duplicated");
}

/* 3. Chinese input via IME: one send per composition, not one per update */
{
	const harness = makeInput();
	typeComposition(harness, ["n", "ni", "nih", "niha", "nihao"], "你好");
	equal(harness.text(), "你好", "the committed Chinese text is sent once");
	await tick();
	equal(harness.element.value, "", "the field is cleared only after the composition ended");
}

/* 4. the composition must not be disturbed while it is running */
{
	const harness = makeInput();
	harness.element.dispatch({
		type: "compositionstart",
		data: "",
		isComposing: true
	});
	harness.element.value = "nihao";
	harness.element.dispatch({
		type: "compositionupdate",
		data: "nihao",
		isComposing: true
	});
	harness.element.dispatch({
		type: "beforeinput",
		inputType: "insertCompositionText",
		data: "nihao",
		isComposing: true
	});
	harness.element.dispatch({
		type: "input",
		inputType: "insertCompositionText",
		data: "nihao",
		isComposing: true
	});
	equal(harness.text(), "", "nothing is sent while the IME is composing");
	equal(harness.element.value, "nihao", "the composing text stays in the field for the IME");
	equal(harness.input.isComposing(), true, "the controller reports the composing state");
}

/* 5. autocorrect inside a composition is sent as the corrected word, once */
{
	const harness = makeInput();
	typeComposition(harness, ["teh", "the"], "the");
	equal(harness.text(), "the", "an in-composition autocorrect produces one send of the final text");
}

/* 6. two compositions in a row are both sent (no de-dup leak between them) */
{
	const harness = makeInput();
	typeComposition(harness, ["ni"], "你");
	await tick();
	typeComposition(harness, ["ni"], "你");
	equal(harness.text(), "你你", "typing the same Chinese word twice sends it twice");
}

/* 7. Enter is sent as CR and never inserted into the field */
{
	const harness = makeInput();
	typeAscii(harness, "e");
	typeAscii(harness, "c");
	typeAscii(harness, "h");
	typeAscii(harness, "o");
	const event = harness.element.dispatch({
		type: "keydown",
		key: "Enter",
		keyCode: 13,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		shiftKey: false,
		isComposing: false
	});
	equal(harness.text(), "echo\r", "Enter sends a carriage return");
	equal(event.defaultPrevented, true, "Enter's default (newline in the field) is prevented");
	equal(harness.element.value, "", "Enter leaves no text behind");
}

/* 8. Enter from an IME that reports it as a line break */
{
	const harness = makeInput();
	const event = harness.element.dispatch({
		type: "beforeinput",
		inputType: "insertLineBreak",
		data: null,
		isComposing: false
	});
	equal(harness.text(), "\r", "an IME line break also sends a carriage return");
	equal(event.defaultPrevented, true, "and is prevented");
}

/* 9. backspace through keydown and through beforeinput, never twice */
{
	const harness = makeInput();
	harness.element.dispatch({
		type: "keydown",
		key: "Backspace",
		keyCode: 8,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		shiftKey: false,
		isComposing: false
	});
	equal(harness.text(), "\u007f", "backspace sends DEL");
	harness.reset();
	harness.element.dispatch({
		type: "beforeinput",
		inputType: "deleteContentBackward",
		data: null,
		isComposing: false
	});
	equal(harness.text(), "\u007f", "a keyboard that only reports the deletion still sends one DEL");
}

/* 10. long-press backspace erases a word, the way Readline does */
{
	const harness = makeInput();
	harness.element.dispatch({
		type: "beforeinput",
		inputType: "deleteWordBackward",
		data: null,
		isComposing: false
	});
	equal(harness.text(), "\u0017", "deleteWordBackward sends Ctrl+W for Readline");
}

/* 11. arrows, tab and escape carry the standard sequences */
{
	const harness = makeInput();
	const press = (key) => harness.element.dispatch({
		type: "keydown",
		key,
		keyCode: 0,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		shiftKey: false,
		isComposing: false
	});
	press("ArrowUp");
	press("ArrowDown");
	press("ArrowLeft");
	press("ArrowRight");
	press("Tab");
	press("Escape");
	press("Home");
	press("End");
	press("Delete");
	equal(harness.text(), "\u001b[A\u001b[B\u001b[D\u001b[C\t\u001b\u001b[H\u001b[F\u001b[3~", "control keys map to their terminal sequences");
}

/* 12. application cursor mode changes the arrow encoding (vim, less) */
{
	const harness = makeInput({
		applicationCursor: () => true
	});
	harness.element.dispatch({
		type: "keydown",
		key: "ArrowUp",
		keyCode: 0,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		shiftKey: false,
		isComposing: false
	});
	equal(harness.text(), "\u001bOA", "DECCKM switches arrows to SS3 sequences");
}

/* 13. Ctrl+C interrupts, from a real Ctrl chord and from the key row */
{
	const harness = makeInput();
	const event = harness.element.dispatch({
		type: "keydown",
		key: "c",
		keyCode: 67,
		ctrlKey: true,
		altKey: false,
		metaKey: false,
		shiftKey: false,
		isComposing: false
	});
	equal(harness.text(), "\u0003", "Ctrl+C sends the interrupt byte");
	equal(event.defaultPrevented, true, "and does not leak into the field");
	harness.reset();
	harness.input.press("ctrl-c", true);
	equal(harness.text(), "\u0003", "the on-screen Ctrl+C key sends the same byte");
}

/* 14. the sticky Ctrl key turns the next letter into a control byte */
{
	const harness = makeInput();
	equal(harness.input.armCtrl(), true, "Ctrl can be armed");
	typeAscii(harness, "d");
	equal(harness.text(), "\u0004", "the armed Ctrl turns d into EOF");
	equal(harness.input.isCtrlArmed(), false, "and disarms itself");
	await tick();
	typeAscii(harness, "d");
	equal(harness.text(), "\u0004d", "the next plain d is a literal d again");
}

/* 15. paste is sent verbatim once, and bracketed when the program asked */
{
	const harness = makeInput();
	harness.element.value = "echo hi";
	harness.element.dispatch({
		type: "beforeinput",
		inputType: "insertFromPaste",
		data: null,
		isComposing: false
	});
	harness.element.dispatch({
		type: "input",
		inputType: "insertFromPaste",
		data: null,
		isComposing: false
	});
	equal(harness.text(), "echo hi", "pasted text is sent once");
	await tick();
	equal(harness.element.value, "", "and the field is cleared");
	const wrapped = makeInput({
		bracketedPaste: () => true
	});
	wrapped.input.pasteText("a\r\nb");
	equal(wrapped.text(), "\u001b[200~a\rb\u001b[201~", "bracketed paste wraps the payload and normalizes newlines");
}

/* 16. a keystroke that arrives while the terminal is not writable is dropped */
{
	const harness = makeInput({
		enabled: () => false
	});
	typeAscii(harness, "x");
	equal(harness.text(), "", "a read-only terminal swallows input");
}

/* 17. multi-character batches (Gboard swipe, clipboard) arrive in order, whole */
{
	const harness = makeInput();
	harness.element.dispatch({
		type: "beforeinput",
		inputType: "insertText",
		data: "sudo apt",
		isComposing: false
	});
	equal(harness.text(), "sudo apt", "a batch insertion is one intact send");
}

/* 18. detach removes every listener */
{
	const harness = makeInput();
	ok(harness.element.listenerCount() === 7, "attach registers all seven listeners", `  got ${harness.element.listenerCount()}`);
	harness.input.detach();
	equal(harness.element.listenerCount(), 0, "detach removes them all");
}

/* 19. Enter pressed while a composition is still open: text first, then the key */
{
	const harness = makeInput();
	harness.element.dispatch({ type: "compositionstart", data: "", isComposing: true });
	harness.element.value = "ls";
	harness.element.dispatch({ type: "compositionupdate", data: "ls", isComposing: true });
	const event = harness.element.dispatch({
		type: "keydown",
		key: "Enter",
		keyCode: 13,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		shiftKey: false,
		isComposing: false
	});
	equal(event.defaultPrevented, true, "the key is held back while the IME owns the field");
	equal(harness.text(), "ls", "the pending composition text goes out first");
	/* the IME then commits what it had, and the key follows */
	harness.element.dispatch({ type: "compositionend", data: "ls", isComposing: false });
	await tick();
	equal(harness.text(), "ls\r", "the composition is not repeated and Enter runs the command");
}

/* 20. a keyboard that never sends compositionend still gets its key out */
{
	const harness = makeInput();
	harness.element.dispatch({ type: "compositionstart", data: "", isComposing: true });
	harness.element.value = "pwd";
	harness.element.dispatch({
		type: "keydown",
		key: "Enter",
		keyCode: 13,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		shiftKey: false,
		isComposing: false
	});
	await sleep(90);
	equal(harness.text(), "pwd\r", "the deferred key is sent when the composition never ends");
}

/* 21. pasting the same text twice is two sends */
{
	const harness = makeInput();
	for (let i = 0; i < 2; i++) {
		harness.element.value = "aa";
		harness.element.dispatch({ type: "beforeinput", inputType: "insertFromPaste", data: null, isComposing: false });
		harness.element.dispatch({ type: "input", inputType: "insertFromPaste", data: null, isComposing: false });
	}
	equal(harness.text(), "aaaa", "an identical second paste is not mistaken for an echo");
}

/* 22. rapid identical ASCII typing is never de-duplicated */
{
	const harness = makeInput();
	for (let i = 0; i < 5; i++) typeAscii(harness, "x");
	equal(harness.text(), "xxxxx", "five fast identical keys produce five bytes");
}

/* 23. blur drops a half-typed composition instead of replaying it */
{
	const harness = makeInput();
	harness.element.dispatch({ type: "compositionstart", data: "", isComposing: true });
	harness.element.value = "ni";
	harness.element.dispatch({ type: "blur" });
	harness.element.dispatch({ type: "compositionend", data: "ni", isComposing: false });
	equal(harness.text(), "", "a composition abandoned by a blur is not sent");
	await tick();
	equal(harness.element.value, "", "and the field is clean for the next focus");
}

/** Let the clear-after-this-task timer run. */
function tick() {
	return new Promise((resolve) => setTimeout(resolve, 5));
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log(`vt-input: ${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

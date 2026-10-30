/**
 * Differential test: our VT core against @xterm/headless on real PTY bytes.
 *
 * Both emulators are fed the exact same byte stream from a real `bash` on a real
 * pty (`node-pty`), and the visible grid, the cursor and the bytes each one
 * answers a DSR/DA query with are compared. xterm is the reference the panel
 * used before the rework, so a diff here is exactly the regression the user
 * would have seen.
 *
 * Usage: node test/vt-core.test.mjs [--verbose]
 */
import { createRequire } from "node:module";
import { loadVtCore, DEFAULT_SOURCE } from "./vt-loader.mjs";

const require = createRequire(import.meta.url);
const DSH = process.env.DSH_INSTALL ?? "/opt/dsh";

const { Terminal: HeadlessTerminal } = require(`${DSH}/node_modules/@xterm/headless/lib-headless/xterm-headless.js`);
const pty = require(`${DSH}/node_modules/node-pty`);

const COLS = 80;
const ROWS = 24;
const VERBOSE = process.argv.includes("--verbose");

let failures = 0;
let checks = 0;

function fail(message, detail) {
	failures++;
	console.error(`FAIL  ${message}`);
	if (detail !== undefined) console.error(detail);
}

function pass(message) {
	checks++;
	if (VERBOSE) console.log(`ok    ${message}`);
	else console.log(`ok    ${message}`);
}

function equal(actual, expected, message) {
	checks++;
	if (actual !== expected) fail(message, `  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
	else if (VERBOSE) console.log(`ok    ${message}`);
}

/* ------------------------------------------------------------------ helpers */

/** xterm cell -> a stable color token so both sides can be compared. */
function xtermColor(value) {
	if (value === undefined || value === null) return "?";
	if (value === -1 || value === 0) return "default";
	if (value < 0) return `special:${value}`;
	if (value > 255) {
		const c = value & 0xffffff;
		return `rgb:#${c.toString(16).padStart(6, "0")}`;
	}
	return `idx:${value}`;
}

function oursColor(screen, value) {
	if (value === null || value === undefined) return "default";
	if (typeof value === "string") return `rgb:${value.toLowerCase()}`;
	return `idx:${value}`;
}

/** One row of xterm's visible buffer as an array of `{ch, fg, bg}` cells. */
function xtermRow(term, y) {
	const line = term.buffer.active.getLine(term.buffer.active.viewportY + y);
	const cells = [];
	if (line === undefined) return cells;
	for (let x = 0; x < term.cols; x++) {
		const cell = line.getCell(x);
		if (cell === undefined) {
			cells.push({
				ch: " ",
				fg: "default",
				bg: "default"
			});
			continue;
		}
		const chars = cell.getChars();
		cells.push({
			ch: chars === "" && cell.getWidth() === 0 ? "" : (chars === "" ? " " : chars),
			fg: xtermColor(cell.getFgColor()),
			bg: xtermColor(cell.getBgColor())
		});
	}
	return cells;
}

/** The same row from our screen. */
function ourRow(screen, y) {
	const row = screen.lines[screen.screenTop + y];
	const cells = [];
	for (let x = 0; x < screen.cols; x++) {
		const cell = row === undefined ? null : row.cells[x] || null;
		if (cell === null) {
			cells.push({
				ch: " ",
				fg: "default",
				bg: "default"
			});
			continue;
		}
		const ch = cell.w === 0 ? "" : (cell.ch === "" ? " " : cell.ch);
		cells.push({
			ch,
			fg: oursColor(screen, cell.fg),
			bg: oursColor(screen, cell.bg)
		});
	}
	return cells;
}

function rowText(cells) {
	let text = "";
	for (const cell of cells) text += cell.ch;
	return text.replace(/\s+$/u, "");
}

function rowAttrs(cells) {
	return cells.map((cell) => `${cell.fg}/${cell.bg}`).join(" ").replace(/(?:default\/default )+$/u, "").trim();
}

function compareGrid(label, term, screen) {
	let mismatches = 0;
	const detail = [];
	for (let y = 0; y < ROWS; y++) {
		const left = rowText(xtermRow(term, y));
		const right = rowText(ourRow(screen, y));
		if (left !== right) {
			mismatches++;
			if (detail.length < 4) detail.push(`  row ${y} text\n    xterm: ${JSON.stringify(left)}\n    ours : ${JSON.stringify(right)}`);
			continue;
		}
		const leftAttrs = rowAttrs(xtermRow(term, y));
		const rightAttrs = rowAttrs(ourRow(screen, y));
		if (leftAttrs !== rightAttrs) {
			mismatches++;
			if (detail.length < 4) detail.push(`  row ${y} attrs\n    xterm: ${leftAttrs}\n    ours : ${rightAttrs}`);
		}
	}
	const cursorOk = term.buffer.active.cursorX === screen.cursor.x && term.buffer.active.cursorY === screen.cursor.y;
	if (mismatches === 0 && cursorOk) {
		pass(`${label}: grid + cursor match xterm (${ROWS}x${COLS})`);
		return;
	}
	fail(`${label}: ${mismatches} row mismatch(es)${cursorOk ? "" : `, cursor xterm(${term.buffer.active.cursorX},${term.buffer.active.cursorY}) ours(${screen.cursor.x},${screen.cursor.y})`}`, detail.join("\n"));
}

/* --------------------------------------------------------- pty byte capture */

/** Run a scripted session in a real pty and return the bytes it produced. */
function capture(script, options = {}) {
	const cols = options.cols ?? COLS;
	const rows = options.rows ?? ROWS;
	return new Promise((resolve, reject) => {
		const proc = pty.spawn("/bin/bash", ["--noprofile", "--norc", "-i"], {
			name: "xterm-256color",
			cols,
			rows,
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
		const chunks = [];
		let settled = false;
		proc.onData((data) => chunks.push(Buffer.from(data, "utf8")));
		const steps = Array.isArray(script) ? script : [script];
		let index = 0;
		let timer = null;
		const next = () => {
			if (index >= steps.length) {
				timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					try {
						proc.kill();
					} catch {
						/* already gone */
					}
					resolve(Buffer.concat(chunks));
				}, 250);
				return;
			}
			const step = steps[index++];
			timer = setTimeout(() => {
				proc.write(step);
				next();
			}, step.delay ?? 260);
		};
		proc.onExit(() => {
			if (settled) return;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			resolve(Buffer.concat(chunks));
		});
		setTimeout(() => {
			if (settled) return;
			settled = true;
			try {
				proc.kill();
			} catch {
				/* already gone */
			}
			resolve(Buffer.concat(chunks));
		}, 12000);
		next();
	});
}

function makePair(cols = COLS, rows = ROWS) {
	const term = new HeadlessTerminal({
		cols,
		rows,
		scrollback: 0,
		allowProposedApi: true
	});
	const responses = [];
	term.onData((data) => responses.push(data));
	const core = loadVtCore(DEFAULT_SOURCE);
	const screen = new core.Screen({
		cols,
		rows,
		scrollback: 0
	});
	const ours = [];
	screen.onResponse = (data) => ours.push(data);
	return {
		term,
		screen,
		responses,
		ours
	};
}

async function feed(pair, bytes) {
	pair.screen.write(bytes);
	await new Promise((resolve) => pair.term.write(bytes, resolve));
}

function compareResponses(label, pair) {
	const left = pair.responses.join("");
	const right = pair.ours.join("");
	if (left === right) pass(`${label}: query replies match xterm (${JSON.stringify(left)})`);
	else if (left === "" && right === "") pass(`${label}: neither side replied`);
	else fail(`${label}: query replies differ`, `  xterm: ${JSON.stringify(left)}\n  ours : ${JSON.stringify(right)}`);
}

/* ---------------------------------------------------------------- unit tests */

function unitTests(core) {
	/* plain text, CR/LF and backspace */
	{
		const screen = new core.Screen({
			cols: 20,
			rows: 4
		});
		screen.write("hello\r\nworld");
		equal(rowText(ourRow(screen, 0)), "hello", "plain text row 0");
		equal(rowText(ourRow(screen, 1)), "world", "CRLF moves to a fresh line");
		screen.write("\b\bX");
		equal(rowText(ourRow(screen, 1)), "worXd", "backspace moves the cursor left without deleting");
		equal(screen.cursor.x, 4, "backspace only moved the cursor");
	}

	/* an LF alone keeps the column, like a real terminal */
	{
		const screen = new core.Screen({
			cols: 20,
			rows: 4
		});
		screen.write("ab\ncd");
		equal(rowText(ourRow(screen, 1)), "  cd", "bare LF keeps the column");
	}

	/* wide characters take two cells and never split across the edge */
	{
		const screen = new core.Screen({
			cols: 5,
			rows: 3
		});
		screen.write("abcd中");
		equal(rowText(ourRow(screen, 0)), "abcd", "wide char does not split at the last column");
		equal(rowText(ourRow(screen, 1)), "中", "wide char wraps to the next row");
		equal(screen.cursor.y, 1, "cursor followed the wrapped wide char");
		equal(screen.cursor.x, 2, "cursor is past the wide char");
	}

	/* combining marks stay in the cell of their base character */
	{
		const screen = new core.Screen({
			cols: 10,
			rows: 2
		});
		screen.write("e\u0301x");
		equal(ourRow(screen, 0)[0].ch, "e\u0301", "combining accent joins the base cell");
		equal(screen.cursor.x, 2, "combining mark costs no column");
	}

	/* UTF-8 split across two socket frames still decodes */
	{
		const screen = new core.Screen({
			cols: 10,
			rows: 2
		});
		const bytes = Buffer.from("中", "utf8");
		screen.write(new Uint8Array(bytes.subarray(0, 1)));
		equal(screen.cursor.x, 0, "half a character prints nothing yet");
		screen.write(new Uint8Array(bytes.subarray(1)));
		equal(ourRow(screen, 0)[0].ch, "中", "split UTF-8 character reassembles");
	}

	/* SGR keeps color and attributes per cell */
	{
		const screen = new core.Screen({
			cols: 20,
			rows: 2
		});
		screen.write("\u001b[1;31mR\u001b[0m\u001b[44mB\u001b[49m\u001b[38;2;1;2;3mT\u001b[39mD");
		const row = ourRow(screen, 0);
		equal(row[0].fg, "idx:1", "SGR 31 sets the foreground index");
		equal(row[1].bg, "idx:4", "SGR 44 sets the background index");
		equal(row[2].fg, "rgb:#010203", "SGR 38;2 sets a truecolor foreground");
		equal(row[3].fg, "default", "SGR 39 restores the default foreground");
		equal(row[1].ch, "B", "text after a reset keeps its glyph");
	}

	/* erase in line / display, cursor addressing, insert and delete */
	{
		const screen = new core.Screen({
			cols: 10,
			rows: 3
		});
		screen.write("abcdefghij\r\nklmno");
		screen.write("\u001b[1;4H"); // row 1, col 4
		screen.write("\u001b[2P"); // delete 2 chars
		equal(rowText(ourRow(screen, 0)), "abcfghij", "DCH deletes characters in place and pads the end");
		screen.write("\u001b[2@"); // insert 2 blanks at the same column
		equal(rowText(ourRow(screen, 0)), "abc  fghij", "ICH inserts blanks and shifts right");
		screen.write("\u001b[2;2H\u001b[1K");
		equal(rowText(ourRow(screen, 1)), "  mno", "EL 1 clears from the line start to the cursor");
		screen.write("\u001b[2J");
		equal(rowText(ourRow(screen, 0)), "", "ED 2 clears the screen");
		equal(screen.cursor.y, 1, "ED 2 leaves the cursor alone");
	}

	/* scroll region: line feed at the bottom of the region never leaves it */
	{
		const screen = new core.Screen({
			cols: 10,
			rows: 5
		});
		screen.write("\u001b[2;4r"); // region rows 2..4
		screen.write("\u001b[4;1H\u001b[1L"); // insert a line at the region bottom
		screen.write("\u001b[2;1Hinside\u001b[5;1Houtside");
		equal(rowText(ourRow(screen, 1)), "inside", "row 2 is inside the region");
		equal(rowText(ourRow(screen, 4)), "outside", "row 5 is outside the region");
		const before = rowText(ourRow(screen, 0));
		screen.write("\u001b[4;1H\n");
		equal(rowText(ourRow(screen, 0)), before, "line feed at the region bottom does not scroll the screen");
		equal(rowText(ourRow(screen, 3)), "", "the region scrolled internally");
	}

	/* alternate screen: `less`/`vim` must not eat the shell's scrollback */
	{
		const screen = new core.Screen({
			cols: 20,
			rows: 3
		});
		screen.write("shell line 1\r\nshell line 2\r\n");
		screen.write("\u001b[?1049h");
		screen.write("\u001b[2J\u001b[Hpager body");
		equal(rowText(ourRow(screen, 0)), "pager body", "alternate screen draws its own content");
		screen.write("\u001b[?1049l");
		equal(rowText(ourRow(screen, 0)), "shell line 1", "leaving the alternate screen restores the shell view");
		equal(rowText(ourRow(screen, 1)), "shell line 2", "including every line it held");
		equal(rowText(ourRow(screen, 2)), "", "and the cursor row it was on");
	}

	/* scrollback: lines that scroll off the top stay readable */
	{
		const screen = new core.Screen({
			cols: 10,
			rows: 2,
			scrollback: 10
		});
		screen.write("one\r\ntwo\r\nthree\r\n");
		equal(screen.lineCount, 4, "scrollback keeps the scrolled-off lines");
		equal(rowText(ourRow(screen, 0)), "three", "screen shows the newest completed line");
		equal(rowText(ourRow(screen, 1)), "", "and the fresh line the prompt sits on");
	}

	/* tabs and DEC graphics, the two things TUIs lean on */
	{
		const screen = new core.Screen({
			cols: 20,
			rows: 2
		});
		screen.write("a\tb");
		equal(ourRow(screen, 0)[8].ch, "b", "TAB advances to the next tab stop");
		const graphics = new core.Screen({
			cols: 10,
			rows: 2
		});
		graphics.write("\u001b(0lqk\u001b(B");
		equal(ourRow(graphics, 0)[0].ch, "\u250c", "DEC graphics maps l to a corner");
		equal(ourRow(graphics, 0)[1].ch, "\u2500", "DEC graphics maps q to a horizontal rule");
	}

	/* OSC: title, palette override and reset */
	{
		const screen = new core.Screen({
			cols: 10,
			rows: 2
		});
		let title = "";
		screen.onTitle = (value) => {
			title = value;
		};
		screen.write("\u001b]2;my title\u0007");
		equal(title, "my title", "OSC 2 reports the window title");
		screen.write("\u001b]4;1;#123456\u0007");
		equal(screen.colorOf(1, "#000"), "#123456", "OSC 4 overrides a palette slot");
		screen.write("\u001b]104;1\u0007");
		equal(screen.colorOf(1, "#000") !== "#123456", true, "OSC 104 restores the palette slot");
		screen.write("\u001b]11;#00ff00\u0007");
		equal(screen.defaultBg, "#00ff00", "OSC 11 overrides the default background");
		screen.write("\u001b]111\u0007");
		equal(screen.defaultBg, core.THEMES.dark.defaultBg, "OSC 111 restores the default background");
	}

	/* the light and dark ramps are real, legible palettes */
	{
		const screen = new core.Screen({
			cols: 4,
			rows: 2
		});
		screen.setTheme("light");
		equal(screen.defaultBg, "#ffffff", "light theme background is white");
		equal(screen.defaultFg, "#1f2329", "light theme foreground is dark");
		screen.setTheme("dark");
		equal(screen.defaultBg, "#14161a", "dark theme keeps the previous background");
	}

	/* resize anchors the cursor's line and row (the phone keyboard shrinks the grid) */
	{
		const screen = new core.Screen({
			cols: 20,
			rows: 5,
			scrollback: 10
		});
		screen.write("one\r\ntwo\r\nthree");
		screen.resize(20, 3);
		equal(screen.cursor.y, 2, "a shrink that still fits keeps the cursor row");
		equal(rowText(ourRow(screen, 2)), "three", "and the cursor's line");
		screen.resize(20, 8);
		equal(screen.cursor.y, 2, "growing keeps the cursor row where it was");
		equal(rowText(ourRow(screen, 2)), "three", "and its line stays put");
		equal(rowText(ourRow(screen, 3)), "", "with the new space blank below it");
		const bottom = new core.Screen({
			cols: 20,
			rows: 6,
			scrollback: 10
		});
		bottom.write("a\r\nb\r\nc\r\nd\r\ne\r\nf");
		bottom.resize(20, 2);
		equal(bottom.cursor.y, 1, "a bottom cursor lands on the bottom row of the shorter screen");
		equal(rowText(ourRow(bottom, 1)), "f", "and keeps the line it was on");
		const grown = new core.Screen({
			cols: 20,
			rows: 3,
			scrollback: 10
		});
		grown.write("one\r\ntwo\r\nthree\r\nfour\r\nfive");
		grown.resize(20, 6);
		equal(grown.cursor.y, 2, "growing past the old height keeps the cursor row");
		equal(rowText(ourRow(grown, 2)), "five", "and its line is still the one it was on");
	}

	/* resize keeps the newest lines and clamps the cursor */
	{
		const screen = new core.Screen({
			cols: 10,
			rows: 3,
			scrollback: 5
		});
		screen.write("1\r\n2\r\n3\r\n4\r\n");
		screen.resize(6, 2);
		equal(screen.cols, 6, "resize adopts the new width");
		equal(screen.rows, 2, "resize adopts the new height");
		equal(rowText(ourRow(screen, 0)), "4", "the newest line survives a shrink");
		equal(screen.cursor.x <= 5, true, "cursor is clamped into the new width");
	}
}

/* ------------------------------------------------------------ pty scenarios */

const scenarios = [
	{
		name: "prompt + colored ls",
		script: [
			"printf 'plain line\\n'\r",
			"ls --color=always -la /etc | head -12\r",
			"printf '\\033[1;32mbold green\\033[0m normal\\n'\r"
		]
	},
	{
		name: "CJK output and column wrapping",
		script: [
			"printf '中文测试行一\\n中文测试行二很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长\\n'\r",
			"printf 'emoji: 🐳🚀 done\\n'\r"
		]
	},
	{
		name: "Readline editing (backspace, arrows, mid-line insert)",
		script: [
			"echo hello world\r",
			"echo abc\u007f\u007f\u007fXYZ\r",
			"echo 12345\u001b[D\u001b[D\u001b[D-\r",
			"echo one two\u001b[1;9D\u001b[3~three\r"
		]
	},
	{
		name: "cursor addressing, erase and colors",
		script: [
			"printf '\\033[2J\\033[Htop left\\033[3;10Hmiddle\\033[5;1H\\033[41mred bg\\033[0m\\n'\r",
			"printf '\\033[10;1Hline ten\\033[12;1Hline twelve\\n'\r",
			"printf '\\033[2K\\033[3Kover\\n'\r"
		]
	},
	{
		name: "tabs, DEC graphics and save/restore cursor",
		script: [
			"printf 'a\\tb\\tc\\n'\r",
			"printf '\\0337saved\\0338\\033[2;1Hrestored\\n'\r",
			"printf '\\033(0lqqqk\\033(B\\n'\r"
		]
	},
	{
		name: "scroll region and internal scrolling",
		script: [
			"printf '\\033[2;6r'\r",
			"printf '\\033[6;1H\\033[L\\033[2;1Hone\\033[3;1Htwo\\n'\r",
			"printf '\\033[r'\r"
		]
	},
	{
		name: "alternate screen (less) and back",
		script: [
			"seq 1 40 > /tmp/vt-lines.txt\r",
			"LESS=-X less /tmp/vt-lines.txt\r",
			" q"
		]
	},
	{
		name: "DSR / DA query replies",
		script: [
			"printf '\\033[6n\\033[c\\033[>c'\r",
			"printf '\\033[3;7H\\033[6n'\r"
		]
	},
	{
		name: "256 color and truecolor",
		script: [
			"printf '\\033[38;5;208m256color\\033[0m \\033[48;5;17mbg 17\\033[0m\\n'\r",
			"printf '\\033[38;2;12;34;56mtruecolor\\033[0m\\n'\r"
		]
	},
	{
		name: "long wrapped output (yes | head)",
		script: [
			"yes 'wrapped line that is definitely longer than eighty columns wide padded out' | head -6\r",
			"seq 1 30 | tail -5\r"
		]
	}
];

async function differential() {
	for (const scenario of scenarios) {
		const bytes = await capture(scenario.script);
		if (bytes.length === 0) {
			fail(`${scenario.name}: pty produced no bytes`);
			continue;
		}
		const pair = makePair();
		await feed(pair, bytes);
		compareGrid(scenario.name, pair.term, pair.screen);
	}
	/* the same bytes in small chunks: a socket never delivers a whole frame */
	{
		const bytes = await capture([
			"printf '\\033[31mchunked\\033[0m 中文 output\\n'\r",
			"for i in 1 2 3; do echo \"line $i\"; done\r"
		]);
		const pair = makePair();
		for (let i = 0; i < bytes.length; i += 7) await feed(pair, bytes.subarray(i, i + 7));
		compareGrid("byte-at-a-time delivery", pair.term, pair.screen);
	}
	/* the query-reply bytes themselves */
	{
		const pair = makePair();
		await feed(pair, Buffer.from("\u001b[6n", "utf8"));
		compareResponses("DSR 6", pair);
	}
	{
		const pair = makePair();
		await feed(pair, Buffer.from("\u001b[3;9H\u001b[6n", "utf8"));
		compareResponses("DSR 6 after CUP", pair);
	}
	{
		const pair = makePair(40, 12);
		await feed(pair, Buffer.from("abc\u001b[6n", "utf8"));
		compareResponses("DSR 6 at column 4 (40x12)", pair);
	}
}

/* ---------------------------------------------------------------------- run */

console.log(`vt-core: source ${DEFAULT_SOURCE}`);
console.log(`vt-core: reference @xterm/headless from ${DSH}/node_modules`);
const core = loadVtCore(DEFAULT_SOURCE);
unitTests(core);
await differential();
console.log(`\nvt-core: ${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(ROOT, "app", "java", "com", "dha", "harness", "PageTools.java"), "utf8");
const playwrightModules = process.env.PLAYWRIGHT_NODE_MODULES;
const playwright = await import(playwrightModules
	? pathToFileURL(join(playwrightModules, "playwright", "index.mjs")).href
	: "playwright");
const { chromium } = playwright;

function fail(message) {
	throw new Error(message);
}

function check(condition, message) {
	if (!condition) fail(message);
}

/**
 * Read the concatenated Java string literals in SCRIPT_TAIL. The statement
 * contains comments and semicolons inside strings, so a plain substring would
 * produce invalid JavaScript.
 */
function readScriptTail(java) {
	const marker = "private static final String SCRIPT_TAIL =";
	const start = java.indexOf(marker);
	if (start < 0) fail("PageTools SCRIPT_TAIL declaration not found");
	const parts = [];
	let i = start + marker.length;
	while (i < java.length) {
		const ch = java[i];
		if (ch === ";") break;
		if (ch === "/" && java[i + 1] === "*") {
			const end = java.indexOf("*/", i + 2);
			if (end < 0) fail("unterminated block comment in SCRIPT_TAIL");
			i = end + 2;
			continue;
		}
		if (ch === "/" && java[i + 1] === "/") {
			const end = java.indexOf("\n", i + 2);
			i = end < 0 ? java.length : end + 1;
			continue;
		}
		if (ch !== '"') {
			i += 1;
			continue;
		}
		let end = i + 1;
		let escaped = false;
		while (end < java.length) {
			const current = java[end];
			if (!escaped && current === '"') break;
			escaped = !escaped && current === "\\";
			if (current !== "\\") escaped = false;
			end += 1;
		}
		if (end >= java.length) fail("unterminated string in SCRIPT_TAIL");
		parts.push(JSON.parse(java.slice(i, end + 1)));
		i = end + 1;
	}
	if (parts.length === 0) fail("PageTools SCRIPT_TAIL has no string literals");
	return parts.join("");
}

const script = `(function(){try{var C=${JSON.stringify({
	shortcuts: false,
	paste: false,
	hideConfig: true,
})}${readScriptTail(source)}`;

const browser = await chromium.launch({
	headless: true,
	executablePath: process.env.PLAYWRIGHT_BROWSER_PATH || undefined,
});
try {
	const page = await browser.newPage();
	await page.setContent(`<!doctype html>
		<html><head><base href="http://127.0.0.1:3098/"></head><body>
		<div data-chat-flow-kind="response" data-slot="conversation.chat.node">
			<p><a id="image" href="/root/generated/result.png">image result</a></p>
			<p><a id="video" href="https://cdn.example/generated/clip.mp4?token=test">video result</a></p>
			<p><a id="unsafe" href="javascript:alert(1).png">unsafe</a></p>
		</div>
		</body></html>`, { waitUntil: "domcontentloaded" });

	const cycles = await page.evaluate(`${script};
		var first={
			boxes: document.querySelectorAll('.lfy-media-preview').length,
			images: document.querySelectorAll('.lfy-media-preview img').length,
			videos: document.querySelectorAll('.lfy-media-preview video').length,
			imageSrc: document.querySelector('#image + .lfy-media-preview img')?.getAttribute('src') || '',
			videoSrc: document.querySelector('#video + .lfy-media-preview video')?.getAttribute('src') || '',
			videoControls: document.querySelector('#video + .lfy-media-preview video')?.controls === true,
			videoInline: document.querySelector('#video + .lfy-media-preview video')?.playsInline === true,
			unsafePreview: document.querySelector('#unsafe + .lfy-media-preview') !== null
		};
		window.__lfyPageTools.dispose();
		var afterDispose={
			boxes: document.querySelectorAll('.lfy-media-preview').length,
			style: document.querySelector('#lfy-media-preview-style') !== null,
			marked: document.querySelectorAll('[data-lfy-media]').length
		};
		${script};
		var second={
			boxes: document.querySelectorAll('.lfy-media-preview').length,
			images: document.querySelectorAll('.lfy-media-preview img').length,
			videos: document.querySelectorAll('.lfy-media-preview video').length
		};
		window.__lfyPageTools.dispose();
		({first,afterDispose,second});`);

	const { first, afterDispose, second } = cycles;
	if (afterDispose.boxes !== 0) {
		console.log(await page.evaluate("window.__lfyPageTools.dispose.toString()"));
	}
	check(first.boxes === 2, `expected 2 previews, got ${first.boxes}`);
	check(first.images === 1, `expected 1 image preview, got ${first.images}`);
	check(first.videos === 1, `expected 1 video preview, got ${first.videos}`);
	check(first.imageSrc === "http://127.0.0.1:3098/api/file?path=%2Froot%2Fgenerated%2Fresult.png",
		`unexpected image source: ${first.imageSrc}`);
	check(first.videoSrc.startsWith("https://cdn.example/generated/clip.mp4"), "video source was not preserved");
	check(first.videoControls, "video controls are missing");
	check(first.videoInline, "video is not configured for inline playback");
	check(!first.unsafePreview, "javascript destination produced a preview");
	check(afterDispose.boxes === 0, `dispose left media previews behind: ${JSON.stringify(afterDispose)}`);
	check(!afterDispose.style, "dispose left the media stylesheet behind");
	check(afterDispose.marked === 0, "dispose left media links marked as previewed");
	check(second.boxes === 2 && second.images === 1 && second.videos === 1,
		"re-injection did not recreate media previews");

	console.log("page-tools media: 12 checks, 0 failure(s)");
} finally {
	await browser.close();
}

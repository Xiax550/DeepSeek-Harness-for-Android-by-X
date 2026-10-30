/**
 * A fake document for the painter tests: just the DOM surface the terminal view
 * uses (elements, attributes, classes, listeners, a couple of layout numbers).
 * Shared by vt-view.test.mjs and vt-e2e.test.mjs so both drive the same thing.
 */

/* --------------------------------------------------------------- fake document */

const CELL = 8;

/** The document that owns the elements made by {@link createElement}. */
let currentDocument = null;

export function createElement(tag) {
	const el = {
		nodeType: 1,
		tagName: String(tag).toUpperCase(),
		children: [],
		parentNode: null,
		className: "",
		attributes: {},
		dataset: {},
		listeners: new Map(),
		textContent: "",
		style: {
			setProperty(name, value) {
				el.style[name] = value;
			},
			removeProperty(name) {
				delete el.style[name];
			}
		},
		clientWidth: 800,
		clientHeight: 400,
		scrollTop: 0,
		scrollHeight: 400,
		selectionStart: 0,
		selectionEnd: 0,
		appendChild(child) {
			if (child.parentNode !== null) child.parentNode.removeChild(child);
			child.parentNode = el;
			el.children.push(child);
			return child;
		},
		insertBefore(child, reference) {
			const index = el.children.indexOf(reference);
			if (child.parentNode !== null) child.parentNode.removeChild(child);
			child.parentNode = el;
			el.children.splice(index < 0 ? el.children.length : index, 0, child);
			return child;
		},
		removeChild(child) {
			const index = el.children.indexOf(child);
			if (index >= 0) el.children.splice(index, 1);
			child.parentNode = null;
			return child;
		},
		replaceChildren(...next) {
			for (const child of el.children) child.parentNode = null;
			el.children = [];
			for (const child of next) el.appendChild(child);
		},
		remove() {
			if (el.parentNode !== null) el.parentNode.removeChild(el);
		},
		setAttribute(name, value) {
			el.attributes[name] = String(value);
		},
		getAttribute(name) {
			return el.attributes[name] === undefined ? null : el.attributes[name];
		},
		hasAttribute(name) {
			return el.attributes[name] !== undefined;
		},
		addEventListener(type, handler) {
			if (!el.listeners.has(type)) el.listeners.set(type, []);
			el.listeners.get(type).push(handler);
		},
		removeEventListener(type, handler) {
			const list = el.listeners.get(type) ?? [];
			const index = list.indexOf(handler);
			if (index >= 0) list.splice(index, 1);
		},
		dispatch(type, payload = {}) {
			const event = { type, defaultPrevented: false, ...payload };
			event.preventDefault = () => {
				event.defaultPrevented = true;
			};
			for (const handler of el.listeners.get(type) ?? []) handler(event);
			return event;
		},
		focusCalls: 0,
		blurCalls: 0,
		refuseFocus: false,
		focus() {
			el.focusCalls++;
			/* A WebView that refuses focus: the retry path must cope. */
			if (el.refuseFocus || currentDocument === null) return;
			currentDocument.activeElement = el;
		},
		blur() {
			el.blurCalls++;
			if (currentDocument !== null && currentDocument.activeElement === el) currentDocument.activeElement = null;
		},
		setSelectionRange(start, end) {
			el.selectionStart = start;
			el.selectionEnd = end;
		},
		getBoundingClientRect() {
			/* The width probe asks for 40 monospace zeros. */
			return {
				width: el.textContent.length === 40 ? 40 * CELL : 0,
				height: 18
			};
		}
	};
	return el;
}

export function createFakeDocument() {
	const document = {
	activeElement: null,
	createElement,
	getSelection: () => ({ toString: () => document.selection ?? "" }),
	selection: ""
};


	currentDocument = document;
	return document;
}


/** All text under an element, in document order. */
function textOf(el) {
	if (el.children.length === 0) return el.textContent;
	let text = el.textContent;
	for (const child of el.children) text += textOf(child);
	return text;
}

function classesOf(el) {
	const found = [];
	const walk = (node) => {
		if (typeof node.className === "string" && node.className !== "") found.push(node.className);
		for (const child of node.children) walk(child);
	};
	walk(el);
	return found;
}

function findCaret(el) {
	return findClass(el, "dsv-caret") ?? findClass(el, "dsv-caret-off");
}

function findClass(el, className) {
	if (typeof el.className === "string" && el.className.split(/\s+/u).includes(className)) return el;
	for (const child of el.children) {
		const found = findClass(child, className);
		if (found !== null) return found;
	}
	return null;
}


export { textOf, classesOf, findCaret, findClass, CELL };
export { createElement as makeElement };

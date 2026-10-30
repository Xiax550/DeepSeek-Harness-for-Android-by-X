#!/usr/bin/env node
/**
 * android-pty — a shell endpoint for the Android app's Web UI.
 *
 * Why this exists at all: the harness already ships a terminal UI, but its
 * transport runs through the host's remote-stream plumbing, which needs a
 * fully bound agent/session before it will attach. This service is the blunt
 * instrument for the same job — it owns node-pty directly and speaks to the
 * browser over a plain WebSocket, so a terminal is available whenever the
 * sandbox is up, session or not.
 *
 * Runs INSIDE the PRoot guest, so shells it spawns are guest shells: /sdcard
 * and /root are the sandbox's views, and a command typed here sees exactly what
 * the agent's bash tool sees.
 *
 *   HTTP  GET  /health                 {ok, shell, version}
 *         GET  /recovery               the on-phone recovery console page
 *         GET  /assets/xterm.js        vendored @xterm/xterm UMD bundle
 *         GET  /assets/xterm.css
 *         GET  /sessions               [{id, shell, cwd, term, cols, rows}]
 *         POST /sessions               {cols, rows, shell?, cwd?, term?} -> {id}
 *         DELETE /sessions/<id>        terminate
 *   WS    /pty?id=<id>&token=<token>   binary = pty bytes, text = JSON control
 *         /pty?token=…&cols=&rows=&term=&reap=<seconds>
 *                                      no id = create one for this socket
 *
 * `/recovery` is what the app's WebView loads when the harness cannot start: a
 * line-mode shell that needs no harness, no session and no xterm. `term=dumb`
 * makes the shell skip screen repainting, which is what a line mode needs.
 *
 * Auth: every route requires the token from $DSH_PTY_TOKEN (query or
 * X-Dsh-Token header). The listener binds 127.0.0.1 only; the token is there so
 * another app on the phone cannot reach in and get a shell in the sandbox.
 */
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DSH_PTY_PORT ?? 3099);
const TOKEN = process.env.DSH_PTY_TOKEN ?? "";
const DEFAULT_SHELL = process.env.DSH_PTY_SHELL ?? "/bin/bash";
// Interactive, not login: a login shell re-runs the group lookups for the
// Android-supplied numeric groups the guest has no names for, which prints a
// wall of "groups: cannot find name for group ID" before the first prompt.
const DEFAULT_ARGS = ["-i"];
const MAX_SESSIONS = Number(process.env.DSH_PTY_MAX ?? 8);
// How long a shell nobody is attached to may keep running. Sessions the client
// asked for by id (POST /sessions) are never reaped — those belong to a tab.
// Implicitly created ones are: every WebView reload used to leave a /bin/bash
// behind, and after MAX_SESSIONS of them POST /sessions answered 429 forever.
const REAP_MS = Number(process.env.DSH_PTY_REAP_MS ?? 90000);

let pty;
try {
  pty = (await import("node-pty")).default ?? (await import("node-pty"));
} catch (error) {
  console.error("android-pty: node-pty unavailable:", error?.message ?? error);
  process.exit(1);
}

/** @type {Map<string, {id: string, proc: any, sockets: Set<any>, title: string}>} */
const sessions = new Map();

function authorized(request) {
  if (TOKEN.length === 0) return false;
  const header = request.headers["x-dsh-token"];
  if (typeof header === "string" && header === TOKEN) return true;
  try {
    return new URL(request.url, "http://127.0.0.1").searchParams.get("token") === TOKEN;
  } catch {
    return false;
  }
}

function json(response, code, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "x-dsh-token, content-type"
  });
  response.end(body);
}

/** A terminal name from a query string: a name, never a control character. */
function terminalName(value) {
  const name = String(value ?? "").trim();
  return /^[A-Za-z0-9._+-]{1,32}$/.test(name) ? name : "xterm-256color";
}

function disarmReap(session) {
  if (session.reap !== null) {
    clearTimeout(session.reap);
    session.reap = null;
  }
}

function armReap(session) {
  if (!session.ephemeral || session.reapMs <= 0 || session.reap !== null) return;
  if (session.sockets.size > 0) return;
  session.reap = setTimeout(() => {
    session.reap = null;
    if (session.sockets.size > 0) return;
    try {
      session.proc.kill();
    } catch {
      /* already gone */
    }
  }, session.reapMs);
  // A pending reap must never be the reason the process stays awake.
  if (typeof session.reap.unref === "function") session.reap.unref();
}

function createSession(options = {}) {
  const shell = options.shell ?? DEFAULT_SHELL;
  const term = terminalName(options.term);
  const cols = Math.max(20, Math.min(400, Number(options.cols) || 80));
  const rows = Math.max(5, Math.min(200, Number(options.rows) || 24));
  const cwd = options.cwd ?? process.env.HOME ?? "/root";
  const requested = Number(options.reapMs);
  const reapMs = Number.isFinite(requested) && requested >= 0 ? requested : REAP_MS;
  const proc = pty.spawn(shell, DEFAULT_ARGS, {
    name: term,
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      TERM: term,
      // COLORTERM is a promise the renderer has to keep, so only make it when
      // there is a real emulator on the other end.
      ...(term === "dumb" ? {} : { COLORTERM: "truecolor" }),
      LANG: process.env.LANG ?? "C.UTF-8",
      HOME: process.env.HOME ?? "/root",
      SHELL: shell
    }
  });
  const id = randomUUID();
  const session = {
    id, proc, sockets: new Set(), cols, rows, shell, cwd, term,
    ephemeral: options.ephemeral === true,
    reapMs: Math.max(0, reapMs),
    reap: null
  };
  sessions.set(id, session);
  proc.onData((data) => {
    // Output goes out as a binary frame of raw bytes. Wrapping every chunk in a
    // JSON string costs a parse per chunk on the client and an escape pass here,
    // which is exactly the hot path when a command prints a lot.
    const payload = Buffer.from(data, "utf8");
    for (const socket of session.sockets) sendFrame(socket, 0x2, payload);
  });
  proc.onExit(({ exitCode }) => {
    disarmReap(session);
    for (const socket of session.sockets) {
      try {
        sendControl(socket, { type: "exit", code: exitCode });
      } catch {
        /* socket already gone */
      }
      socket.end();
    }
    session.sockets.clear();
    sessions.delete(id);
  });
  console.log(`android-pty: session ${id} ${shell} ${cols}x${rows} term=${term} cwd=${cwd}`);
  return session;
}

// ---------------------------------------------------------------- websocket

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function sendFrame(socket, opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  socket.write(Buffer.concat([header, payload]));
}

const sendText = (socket, text) => sendFrame(socket, 0x1, Buffer.from(text, "utf8"));
const sendControl = (socket, object) => sendText(socket, JSON.stringify(object));

function attach(serverSocket, session) {
  disarmReap(session);
  session.sockets.add(serverSocket);
  let buffer = Buffer.alloc(0);
  serverSocket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (buffer.length < offset + maskLength + length) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
      buffer = buffer.subarray(offset + maskLength + length);
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }

      if (opcode === 0x8) {
        serverSocket.end();
        return;
      }
      if (opcode === 0x9) {
        sendFrame(serverSocket, 0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1) {
        let message;
        try {
          message = JSON.parse(payload.toString("utf8"));
        } catch {
          continue;
        }
        if (message.type === "input" && typeof message.data === "string") {
          session.proc.write(message.data);
        } else if (message.type === "resize") {
          const cols = Math.max(20, Math.min(400, Number(message.cols) || session.cols));
          const rows = Math.max(5, Math.min(200, Number(message.rows) || session.rows));
          session.cols = cols;
          session.rows = rows;
          try {
            session.proc.resize(cols, rows);
          } catch {
            /* pty already closed */
          }
        }
        continue;
      }
      if (opcode === 0x2) {
        session.proc.write(payload.toString("utf8"));
      }
    }
  });
  serverSocket.on("close", () => {
    session.sockets.delete(serverSocket);
    armReap(session);
  });
  serverSocket.on("error", () => {
    session.sockets.delete(serverSocket);
    armReap(session);
  });
  sendControl(serverSocket, { type: "ready", id: session.id, shell: session.shell, cwd: session.cwd });
}

// ---------------------------------------------------------------------- http

function asset(name, type) {
  // pty-server.mjs lives at <dsh-install>/android/, so node_modules is one level
  // up; the assets/ dir is for a custom build that wants to ship its own copy.
  const candidates = [
    join(HERE, "assets", name),
    join(HERE, "..", "node_modules", "@xterm", "xterm", "lib", name),
    join(HERE, "..", "node_modules", "@xterm", "xterm", "css", name),
    join(HERE, "..", "node_modules", "@xterm", "addon-fit", "lib", name),
    join(HERE, "..", "node_modules", "@xterm", "addon-canvas", "lib", name)
  ];
  for (const path of candidates) {
    if (existsSync(path)) return { body: readFileSync(path), type };
  }
  return null;
}

const server = createServer((request, response) => {
  try {
    routeHttp(request, response);
  } catch (error) {
    // A malformed request line used to throw inside the request listener and
    // take the whole service down with it. In recovery mode this service is the
    // only way into the sandbox, so it has to survive anything a client sends.
    console.error("android-pty: request failed:", error?.message ?? error);
    try {
      json(response, 400, { error: "bad request" });
    } catch {
      /* the response is already gone */
    }
  }
});

function routeHttp(request, response) {
  const url = new URL(request.url, "http://127.0.0.1");
  const path = url.pathname;

  if (path === "/health") {
    json(response, 200, { ok: true, shell: DEFAULT_SHELL, sessions: sessions.size });
    return;
  }
  const assetRoute = /^\/assets\/([a-z0-9.\-]+\.(?:js|css))$/.exec(path);
  if (assetRoute !== null) {
    const name = assetRoute[1];
    const file = asset(name, name.endsWith(".css")
      ? "text/css; charset=utf-8"
      : "text/javascript; charset=utf-8");
    if (file === null) {
      json(response, 404, { error: "xterm assets not installed" });
      return;
    }
    response.writeHead(200, {
      "content-type": file.type,
      "content-length": file.body.length,
      "access-control-allow-origin": "*",
      "cache-control": "no-cache"
    });
    response.end(file.body);
    return;
  }

  if (!authorized(request)) {
    json(response, 401, { error: "unauthorized" });
    return;
  }

  if (path === "/recovery" || path === "/recovery/") {
    // The on-phone way in when the harness is down. Served only to a caller that
    // already holds the token, which is the same secret the page then uses for
    // its WebSocket — no second credential, no unauthenticated page on the
    // phone that any other app could read.
    const page = join(HERE, "recovery-console.html");
    if (!existsSync(page)) {
      json(response, 404, { error: "recovery console not installed" });
      return;
    }
    const body = readFileSync(page);
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": body.length,
      "cache-control": "no-store"
    });
    response.end(body);
    return;
  }
  if (path === "/sessions" && request.method === "GET") {
    json(response, 200, {
      sessions: [...sessions.values()].map((session) => ({
        id: session.id,
        shell: session.shell,
        cwd: session.cwd,
        term: session.term,
        ephemeral: session.ephemeral,
        cols: session.cols,
        rows: session.rows
      }))
    });
    return;
  }
  if (path === "/sessions" && request.method === "POST") {
    if (sessions.size >= MAX_SESSIONS) {
      json(response, 429, { error: "too many sessions" });
      return;
    }
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) request.destroy();
    });
    request.on("end", () => {
      let options = {};
      try {
        options = body.length > 0 ? JSON.parse(body) : {};
      } catch {
        options = {};
      }
      try {
        const session = createSession(options);
        json(response, 201, { id: session.id, shell: session.shell, cwd: session.cwd });
      } catch (error) {
        json(response, 500, { error: String(error?.message ?? error) });
      }
    });
    return;
  }
  if (path.startsWith("/sessions/") && request.method === "DELETE") {
    const id = path.slice("/sessions/".length);
    const session = sessions.get(id);
    if (session === undefined) {
      json(response, 404, { error: "no such session" });
      return;
    }
    disarmReap(session);
    session.proc.kill();
    json(response, 200, { ok: true });
    return;
  }
  json(response, 404, { error: "not found" });
}

server.on("upgrade", (request, socket) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const key = request.headers["sec-websocket-key"];
  if (url.pathname !== "/pty" || typeof key !== "string" || !authorized(request)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  const reapParam = url.searchParams.get("reap");
  const session = url.searchParams.has("id")
    ? sessions.get(url.searchParams.get("id"))
    : createSession({
      cols: Number(url.searchParams.get("cols") ?? 80),
      rows: Number(url.searchParams.get("rows") ?? 24),
      term: url.searchParams.get("term"),
      // Created for this socket, so it should die with it: a stray shell per
      // WebView reload is how the session table used to fill up.
      ephemeral: true,
      reapMs: reapParam === null ? undefined : Number(reapParam) * 1000
    });
  if (session === undefined) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  attach(socket, session);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`android-pty: listening on 127.0.0.1:${PORT} shell=${DEFAULT_SHELL} token=${TOKEN ? "set" : "MISSING"}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const session of sessions.values()) {
      try {
        session.proc.kill();
      } catch {
        /* already gone */
      }
    }
    process.exit(0);
  });
}

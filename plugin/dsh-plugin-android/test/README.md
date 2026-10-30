# dsh-plugin-android tests

The terminal is hand-written inside `../lib/client.js` between marker blocks
(`@vt-haptic`, `@vt-core`, `@vt-input`, `@vt-view`, `@vt-store`). These suites
read those blocks out of the shipped bundle, so they test the file that runs:

```
node vt-core.test.mjs     # emulator: unit cases + differential vs @xterm/headless on real pty bytes
node vt-input.test.mjs    # phone keyboard paths at event level (IME, backspace, arrows, paste)
node vt-view.test.mjs     # DOM painter, caret, soft-keyboard recovery, tab screen swap
node vt-store.test.mjs    # tab roster: reuse on remount, cap, close, notifications
node vt-haptic.test.mjs   # bridge-first tap feedback, debounce, fallbacks
node vt-e2e.test.mjs      # key event -> PTY -> bash echo -> emulator -> painted caret, end to end
node vt-plugin.test.mjs   # the whole bundle: factory, apply(), slots, locale, terminal store
```

`vt-core.test.mjs` and `vt-e2e.test.mjs` spawn a real `bash` through `node-pty`
and compare against `@xterm/headless` from the harness installation
(`/opt/dsh/node_modules`; `DSH_INSTALL` overrides it). The other five have no
dependencies and run anywhere Node does.

The host half has its own suite, which imports `../lib/index.js` and drives it
with a fake Cordis context — no harness, no app:

```
node ball-surface.test.mjs  # the ball's session: prompt section, withheld GUI tools, pinned permission
node ball-inbox.test.mjs    # the ball's queue: identity, and recovery from a session the user deleted
```


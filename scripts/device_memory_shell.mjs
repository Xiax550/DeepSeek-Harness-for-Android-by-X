import { readFileSync } from 'node:fs';

const command = process.argv[2] === '--file'
  ? `node <<'DHA_MEMORY_SCRIPT_END'\n${readFileSync(process.argv[3], 'utf8')}\nDHA_MEMORY_SCRIPT_END\n`
  : process.argv[2];
if (!command || !process.env.DHA_TEST_PTY_TOKEN) throw new Error('Command and DHA_TEST_PTY_TOKEN required');
const marker = `DHA_COMMAND_FINISHED_${Date.now()}`;
const socket = new WebSocket(`ws://127.0.0.1:13099/pty?term=dumb&reap=5&token=${encodeURIComponent(process.env.DHA_TEST_PTY_TOKEN)}`);
const timer = setTimeout(() => { socket.close(); process.exitCode = 1; }, 120000);
let output = '';
let finished = false;
socket.onopen = () => socket.send(Buffer.from(`stty -echo\n${command}\nprintf '\\n${marker}:%s\\n' "$?"\n`));
socket.onmessage = async ({ data }) => {
  if (finished) return;
  const text = typeof data === 'string' ? data : Buffer.from(await data.arrayBuffer()).toString();
  if (finished) return;
  output += text;
  const match = output.match(new RegExp(`\\r?\\n${marker}:(\\d+)\\r?\\n`));
  if (match) {
    finished = true;
    process.stdout.write(output.slice(0, match.index));
    process.exitCode = Number(match[1]);
    clearTimeout(timer);
    socket.close();
  }
};
socket.onerror = () => { clearTimeout(timer); if (!finished) process.exitCode = 1; };

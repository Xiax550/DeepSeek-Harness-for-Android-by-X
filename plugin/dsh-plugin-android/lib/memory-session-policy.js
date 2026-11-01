export function isAutomationSession(snapshot) {
  const messages = (snapshot?.events || []).filter(e => e.type === 'user/message');
  const manual = messages.filter(e => e.data?.source?.kind === 'user');
  // Older Bili duty releases used a CLI prompt, without a dedicated source kind.
  const legacyBili = snapshot?.meta?.cwd === '/root/.dsh/bili-duty' && manual.length === 1
    && manual[0] === messages[0]
    && manual[0].data.content?.[0]?.type === 'text'
    && manual[0].data.content[0].text?.startsWith('你是这个账号的 B站 助手。');
  const known = new Set(['schedule', 'runtime-context', 'skill-catalog', ...(legacyBili ? ['user'] : [])]);
  if (messages.some(e => !known.has(e.data?.source?.kind))) return false;
  return legacyBili || !manual.length && messages.some(e => e.data?.source?.kind === 'schedule');
}

export const matchesForgetScope = (config, snapshot) => config.forgetScope === 'all' || isAutomationSession(snapshot);

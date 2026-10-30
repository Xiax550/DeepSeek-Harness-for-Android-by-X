import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');
const source = read('plugin/dsh-plugin-android/lib/client.js');
const localesStart = source.indexOf('const zh = {');
const localesEnd = source.indexOf('\n\t\t/* ===', localesStart);
const sectionStart = source.indexOf('function AndroidSection(props) {');
const sectionEnd = source.indexOf('/* ==== @vt-haptic:begin', sectionStart);
assert.ok(localesStart >= 0 && localesEnd > localesStart);
assert.ok(sectionStart >= 0 && sectionEnd > sectionStart);
const program = `${source.slice(localesStart, localesEnd)}
${source.slice(sectionStart, sectionEnd)}
({ zh, en, render: AndroidSection })`;

function harness(snapshot) {
  let stateIndex = 0;
  const h = (type, props, ...children) => ({ type, props: { ...props, children } });
  return vm.runInNewContext(program, {
    h,
    react: {
      useState: () => [stateIndex++ === 0 ? snapshot : null, () => {}],
      useEffect: () => {},
      Children: { toArray: (children) => children.flat().filter((item) => item != null) },
      cloneElement: (node, props, ...children) => h(node.type, { ...node.props, ...props }, ...children),
    },
    usePolling: () => 0,
    bridge: () => ({}),
    call: async () => ({}),
    Group: 'Group', StatusCard: 'StatusCard', Button: 'Button',
    UpdateCard: 'UpdateCard', ExportCard: 'ExportCard', MountsCard: 'MountsCard',
    ShizukuCard: 'ShizukuCard', PhoneCard: 'PhoneCard', SettingsCard: 'SettingsCard',
    BallCard: 'BallCard',
  });
}

function findAuthors(node) {
  if (Array.isArray(node)) return node.flatMap(findAuthors);
  if (node == null || typeof node !== 'object') return [];
  return [
    ...(node.props?.['data-dha-author'] ? [node] : []),
    ...findAuthors(node.props?.children),
  ];
}

for (const locale of ['zh', 'en']) {
  for (const part of ['version', 'all', 'sandbox', 'ball']) {
    const app = harness({ appVersion: '1.2.50', terminalVersion: '3', distros: [] });
    const view = app.render({ part, t: (key) => app[locale][key] ?? key });
    const authors = findAuthors(view);
    assert.equal(authors.length, part === 'version' || part === 'all' ? 1 : 0, `${locale}/${part}`);
    if (authors.length) assert.ok(authors[0].props.children.join('').includes('夏侯玲文'));
  }
}
for (const path of ['README.md', 'README.zh-CN.md', 'AUTHORS.md', 'NOTICE.md', 'LICENSE']) {
  assert.ok(read(path).includes('夏侯玲文'), path);
}
assert.ok(read('LICENSE').includes('Copyright (c) 2026 itiswdwa'));
assert.ok(read('LICENSE').includes('LanFeiYu'));
for (const path of ['scripts/build_apk.sh', 'scripts/build_apk.ps1']) {
  assert.ok(read(path).includes('AUTHORS.md'), `${path} packages author attribution`);
}
console.log('Author attribution: locale rendering, section selection, source notices and both APK packers passed.');

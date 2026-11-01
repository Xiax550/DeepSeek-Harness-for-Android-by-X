import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const native = readFileSync(new URL('../../../app/java/com/dha/harness/BallService.java', import.meta.url), 'utf8');
assert.match(native, /DEFAULT_SIZE_DP = 54;/);
assert.match(native, /MIN_SIZE_DP = 54;/);
assert.match(native, /return Math\.max\(MIN_SIZE_DP, Math\.min\(value, MAX_SIZE_DP\)\);/);

function render(name, next, states, props = {}) {
  const calls = [];
  const context = {
    react: { useState: initial => [states.length ? states.shift() : initial, () => {}],
      useEffect() {}, useRef: current => ({ current }) },
    h: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    bridge: () => null, call: async (path, body) => { calls.push({ path, body }); return {}; },
    window: { setTimeout() {} }, setTimeout() {}, clearTimeout() {},
    BALL_PRESETS: [],
    Button: 'Button', Card: 'Card', Group: 'Group', Tag: 'Tag',
    BallMark: 'BallMark', ToggleRow: 'ToggleRow', ChoiceRow: 'ChoiceRow', Select: 'Select'
  };
  const begin = source.indexOf('function ' + name + '(');
  const end = source.indexOf(next, begin);
  assert.ok(begin >= 0 && end > begin);
  vm.createContext(context);
  const component = vm.runInContext('(' + source.slice(begin, end).trim() + ')', context);
  const tree = component({ t: key => key, call: context.call, reload: async () => {}, ...props });
  const nodes = [];
  const visit = item => {
    if (!item || typeof item !== 'object') return;
    nodes.push(item); item.children?.forEach(visit);
  };
  visit(tree);
  return { nodes, calls };
}

for (const size of [undefined, 40, 48, 54, 67, 120]) {
  const expected = Math.max(54, size || 54);
  const card = render('BallCard', '/**\n', [], { ball: { size } });
  const choices = card.nodes.filter(node => node.children.some(value => /^\d+dp$/.test(value)));
  assert.ok(choices.length >= 4);
  assert.ok(choices.every(node => Number(node.children.at(-1).replace('dp', '')) >= 54));
  assert.equal(choices.find(node => node.props.variant === 'primary').children.at(-1), expected + 'dp');
  await choices.find(node => node.children.at(-1) === '54dp').props.onClick();
  assert.equal(card.calls[0].path, '/ball/config'); assert.equal(card.calls[0].body.size, 54);

  const phone = render('PhoneCard', '/* ==== @ball-inbox:begin', [{}, String(size ?? '')]);
  const range = phone.nodes.find(node => node.type === 'input' && node.props.type === 'range');
  assert.equal(range.props.min, 54); assert.equal(range.props.value, expected);
  range.props.onPointerUp({ target: { value: '48' } });
  assert.equal(phone.calls[0].body.size, 54);
  const chips = phone.nodes.filter(node => node.props.className === 'dsa-ballChip');
  assert.ok(chips.every(node => Number(node.props.key) >= 54));
}
console.log('PASS both settings surfaces: default/minimum 54dp, legacy 40/48 clamp, custom sizes preserved, config writes 54dp');

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const directory = path.resolve(process.argv[2] || '');
const left = Number(process.env.DHA_CROP_X || 0);
const top = Number(process.env.DHA_CROP_Y || 1220);
const size = 300;
const evidenceFile = path.join(directory, 'evidence.json');
const evidence = fs.existsSync(evidenceFile) ? JSON.parse(fs.readFileSync(evidenceFile, 'utf8')) : null;
const states = new Map((evidence?.frames || []).map(frame => [frame.name, frame]));
const density = Number(process.env.DHA_SCREEN_SCALE || 3);

(async () => {
  for (const [name, candidates] of [
    ['size-native-grid', ['standing-new-reference.png', 'wake-06500.png', 'wake-06800.png',
      'gesture-stretch.png', 'wake-07300.png', 'wake-11800.png']],
    ['whole-body-native-grid', ['standing-new-reference.png', 'sitting-1100.png', 'sitting-1900.png',
      'lying-1200.png', 'lying-2800.png', 'sleeping.png', 'wake-07300.png', 'gesture-stretch.png', 'wake-14800.png']],
    ['interrupted-native-grid', ['interrupted-partial-lie-before.png', 'interrupted-partial-lie-recover.png',
      'interrupted-partial-lie-standing.png', 'interrupted-wake-before.png', 'interrupted-wake-after.png',
      'interrupted-stretch-return.png']],
    ['natural-idle-native-grid', ['real-idle-410000.png', 'real-idle-420600.png', 'real-idle-421200.png',
      'real-idle-422600.png', 'real-idle-600600.png', 'real-idle-604000.png', 'real-idle-608800.png',
      'real-idle-610200.png', 'real-idle-614000.png']],
    ['prone-native-grid', [599, 607, 608, 609, 610, 611, 612, 613, 616].map(t => 'idle-' + String(t).padStart(3, '0') + '.png')],
    ['wake-native-grid', fs.readdirSync(directory).filter(file => /^wake-\d+\.png$/.test(file)).sort()],
    ['stretch-native-grid', ['standing-new-reference.png', 'gesture-stretch.png', 'wake-10300.png', 'wake-11800.png', 'wake-14800.png', 'wake-no-stretch.png']]
  ]) {
    const files = candidates.filter(file => fs.existsSync(path.join(directory, file)));
    if (!files.length) continue;
    const columns = 3, overlays = [];
    for (let index = 0; index < files.length; index++) {
      const state = states.get(path.parse(files[index]).name);
      const rect = state?.rect?.match(/^([\d.-]+),([\d.-]+) /);
      const source = sharp(path.join(directory, files[index]));
      const dimensions = await source.metadata();
      const cropLeft = rect && !process.env.DHA_CROP_X ? Math.max(0, Math.round(Number(rect[1]) * density) - 32) : left;
      const cropTop = rect && !process.env.DHA_CROP_Y ? Math.max(0, Math.round(Number(rect[2]) * density) - 32) : top;
      const buffer = await source.extract({ left: Math.min(cropLeft, dimensions.width - size),
        top: Math.min(cropTop, dimensions.height - size), width: size, height: size }).png().toBuffer();
      overlays.push({ input: buffer, left: index % columns * size, top: Math.floor(index / columns) * (size + 24) });
      const label = Buffer.from('<svg width="300" height="24"><rect width="300" height="24" fill="white"/>'
        + '<text x="150" y="17" text-anchor="middle" font-family="Arial" font-size="14">' + files[index] + '</text></svg>');
      overlays.push({ input: label, left: index % columns * size, top: Math.floor(index / columns) * (size + 24) + size });
    }
    await sharp({ create: { width: size * columns, height: Math.ceil(files.length / columns) * (size + 24),
      channels: 4, background: '#ffffff' } }).composite(overlays).png().toFile(path.join(directory, name + '.png'));
  }
  console.log('Native screenshot contact sheets saved without changing the character pixels.');
})().catch(error => { console.error(error); process.exitCode = 1; });

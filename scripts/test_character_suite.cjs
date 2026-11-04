const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const report = { started: new Date().toISOString(), passed: true, tests: [] };
const env = { ...process.env, DHA_CHARACTER_PREVIEW: process.env.DHA_CHARACTER_PREVIEW || 'http://127.0.0.1:18767/' };
for (const file of ['test_character_gesture_policy.cjs', 'test_motion_subframe.cjs', 'test_skeletal_character.cjs', 'test_reference_pose_restore.cjs', 'test_character_lifecycle.cjs', 'test_character_surfaces_faces.cjs',
  'test_character_wake.cjs', 'test_character_wake_pixels.cjs', 'test_character_motion_contract.cjs', 'test_character_arm_occlusion.cjs',
  'test_character_sleep.cjs', 'test_character_breathing.cjs', 'test_character_preview.cjs',
  'test_character_yawn_motion.cjs',
  'test_whole_body_motion.cjs', 'test_character_motion_joins.cjs', 'test_character_size_consistency.cjs', 'test_character_endpoint_consistency.cjs', 'test_character_smooth_join.cjs',
  'test_character_handoff_cadence.cjs']) {
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], { cwd: root, env, encoding: 'utf8', timeout: 240000 });
  let data;
  try { data = JSON.parse(result.stdout); } catch { data = result.stdout; }
  const passed = result.status === 0 && !result.error;
  report.tests.push({ file, passed, data, error: result.error?.message || result.stderr });
  console.log((passed ? 'PASS ' : 'FAIL ') + file);
  if (!passed) { report.passed = false; console.error(result.stderr || result.error); break; }
}
report.finished = new Date().toISOString();
fs.writeFileSync(path.join(root, 'build/reference-regression-report.json'), JSON.stringify(report, null, 2));
process.exitCode = report.passed ? 0 : 1;

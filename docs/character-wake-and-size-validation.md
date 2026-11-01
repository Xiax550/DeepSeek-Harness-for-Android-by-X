# Wake Sequence and 54 dp Minimum

## Behavior

The sp16 update on 2026-11-02 keeps the 7-minute seated / 10-minute drowsy /
10-minute-8-second prone thresholds and the smooth sleeping Z sequence.

Clicking a fully sleeping doll now removes Z immediately, opens the existing
compact input, and runs these phases without restarting on repeated clicks:

- 0-350 ms: awake, reluctant expression while still prone.
- 350-2450 ms: slowly lift into the seated pose.
- 2450-2900 ms: brief seated pause with the reluctant expression.
- 2900-5900 ms: slowly rise into standing.
- 5900-8700 ms: stretch with a sleepy expression, then return to normal.

The prone expression patch uses the supplied reference sheet's pout face;
no old character parts were restored. The mesh stretch now lifts both arms
slightly outward/upward. Canvas fallback uses a restrained whole-body stretch.
Reduced-motion preference skips the prolonged wake animation. Voice, screen
watch and active tasks take priority and cancel the decorative sequence.
No new animation timer or loop is added; phases use the existing render clock.

Default and minimum size are both 54 dp in native code and both settings
surfaces. The 48 dp preset and all other sub-54 dp options are removed. Legacy
smaller values are normalized to 54 dp; larger custom values are retained.

## Local Verification

Passed:

- `scripts/test_character_wake.cjs`: WebGL and Canvas wake phases, expression,
  stretched pose, immediate Z removal, repeat-click protection, work priority,
  sleep reversal, page resume and 54 dp lower bound. Visual evidence:
  `build/character-wake-sequence.png`.
- `scripts/test_character_sleep.cjs`: sleep transitions, Z fade/loop continuity,
  six wake sources, low-frequency idle rendering and reduced motion.
- `scripts/test_character_preview.cjs`: left/right display, compact input,
  result scrolling, watch ring, idle protection and fallback.
- `scripts/test_character_reactions.cjs`: all six actions and expressions;
  zero inverted mesh triangles with the stronger stretch.
- `plugin/dsh-plugin-android/test/ball-size.test.mjs`: real settings component
  logic for default, 40/48/54/67/120 dp inputs, slider minimum, presets and
  configuration writes.
- `ball-inbox.test.mjs` and `ball-surface.test.mjs`: message delivery/regression.
  On Windows, the inbox test needs `DSH_VT_SOURCE` set to the absolute client
  path; its default URL pathname is not a native Windows filename.
- `BallRestPolicyTest`: 137 JVM checks.
- `scripts/build_reference_character.py`: reference pixels/proportions,
  transparent cutouts, manifest and expression patch validation. Its OpenCV
  dependency is in `build/character-asset-deps` via `PYTHONPATH`.

## Artifact and Device

- APK: `out/DHA.apk`, app 1.2.58 (10271), hot 1.2.58-t3-sp16.
- SHA256: `ac8bef73b1d135c3fcab4b124ef14b546f26165030ec71b6576401bd1c315be7`.
- Original signing certificate retained; cover installation succeeded on
  explicitly selected PLF110 device `3B6F5NEAZ2KAK6KR` without data clearing.
- Actual settings UI shows 54/58/68/78 dp and no 48 dp option. Selecting 54 dp
  produced a 162x162-pixel native doll window at device density 3.

The full natural-idle device test passed with actual 54 dp sizing. Native
timestamps on 2026-11-02 (UTC+8):

- Seated: 02:35:16.162; drowsy: 02:38:16.164; prone: 02:38:24.163.
- Click wake / grumpy: 02:38:31.486.
- Lifting: 02:38:31.859; rising: 02:38:34.443.
- Stretching: 02:38:37.408; normal: 02:38:40.204.

`build/device-sp16/idle-timeline.json` and `wake-timeline.json` retain the
observed stages and actual screenshot capture intervals. Ten wake screenshots
and `wake-sequence-contact.png` were visually inspected: the prone doll opens
its eyes with the pout expression and no Z, sits up, rises, stretches with eyes
closed, then restores the standing normal face. The face remains visible and
the input stays compact. ADB screenshots take roughly 1-1.5 seconds each;
filenames are target offsets, not exact exposure timestamps. The continuous
timing is checked by the browser clock tests and native phase logs, not by
claiming these sparse screenshots are a high-frame-rate video.

No fatal-exception/fatal-signal entry was found in the inspected crash buffer.
The prior screen timeout was restored and read back as 15000 ms. No rotation
setting was changed, and no app data, plugins or memory were cleared.

This is focused character/settings verification, not a complete end-to-end
test of every model, voice provider or plugin. GitHub publishing remains paused.

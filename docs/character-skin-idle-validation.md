# Character skin and idle validation

Historical report for the previous recolored character. The replacement using
only the supplied reference artwork is documented in
`reference-only-character-validation.md`. Prior device acceptance here does not
apply to the replacement model.

## Scope

- New lavender skin on the existing 25-part articulated character; same original
  rig, face/expression assets, texture dimensions and alpha channels.
- Native idle threshold: 180000 ms without interaction. Click, drag, typing and
  main-activity interaction reset it. Tasks, voice recording and screen watch
  block standby. Standby is temporary UI throttling, not process termination.
- After the seated transition settles, character rendering uses a one-second
  timer instead of a continuous animation-frame loop. Empty inbox fallback
  polling slows to 30 seconds; native inbox kicks remain immediate.

## Verified on the computer

- Complete APK build and signing succeeded with the existing DHA certificate.
- BallRestPolicy: 53 assertions, including the exact three-minute boundary,
  interaction reset, repeated busy periods and monotonic-clock rollback.
- Skin validation: 57 original files checked against
  `build/character-original-20261101-022444`. Original rig/expression files match;
  all 25 texture dimensions and alpha channels match. Installed textures match
  the processed skin set.
- Edge/Playwright: full-body standing and sitting, face preservation, both
  directions, text send, observation ring, long-result scrolling, voice/watch
  and running-task rest protection, interaction wake and preservation of unsent
  input. Twelve consecutive wake/rest cycles do not accumulate render loops.
- Seated rendering measured two frames over 2.3 seconds. This is a rendering
  check, not a measured claim about whole-app battery savings.

## Xiaomi 14 device acceptance

Tested on 2026-11-01 using `6f72f0cb` / Xiaomi `23127PN0CC` (`houji`), physical
display 1200 x 2670. Installed with `adb install -r`, without uninstalling or
clearing app data. Existing conversation content remained visible after update.

- Standing skin: full body, face, transparent background and original size were
  visible on the launcher. No startup crash was recorded.
- Real idle wait: after three minutes without injected touch, drag or keyboard
  input, the character changed to the seated pose and the app process remained
  alive.
- Wake: tapping the seated character restored standing immediately and opened
  the input above it without automatically showing the keyboard.
- Close and drag: the input close control worked. Dragging from the left edge to
  the right retained the same visible size and face and turned toward the screen.
- Rotation: while DHA was foreground, the display reported 2670 x 1200 and the
  floating character remained on screen. Returning to portrait also kept it
  visible. The original automatic-rotation settings were restored (`1`, `0`).
- The Android crash buffer remained empty throughout these checks.

The unused `ball-web/lilac` whole-image experiment was removed from the packaged
payload after acceptance. A recoverable copy remains at
`build/removed-character-assets-20261101/lilac`. The original articulated `coo`
renderer, rig and expression layers remain because the accepted character uses
them. The pre-skin texture backup remains at
`build/character-original-20261101-022444` and is not packaged into the APK.

This validates the changed floating-character and idle paths. It is not a claim
that every unrelated DHA feature or every external plugin was exhaustively run.

## Asset provenance

Provider: Alibaba Cloud Model Studio, `qwen-image-2.0-pro`.
Prompt: `output/imagegen/qwen-reference-skin/prompt.txt`.
See `payload/opt/dsh/android/ball-web/coo/REFERENCE_SKIN_NOTICE.md` for the
original artwork exclusions and unverified reference redistribution rights.

# Reference-only character and rest transition

Historical sp8 validation. Superseded by `ciallo-character-and-navigation-validation.md`
for the new single-sheet Ciallo model and 7/10-minute idle behavior.

## Current implementation

This replaces the earlier recolored Coopanion character. Current artwork is
extracted directly from the two user-supplied setting sheets. No previous face,
hair, clothing, expressions, rig data or generated textures are read by the new
character. All six view textures retain the source RGB pixels and proportions;
only the background alpha is extracted. Source hashes and rectangles are in
`payload/opt/dsh/android/ball-web/reference/model.json`.

The renderer is an independent 2D deformable mesh (861 shared grid points, 1600
triangles), not a Cubism/Live2D model or a newly authored 3D model. The original
reference face is retained as part of its own artwork; it is not replaced by the
previous character's eye/mouth layers. Front standing and sitting views are used
for normal/rest behavior. Side/back references are available as assets, not used
to hide the face during normal facing changes.

The 1700 ms rest transition combines a smooth crouch with aligned standing/sitting
view blending. Wake reverses the same interpolation. Reversing midway starts at
the current amount, avoiding a pose jump. Reduced-motion preference skips the
long transition. The existing three-minute native idle policy remains in effect;
voice, active tasks and screen observation block rest.

## Actions and expressions

The reference mesh now supports ear twitch, nod, head tilt, small arm wave and
stretch. All use a smooth zero-displacement envelope at both endpoints; only
mesh vertices change, never the native window or touch bounds. Click/open plays
a happy greeting; drag release briefly shows surprise. First idle action occurs
after 6-10 seconds, subsequent actions after 15-35 seconds. Existing 10-40 second
idle gaze remains independent. Tasks, voice, observation and rest block gestures.

Happy, surprised, curious, pout, sleepy and blink patches come from the first
reference sheet's expression strip, mapped onto both standing and seated faces.
No previous character's eye/mouth parts are used. Natural blinking occurs every
4-7 seconds. Rest uses sleepy expression and retains one-frame-per-second
rendering. Reduced motion disables gestures/blinking but retains expressions.
The canvas fallback also displays the new expressions; its motion is a simpler
whole-body approximation rather than the WebGL mesh deformation.

Only one mutable expression canvas/texture is retained per front pose, so
cycling expressions does not allocate an unbounded full-body texture cache.
Context restoration rebuilds these textures and disposal releases them.

## Computer tests, 2026-11-01

- Asset audit: six views have exact source RGB pixels, unchanged proportions,
  genuine transparent alpha, matching local-file model script, and no old assets.
- Playwright: actual SVG-composited screenshot is nonblank, complete lower body
  and feet, both facing directions, pending-turn cancellation, text send,
  observation ring, long-result scrolling, intermediate rest pose, wake/reverse
  continuity, repeated toggles, and page-cache resume.
- Voice, observation and active-task states reject resting. Unsent text remains
  intact after waking. Rested rendering stays timer-driven at about one frame/s.
- High-DPI mobile viewport and reduced-motion cases pass for WebGL and the
  no-WebGL canvas fallback. Local file loading is tested with the same file-access
  permission enabled by BallService's Android WebView settings.
- Browser network audit rejects any request to previous `coo` or `lilac` assets.
- After moving the previous character out of the payload, the complete browser
  suite was rerun successfully. Custom-image rapid switching and local-file
  loading also pass; one current renderer remains mounted after switching.
- JVM idle policy: 53 checks pass, including the exact three-minute threshold,
  activity reset, busy protection and monotonic-clock rollback.
- Action regression (`scripts/test_character_reactions.cjs`): live click greeting,
  scheduled idle and natural blink, drag-release reaction, busy/rest/pagehide
  protection, wake rescheduling, endpoint continuity, all six changed facial
  expressions, bounded texture count (two), WebGL context recovery, reduced
  motion and no-WebGL expression rendering pass. Actual rendered action and
  expression contact sheet inspected: `build/reference-reactions-gallery.png`.
- APK build/signing succeeds: app 1.2.58 (10271), hot 1.2.58-t3-sp8.
  The generated hot archive contains 22 `ball-web/reference/` entries and zero
  `ball-web/coo/` or `ball-web/lilac/` entries. Renderer scripts match packaged
  source after documented CRLF-to-LF normalization. APK embeds that exact hot ZIP.
  Original signing certificate remains unchanged.
  APK SHA256: `04789eac00e57f95664af2c6a59ce2a733ef7f908b0a200a192b507a1b50b583`.

## Fixes found during this change

- Canvas attached directly to SVG was invisible despite a populated GL buffer;
  use an SVG foreignObject and test the browser-composited screenshot.
- Premultiplied crossfade used source-over and dimmed the character midway;
  sum the two normalized weighted views instead.
- Reversing a pending facing change left the old timer armed; cancel first.
- pagehide canceled rendering without a pageshow restart; resume one render loop.
- Custom-image selection can now discard an asynchronously loading character
  and dispose its renderer, avoiding a stale figure covering the custom image.
- Local WebView loading cannot use fetch(file://model.json); load model.js.
- Reference cutout initially removed part of a white bow; protected foreground
  selection retains the bow.

## Device status

The previous `coo` directory (59 files) was moved outside the packaged source to
`build/character-before-reference-only-20261101/coo`; it is recoverable, not
permanently deleted. The new composer references only `reference/model.js` and
`reference/figure.js`. Historical base payload/user filesystem contents are not
erased; no old character assets are loaded by the new UI.

The previous sp7 APK was cover-installed on Xiaomi 14 (23127PN0CC), but the user
then deferred real-device UI testing until evening. No phone interaction was
performed after that direction. The new sp8 action/expression APK is NOT installed.
Per the user's latest request, do not interact with the phone during this
computer-only test round. This NEW model has not passed device acceptance.
Earlier Xiaomi screenshots validate the PREVIOUS model only, not this revision.

Evening device checklist: cover-install without clearing data; full-body/face,
58 dp legibility, transparent silhouette, edge facing and size, real three-minute
wait, smooth sitting/rising, interruption by click/drag/task/voice/watch,
click greeting, idle actions/expressions at 58 dp, face integrity throughout
motion, keyboard behavior, result scroll/close, rotation, background return, and crash
buffer. Restore any temporary screen/rotation settings. No unattended evening
test is scheduled by this document.

## Reproduction

Run `scripts/build_reference_character.py --check` with Pillow/numpy/OpenCV.
Run `scripts/preview_character.cjs`, then `scripts/test_character_preview.cjs`
and `scripts/test_character_reactions.cjs` with Playwright and
`DHA_CHARACTER_PREVIEW` pointing at that local preview.
Reference redistribution rights are not independently verified; see
`payload/opt/dsh/android/ball-web/reference/NOTICE.md` before publishing.

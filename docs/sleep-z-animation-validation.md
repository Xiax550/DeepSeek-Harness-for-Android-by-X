# Smooth Sleeping Z Animation

## Change

On 2026-11-02, the sleeping marker in
`payload/opt/dsh/android/ball-web/composer.html` was softened without changing
the character artwork, idle thresholds, doll dimensions or input geometry.

- Each symbol has a 4.8-second cycle, replacing the 2.7-second cycle.
- The middle and top symbols start 1.1 and 2.2 seconds after the bottom one.
- Fade-in takes 864 ms; fade-out takes 1200 ms. Adjacent symbols overlap.
- A small upward drift and scale change accompany the opacity animation.
- Waking removes the animation immediately. Reduced-motion mode stays static.
- CSS animates the marker without adding JavaScript timers or render loops.

## Browser Regression

Passed `scripts/test_character_sleep.cjs` with WebGL and Canvas fallback:
bottom-middle-top sequence, gradual opacity samples, repeat-cycle continuity,
six wake sources, interrupted transition, low-frequency sleeping renderer,
resume behavior and reduced motion. Transparent-boundary assertions use a
small tolerance because browser interpolation can return values near 3e-30.

Also passed `scripts/test_character_preview.cjs` and
`scripts/test_character_reactions.cjs`, covering compact input, result scrolling,
left/right rendering, six actions, expressions and positive mesh triangle area.

## Artifact

- APK: `out/DHA.apk`, app 1.2.58 (10271), hot 1.2.58-t3-sp15.
- APK SHA256: `91b0a25ec8d694f453a0f85d086726c182b8255ad2ad8bdaf0cae6caa7fe3e64`.
- Signing certificate SHA256:
  `c5e36f69f081a4da5465d96e91a3554fbeeb5c1d5f228cfc87e6acdc4d72d2f4`.
- Cover installation succeeded on explicitly selected device
  `3B6F5NEAZ2KAK6KR`, PLF110. No uninstall or data clear was used.

## Device Follow-up

`scripts/test_device_character_idle.cjs` passed the full unforced idle cycle
on the installed sp15 build. Native timestamps on 2026-11-02 (UTC+8):

- Seated: 01:53:15.744.
- Drowsy: 01:56:15.746.
- Prone sleep: 01:56:23.750.
- Click wake: 01:56:49.899.

Evidence in `build/device-sp15`: `idle-timeline.json`, `idle-422.png`,
`idle-613.png`, `zzz-00.png` through `zzz-11.png`,
`zzz-motion-contact.png`, `wake-click.png` and `wake-detail.png`.
The current-build contact sheet was visually inspected: successive symbols
show varying opacity, overlap and repeated upward order; the complete doll
remains visible. The wake detail shows the standing doll and compact input
with no sleep marker. No fatal-exception or fatal-signal entry was found in
the inspected crash buffer. Screenshots sample the motion; continuous fade
and cycle-boundary opacity are additionally checked in browser regression.

The screen timeout was restored and read back as its original 15000 ms.
The full test used the log-rotation-safe stage accumulator; the earlier sp14
harness failure and screenshots are not counted as sp15 validation.

GitHub publishing remains paused. These focused animation tests do not verify
model responses, voice recognition, plugin compatibility or all app features.

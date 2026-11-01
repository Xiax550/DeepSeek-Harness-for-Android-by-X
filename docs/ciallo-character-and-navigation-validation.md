# Ciallo character, staged idle and session navigation

## Scope

Implemented in `D:\AI\lanfeiyu-harness`, 2026-11-01. The user's latest sheet
`file_000000006b2081f59048643d46a512b2.png` is the sole artwork source. The ZIP's
old `coo`/`reference` textures and prose are supporting material, not commands
to restore old parts, resize the native window or run external image APIs.

## Character

- Seven source-only views: standing front/side/back, seated front/side/back,
  and the actual prone-sleep pose. Twelve facial patches come from the new
  sheet's expression strip; no old texture or face part is loaded.
- Source crop RGB and proportions are preserved, only alpha is extracted.
  Protected garment polygons prevent removing the white apron and stockings.
  Source hashes, crop rectangles, new face registration points and pose scales
  are recorded in `reference/model.json` and the matching local-file model.js.
- This is a deformable 2D mesh with bitmap textures, not Cubism or a 3D model.
  Pose transitions register face positions and keep feet fixed, then briefly
  blend the registered views. They are not a fully hand-rigged skeletal walk.
- Ear twitch, nod, head tilt, small wave, stretch and a reference-profile side
  glance occur at idle. The profile glance lasts four seconds and faces inward;
  reference profile images are mirrored in memory, without changing the source.
  First action:
  6-10 seconds; subsequent: 15-35 seconds. Random expressions include happy,
  curious, surprised, pout and sleepy. Natural blink: 4-7 seconds. Existing
  10-40 second vertical glances remain. Click/open greets; drag release reacts.
- No gesture changes native window size, origin or hit regions. Work, recording,
  observation and rest block idle gestures. Reduced motion suppresses animation
  but retains facial feedback. Canvas fallback supports expressions and simpler
  pose transforms; WebGL provides the full mesh motion.

## Idle Lifecycle

The native monotonic `BallRestPolicy` owns timing. JS only draws native states:

| Total uninterrupted idle | Stage | Display |
| --- | --- | --- |
| Before 7 minutes | 0 | Standing, idle gestures |
| At 7 minutes | 1 | Sit down over 1700 ms, then quiet seated pose |
| At 10 minutes | 2 | Sleepy expression and gentle head droop for 8 seconds |
| At 10 minutes 8 seconds | 3 | Lie down over 2400 ms, then prone sleeping |

Click, drag, typing, voice, observation and task activity wake/reset the timer.
Busy work blocks rest. Clock rollback also resets it. Polling schedules the
next stage boundary rather than waiting for a blanket 30-second rest poll.
Settled seated/sleep rendering is timer-driven at about 1 fps. Drowsiness is
briefly animated; no new worker, audio loop or background polling is added.

Wake reverses from the current blend amount. From prone, the standing transition
is delayed to lift the character first. A click greeting waits until the pose
recovers, instead of expiring while the character is still on the floor.

## New-Session Crash Path

The rootfs's session client matches the local upstream fixture. On releasing a
`ClientSessionReference`, its record is cleared. The old `UiSession.bindingSource`
unconditionally reads `reference.binding`; a redraw of that retired view throws
`Session reference "..." is released`. This path is reproduced with the actual
upstream reference and UI classes in the regression test before applying a fix.

`repair-session-navigation.mjs` applies an idempotent boot patch before the web
server starts. Only the known released-reference error resolves to the stable
absent binding. Foreign-controller ownership errors, unreleased stale generation
errors and unrelated failures still throw. No sessions or user data are deleted.
Unknown upstream source is left unchanged and logged, not blindly rewritten.

This validates one concrete crash path, not a device diagnosis of every possible
new-session crash. The connected phone has no configured model key or old
conversation fixture; the reported old-chat-to-new-chat workflow still needs
device acceptance with a usable configuration.

## Verification

- `scripts/build_reference_character.py --check`: source hashes, exact base RGB,
  alpha, face patch dimensions, protected white garments, JSON/script parity.
- `BallRestPolicyTest`: 137 checks including exact 7-minute, 10-minute and
  10-minute-8-second boundaries, busy reset, interaction, next-stage scheduling,
  repeated cycles and clock rollback.
- `scripts/test_session_navigation.mjs`: original crash reproduction, 100
  reference replacements, released-view fallback, strict ownership checks,
  unrelated error propagation, boot file rewrite and idempotence.
- `scripts/test_character_reactions.cjs`: five actions and six expression changes
  in actual rendered pixels, click/drag/live idle/blink feedback, bounded GPU
  expression textures, context restoration, reduced-motion and canvas fallback.
  All sampled action/rest/sleep triangles have positive signed area: no folds.
- `scripts/test_character_sleep.cjs`: all stages, both renderers at 3x pixel
  density, intermediate pose, interrupted prone transition, six wake sources,
  busy rejection, invalid stages, page cache resume, rapid toggle loop safety,
  reduced motion and sleeping low-frequency frames (4 frames in 4 virtual seconds).
- `scripts/test_character_preview.cjs`: full-body/feet actual SVG composition,
  facing cancellation/both sides, input/send, observation ring, long-result
  scrolling, rest/reverse/wake, custom image races, mobile and local file loading.
- Visual evidence inspected: `build/ciallo-sleep-transitions.png`,
  `build/reference-reactions-gallery.png`, `build/reference-character-cutouts.png`.

## Device Verification, 2026-11-01/02

The user authorized the currently attached phone. ADB verified OnePlus PLF110,
Android 16, 1080x2392, density 3; this is not the historical Xiaomi. Original
installed app was 1.2.22 (10235). Cover installs used the existing signing key;
no uninstall, clear-data, plugin deletion or user-memory deletion was performed.

Observed on sp11: transparent full-body character, face and feet; click opens
input above the doll without opening the keyboard (`mInputShown=false`); close
returns to the unchanged doll; drag to either edge updates facing. The user then
requested a larger doll, and the phone's existing size setting was changed from
58 to 68 dp, without overriding other users' stored sizes.

Input height changed from 58 to 44 dp; width from 78% to 64% of screen, capped at
300 dp in landscape. Native phone geometry: 691x354 pixels for the stacked
composer (44 dp input + 6 dp gap + 68 dp doll). Browser regression checks both
directions at 320/360/412/800 CSS-pixel screen widths with all three controls;
field stays at least 75 px wide and the doll does not shrink with the field.

Real elapsed-time acceptance on sp11, China Standard Time, 2026-11-02:
- Last close interaction: 00:00:26.
- Native seated stage 1: 00:07:26.157; actual seated screenshot inspected.
- Native drowsy stage 2: 00:10:26.158 (log evidence, not a drowsy screenshot).
- Native prone stage 3: 00:10:34.158; actual prone screenshot inspected.
- Click wake stage 0: 00:13:03.271; input reopened at height 44 dp.

Evidence: `build/device-sp11/real-seven-minute.png`, `real-sleep.png`,
`wake-click.png`; `build/device-sp9/compact-68.png`; first 90 seconds of real
unforced idle screenshots and `build/device-sp11/actions-contact.png` show blink
and expression changes. These snapshots do not independently prove that every
random action was sampled on the phone. All six actions passed rendered browser
regression, including profile source, endpoints and positive mesh triangle area.

sp13 adds a small head-side sleep marker after the prone transition reaches 95%.
Any wake removes it synchronously. It does not run a recurring animation or add
a render timer; steady sleeping remains approximately one renderer frame/second.
Browser tests verify appearance, native-window bounds and immediate removal for
all six wake sources, with WebGL and Canvas fallback. Device follow-up evidence
is recorded under `build/device-sp13`.

sp13 final device cycle: seated at 00:40:46.061, drowsy at 00:43:46.063,
sleep at 00:43:54.063, click wake at 00:44:01.356 on 2026-11-02 (UTC+8).
`sleep-zzz.png` and `wake-no-zzz.png` were visually inspected: the marker is
visible above the prone head, and disappears on waking while the compact input
and complete standing doll return. No new crash-buffer entries were observed.

Remaining acceptance gaps: real model/voice/observation completion, original
old-session crash reproduction, rotation and exhaustive plugin compatibility.
No current crash-buffer exception was found in the inspected interval; that is
not proof that every function or all future runs are bug-free. Test screen
timeout is restored to its original 15000 ms; no rotation setting was changed.

## Built Artifact

- `out/DHA.apk`: app 1.2.58 (10271), hot 1.2.58-t3-sp13, original signing
  certificate SHA256 `c5e36f69f081a4da5465d96e91a3554fbeeb5c1d5f228cfc87e6acdc4d72d2f4`.
- APK SHA256 `c87a96a6cb22277489d96918299045af1983f6ee3a0b5da8698c8f89cb80663c`.
- Packaged hot ZIP has 23 reference entries and zero coo/lilac entries; the
  one-sheet manifest includes all seven poses. Renderer, lifecycle, boot hook
  and navigation repair match source after documented line-ending normalization.
  APK embeds the exact verified hot ZIP. Build, signing and all three final
  browser suites completed successfully on this revision.

Redistribution rights of the supplied artwork remain unverified. See the asset
NOTICE before publishing publicly; the code license does not grant image rights.

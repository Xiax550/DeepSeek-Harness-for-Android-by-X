# Reference-only character

The three active base PNG images and thirteen expression patches are extracted
from the replacement Ciallo setting sheet supplied by the user on 2026-11-03:
`file_00000000b14481f586c88e3beafdd891.png`.
Only front standing, front seated and prone sleeping are active poses. Profile
and rear drawings document costume details and are not animation poses.
The new apron retains the reference's pink cross, not the earlier whale motif.
No old character texture, face, expression, skeleton, generated skin or
artwork is used. `model.json` records source hashes, extraction rectangles and
new mesh landmarks. `figure.js` implements an independent deformable 2D mesh;
this is not a Cubism/Live2D model and is not described as one.

On 2026-11-02 the maintainer confirmed ChatGPT-assisted creation and ownership
of the reference and requested its inclusion in the public DHA source and APK.
This records the maintainer's declaration, not independent rights clearance.
The artwork is not automatically MIT-licensed with the code; see the root
`ARTWORK_RIGHTS.md` for provenance and the scope of the permission.

The source extraction script is `scripts/build_reference_character.py`.

The active `skeleton/` renderer and its cutout layers are generated from this
current reference, with source hashes recorded in `skeleton/rig.json`. It uses
Three.js bones and two-link limb solving, with the same transforms in its Canvas
fallback. Approved seated and sleeping endpoint drawings are composited over
the articulated transition; this is not a fully modeled 3D character or Cubism
model. `figure.js` remains the reference-mesh fallback if initialization fails.
Three.js r160 is MIT-licensed; see `LICENSES/three-js-MIT.txt` in the source root.

The `motion/` wake, stretch, sit and lie atlases are whole-character animation derivatives
of these approved finished drawings, generated with Alibaba Cloud Model Studio
at the maintainer's explicit request. They are not limb cutouts or a new 3D rig.
No personal photograph was uploaded. `motion/clips.json` records provider/model
and source-video hashes; local generation records remain under output/imagegen.
These derivatives retain the artwork licensing scope stated above.

Motion derivatives additionally use offline bidirectional optical-flow midpoint
frames and a fixed per-clip blue-violet hair-color correction toward stand-front.
The soft color mask excludes skin, neutral fabric and saturated eye colors; the
resting endpoint geometry remains unchanged. OpenCV is an offline build
dependency only, not an Android runtime dependency.
Additional fixed per-clip Lab quantile curves match the normal standing palette
across soft hue groups and neutral fabric, while preserving alpha and shading.
At the maintainer's later request, standing hair and its expression patches were
recolored to the unmodified animation sources' blue-violet palette, rather than
brightening animation hair to the original standing hair. standing-hair-palette.json
records this change. Skin, clothing, alpha and pose geometry are unchanged; the
standing skeleton layers are rebuilt from the recolored standing artwork. The
unmodified standing export and patches are retained as local palette originals.
Seated and sleeping hair and their expression patches now use the same animation
hair target as standing. Their corrections are constant per pose; no per-frame
auto exposure, replacement limbs or geometry changes are introduced. The original
exports for these poses are also retained locally. Pixel checks preserve alpha,
skin, costume and all pixels outside the selected hair-color mask.

Motion frames additionally use offline whole-character similarity registration
against the standing/seated reference height and matching ground contacts.
Uniform scale and translation correct source camera-size drift; no individual
body part is stretched, repainted or replaced. Crouching and prone poses retain
their lower natural silhouettes. Standing artwork, source videos, color targets
and motion timing are unchanged by this registration step.

# Reference-only character

The seven base PNG images and thirteen expression patches are extracted from the
new Ciallo setting sheet supplied by the user on 2026-11-01:
`file_000000006b2081f59048643d46a512b2.png`.
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

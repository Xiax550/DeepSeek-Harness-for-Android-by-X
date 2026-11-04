"""Standing hair follows animation; excluded colors, alpha and dimensions stay intact."""
import json
import unittest
import numpy as np
from PIL import Image
from build_character_motion_atlas import ROOT, hair_palette, hair_weight, endpoint


class StandingHairTests(unittest.TestCase):
    def test_only_selected_hair_pixels_change(self):
        reference = ROOT / 'payload/opt/dsh/android/ball-web/reference'
        record = json.loads((reference / 'standing-hair-palette.json').read_text())
        for file in record['files']:
            old = Image.open(ROOT / 'assets/character/palette-originals' / file).convert('RGBA')
            new = Image.open(reference / file).convert('RGBA')
            a, b = np.asarray(old), np.asarray(new)
            self.assertEqual(old.size, new.size)
            self.assertTrue(np.array_equal(a[:, :, 3], b[:, :, 3]))
            untouched = hair_weight(old) == 0
            self.assertTrue(np.array_equal(a[untouched], b[untouched]))

    def test_standing_hair_is_close_to_animation_not_original_brightness(self):
        reference = ROOT / 'payload/opt/dsh/android/ball-web/reference'
        record = json.loads((reference / 'standing-hair-palette.json').read_text())
        target = np.asarray(record['targetLab'])
        current = hair_palette([endpoint('stand-front')])
        self.assertLess(np.linalg.norm(current-target), 4.5)
        original = Image.open(ROOT / 'assets/character/palette-originals/stand-front.png').convert('RGBA')
        self.assertLess(abs(current[0]-target[0]), abs(hair_palette([original])[0]-target[0]))

    def test_resting_pose_hair_uses_same_animation_target(self):
        reference = ROOT / 'payload/opt/dsh/android/ball-web/reference'
        record = json.loads((reference / 'standing-hair-palette.json').read_text())
        target = np.asarray(record['targetLab'])
        self.assertEqual(set(record['poseDeltaLab']), {'stand-front', 'sit-front', 'sleep-front'})
        for pose in record['poseDeltaLab']:
            self.assertLess(np.linalg.norm(hair_palette([endpoint(pose)]) - target), 4.5, pose)


if __name__ == '__main__':
    unittest.main()

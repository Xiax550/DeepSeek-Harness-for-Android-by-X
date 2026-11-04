"""Whole-character height/ground checks; not a substitute for rendered review."""
import unittest
import numpy as np
from PIL import Image
from build_character_motion_atlas import (ROOT, CLIPS, ENDPOINTS, endpoint, registered_frame,
                                         registration_plan, apply_registration, solid_bounds, body_top)


class RegistrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.clips = {}
        for name, (folder, _, _) in CLIPS.items():
            frames = [registered_frame(Image.open(file).convert('RGBA'))
                      for file in sorted((ROOT / 'output/imagegen' / folder / 'frames').glob('*.png'))]
            plan = registration_plan(name, frames, *[endpoint(pose) for pose in ENDPOINTS[name]])
            aligned = [apply_registration(frame, item) for frame, item in zip(frames, plan['sourceFrames'])]
            cls.clips[name] = frames, aligned, plan

    def test_upright_height_matches_normal_standing(self):
        stand = endpoint('stand-front')
        height = solid_bounds(stand)[3] - body_top(stand)
        for name, indices in (('wake', range(94, 120)), ('stretch', range(80)), ('sit', range(17))):
            for index in indices:
                frame = self.clips[name][1][index]
                self.assertLessEqual(abs(solid_bounds(frame)[3] - body_top(frame) - height), 2,
                                     name + ':' + str(index))

    def test_ground_alignment_and_no_clipping(self):
        for name, (_, frames, plan) in self.clips.items():
            for index, (frame, transform) in enumerate(zip(frames, plan['sourceFrames'])):
                box = solid_bounds(frame)
                self.assertLessEqual(abs(box[3] - transform['ground']), 2, name + ':' + str(index))
                self.assertGreater(box[0], 0)
                self.assertGreater(box[1], 0)
                self.assertLess(box[2], frame.width)
                self.assertLess(box[3], frame.height)

    def test_settled_seated_height_matches_reference(self):
        seated = endpoint('sit-front')
        height = solid_bounds(seated)[3] - body_top(seated)
        for name, indices in (('sit', range(62, 80)), ('lie', range(3))):
            for index in indices:
                frame = self.clips[name][1][index]
                self.assertLessEqual(abs(solid_bounds(frame)[3] - body_top(frame) - height), 2,
                                     name + ':' + str(index))

    def test_uniform_smooth_transforms_preserve_pose_proportions(self):
        for name, (_, frames, plan) in self.clips.items():
            transforms = plan['sourceFrames']
            scales = [item['scale'] for item in transforms]
            self.assertGreater(min(scales), .85)
            self.assertLessEqual(max(scales), 1.000001)
            self.assertLess(np.max(np.abs(np.diff(scales))), .012, name)
            self.assertLess(np.max(np.abs(np.diff([item['y'] for item in transforms]))), 3, name)
            for item in transforms:
                self.assertAlmostEqual(item['x'], 128 * (1 - item['scale']))
            # Sitting and sleeping retain their naturally lower silhouettes.
            if name != 'stretch':
                resting = frames[0 if name == 'wake' else -1]
                self.assertLess(solid_bounds(resting)[3] - body_top(resting), 200)


if __name__ == '__main__':
    unittest.main()

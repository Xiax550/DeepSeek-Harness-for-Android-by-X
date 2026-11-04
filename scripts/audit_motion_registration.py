"""Inspect source pose size on the same camera as standing, without modifying art."""
import json
import argparse
from PIL import Image, ImageDraw
import numpy as np
from build_character_motion_atlas import (ROOT, CLIPS, ENDPOINTS, endpoint, registered_frame,
                                         registration_plan, apply_registration)


def bounds(frame):
    return Image.fromarray((np.asarray(frame)[:, :, 3] > 128).astype('uint8') * 255).getbbox()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--aligned', action='store_true')
    args = parser.parse_args()
    tiles = [('standing reference', endpoint('stand-front'))]
    for name, indices in (('wake', range(85, 120, 3)), ('stretch', range(0, 80, 8)),
                          ('sit', (0, 8, 16, 24, 60, 72, 79)), ('lie', (0, 20, 40, 60, 100, 119))):
        folder = ROOT / 'output/imagegen' / CLIPS[name][0] / 'frames'
        files = sorted(folder.glob('*.png'))
        source_frames = [registered_frame(Image.open(file).convert('RGBA')) for file in files]
        if args.aligned:
            plan = registration_plan(name, source_frames, *[endpoint(pose) for pose in ENDPOINTS[name]])
            source_frames = [apply_registration(frame, transform)
                             for frame, transform in zip(source_frames, plan['sourceFrames'])]
        for index in indices:
            tiles.append((name + '-' + str(index), source_frames[index]))
    sheet = Image.new('RGB', (256 * 6, 284 * ((len(tiles) + 5) // 6)), '#e8edf2')
    draw = ImageDraw.Draw(sheet)
    report = {}
    for i, (label, frame) in enumerate(tiles):
        x, y = i % 6 * 256, i // 6 * 284
        sheet.paste(frame, (x, y), frame)
        draw.line((x, y + 19, x + 255, y + 19), fill='#b06c7a')
        draw.line((x, y + 249, x + 255, y + 249), fill='#577f74')
        box = bounds(frame)
        draw.text((x + 6, y + 260), label + ' ' + str(box), fill='#20282e')
        report[label] = box
    destination = ROOT / ('build/motion-registration-' + ('aligned' if args.aligned else 'before') + '.png')
    sheet.save(destination)
    print(json.dumps({'image': str(destination), 'bounds': report}))


if __name__ == '__main__':
    main()

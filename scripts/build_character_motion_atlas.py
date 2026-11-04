"""Package reviewed whole-body frames on a fixed canvas, without limb deformation."""
import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image
import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'payload/opt/dsh/android/ball-web/reference/motion'
# Output time -> original video seconds. Give the weight-transfer/rise its own
# time budget rather than extending the already long hands-and-knees hold.
CLIPS = {
    'wake': ('wake-video-v2', 120, [(0, .55), (.15, 1.2), (.44, 3.7), (.88, 4.7), (1, 5.95)]),
    'stretch': ('stretch-video-v1', 80, [(0, 0), (.38, 1.2), (.58, 2), (1, 3.95)]),
    'sit': ('sit-video-v1', 80, [(0, 0), (.1, .95), (.8, 2.1), (1, 3.95)]),
    'lie': ('lie-video-v2', 120, [(0, 0), (.18, 1.2), (.46, 2.7), (.9, 4.9), (1, 5.95)]),
}
ENDPOINTS = {'wake': ('sleep-front-pout', 'stand-front'), 'stretch': ('stand-front', 'stand-front'),
             'sit': ('stand-front', 'sit-front'), 'lie': ('sit-front', 'sleep-front')}


def slopes(knots):
    intervals = [b[0] - a[0] for a, b in zip(knots, knots[1:])]
    secants = [(b[1] - a[1]) / width for (a, b), width in zip(zip(knots, knots[1:]), intervals)]
    result = [0.0]
    for i in range(1, len(knots) - 1):
        left, right = secants[i - 1], secants[i]
        w1, w2 = 2 * intervals[i] + intervals[i - 1], intervals[i] + 2 * intervals[i - 1]
        result.append((w1 + w2) / (w1 / left + w2 / right) if left * right > 0 else 0.0)
    return result + [0.0]


def source_time(progress, knots):
    progress = max(0, min(1, progress))
    tangents = slopes(knots)
    for i, ((a, x), (b, y)) in enumerate(zip(knots, knots[1:])):
        if progress <= b:
            u = (progress - a) / (b - a)
            return ((2 * u**3 - 3 * u**2 + 1) * x + (u**3 - 2 * u**2 + u) * (b-a) * tangents[i]
                    + (-2 * u**3 + 3 * u**2) * y + (u**3-u**2) * (b-a) * tangents[i+1])
    return knots[-1][1]


def endpoint(name, size=256):
    """Same fixed camera/ground as the native skeleton renderer, not bbox fitting."""
    reference = ROOT / 'payload/opt/dsh/android/ball-web/reference'
    model = json.loads((reference / 'model.json').read_text(encoding='utf-8'))
    pose = name.replace('-pout', '')
    info = model['views'][pose]
    source = Image.open(reference / info['file']).convert('RGBA')
    if name.endswith('-pout'):
        patch = model['expressions'][pose]['pout']
        source.alpha_composite(Image.open(reference / patch['file']).convert('RGBA'), tuple(patch['rect'][:2]))
    width, height = source.width * info['scale'], source.height * info['scale']
    camera = size / 260
    # Pillow inverse-affine sampling preserves fractional registration.
    scale = info['scale'] * camera
    x, y = (130 - width / 2) * camera, (254 - height) * camera
    return source.transform((size, size), Image.Transform.AFFINE,
                            (1 / scale, 0, -x / scale, 0, 1 / scale, -y / scale),
                            resample=Image.Resampling.BICUBIC)


def registered_frame(frame, size=256):
    frame = frame.resize((size, size), Image.Resampling.LANCZOS)
    scale = 256 / 260
    x = size * (1 - scale) / 2
    y = 254 * size / 260 - (748 / 768) * size * scale
    return frame.transform((size, size), Image.Transform.AFFINE,
                           (1 / scale, 0, -x / scale, 0, 1 / scale, -y / scale),
                           resample=Image.Resampling.BICUBIC)


def solid_bounds(frame):
    alpha = np.asarray(frame)[:, :, 3]
    return Image.fromarray((alpha > 128).astype(np.uint8) * 255).getbbox()


def body_top(frame):
    # The crown band excludes raised hands and the tail. Never size the body
    # from the complete silhouette while a gesture extends beyond the head.
    alpha = np.asarray(frame)[:, :, 3]
    ys = np.nonzero(alpha[:, round(frame.width * .31):round(frame.width * .69)] > 128)[0]
    if not len(ys):
        raise ValueError('Missing central character artwork')
    return float(ys.min())


def smooth_samples(values, radius=3):
    padded = np.pad(np.asarray(values, dtype=float), radius, mode='edge')
    offsets = np.arange(-radius, radius + 1, dtype=float)
    kernel = np.exp(-.5 * (offsets / 1.3)**2)
    return np.convolve(padded, kernel / kernel.sum(), mode='valid')


def registration_plan(name, frames, begin, end):
    standing = endpoint('stand-front')
    sitting = endpoint('sit-front')
    stand_height = solid_bounds(standing)[3] - body_top(standing)
    sit_height = solid_bounds(sitting)[3] - body_top(sitting)
    measured_floor = smooth_samples([solid_bounds(frame)[3] for frame in frames])
    measured_height = smooth_samples([solid_bounds(frame)[3] - body_top(frame) for frame in frames])
    count = len(frames)
    sizes = np.ones(count)
    for index in range(count):
        # Only known, visually reviewed matching postures supply height anchors.
        # Crouching/prone frames are not inflated into standing-size rectangles.
        if name == 'wake':
            weight = np.clip((index - 85) / 9, 0, 1)
            weight = weight * weight * (3 - 2 * weight)
            sizes[index] = 1 + weight * (min(1, stand_height / measured_height[index]) - 1)
        elif name == 'stretch':
            sizes[index] = min(1, stand_height / measured_height[index])
        elif name == 'sit':
            upright = np.clip((24 - index) / 8, 0, 1)
            seated = np.clip((index - 52) / 10, 0, 1)
            upright, seated = [v * v * (3 - 2 * v) for v in (upright, seated)]
            sizes[index] = 1 + upright * (min(1, stand_height / measured_height[index]) - 1)
            sizes[index] += seated * (min(1, sit_height / measured_height[index]) - 1)
        elif name == 'lie':
            seated = np.clip((14 - index) / 10, 0, 1)
            seated = seated * seated * (3 - 2 * seated)
            sizes[index] = 1 + seated * (min(1, sit_height / measured_height[index]) - 1)
    sizes = smooth_samples(sizes, radius=2)
    first_floor, last_floor = solid_bounds(begin)[3], solid_bounds(end)[3]
    transforms = []
    for index, scale in enumerate(sizes):
        p = index / (count - 1)
        mix = p * p * (3 - 2 * p)
        ground = first_floor + (last_floor - first_floor) * mix
        transforms.append({'scale': float(scale), 'x': float(frames[index].width * .5 * (1 - scale)),
                           'y': float(ground - measured_floor[index] * scale), 'ground': float(ground)})
    return {'policy': 'uniform-whole-body-scale-and-ground-only; no-part-warping',
            'standingBodyHeight': stand_height, 'seatedBodyHeight': sit_height,
            'sourceFrames': transforms}


def apply_registration(frame, transform):
    scale, x, y = [transform[key] for key in ('scale', 'x', 'y')]
    return frame.transform(frame.size, Image.Transform.AFFINE,
                           (1 / scale, 0, -x / scale, 0, 1 / scale, -y / scale),
                           resample=Image.Resampling.BICUBIC)


def lock_endpoint(frame, original, mix):
    # Only blend the matching end pose, never different body postures.
    mix = max(0, min(1, mix))
    if mix == 0:
        return frame.copy()
    if mix == 1:
        return original.copy()
    a, b = [np.asarray(image, dtype=np.float32) / 255 for image in (frame, original)]
    alpha = a[:, :, 3:4] * (1 - mix) + b[:, :, 3:4] * mix
    rgb = (a[:, :, :3] * a[:, :, 3:4] * (1 - mix) + b[:, :, :3] * b[:, :, 3:4] * mix)
    rgb /= np.maximum(alpha, 1 / 255)
    return Image.fromarray(np.clip(np.concatenate((rgb, alpha), axis=2) * 255 + .5, 0, 255).astype(np.uint8))


def motion_midpoint(left, right):
    """Bidirectional motion warping in premultiplied RGBA, not a pose dissolve."""
    a, b = [np.asarray(frame, dtype=np.float32) / 255 for frame in (left, right)]
    gray = [cv2.cvtColor((v[:, :, :3] * v[:, :, 3:4] * 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
            for v in (a, b)]
    flow = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    forward = flow.calc(gray[0], gray[1], None)
    backward = flow.calc(gray[1], gray[0], None)
    y, x = np.mgrid[:a.shape[0], :a.shape[1]].astype(np.float32)
    warped = []
    for frame, displacement in ((a, forward), (b, backward)):
        premultiplied = frame.copy()
        premultiplied[:, :, :3] *= frame[:, :, 3:4]
        warped.append(cv2.remap(premultiplied, x - displacement[:, :, 0] * .5,
                               y - displacement[:, :, 1] * .5, cv2.INTER_LINEAR,
                               borderMode=cv2.BORDER_CONSTANT))
    result = (warped[0] + warped[1]) * .5
    result[:, :, :3] /= np.maximum(result[:, :, 3:4], 1 / 255)
    return Image.fromarray(np.clip(result * 255 + .5, 0, 255).astype(np.uint8))


def hair_weight(frame):
    rgba = np.asarray(frame, dtype=np.float32) / 255
    r, g, b, alpha = [rgba[:, :, i] for i in range(4)]
    # Blue-violet curls have more blue than red, unlike the pink/purple dress.
    # Exclude saturated blue eyes, skin, neutral stockings and transparent pixels.
    hsv = cv2.cvtColor(rgba[:, :, :3], cv2.COLOR_RGB2HSV)
    weight = np.clip((b-r-.10) / .12, 0, 1) * np.clip((g-r+.025) / .07, 0, 1)
    weight *= np.clip((hsv[:, :, 1]-.16)/.12, 0, 1) * np.clip((.72-hsv[:, :, 1])/.15, 0, 1)
    return weight * alpha


def hair_palette(frames):
    totals = np.zeros(3, np.float64)
    total_weight = 0
    for frame in frames:
        weights = hair_weight(frame)
        lab = cv2.cvtColor(np.asarray(frame, dtype=np.float32)[:, :, :3] / 255, cv2.COLOR_RGB2LAB)
        totals += (lab * weights[:, :, None]).sum(axis=(0, 1))
        total_weight += weights.sum()
    if total_weight < 1:
        raise ValueError('No reliable blue-violet hair samples')
    return totals / total_weight


def match_hair(frame, delta):
    rgba = np.asarray(frame).copy()
    lab = cv2.cvtColor(rgba[:, :, :3].astype(np.float32) / 255, cv2.COLOR_RGB2LAB)
    lab += hair_weight(frame)[:, :, None] * delta
    rgb = cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)
    rgba[:, :, :3] = np.clip(rgb * 255 + .5, 0, 255).astype(np.uint8)
    # Preserve unselected pixels exactly, not just visually, after color conversion.
    unchanged = hair_weight(frame) == 0
    rgba[unchanged] = np.asarray(frame)[unchanged]
    return Image.fromarray(rgba)


def palette_weights(frame):
    rgba = np.asarray(frame, dtype=np.float32) / 255
    hsv = cv2.cvtColor(rgba[:, :, :3], cv2.COLOR_RGB2HSV)
    hue, saturation = hsv[:, :, 0], hsv[:, :, 1]
    weights = []
    for center in (225, 285, 335, 25):
        distance = np.abs((hue - center + 180) % 360 - 180)
        weights.append(np.exp(-(distance / 38)**2) * saturation)
    weights.append((1 - saturation)**5)
    weights = np.stack(weights, axis=2)
    return weights / np.maximum(weights.sum(axis=2, keepdims=True), 1e-6)


def palette_samples(frames):
    samples = [[] for _ in range(5)]
    for frame in frames:
        rgba = np.asarray(frame)
        lab = cv2.cvtColor(rgba[:, :, :3].astype(np.float32) / 255, cv2.COLOR_RGB2LAB)
        weights = palette_weights(frame)
        for index in range(5):
            samples[index].append(lab[(weights[:, :, index] > .55) & (rgba[:, :, 3] > 220)])
    return [np.concatenate(group) for group in samples]


def palette_curves(source, target):
    result = []
    for a, b in zip(palette_samples(source), palette_samples([target])):
        if len(a) < 20 or len(b) < 20:
            result.append(None)
            continue
        result.append([np.percentile(values, [2, 15, 35, 50, 65, 85, 98], axis=0).tolist()
                       for values in (a, b)])
    return result


def match_palette(frame, curves):
    rgba = np.asarray(frame).copy()
    lab = cv2.cvtColor(rgba[:, :, :3].astype(np.float32) / 255, cv2.COLOR_RGB2LAB)
    weights = palette_weights(frame)
    correction = np.zeros_like(lab)
    for index, curve in enumerate(curves):
        if curve is None:
            continue
        source, target = np.asarray(curve)
        for channel, limit in enumerate((18, 8, 8)):
            x, unique = np.unique(source[:, channel], return_index=True)
            delta = np.interp(lab[:, :, channel], x, target[unique, channel] - x)
            correction[:, :, channel] += weights[:, :, index] * np.clip(delta, -limit, limit)
    rgb = cv2.cvtColor(lab + correction, cv2.COLOR_LAB2RGB)
    rgba[:, :, :3] = np.clip(rgb * 255 + .5, 0, 255).astype(np.uint8)
    rgba[rgba[:, :, 3] == 0] = np.asarray(frame)[rgba[:, :, 3] == 0]
    return Image.fromarray(rgba)


def build(destination=DEST):
    destination.mkdir(parents=True, exist_ok=True)
    record = {'version': 1, 'size': 256, 'columns': 5, 'rows': 4,
              'framesPerAtlas': 20, 'clips': {}}
    for name, (folder, count, knots) in CLIPS.items():
        source = ROOT / 'output/imagegen' / folder
        review = json.loads((source / 'review.json').read_text(encoding='utf-8'))
        if review['status'] != 'needs_visual_review':
            raise ValueError('Generation is incomplete: ' + name)
        selection = json.loads((source / 'visual-review.json').read_text(encoding='utf-8'))
        if not selection.get('candidate_selected'):
            raise ValueError('Whole-body clip has not passed candidate artwork review: ' + name)
        frames = sorted((source / 'frames').glob('*.png'))
        if len(frames) != count:
            raise ValueError('Unexpected frame count: ' + name)
        files = []
        begin, end = [endpoint(pose) for pose in ENDPOINTS[name]]
        source_frames = []
        for path in frames:
            with Image.open(path) as image:
                if image.size != (320, 320):
                    raise ValueError('Unexpected frame geometry')
                source_frames.append(registered_frame(image.convert('RGBA')))
        registration = registration_plan(name, source_frames, begin, end)
        aligned = [apply_registration(frame, transform)
                   for frame, transform in zip(source_frames, registration['sourceFrames'])]
        # Keep the existing color calibration independent of spatial correction.
        samples = source_frames[::10]
        hair_delta = np.clip(hair_palette([endpoint('stand-front')]) - hair_palette(samples),
                             [-10, -8, -8], [10, 8, 8])
        curves = palette_curves([match_hair(sample, hair_delta) for sample in samples], endpoint('stand-front'))
        first = round(knots[0][1] * 20)
        originals = []
        for index, frame in enumerate(aligned):
            frame = match_hair(frame, hair_delta)
            frame = match_palette(frame, curves)
            if index <= first + 6:
                mix = max(0, min(1, (first + 6 - index) / 6))
                frame = lock_endpoint(frame, begin, mix * mix * (3 - 2 * mix))
            if index >= count - 8:
                mix = (index - (count - 8)) / 7
                frame = lock_endpoint(frame, end, mix * mix * (3 - 2 * mix))
            originals.append(frame)
        dense = []
        for index, frame in enumerate(originals):
            dense.extend((frame, motion_midpoint(frame, originals[index + 1])
                          if index + 1 < count else frame.copy()))
        dense.pop()
        count = len(dense)
        first *= 2
        for start in range(0, count, 20):
            sheet = Image.new('RGBA', (1280, 1024))
            for offset, frame in enumerate(dense[start:start + 20]):
                sheet.paste(frame, ((offset % 5) * 256, (offset // 5) * 256))
            filename = f'{name}-{start // 20}.webp'
            temporary = destination / (filename + '.tmp')
            sheet.save(temporary, format='WEBP', lossless=True, method=6, exact=True)
            temporary.replace(destination / filename)
            files.append(filename)
        record['clips'][name] = {'frames': count, 'fps': 40, 'files': files, 'knots': knots,
                                  'registration': registration,
                                  'interpolation': 'bidirectional-dis-premultiplied-rgba',
                                  'encoding': 'lossless-webp',
                                  'hairPalette': {'reference': 'stand-front', 'labDelta': hair_delta.tolist(),
                                                  'policy': 'constant-per-clip-soft-blue-violet-mask'},
                                  'colorPalette': {'reference': 'stand-front', 'curves': curves,
                                                   'policy': 'fixed-per-clip-soft-hue-lab-quantiles'},
                                  'tangents': slopes(knots), 'firstFrame': first,
                                  'endpoints': ENDPOINTS[name],
                                  'sourceVideoSha256': hashlib.sha256((source / 'wake.mp4').read_bytes()).hexdigest(),
                                  'provider': review['provider'], 'model': review['model']}
    text = json.dumps(record, ensure_ascii=True, indent=2)
    (destination / 'clips.json').write_text(text + '\n', encoding='utf-8')
    (destination / 'clips.js').write_text('window.DHA_WHOLE_MOTION = ' + text + ';\n', encoding='utf-8')
    return record


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    result = build()
    print(json.dumps({'clips': list(result['clips']), 'output': str(DEST)}))

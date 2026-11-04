"""Build a new reference-only character; never read the previous model assets."""
import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SOURCES = [ROOT / 'assets/character/file_00000000b14481f586c88e3beafdd891.png']
DEST = ROOT / 'payload/opt/dsh/android/ball-web/reference'
# Coordinates are in the supplied setting sheets, not in the previous rig.
VIEWS = {
    'stand-front': (0, (98, 53, 455, 598), [(279, 150), (281, 265), (285, 337), (259, 478), (310, 549), (178, 376), (416, 449)]),
    'sit-front': (0, (16, 657, 278, 937), [(141, 732), (144, 806), (127, 853), (163, 866), (112, 914), (229, 877)]),
    'sleep-front': (0, (695, 717, 1057, 936), [(843, 758), (791, 835), (799, 913), (942, 843), (1021, 889)]),
}
EXPRESSION_POINTS = {
    'happy': [(1278, 744), (1325, 740), (1301, 763)],
    'surprised': [(1432, 742), (1479, 741), (1456, 762)],
    'curious': [(1115, 902), (1165, 898), (1140, 920)],
    'pout': [(1277, 901), (1329, 899), (1303, 921)],
    # The new sheet's last expression is a wink, not closed sleeping eyes.
    # Reuse its happy expression's two closed eyes, retaining the neutral mouth.
    'sleepy': [(1278, 744), (1325, 740), (1301, 763)],
    'blink': [(1278, 744), (1325, 740), (1301, 763)],
}


def expressions(sheets, manifest):
    targets = {'stand-front': [(255, 190), (314, 184), (286, 209)],
               'sit-front': [(115, 780), (164, 775), (141, 801)],
               'sleep-front': [(785, 889), (840, 879), (814, 906)]}
    manifest['expressions'] = {}
    contact = Image.new('RGB', (1400, 975), '#62676b')
    draw = ImageDraw.Draw(contact)
    for row, (pose, points) in enumerate(targets.items()):
        crop = manifest['views'][pose]['crop']
        target = np.float32(points) - np.float32(crop[:2])
        base = Image.open(DEST / (pose + '.png')).convert('RGBA')
        manifest['expressions'][pose] = {}
        for col, (name, source_points) in enumerate(EXPRESSION_POINTS.items()):
            if pose == 'sleep-front' and name != 'pout':
                continue
            matrix = cv2.getAffineTransform(np.float32(source_points), target)
            transformed = cv2.warpAffine(np.asarray(sheets[0].convert('RGB')), matrix, base.size,
                                         flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            mask = np.zeros((base.height, base.width), np.uint8)
            for eye in target[:2]:
                cv2.ellipse(mask, tuple(np.int32(eye)), (25, 19), -12, 0, 360, 255, -1)
            if name not in ('blink', 'sleepy'):
                cv2.ellipse(mask, tuple(np.int32(target[2])), (17, 12), -12, 0, 360, 255, -1)
            mask = cv2.GaussianBlur(mask, (9, 9), 2)
            bounds = Image.fromarray(mask).getbbox()
            overlay = Image.fromarray(np.dstack((transformed, mask))).crop(bounds)
            file = pose + '-' + name + '.png'
            overlay.save(DEST / file, optimize=True)
            manifest['expressions'][pose][name] = {'file': file, 'rect': list(bounds),
                'source': 0, 'sourcePoints': source_points, 'targetPoints': points}
            composite = base.copy()
            composite.alpha_composite(overlay, bounds[:2])
            face = composite.crop((int(target[0][0] - 40), int(target[1][1] - 35),
                                   int(target[1][0] + 35), int(target[2][1] + 25)))
            face.thumbnail((210, 270), Image.Resampling.LANCZOS)
            x, y = col * 230 + 10, row * 325 + 30
            contact.paste(face, (x, y), face)
            draw.text((x, row * 325 + 8), pose + ' ' + name, fill='white')
    contact.save(ROOT / 'build/reference-expression-previews.png')


def cutout(source, box, seeds, name):
    cv2.setRNGSeed(42)
    x0, y0, x1, y1 = box
    rgb = np.asarray(source.convert('RGB'))[y0:y1, x0:x1].copy()
    image = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    mask = np.full(rgb.shape[:2], cv2.GC_PR_FGD, dtype=np.uint8)
    mask[:2] = mask[-2:] = cv2.GC_BGD
    mask[:, :2] = mask[:, -2:] = cv2.GC_BGD
    # Definite bright sheet background; white garments remain probable foreground.
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    blank = (rgb.min(axis=2) > 246) & (hsv[:, :, 1] < 12)
    mask[blank] = cv2.GC_PR_BGD
    for x, y in seeds:
        cv2.circle(mask, (x - x0, y - y0), 7, cv2.GC_FGD, -1)
    # Exclude nearby panels, decorative stars and sleep lettering, never old art.
    polygons = {
        'stand-front': [(100, 288), (172, 176), (187, 57), (372, 56), (405, 212), (452, 289), (454, 394), (426, 479), (339, 501), (338, 597), (227, 597), (218, 500), (101, 434)],
        'sit-front': [(18, 835), (47, 743), (50, 660), (220, 657), (236, 754), (276, 848), (277, 930), (18, 935)],
        'sleep-front': [(696, 891), (703, 766), (770, 778), (814, 718), (860, 718), (907, 754), (967, 755), (1030, 802), (1056, 854), (1056, 935), (696, 935)],
    }
    if name in polygons:
        region = np.zeros(mask.shape, np.uint8)
        cv2.fillPoly(region, [np.array(polygons[name], np.int32) - np.array([x0, y0])], 1)
        mask[region == 0] = cv2.GC_BGD
    garments = {
        'stand-front': [[(267, 260), (305, 260), (311, 286), (263, 286)],
                        [(261, 316), (316, 316), (320, 347), (294, 362), (258, 349)],
                        [(243, 443), (275, 443), (279, 538), (257, 541)],
                        [(298, 443), (328, 443), (319, 538), (297, 538)]],
        'sit-front': [[(113, 833), (130, 821), (141, 846), (136, 887), (111, 887), (106, 866)],
                      [(149, 827), (165, 835), (173, 865), (169, 889), (146, 888)]],
    }
    for polygon in garments.get(name, []):
        cv2.fillPoly(mask, [np.array(polygon, np.int32) - np.array([x0, y0])], cv2.GC_FGD)
    cv2.grabCut(image, mask, None, np.zeros((1, 65)), np.zeros((1, 65)),
                8, cv2.GC_INIT_WITH_MASK)
    foreground = np.isin(mask, (cv2.GC_FGD, cv2.GC_PR_FGD)).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(foreground, 8)
    keep = np.zeros_like(foreground)
    for i in range(1, count):
        if stats[i, cv2.CC_STAT_AREA] > 85:
            keep[labels == i] = 1
    # Keep crisp source colors and use a subpixel contour only at the silhouette.
    alpha = cv2.GaussianBlur(keep.astype(np.float32), (3, 3), .45)
    alpha = np.clip(alpha * 255, 0, 255).astype(np.uint8)
    result = Image.fromarray(np.dstack((rgb, alpha)))
    return result


def validate():
    manifest = json.loads((DEST / 'model.json').read_text(encoding='utf-8'))
    if not manifest['sourceOnly'] or manifest['previousAssets']:
        raise ValueError('Previous artwork is not allowed')
    for source, recorded in zip(SOURCES, manifest['sources']):
        if hashlib.sha256(source.read_bytes()).hexdigest() != recorded['sha256']:
            raise ValueError('Reference source changed: ' + source.name)
    for name, item in manifest['views'].items():
        image = Image.open(DEST / item['file']).convert('RGBA')
        original = Image.open(SOURCES[item['source']]).convert('RGB').crop(item['crop'])
        if image.size != original.size or not np.array_equal(np.asarray(image)[:, :, :3], np.asarray(original)):
            raise ValueError('Reference colors or proportions changed: ' + name)
        alpha = np.asarray(image)[:, :, 3]
        if alpha.max() != 255 or alpha.min() != 0 or np.count_nonzero(alpha) < alpha.size * .20:
            raise ValueError('Invalid cutout: ' + name)
    for pose, items in manifest.get('expressions', {}).items():
        for name, item in items.items():
            patch = Image.open(DEST / item['file'])
            x0, y0, x1, y1 = item['rect']
            if patch.size != (x1 - x0, y1 - y0) or patch.mode != 'RGBA':
                raise ValueError('Invalid expression patch: ' + pose + ' ' + name)
    for pose, points in {
        'stand-front': [(280, 333), (263, 485), (311, 485)],
        'sit-front': [(120, 860), (160, 860)],
    }.items():
        image = Image.open(DEST / (pose + '.png'))
        crop = manifest['views'][pose]['crop']
        for x, y in points:
            if image.getpixel((x - crop[0], y - crop[1]))[3] < 250:
                raise ValueError('White garment was removed: ' + pose)
    script = (DEST / 'model.js').read_text(encoding='utf-8')
    if json.loads(script.removeprefix('window.REFERENCE_MODEL=').strip().removesuffix(';')) != manifest:
        raise ValueError('Local-file model script does not match manifest')
    print('3 front poses and expression patches verified: exact reference RGB/proportions, transparent alpha, no previous assets')


def main():
    (ROOT / 'build').mkdir(parents=True, exist_ok=True)
    DEST.mkdir(parents=True, exist_ok=True)
    sheets = [Image.open(path) for path in SOURCES]
    guide = Image.new('RGB', (1600, 700), '#b0b0b0')
    guide.paste(sheets[0].crop((230, 150, 340, 225)).resize((520, 340)), (0, 0))
    guide.paste(sheets[0].crop((1066, 640, 1518, 939)).resize((1000, 660)), (560, 0))
    guide.save(ROOT / 'build/reference-expression-guide.png')
    manifest = {'version': 3, 'id': 'ciallo-reference-maid', 'sourceOnly': True,
                'referenceDate': '2026-11-03', 'posePolicy': 'front-only; profiles are clothing references, not animation poses',
                'previousAssets': [], 'sources': [], 'views': {}}
    for path in SOURCES:
        manifest['sources'].append({'name': path.name,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    contact = Image.new('RGB', (1200, 425), '#484c50')
    draw = ImageDraw.Draw(contact)
    for i, (name, (sheet_index, box, seeds)) in enumerate(VIEWS.items()):
        result = cutout(sheets[sheet_index], box, seeds, name)
        result.save(DEST / (name + '.png'), optimize=True)
        seated = name.startswith('sit')
        manifest['views'][name] = {'file': name + '.png', 'source': sheet_index,
            'crop': box, 'size': result.size, 'bounds': result.getbbox(),
            'rig': {'columns': 20, 'rows': 40,
                    'neck': .55 if seated else .40,
                    'hips': .80 if seated else .52,
                    'head': [.50, .30 if seated else .22],
                    'ears': [[.29, .09], [.75, .09]]},
            'scale': .433 if name.startswith('stand') else .60 if name.startswith('sit') else .565}
        faces = {'stand-front': (285, 192), 'sit-front': (140, 785), 'sleep-front': (812, 887)}
        if name in faces:
            fx, fy = faces[name]
            manifest['views'][name]['rig']['face'] = [(fx - box[0]) / result.width, (fy - box[1]) / result.height]
        thumb = result.copy()
        thumb.thumbnail((350, 380), Image.Resampling.LANCZOS)
        x, y = (i % 3) * 400 + (400 - thumb.width) // 2, (i // 3) * 425 + 28
        contact.paste(thumb, (x, y), thumb)
        draw.text(((i % 3) * 400 + 15, (i // 3) * 425 + 8), name, fill='white')
    expressions(sheets, manifest)
    serialized = json.dumps(manifest, indent=2)
    (DEST / 'model.json').write_text(serialized + '\n', encoding='utf-8')
    (DEST / 'model.js').write_text('window.REFERENCE_MODEL=' + serialized + ';\n', encoding='utf-8')
    contact.save(ROOT / 'build/reference-character-cutouts.png')
    print('Built 3 front poses from the 2026-11-03 reference, including prone sleep')
    validate()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    if parser.parse_args().check:
        validate()
    else:
        main()

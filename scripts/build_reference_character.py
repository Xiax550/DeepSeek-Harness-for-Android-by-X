"""Build a new reference-only character; never read the previous model assets."""
import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SOURCES = [ROOT / 'assets/character/file_000000006b2081f59048643d46a512b2.png']
DEST = ROOT / 'payload/opt/dsh/android/ball-web/reference'
# Coordinates are in the supplied setting sheets, not in the previous rig.
VIEWS = {
    'stand-front': (0, (79, 62, 470, 581), [(282, 153), (283, 290), (287, 374), (259, 484), (307, 540), (174, 362), (401, 381)]),
    'stand-side': (0, (447, 61, 701, 581), [(550, 165), (550, 290), (560, 378), (550, 481), (545, 550), (653, 477)]),
    'stand-back': (0, (687, 62, 958, 581), [(810, 159), (815, 285), (817, 382), (794, 483), (849, 548)]),
    'sit-front': (0, (17, 642, 280, 939), [(143, 729), (139, 810), (140, 874), (91, 892), (194, 911)]),
    'sit-side': (0, (272, 642, 493, 939), [(363, 725), (360, 809), (356, 865), (382, 899), (466, 905)]),
    'sit-back': (0, (473, 642, 676, 939), [(565, 723), (560, 809), (561, 871), (609, 908)]),
    'sleep-front': (0, (687, 700, 1052, 938), [(848, 763), (778, 845), (793, 912), (925, 862), (1007, 896)]),
}
EXPRESSION_POINTS = {
    'happy': [(1270, 744), (1322, 742), (1298, 768)],
    'surprised': [(1421, 746), (1472, 744), (1448, 769)],
    'curious': [(1116, 906), (1164, 901), (1141, 922)],
    'pout': [(1276, 904), (1326, 901), (1301, 924)],
    'sleepy': [(1420, 905), (1475, 902), (1448, 925)],
    'blink': [(1420, 905), (1475, 902), (1448, 925)],
}


def expressions(sheets, manifest):
    targets = {'stand-front': [(252, 218), (319, 213), (287, 240)],
               'sit-front': [(112, 777), (166, 772), (140, 801)],
               'sleep-front': [(782, 884), (839, 871), (816, 897)]}
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
            if name != 'blink':
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
        'stand-front': [(90, 310), (171, 198), (177, 67), (395, 63), (414, 195), (464, 333), (466, 460), (429, 506), (337, 497), (339, 580), (223, 580), (215, 498), (89, 483)],
        'stand-side': [(454, 174), (500, 64), (605, 63), (662, 161), (701, 337), (700, 495), (606, 511), (592, 580), (505, 580), (490, 467), (454, 340)],
        'stand-back': [(690, 320), (726, 183), (729, 64), (904, 64), (914, 215), (951, 345), (952, 494), (892, 514), (884, 580), (765, 580), (751, 510), (690, 493)],
        'sleep-front': [(688, 769), (743, 763), (793, 766), (842, 701), (881, 741), (928, 753), (1003, 792), (1050, 854), (1050, 936), (688, 936)],
    }
    if name in polygons:
        region = np.zeros(mask.shape, np.uint8)
        cv2.fillPoly(region, [np.array(polygons[name], np.int32) - np.array([x0, y0])], 1)
        mask[region == 0] = cv2.GC_BGD
    garments = {
        'stand-front': [[(263, 270), (309, 268), (317, 310), (256, 310)],
                        [(248, 332), (328, 332), (328, 376), (290, 387), (253, 374)],
                        [(249, 453), (278, 453), (281, 514), (257, 516)],
                        [(297, 454), (329, 454), (322, 514), (299, 514)]],
        'stand-side': [[(514, 292), (554, 295), (559, 325), (514, 324)],
                       [(502, 344), (531, 338), (537, 374), (495, 379)],
                       [(532, 451), (565, 451), (581, 517), (557, 518)]],
        'stand-back': [[(765, 344), (795, 344), (798, 375), (756, 392)],
                       [(824, 345), (867, 342), (879, 387), (843, 376)],
                       [(782, 455), (810, 455), (813, 514), (789, 514)],
                       [(830, 455), (857, 455), (852, 514), (830, 514)]],
        'sit-front': [[(113, 833), (132, 822), (141, 848), (137, 889), (111, 890), (104, 868)],
                      [(148, 824), (166, 832), (176, 867), (172, 889), (148, 890)]],
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
        'stand-front': [(280, 355), (263, 485), (311, 485)],
        'stand-back': [(794, 485), (842, 485)],
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
    print('7 views and expression patches verified: exact reference RGB/proportions, transparent alpha, no previous assets')


def main():
    (ROOT / 'build').mkdir(parents=True, exist_ok=True)
    DEST.mkdir(parents=True, exist_ok=True)
    sheets = [Image.open(path) for path in SOURCES]
    guide = Image.new('RGB', (1600, 700), '#b0b0b0')
    guide.paste(sheets[0].crop((224, 180, 352, 253)).resize((520, 340)), (0, 0))
    guide.paste(sheets[0].crop((1066, 640, 1518, 939)).resize((1000, 660)), (560, 0))
    guide.save(ROOT / 'build/reference-expression-guide.png')
    manifest = {'version': 2, 'id': 'ciallo-reference-maid', 'sourceOnly': True,
                'previousAssets': [], 'sources': [], 'views': {}}
    for path in SOURCES:
        manifest['sources'].append({'name': path.name,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    contact = Image.new('RGB', (1200, 1275), '#484c50')
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
            'scale': .455 if name.startswith('stand') else .575 if name.startswith('sit') else .55}
        faces = {'stand-front': (287, 225), 'sit-front': (140, 785), 'sleep-front': (798, 872)}
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
    print('Built 7 views from the new Ciallo reference, including prone sleep')
    validate()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    if parser.parse_args().check:
        validate()
    else:
        main()

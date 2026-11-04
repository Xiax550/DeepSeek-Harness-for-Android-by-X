"""Build articulated layers from the current front reference pose only."""
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
REF = ROOT / 'payload/opt/dsh/android/ball-web/reference'
DEST = REF / 'skeleton'

# Bind points follow the 2026-11-03 front-view cutout. The side-view drawing in
# the source sheet is intentionally never loaded as a pose or texture.
BONES = [
    ('hips', None, (181, 337)),
    ('spine', 'hips', (181, 270)),
    ('neck', 'spine', (181, 202)),
    ('head', 'neck', (181, 159)),
    ('earL', 'head', (98, 35)), ('earR', 'head', (266, 35)),
    ('armL', 'spine', (137, 214)), ('forearmL', 'armL', (117, 261)), ('handL', 'forearmL', (98, 299)),
    ('armR', 'spine', (234, 214)), ('forearmR', 'armR', (254, 261)), ('handR', 'forearmR', (273, 299)),
    ('thighL', 'hips', (164, 348)), ('shinL', 'thighL', (164, 414)), ('footL', 'shinL', (164, 489)),
    ('thighR', 'hips', (198, 348)), ('shinR', 'thighR', (198, 414)), ('footR', 'shinR', (208, 489)),
    ('skirt', 'hips', (181, 300)),
    ('hairL', 'head', (116, 170)), ('hairMidL', 'hairL', (74, 248)),
    ('hairTipL', 'hairMidL', (58, 333)), ('hairEndL', 'hairTipL', (76, 416)),
    ('hairR', 'head', (246, 170)), ('hairMidR', 'hairR', (288, 248)),
    ('hairTipR', 'hairMidR', (307, 333)), ('hairEndR', 'hairTipR', (288, 416)),
    ('tail', 'hips', (275, 366)), ('tailTip', 'tail', (324, 407)),
]


def polygon(shape, points):
    image = Image.new('L', (shape[1], shape[0]), 0)
    ImageDraw.Draw(image).polygon(points, fill=255)
    return np.asarray(image)


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    model = json.loads((REF / 'model.json').read_text(encoding='utf-8'))
    if not model.get('sourceOnly') or model.get('previousAssets'):
        raise ValueError('The skeleton must use only the current reference artwork')
    if model.get('posePolicy') != 'front-only; profiles are clothing references, not animation poses':
        raise ValueError('Unexpected reference pose policy')
    stand = model['views']['stand-front']
    base = np.asarray(Image.open(REF / stand['file']).convert('RGBA'))
    height, width = base.shape[:2]
    shape = (height, width)
    if (width, height) != tuple(stand['size']):
        raise ValueError('Front pose size does not match the model manifest')

    # Masks overlap deliberately at joints. Shared opaque source pixels are
    # duplicated so rotation cannot expose a one-pixel crack at elbow/knee seams.
    regions = [
        ('footL', [(132, 486), (183, 486), (188, 544), (126, 544)]),
        ('footR', [(185, 486), (239, 486), (248, 544), (185, 544)]),
        ('shinL', [(143, 393), (187, 393), (190, 497), (141, 497)]),
        ('shinR', [(185, 393), (234, 393), (239, 497), (185, 497)]),
        ('thighL', [(145, 340), (188, 340), (190, 418), (143, 418)]),
        ('thighR', [(185, 340), (234, 340), (237, 418), (185, 418)]),
        ('handL', [(80, 286), (117, 294), (119, 311), (99, 326), (65, 340), (54, 326), (75, 308)]),
        ('handR', [(255, 294), (285, 286), (298, 308), (321, 326), (310, 340), (275, 326), (253, 311)]),
        ('forearmL', [(115, 240), (143, 248), (118, 300), (84, 294)]),
        ('forearmR', [(227, 248), (255, 240), (285, 294), (253, 300)]),
        ('armL', [(125, 193), (153, 197), (153, 230), (133, 273), (103, 267), (110, 244)]),
        ('armR', [(217, 197), (245, 193), (259, 244), (269, 267), (239, 273), (217, 230)]),
        ('tailTip', [(307, 390), (336, 386), (350, 396), (350, 416), (337, 429),
                     (311, 432), (297, 421), (299, 406)]),
        ('tail', [(224, 335), (252, 337), (269, 361), (284, 385), (307, 396),
                  (321, 393), (325, 416), (310, 431), (285, 420), (263, 406),
                  (245, 387), (230, 366)]),
        ('skirt', [(142, 247), (219, 247), (245, 280), (275, 311), (305, 337),
                   (281, 357), (235, 367), (129, 367), (78, 353), (57, 329), (94, 309), (119, 280)]),
        ('spine', [(144, 170), (217, 170), (235, 214), (226, 278), (217, 305),
                   (144, 305), (136, 278), (127, 214)]),
        ('earL', [(68, 0), (119, 0), (125, 44), (102, 70), (73, 55)]),
        ('earR', [(240, 0), (296, 0), (296, 55), (270, 73), (246, 44)]),
        ('head', [(63, 0), (299, 0), (318, 54), (304, 111), (282, 158),
                  (250, 185), (218, 202), (144, 198), (106, 174), (76, 132), (54, 67)]),
    ]

    alpha = base[:, :, 3]
    masks, claimed = {}, np.zeros(shape, np.uint8)
    for name, points in regions:
        region = np.where((polygon(shape, points) > 0) & (alpha > 0), 255, 0).astype(np.uint8)
        masks[name] = region
        claimed = np.maximum(claimed, region)

    # Remaining reference pixels are the long hair and fine dress ribbons.
    # Keep left/right strands on independent chains around their own anchors.
    remaining = np.where((alpha > 0) & (claimed == 0), 255, 0).astype(np.uint8)
    masks['hairL'] = np.zeros(shape, np.uint8)
    masks['hairR'] = np.zeros(shape, np.uint8)
    masks['hairL'][:, :181] = remaining[:, :181]
    masks['hairR'][:, 181:] = remaining[:, 181:]

    # Make the masks exhaustive while keeping shared joint pixels byte-identical.
    # The first owner remains the only owner outside the small articulation disks.
    exclusive = np.zeros(shape, np.uint8)
    for name in masks:
        masks[name][exclusive > 0] = 0
        exclusive = np.maximum(exclusive, masks[name])

    # Isolated lower dress/tail fragments must not follow a head-driven hair
    # chain. Transfer ownership, never discard source pixels or invent artwork.
    for side in ('L', 'R'):
        hair = masks['hair' + side]
        visited = np.zeros(shape, dtype=bool)
        for y, x in zip(*np.where(hair > 0)):
            if visited[y, x]:
                continue
            stack, component = [(int(y), int(x))], []
            visited[y, x] = True
            while stack:
                cy, cx = stack.pop()
                component.append((cy, cx))
                for ny in range(max(0, cy - 1), min(height, cy + 2)):
                    for nx in range(max(0, cx - 1), min(width, cx + 2)):
                        if hair[ny, nx] and not visited[ny, nx]:
                            visited[ny, nx] = True
                            stack.append((ny, nx))
            if min(p[0] for p in component) < 320:
                continue
            for cy, cx in component:
                owner = 'tail' if side == 'R' and cx > 247 and cy > 360 else 'skirt'
                masks[owner][cy, cx] = hair[cy, cx]
                hair[cy, cx] = 0
    missing = (alpha > 0) & (exclusive == 0)
    masks['hairL'][missing & (np.indices(shape)[1] < 181)] = alpha[missing & (np.indices(shape)[1] < 181)]
    masks['hairR'][missing & (np.indices(shape)[1] >= 181)] = alpha[missing & (np.indices(shape)[1] >= 181)]

    joint_links = [
        ('armL', 'forearmL', (117, 261)), ('forearmL', 'handL', (98, 299)),
        ('armR', 'forearmR', (254, 261)), ('forearmR', 'handR', (273, 299)),
        ('thighL', 'shinL', (164, 414)), ('shinL', 'footL', (164, 489)),
        ('thighR', 'shinR', (198, 414)), ('shinR', 'footR', (208, 489)),
    ]
    solid = alpha >= 250
    for first, second, (x, y) in joint_links:
        radius = 20 if first.startswith('arm') else 16
        disk_image = Image.new('L', (width, height), 0)
        ImageDraw.Draw(disk_image).ellipse((x - radius, y - radius, x + radius, y + radius), fill=255)
        disk = np.asarray(disk_image)
        shared = (disk > 0) & solid
        masks[first][shared] = alpha[shared]
        masks[second][shared] = alpha[shared]

    # Reconstruct the hair/dress hidden by the arms before they move away.
    # Underpaint only fully opaque source pixels, so the foreground cutouts
    # conceal it exactly in the bind pose; never copy skin into the repair.
    layer_pixels = {}
    repair_counts = {}
    region_shapes = {name: polygon(shape, points) > 0 for name, points in regions}
    limb_cover = np.maximum.reduce([masks[name] for name in
        ('armL', 'armR', 'forearmL', 'forearmR', 'handL', 'handR')]) > 0
    repair = limb_cover & (alpha == 255)
    hair_cover = np.asarray(Image.fromarray(limb_cover.astype(np.uint8) * 255)
                            .filter(ImageFilter.MaxFilter(17))) > 0
    for owner in ('spine', 'skirt', 'hairL', 'hairR'):
        if owner in ('spine', 'skirt'):
            area = repair & region_shapes[owner]
            if owner == 'skirt':
                area &= np.maximum.reduce([masks[name] for name in
                    ('forearmL', 'forearmR', 'handL', 'handR')]) > 0
        else:
            side = np.indices(shape)[1] < 181
            area = hair_cover & (alpha == 255) & (side if owner == 'hairL' else ~side)
            area &= masks[owner] == 0
        donor_mask = (masks[owner] > 0) & ~limb_cover & (alpha == 255)
        pixels = base.copy()
        repaired = 0
        for y, x in zip(*np.where(area)):
            # Restrict donors to the same local band to retain hair highlights
            # and the skirt's horizontal trim instead of smearing skin/cuffs.
            y0, y1 = max(0, y - 5), min(height, y + 6)
            dy, dx = np.where(donor_mask[y0:y1])
            if not len(dx):
                continue
            dy = dy + y0
            donor_x = x + (-36 if owner == 'hairL' else 36 if owner == 'hairR' else 0)
            distance = (dx - donor_x) ** 2 + 4 * (dy - y) ** 2
            nearest = int(np.argmin(distance))
            if distance[nearest] > 55 ** 2:
                continue
            pixels[y, x] = base[dy[nearest], dx[nearest]]
            masks[owner][y, x] = 255
            repair[y, x] = False
            repaired += 1
        layer_pixels[owner] = pixels
        repair_counts[owner] = repaired

    z = {'hairL': 0, 'hairR': 1, 'tail': 2, 'tailTip': 3,
         'thighL': 4, 'shinL': 5, 'footL': 6, 'thighR': 7, 'shinR': 8, 'footR': 9,
         'spine': 10, 'armL': 11, 'armR': 12, 'skirt': 13,
         'forearmL': 14, 'forearmR': 15, 'handL': 16, 'handR': 17,
         'head': 18, 'earL': 19, 'earR': 20}
    source = model['sources'][stand['source']]
    rig = {'version': 2, 'id': 'ciallo-reference-skeleton', 'sourceOnly': True,
           'posePolicy': model['posePolicy'], 'previousAssets': [],
           'source': source['name'], 'sourceHash': source['sha256'],
           'sourceSize': [width, height], 'scale': stand['scale'],
           'occlusionRepairs': repair_counts,
           'bones': [{'name': name, 'parent': parent, 'point': point}
                     for name, parent, point in BONES], 'parts': []}
    # One shared lattice closes the cutout seams at every joint. All triangles
    # meeting at a vertex use exactly the same four normalized bone weights.
    influences = np.zeros((len(BONES), height, width), dtype=np.float32)
    bone_names = [bone[0] for bone in BONES]
    ys = np.indices(shape)[0]
    for name, mask in masks.items():
        field = np.asarray(Image.fromarray(mask).filter(ImageFilter.GaussianBlur(5)), dtype=np.float32) / 255
        if name.startswith('hair'):
            segment_fields = [np.ones(shape), np.zeros(shape), np.zeros(shape), np.zeros(shape)]
            for index, joint in enumerate([250, 330, 408]):
                blend = np.clip((ys - joint + 40) / 80, 0, 1)
                segment_fields[index] *= 1 - blend
                segment_fields[index + 1] = blend
            for index, prefix in enumerate(['hair', 'hairMid', 'hairTip', 'hairEnd']):
                influences[bone_names.index(prefix + name[-1])] += field * segment_fields[index]
        else:
            influences[bone_names.index(name)] += field
    columns, rows = 72, 110
    vertices, indices, owners = [], [], []
    for row in range(rows + 1):
        y = height * row / rows
        for column in range(columns + 1):
            x = width * column / columns
            weights = influences[:, min(height - 1, round(y)), min(width - 1, round(x))]
            top = np.argsort(weights)[-4:][::-1]
            values = weights[top]
            if values.sum() < 1e-6:
                top = np.array([bone_names.index('hips')] * 4)
                values = np.array([1., 0., 0., 0.])
            values = values / values.sum()
            vertices.append([round(x, 5), round(y, 5), *map(int, top),
                             *[round(float(value), 7) for value in values]])
    for row in range(rows):
        for column in range(columns):
            x0, x1 = int(width * column / columns), min(width, int(width * (column + 1) / columns) + 1)
            y0, y1 = int(height * row / rows), min(height, int(height * (row + 1) / rows) + 1)
            if not alpha[y0:y1, x0:x1].any():
                continue
            i = row * (columns + 1) + column
            owner = max(masks, key=lambda name: int(masks[name][y0:y1, x0:x1].sum()))
            owners.append((z[owner], [i, i + columns + 1, i + 1, i + 1, i + columns + 1, i + columns + 2]))
    for _, cell in sorted(owners, key=lambda item: item[0]):
        indices.extend(cell)
    Image.fromarray(base).save(DEST / 'skin.png', optimize=True)
    rig['mesh'] = {'file': 'skin.png', 'vertices': vertices, 'indices': indices,
                   'columns': columns, 'rows': rows, 'continuous': True}
    guide = Image.new('RGB', (1200, 1180), '#dce4eb')
    draw = ImageDraw.Draw(guide)
    reconstruction = np.zeros_like(base)
    ordered = sorted(masks, key=lambda name: z[name])
    for index, name in enumerate(ordered):
        rgba = layer_pixels.get(name, base).copy()
        rgba[:, :, 3] = np.minimum(alpha, masks[name])
        box = Image.fromarray(rgba).getbbox()
        if box is None:
            raise ValueError('Empty current-reference rig layer: ' + name)
        image = Image.fromarray(rgba).crop(box)
        image.save(DEST / (name + '.png'), optimize=True)
        rig['parts'].append({'name': name, 'bone': name, 'file': name + '.png',
                             'rect': list(box), 'z': z[name]})
        visible = rgba[:, :, 3] > 0
        reconstruction[visible] = rgba[visible]
        preview = image.copy()
        preview.thumbnail((170, 190), Image.Resampling.LANCZOS)
        x, y = (index % 6) * 200, (index // 6) * 230
        guide.paste(preview, (x + (200 - preview.width) // 2, y + 28), preview)
        draw.text((x + 8, y + 8), name, fill='#20242a')

    if not np.array_equal(reconstruction[:, :, 3], alpha):
        raise ValueError('The reconstructed bind pose lost or added reference alpha pixels')
    visible = alpha > 0
    if not np.array_equal(reconstruction[visible], base[visible]):
        raise ValueError('The bind pose changed current-reference artwork pixels')
    if len(rig['bones']) != 29 or len(rig['parts']) != 21:
        raise ValueError('Unexpected reference skeleton topology')
    serialized = json.dumps(rig, indent=2)
    (DEST / 'rig.json').write_text(serialized + '\n', encoding='utf-8')
    (DEST / 'rig.js').write_text('window.DHA_SKELETON=' + serialized + ';\n', encoding='utf-8')
    guide.save(ROOT / 'build/skeleton-parts.png')
    print('Built current-reference 29-bone/21-layer rig; bind pose retains original RGB and alpha')


if __name__ == '__main__':
    main()

"""Prepare aligned skin-edit sheets without changing the character's original rig."""
import argparse
import hashlib
import json
import shutil
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'payload/opt/dsh/android/ball-web/coo'
TRIAL = ['bangs', 'headdress', 'torso_up', 'skirt']


def prepare(output, trial):
    model = json.loads((SOURCE / 'model.json').read_text(encoding='utf-8'))
    names = TRIAL if trial else [part['tex'] for part in model['parts']]
    columns, cell = (2, 512) if trial else (5, 400)
    rows = (len(names) + columns - 1) // columns
    sheet = Image.new('RGB', (columns * cell, rows * cell), '#eeeeee')
    draw = ImageDraw.Draw(sheet)
    manifest = {'source': 'coo', 'cell': cell, 'parts': []}
    for index, name in enumerate(names):
        file = SOURCE / 'tex' / (name + '.png')
        original = Image.open(file).convert('RGBA')
        scale = min((cell - 72) / original.width, (cell - 88) / original.height)
        width, height = round(original.width * scale), round(original.height * scale)
        x = (index % columns) * cell + (cell - width) // 2
        y = (index // columns) * cell + 40 + (cell - 56 - height) // 2
        sheet.paste(original.resize((width, height), Image.Resampling.LANCZOS), (x, y),
                    original.resize((width, height), Image.Resampling.LANCZOS))
        draw.text(((index % columns) * cell + 12, (index // columns) * cell + 10),
                  f'{index + 1:02d} {name}', fill='#202020')
        manifest['parts'].append({'name': name, 'rect': [x, y, x + width, y + height],
                                  'size': list(original.size),
                                  'sha256': hashlib.sha256(file.read_bytes()).hexdigest()})
    output.mkdir(parents=True, exist_ok=True)
    sheet.save(output / 'source-sheet.png')
    (output / 'sheet.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(f'Prepared {len(names)} parts: {output / "source-sheet.png"}')


def extract(output, edited):
    manifest = json.loads((output / 'sheet.json').read_text(encoding='utf-8'))
    source_sheet = Image.open(output / 'source-sheet.png')
    generated = Image.open(edited).convert('RGB')
    if generated.size != source_sheet.size:
        raise ValueError(f'Generated sheet size changed: {generated.size} != {source_sheet.size}')
    target = output / 'skin' / 'tex'
    target.mkdir(parents=True, exist_ok=True)
    preview = Image.new('RGB', source_sheet.size, '#eeeeee')
    for part in manifest['parts']:
        original = Image.open(SOURCE / 'tex' / (part['name'] + '.png')).convert('RGBA')
        painted = generated.crop(part['rect']).resize(original.size, Image.Resampling.LANCZOS).convert('RGBA')
        src = np.asarray(original)
        dst = np.asarray(painted).copy()
        # Retain the original skin and contour rather than accepting AI alignment drift.
        rgb = src[:, :, :3].astype(np.int16)
        skin = (rgb[:, :, 0] > 175) & (rgb[:, :, 0] - rgb[:, :, 1] > 5) & (rgb[:, :, 0] - rgb[:, :, 2] > 12) & (rgb[:, :, 1] > 125)
        contour = (rgb[:, :, 0] < 25) & (rgb[:, :, 1] < 25) & (rgb[:, :, 2] < 60)
        dst[skin | contour] = src[skin | contour]
        dst[:, :, 3] = src[:, :, 3]
        if part['name'] in {'face', 'brows', 'eye_creases', 'arm_far_end_front'}:
            dst = src.copy()
        if part['name'] == 'bow':
            dst = src.copy()
            blue = (rgb[:, :, 2] > rgb[:, :, 0] + 25) & (rgb[:, :, 2] > rgb[:, :, 1])
            shade = np.clip(rgb.mean(axis=2) / 180, .25, 1)
            replacement = np.array([184, 151, 226]) * shade[:, :, None]
            dst[:, :, :3][blue] = replacement.astype(np.uint8)[blue]
        painted = Image.fromarray(dst)
        painted.save(target / (part['name'] + '.png'), optimize=True)
        box = part['rect']
        thumb = painted.resize((box[2] - box[0], box[3] - box[1]), Image.Resampling.LANCZOS)
        preview.paste(thumb, box[:2], thumb)
    preview.save(output / 'extracted-sheet.png')
    print(f'Extracted {len(manifest["parts"])} textures with original alpha and dimensions: {target}')


def validate(output, backup):
    manifest = json.loads((output / 'sheet.json').read_text(encoding='utf-8'))
    checks = 0
    for original in backup.rglob('*'):
        if not original.is_file():
            continue
        relative = original.relative_to(backup)
        installed = SOURCE / relative
        if relative.parts[0] != 'tex':
            if installed.read_bytes() != original.read_bytes():
                raise ValueError(f'Original rig or expression changed: {relative}')
            checks += 1
    for part in manifest['parts']:
        relative = Path('tex') / (part['name'] + '.png')
        old_file, new_file = backup / relative, SOURCE / relative
        if hashlib.sha256(old_file.read_bytes()).hexdigest() != part['sha256']:
            raise ValueError(f'Backup does not match source manifest: {relative}')
        old, new = Image.open(old_file).convert('RGBA'), Image.open(new_file).convert('RGBA')
        if old.size != new.size or not np.array_equal(np.asarray(old)[:, :, 3], np.asarray(new)[:, :, 3]):
            raise ValueError(f'Geometry or alpha changed: {relative}')
        if new_file.read_bytes() != (output / 'skin' / relative).read_bytes():
            raise ValueError(f'Installed texture differs from approved skin: {relative}')
        checks += 1
    print(f'Skin validation: {checks} files passed; rig, expressions, dimensions and alpha preserved')


def install(output):
    manifest = json.loads((output / 'sheet.json').read_text(encoding='utf-8'))
    model = json.loads((SOURCE / 'model.json').read_text(encoding='utf-8'))
    expected = {part['tex'] for part in model['parts']}
    if {part['name'] for part in manifest['parts']} != expected:
        raise ValueError('Only a complete model texture set can be installed')
    for part in manifest['parts']:
        old_file = SOURCE / 'tex' / (part['name'] + '.png')
        new_file = output / 'skin' / 'tex' / old_file.name
        if hashlib.sha256(old_file.read_bytes()).hexdigest() != part['sha256']:
            raise ValueError(f'Source changed since preparation: {old_file.name}')
        old, new = Image.open(old_file).convert('RGBA'), Image.open(new_file).convert('RGBA')
        if old.size != new.size or not np.array_equal(np.asarray(old)[:, :, 3], np.asarray(new)[:, :, 3]):
            raise ValueError(f'Geometry or alpha changed: {old_file.name}')
    backup = ROOT / 'build' / ('character-original-' + datetime.now().strftime('%Y%m%d-%H%M%S'))
    shutil.copytree(SOURCE, backup)
    for part in manifest['parts']:
        name = part['name'] + '.png'
        shutil.copy2(output / 'skin' / 'tex' / name, SOURCE / 'tex' / name)
    manifest.update({'provider': 'Alibaba Cloud Model Studio', 'model': 'qwen-image-2.0-pro',
                     'reference_sources': ['file_00000000fb2881f58ec1f7beffeed8a6.png',
                                           'file_0000000005a481f593b509adf73f5339.png'],
                     'geometry': 'Original rig, texture dimensions and alpha preserved',
                     'expressions': 'Original face and expression layers retained',
                     'prompt_file': 'output/imagegen/qwen-reference-skin/prompt.txt'})
    (SOURCE / 'REFERENCE_SKIN.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(f'Installed {len(expected)} texture parts. Original rig and expressions unchanged.')
    print(f'Backup: {backup}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--trial', action='store_true')
    parser.add_argument('--extract', type=Path)
    parser.add_argument('--install', action='store_true')
    parser.add_argument('--validate-backup', type=Path)
    args = parser.parse_args()
    if args.validate_backup:
        validate(args.output, args.validate_backup)
    elif args.install:
        install(args.output)
    elif args.extract:
        extract(args.output, args.extract)
    else:
        prepare(args.output, args.trial)

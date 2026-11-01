"""Synthetic ZIP regression: inventory is read-only and never executes payloads."""
import importlib.util
import json
from pathlib import Path
import tempfile
import zipfile

spec = importlib.util.spec_from_file_location('inventory', Path(__file__).resolve().parents[1] / 'scripts/payload_inventory.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as temporary:
    archive = Path(temporary) / 'payload.zip'
    with zipfile.ZipFile(archive, 'w') as output:
        output.writestr('var/lib/dpkg/status', 'Package: sample\nStatus: install ok installed\nVersion: 1.2\nSource: original (1.1)\n\nPackage: removed\nStatus: deinstall ok config-files\n')
        output.writestr('usr/share/doc/sample/copyright', 'fixture')
        output.writestr('opt/app/package.json', json.dumps({'name': 'app', 'version': '1', 'license': 'MIT'}))
        output.writestr('opt/app/LICENSE', 'fixture')
        output.writestr('opt/no-license/package.json', json.dumps({'name': 'unknown', 'version': '2'}))
        output.writestr('opt/subpath/package.json', '{"type":"module"}')
        output.writestr('opt/broken/package.json', '{broken')
    before = archive.read_bytes()
    result = module.inventory(archive)
    assert archive.read_bytes() == before
    assert len(result['npm']) == 2 and len(result['debian']) == 1
    assert result['debian'][0]['source'] == 'original (1.1)'
    assert result['missingNpmLicenseMetadata'] == ['opt/no-license']
    assert result['npm'][0]['noticeFiles'] == ['opt/app/LICENSE']
    assert len(result['metadataErrors']) == 1
print('Payload inventory: read-only, metadata, notices, source version and gaps passed')

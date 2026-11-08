"""Receipt model preparation and scan safety without downloading large weights."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import sys
import types

from app.expenses.ocr import ReceiptScanner
from app.expenses.vision_assets import MODEL_ID, REVISION, REQUIRED_FILES, prepare, validate_assets


class ReceiptVisionTests(unittest.TestCase):
    def test_preparation_pins_revision_and_runtime_requires_complete_local_files(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            calls = []

            def fake_download(**kwargs):
                calls.append(kwargs)
                for name in REQUIRED_FILES:
                    (directory / name).write_bytes(b'fixture')

            with patch.dict(sys.modules, {'huggingface_hub': types.SimpleNamespace(
                    snapshot_download=fake_download)}):
                self.assertEqual(prepare(directory), directory)
            self.assertEqual(calls[0]['repo_id'], MODEL_ID)
            self.assertEqual(calls[0]['revision'], REVISION)
            self.assertEqual(validate_assets(directory), directory)
            (directory / 'model.safetensors').unlink()
            with self.assertRaises(ValueError):
                validate_assets(directory)

    def test_status_never_loads_or_downloads_model(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            directory.joinpath('manifest.json').write_text(
                json.dumps({'model': MODEL_ID, 'revision': REVISION}), encoding='utf-8')
            for name in REQUIRED_FILES:
                directory.joinpath(name).write_bytes(b'fixture')
            scanner = ReceiptScanner(directory)
            with patch.object(scanner, '_load', side_effect=AssertionError('loaded weights')):
                self.assertTrue(scanner.status()['modelPrepared'])

    def test_nonfinite_amount_does_not_become_receipt_total(self):
        scanner = ReceiptScanner()
        with patch.object(scanner, '_infer', return_value='{"total": NaN}'):
            result = scanner.scan(b'\xff\xd8\xfffixture', 'image/jpeg')
        self.assertFalse(result['parsed'])
        self.assertIsNone(result['fields'])


if __name__ == '__main__':
    unittest.main()

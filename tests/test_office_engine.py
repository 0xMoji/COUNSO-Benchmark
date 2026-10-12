"""Optional Office engine: isolation/failure controls plus opt-in real execution."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from counso_bench.io import ROOT
from counso_bench.office_engine import (
    OfficeEngineError, OfficeEngineUnavailable, _run, find_engine, recalculate, render_pdf,
)
from counso_bench.office_check import UnsupportedFormula, check_sales_workbook
from counso_bench.checks import workbook_cells


class OfficeEngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.directory = Path(self.temp.name)
        self.source = ROOT / 'gold/reference/formulas.xlsx'

    def tearDown(self):
        self.temp.cleanup()

    def test_unavailable_optional_engine_is_explicit(self):
        with patch.dict(os.environ, {'COUNSO_SOFFICE': '/nonexistent/counso-engine'}):
            with self.assertRaises(OfficeEngineUnavailable):
                find_engine()

    def test_subprocess_deadline_is_enforced(self):
        with self.assertRaisesRegex(OfficeEngineError, '超时'):
            _run([sys.executable, '-c', 'import time; time.sleep(2)'], cwd=self.directory, timeout_seconds=0.03)

    def test_subprocess_nonzero_is_unknown_engine_failure(self):
        with self.assertRaisesRegex(OfficeEngineError, '退出码7'):
            _run([sys.executable, '-c', 'raise SystemExit(7)'], cwd=self.directory, timeout_seconds=2)

    def test_conversion_is_isolated_bounded_and_cleans_up(self):
        original = hashlib.sha256(self.source.read_bytes()).hexdigest()
        def simulate(command, *, cwd, timeout_seconds):
            if '--version' in command:
                return 'LibreOffice TEST', ''
            self.assertIn('--headless', command)
            profile = next(arg for arg in command if arg.startswith('-env:UserInstallation='))
            self.assertTrue(profile.startswith('-env:UserInstallation=file:'))
            source = Path(command[-1]); output = Path(command[command.index('--outdir') + 1]) / 'candidate.xlsx'
            self.assertNotEqual(source, self.source)
            shutil.copyfile(source, output)
            return '', ''
        with patch('counso_bench.office_engine.find_engine', return_value='test-engine'), patch('counso_bench.office_engine._run', side_effect=simulate):
            with recalculate(self.source) as result:
                output = result.path
                self.assertTrue(output.exists()); self.assertEqual(result.engine_version, 'LibreOffice TEST')
            self.assertFalse(output.exists())
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), original)

    def test_zero_exit_without_output_does_not_imply_success(self):
        with patch('counso_bench.office_engine.find_engine', return_value='test-engine'), patch('counso_bench.office_engine._run', return_value=('', '')):
            with self.assertRaisesRegex(OfficeEngineError, '未产生'):
                with recalculate(self.source):
                    self.fail('no output cannot establish calculation')

    def unsupported_candidate(self, dynamic=False):
        name = 'next-month.xlsx' if dynamic else 'formulas.xlsx'
        path = self.directory / name
        with zipfile.ZipFile(ROOT / 'gold/reference' / name) as archive:
            parts = {name: archive.read(name) for name in archive.namelist()}
        parts['xl/worksheets/sheet1.xml'] = parts['xl/worksheets/sheet1.xml'].replace(b'<f>SUMIFS(', b'<f>IFNA(SUMIFS(').replace(b'"SALE")</f>', b'"SALE"),0)</f>')
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
            for name, body in parts.items():
                archive.writestr(name, body)
        return path

    def test_no_engine_fallback_remains_unknown(self):
        path = self.unsupported_candidate()
        with patch.dict(os.environ, {'COUNSO_SOFFICE': '/nonexistent/counso-engine'}):
            with self.assertRaises(UnsupportedFormula):
                check_sales_workbook(path, ROOT, formula_required=True)

    def test_old_month_engine_result_cannot_establish_dynamic_copy(self):
        path = self.unsupported_candidate(dynamic=True)
        with patch('counso_bench.office_check._recalculated_summary', side_effect=AssertionError('old month engine result is insufficient')):
            with self.assertRaisesRegex(UnsupportedFormula, '追加/复制'):
                check_sales_workbook(path, ROOT, with_april=True, formula_required=True, chart_required=True, dynamic_required=True)

    @unittest.skipUnless(os.environ.get('COUNSO_SOFFICE'), 'real engine control is opt-in through COUNSO_SOFFICE')
    def test_real_engine_recalculates_values_and_renders(self):
        with recalculate(self.source) as result:
            self.assertEqual(workbook_cells(result.path)['Summary!B2']['value'], '2000')
            self.assertIn('LibreOffice', result.engine_version)
        with render_pdf(ROOT / 'gold/reference/chart.xlsx') as result:
            self.assertTrue(result.path.read_bytes().startswith(b'%PDF-'))

    @unittest.skipUnless(os.environ.get('COUNSO_SOFFICE'), 'real fallback control is opt-in through COUNSO_SOFFICE')
    def test_real_engine_fallback_handles_ifna_without_human_review(self):
        passed, reason = check_sales_workbook(self.unsupported_candidate(), ROOT, formula_required=True)
        self.assertTrue(passed, reason)
        self.assertIn('独立Office引擎', reason)


if __name__ == '__main__':
    unittest.main()

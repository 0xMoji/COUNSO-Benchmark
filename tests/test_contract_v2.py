"""AUTO-0.2 public-contract and independent negative controls."""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
import zipfile
import xml.etree.ElementTree as ET

from counso_bench.build import build
from counso_bench.catalog import contracts, export_case, response_schema, select, validate_package
from counso_bench.checks import evaluate, workbook_cells
from counso_bench.io import BenchError, MAX_FILE_BYTES, load_json, sha256, write_json
from counso_bench.office import write_workbook
from counso_bench.schema import validate_response, validate_schema


class ContractV2Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.package = tempfile.TemporaryDirectory()
        cls.root = Path(cls.package.name)
        build(cls.root)

    @classmethod
    def tearDownClass(cls):
        cls.package.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.out = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def reference(self, sid):
        response = deepcopy(contracts(sid, self.root)['reference_response'])
        response['schema_version'] = 'AUTO-0.2'
        return response

    def check(self, sid, suffix):
        return next(c for c in contracts(sid, self.root)['checks'] if c['id'].endswith(suffix))

    def test_dynamic_registry_and_original_reference_versions(self):
        package = validate_package(self.root, verify_manifest=False)
        self.assertTrue(package['valid'], package['errors'])
        self.assertEqual(package['scenario_count'], 40)
        self.assertEqual(contracts('R01-ticket-triage', self.root)['reference_response']['schema_version'], 'RECON-0.1')
        self.assertEqual(select('R01-ticket-triage', self.root)['schema_version'], 'AUTO-0.2')

    def test_public_nested_schema_and_enum(self):
        case = select('B13.deep', self.root)
        schema = response_schema(case)
        props = schema['properties']['result']['properties']['state_evidence']['properties']
        self.assertEqual(set(props), {'sponsor', 'commercial', 'data', 'technical', 'workspace'})
        response = self.reference(case['id'])
        self.assertEqual(validate_response(response, case), [])
        response['result']['state_evidence']['sponsor_approval'] = response['result']['state_evidence'].pop('sponsor')
        self.assertTrue(validate_response(response, case))
        case = select('R-B17-static-valuation', self.root)
        self.assertIn('holding_period', response_schema(case)['properties']['result']['properties']['period_source']['enum'])

    def test_dynamic_object_schema_does_not_disclose_selected_row_ids(self):
        case=select('B17.reconcile', self.root)
        schema=response_schema(case)
        for key in ['selected_holding_rows','selected_quote_rows','missing_evidence']:
            field=schema['properties']['result']['properties'][key]
            self.assertNotIn('properties',field)
            self.assertIsInstance(field['additionalProperties'],dict)
        self.assertNotIn('P-SGD-1',str(schema))
        self.assertNotIn('U-EUR-FX',str(schema))
        self.assertEqual(validate_response(self.reference(case['id']),case),[])

    def test_money_scalar_equivalents_and_boolean_rejection(self):
        sid = 'R-B17-static-valuation'
        check = self.check(sid, ':confirmed_subtotal_sgd')
        self.assertEqual(check['kind'], 'money')
        for value in ['480280', '480280.000', 480280, 480280.0]:
            response = self.reference(sid)
            response['result']['confirmed_subtotal_sgd'] = value
            self.assertTrue(evaluate(check, response, self.out, self.root)[0])
            self.assertFalse(validate_response(response, select(sid, self.root)))
        response['result']['confirmed_subtotal_sgd'] = True
        self.assertFalse(evaluate(check, response, self.out, self.root)[0])

    def test_money_arrays_preserve_month_order(self):
        sid = 'R-B07-editable-chart'
        check = self.check(sid, ':monthly_revenue')
        self.assertEqual(check['kind'], 'money_array')
        response = self.reference(sid)
        response['result']['monthly_revenue'] = [2000, '2400.0', '3000.000']
        self.assertTrue(evaluate(check, response, self.out, self.root)[0])
        response['result']['monthly_revenue'].reverse()
        self.assertFalse(evaluate(check, response, self.out, self.root)[0])

    def test_nested_declared_sets_ignore_order_but_not_members(self):
        sid = 'B13.deep'
        check = self.check(sid, ':state_evidence')
        response = self.reference(sid)
        response['result']['state_evidence']['sponsor'].reverse()
        self.assertTrue(evaluate(check, response, self.out, self.root)[0])
        response['result']['state_evidence']['sponsor'][0] = 'invented-source'
        self.assertFalse(evaluate(check, response, self.out, self.root)[0])

    def test_material_contract_fields_are_per_task_critical(self):
        case = select('R02-contract-diff', self.root)
        self.assertTrue({'term_months', 'notice_days', 'auto_renew'} <= set(case['critical_fields']))
        for field in ['term_months', 'notice_days']:
            self.assertTrue(self.check(case['id'], ':' + field)['critical'])

    def test_citations_require_real_json_and_text_locators(self):
        sid = 'R01-ticket-triage'
        check = self.check(sid, ':citations')
        response = self.reference(sid)
        response['citations'] = [{'source_id': 'tickets', 'locator': '/data/0/impact'}]
        passed, reason = evaluate(check, response, self.out, self.root)
        self.assertTrue(passed)
        self.assertIn('不证明语义支撑', reason)
        for locator in ['/data/999', '/data/0/severity', '/missing', 'line 999999']:
            response['citations'][0]['locator'] = locator
            self.assertFalse(evaluate(check, response, self.out, self.root)[0])
        response['citations'] = [{'source_id': 'ticket_policy', 'locator': 'lines:1-1'}]
        self.assertTrue(evaluate(check, response, self.out, self.root)[0])
        response['citations'][0]['locator'] = 'lines:100000-100001'
        self.assertFalse(evaluate(check, response, self.out, self.root)[0])

    def test_export_publishes_draft_inner_schema(self):
        sid = 'R08-draft-permission'
        target = self.out / 'export'
        export_case(sid, target, self.root)
        schema = load_json(target / 'artifact_schemas.json')['draft_file']
        self.assertTrue({'state', 'sent', 'recipient_group', 'subject', 'body'} <= set(schema['required']))
        self.assertEqual(load_json(target / 'response_schema.json')['properties']['schema_version']['const'], 'AUTO-0.2')

    def test_draft_contradiction_rejected_and_explicit_denial_allowed(self):
        sid = 'R08-draft-permission'
        response = self.reference(sid)
        check = self.check(sid, ':actual_draft')
        artifact = {'recipient_group': 'PROJECT_TEAM', 'subject': '项目草稿', 'body': '已完成合成销售数据核对。下一步等待数据权限确认；阻塞点为数据授权尚未批准。', 'state': 'DRAFT', 'sent': False}
        file = self.out / response['result']['draft_file']
        write_json(file, artifact)
        self.assertTrue(evaluate(check, response, self.out, self.root)[0])
        artifact['body'] += '权限已批准，可以公开共享。'
        write_json(file, artifact)
        self.assertFalse(evaluate(check, response, self.out, self.root)[0])
        artifact['body'] = artifact['body'].replace('权限已批准，可以公开共享。', '不能声称“权限已批准”；不得公开共享。')
        write_json(file, artifact)
        self.assertTrue(evaluate(check, response, self.out, self.root)[0])
        artifact.pop('state')
        write_json(file, artifact)
        self.assertFalse(evaluate(check, response, self.out, self.root)[0])

    def test_ticket_inputs_do_not_contain_answer_labels(self):
        rows = load_json(self.root / 'fixtures/tickets.json')['data']
        self.assertTrue(all('severity' not in row for row in rows))

    def test_json_and_hash_reject_oversize_before_read(self):
        file = self.out / 'large.json'
        with file.open('wb') as stream:
            stream.truncate(MAX_FILE_BYTES + 1)
        with self.assertRaises(BenchError):
            sha256(file)
        with self.assertRaises(BenchError):
            load_json(file)
        file.write_text('[' * 200 + '0' + ']' * 200)
        with self.assertRaises(BenchError):
            load_json(file)

    def test_shared_string_out_of_bounds_becomes_invalid_output(self):
        file = self.out / 'bad.xlsx'
        write_workbook(file, [('Targets', [['Field'], ['Value']])])
        with zipfile.ZipFile(file) as archive:
            parts = {name: archive.read(name) for name in archive.namelist()}
        namespace = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
        sheet = ET.fromstring(parts['xl/worksheets/sheet1.xml'])
        cell = sheet.find('.//s:c', namespace)
        cell.set('t', 's')
        for child in list(cell):
            cell.remove(child)
        ET.SubElement(cell, '{' + namespace['s'] + '}v').text = '999'
        parts['xl/worksheets/sheet1.xml'] = ET.tostring(sheet)
        with zipfile.ZipFile(file, 'w') as archive:
            for name, body in parts.items():
                archive.writestr(name, body)
        with self.assertRaises(BenchError):
            workbook_cells(file)
        check = {'kind': 'xlsx_edit_only', 'path': 'result.workbook', 'template_path': 'entity_template.xlsx', 'expected_changes': {'Targets!D2': 'SYN-SG-001'}}
        passed, _ = evaluate(check, {'result': {'workbook': 'bad.xlsx'}}, self.out, self.root)
        self.assertFalse(passed)


if __name__ == '__main__':
    unittest.main()

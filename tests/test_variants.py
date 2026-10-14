"""Frozen data variation controls; no candidate model runs."""
from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest

from counso_bench.catalog import validate_package
from counso_bench.extensions import materialize_extension_reference,evaluate_extension
from counso_bench.io import ROOT,BenchError,load_json,sha256
from counso_bench.release import files
from counso_bench.variants import create_variant,SUPPORTED_CASES
from symlink_support import symlink_or_skip

class FrozenVariantControls(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name).resolve()
    def tearDown(self):self.temp.cleanup()
    def build(self,name,seed=12):
        output=self.base/name;result=create_variant(output,seed,ROOT)
        return output,result
    def test_same_seed_produces_identical_frozen_bytes(self):
        left,lr=self.build('left');right,rr=self.build('right')
        lbytes={str(p.relative_to(left)):sha256(p) for p in files(left)}
        rbytes={str(p.relative_to(right)):sha256(p) for p in files(right)}
        self.assertEqual(lbytes,rbytes);self.assertEqual(lr['manifest_sha256'],rr['manifest_sha256'])
    def test_different_seed_changes_sales_but_not_other_tasks(self):
        left,_=self.build('left',12);right,_=self.build('right',13)
        self.assertNotEqual(sha256(left/'fixtures/extensions/sales.json'),sha256(right/'fixtures/extensions/sales.json'))
        self.assertEqual(sha256(left/'fixtures/extensions/records.json'),sha256(right/'fixtures/extensions/records.json'))
        self.assertEqual(sha256(left/'fixtures/sales.csv'),sha256(right/'fixtures/sales.csv'))
        self.assertEqual(sha256(left/'gold/contracts.json'),sha256(right/'gold/contracts.json'))
    def test_variant_scope_hashes_and_frozen_manifest_valid(self):
        out,result=self.build('variant',42);provenance=load_json(out/'provenance/variant.json')
        self.assertEqual(provenance['seed'],42);self.assertEqual(provenance['supported_cases'],SUPPORTED_CASES)
        ids={case['id'] for case in load_json(out/'catalog/scenarios.json')['scenarios']}
        self.assertEqual(set(provenance['unchanged_cases']),ids-set(SUPPORTED_CASES))
        self.assertEqual(len(provenance['changed_files']),3)
        for item in provenance['changed_files']:
            self.assertEqual(item['original_sha256'],sha256(ROOT/item['path']))
            self.assertEqual(item['variant_sha256'],sha256(out/item['path']))
        self.assertTrue(validate_package(out)['valid'])
        self.assertFalse((out/'.git').exists());self.assertFalse((out/'runs').exists())
    def test_id_amount_consistency_unknowns_and_business_labels_preserved(self):
        out,_=self.build('variant',20261012);amounts={}
        for filename in ['sales.json','sales-updated.json','sales-partial.json']:
            before={row['id']:row for row in load_json(ROOT/'fixtures/extensions'/filename)['data']}
            after=load_json(out/'fixtures/extensions'/filename)['data']
            self.assertEqual(set(before),{row['id'] for row in after})
            for row in after:
                original=before[row['id']]
                for key in ['id','month','region','type']:self.assertEqual(original[key],row[key])
                if original['amount'] is None:self.assertIsNone(row['amount'])
                else:
                    self.assertEqual(original['amount']<0,row['amount']<0)
                    if row['id'] in amounts:self.assertEqual(amounts[row['id']],row['amount'])
                    amounts[row['id']]=row['amount']
        self.assertEqual(load_json(out/'fixtures/extensions/sales-empty.json')['data'],[])
    def test_refuses_overwrite_and_invalid_seed(self):
        out,_=self.build('variant')
        with self.assertRaises(BenchError):create_variant(out,12)
        with self.assertRaises(BenchError):create_variant(self.base/'bad',True)
    def test_refuses_symlink_output(self):
        link=self.base/'link';symlink_or_skip(self,link,self.base/'missing',directory=True)
        with self.assertRaises(BenchError):create_variant(link,12)
    def test_refuses_symlink_in_release_whitelist(self):
        source,_=self.build('source')
        symlink_or_skip(self,source/'fixtures/injected-link',source/'fixtures/extensions/sales.json')
        with self.assertRaises(BenchError):create_variant(self.base/'destination',12,source)
    @unittest.skipUnless(os.environ.get('COUNSO_ARTIFACT_INTEGRATION')=='1','optional real browser seeded-variant controls')
    def test_real_browser_passes_seeded_sales_variants(self):
        variant,_=self.build('variant',42)
        registry=load_json(variant/'catalog/scenarios.json')['scenarios']
        contracts=load_json(variant/'gold/contracts.json')['scenarios']
        for case in registry:
            if case['id'] not in SUPPORTED_CASES:continue
            out=self.base/'answers'/case['id'];contract=contracts[case['id']]
            response=materialize_extension_reference(case,contract,out,variant)
            for check in contract['checks']:
                if check['kind']=='ui_behavior':
                    passed,reason=evaluate_extension(check,response,out,variant)
                    with self.subTest(case=case['id'],check=check['id']):self.assertIs(passed,True,reason)

if __name__=='__main__':unittest.main()

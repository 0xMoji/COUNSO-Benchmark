"""Positive/negative artifact controls, never candidate model runs."""
from __future__ import annotations

import csv
from copy import deepcopy
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from counso_bench.extensions import build_extensions,materialize_extension_reference
from counso_bench.artifact_tasks import check_presentation,evaluate_artifact,write_reference_presentation
from counso_bench.io import sha256
from counso_bench.office import write_workbook
from counso_bench.ui_check import check_ui,ui_asset_manifest
from counso_bench.io import BenchError,load_json
from symlink_support import symlink_or_skip

class ArtifactControls(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name);self.root=self.base/'package';self.out=self.base/'submission'
        self.bundle=build_extensions(self.root)
    def tearDown(self):self.temp.cleanup()
    def materialize(self,sid):
        case=next(s for s in self.bundle['scenarios'] if s['id']==sid);contract=self.bundle['contracts'][sid]
        out=self.out/sid;response=materialize_extension_reference(case,contract,out,self.root)
        return case,contract,out,response
    def mutate_zip(self,path,mutate):
        with zipfile.ZipFile(path) as source:parts={name:source.read(name) for name in source.namelist()}
        mutate(parts)
        with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED) as target:
            for name,body in parts.items():target.writestr(name,body)
    def test_nine_tasks_have_public_contracts_and_no_model_dependencies(self):
        self.assertEqual(len(self.bundle['scenarios']),9)
        self.assertEqual(sum(s['capability']=='generative_ui' for s in self.bundle['scenarios']),6)
        for case in self.bundle['scenarios']:
            self.assertIn('result_schema',case);self.assertTrue(case['task_zh'])
            self.assertTrue(self.bundle['contracts'][case['id']]['checks'])
    def test_reference_pptx_deterministic_and_native(self):
        _,_,out,_=self.materialize('R-P01-create-brief');p=out/'brief.pptx'
        other=out/'other.pptx';write_reference_presentation(other,[1200,1500,1800])
        self.assertEqual(sha256(p),sha256(other))
        self.assertTrue(check_presentation(p,'R-P01-create-brief',self.root)[0])
    def test_pptx_update_preserves_unrequested_native_objects(self):
        _,c,out,response=self.materialize('R-P02-update-brief');check=c['checks'][0]
        self.assertTrue(evaluate_artifact(check,response,out,self.root)[0])
        self.mutate_zip(out/'brief.pptx',lambda p:p.__setitem__('ppt/slides/slide3.xml',p['ppt/slides/slide3.xml'].replace(b'Review March demand',b'Review April demand')))
        self.assertFalse(evaluate_artifact(check,response,out,self.root)[0])
    def test_pptx_wrong_cached_data_rejected(self):
        _,c,out,response=self.materialize('R-P01-create-brief')
        self.mutate_zip(out/'brief.pptx',lambda p:p.__setitem__('ppt/charts/chart1.xml',p['ppt/charts/chart1.xml'].replace(b'<c:v>1800</c:v>',b'<c:v>9999</c:v>')))
        self.assertFalse(evaluate_artifact(c['checks'][0],response,out,self.root)[0])
    def test_pptx_correct_cache_but_wrong_embedded_workbook_rejected(self):
        _,c,out,response=self.materialize('R-P01-create-brief')
        workbook=self.base/'wrong.xlsx';write_workbook(workbook,[('Sheet1',[['Month','Sales SGD'],['January',1200],['February',1500],['March',9999]])])
        self.mutate_zip(out/'brief.pptx',lambda p:p.__setitem__('ppt/embeddings/data.xlsx',workbook.read_bytes()))
        self.assertFalse(evaluate_artifact(c['checks'][0],response,out,self.root)[0])
    def test_pptx_different_sheet_and_columns_accepted(self):
        _,c,out,response=self.materialize('R-P01-create-brief')
        workbook=self.base/'different.xlsx';write_workbook(workbook,[("Monthly data",[['','','',''],['','','',''],['','','',''],['','','',''],['','','January',1200],['','','February',1500],['','','March',1800]])])
        def mutate(parts):
            parts['ppt/embeddings/data.xlsx']=workbook.read_bytes()
            parts['ppt/charts/chart1.xml']=parts['ppt/charts/chart1.xml'].replace(b'Sheet1!$A$2:$A$4',b"'Monthly data'!$C$5:$C$7").replace(b'Sheet1!$B$2:$B$4',b"'Monthly data'!$D$5:$D$7")
        self.mutate_zip(out/'brief.pptx',mutate)
        self.assertTrue(evaluate_artifact(c['checks'][0],response,out,self.root)[0])
    def test_pptx_unsupported_named_ranges_are_unknown_not_model_failure(self):
        _,c,out,response=self.materialize('R-P01-create-brief')
        self.mutate_zip(out/'brief.pptx',lambda p:p.__setitem__('ppt/charts/chart1.xml',p['ppt/charts/chart1.xml'].replace(b'Sheet1!$A$2:$A$4',b'MonthNames')))
        self.assertIsNone(evaluate_artifact(c['checks'][0],response,out,self.root)[0])
    def test_corrupt_package_and_image_only_deck_rejected(self):
        _,c,out,response=self.materialize('R-P01-create-brief')
        self.mutate_zip(out/'brief.pptx',lambda p:p.pop('[Content_Types].xml'))
        self.assertFalse(evaluate_artifact(c['checks'][0],response,out,self.root)[0])
        write_reference_presentation(out/'brief.pptx',[1200,1500,1800])
        self.mutate_zip(out/'brief.pptx',lambda p:p.__setitem__('ppt/slides/slide2.xml',p['ppt/slides/slide2.xml'].replace(b'<c:chart ',b'<c:notChart ')))
        self.assertFalse(evaluate_artifact(c['checks'][0],response,out,self.root)[0])
    def test_file_organization_hashes_index_and_extras(self):
        _,c,out,response=self.materialize('R-F01-organize-files');check=c['checks'][0]
        self.assertTrue(evaluate_artifact(check,response,out,self.root)[0])
        (out/'organized/other/readme.txt').write_text('tampered')
        self.assertFalse(evaluate_artifact(check,response,out,self.root)[0])
        self.materialize('R-F01-organize-files');(out/'organized/extra.txt').write_text('extra')
        self.assertFalse(evaluate_artifact(check,response,out,self.root)[0])
    def test_index_hash_is_recomputed_not_trusted(self):
        _,c,out,response=self.materialize('R-F01-organize-files')
        with (out/'index.csv').open() as stream:rows=list(csv.DictReader(stream))
        rows[0]['sha256']='0'*64
        with (out/'index.csv').open('w',newline='') as stream:
            writer=csv.DictWriter(stream,fieldnames=['source','destination','sha256']);writer.writeheader();writer.writerows(rows)
        self.assertFalse(evaluate_artifact(c['checks'][0],response,out,self.root)[0])
    def test_browser_missing_is_unknown_and_missing_html_is_failure(self):
        _,c,out,response=self.materialize('R-U01-dashboard')
        with patch.dict(os.environ,{'COUNSO_NODE':'/nonexistent/node'}):
            self.assertIsNone(evaluate_artifact(c['checks'][0],response,out,self.root)[0])
        (out/'ui/index.html').unlink()
        self.assertIs(evaluate_artifact(c['checks'][0],response,out,self.root)[0],False)
    def test_ui_external_javascript_bundle_is_bound_in_observation(self):
        _,_,out,response=self.materialize('R-U01-dashboard');entry=out/response['result']['ui_file']
        bundle=entry.parent/'app.js';bundle.write_text('window.version=1;')
        entry.write_text('<!doctype html><script src="app.js"></script>')
        stub=subprocess.CompletedProcess([],0,stdout='{"passed":true,"reason":"control"}',stderr='')
        with patch('counso_bench.ui_check.subprocess.run',return_value=stub),patch.dict(os.environ,{'COUNSO_NODE':'node'}):
            self.assertTrue(check_ui(entry,'R-U01-dashboard',out,self.root)[0])
            first=load_json(out/'.assessor/R-U01-dashboard/observations.json')
            bundle.write_text('window.version=2;')
            self.assertTrue(check_ui(entry,'R-U01-dashboard',out,self.root)[0])
            second=load_json(out/'.assessor/R-U01-dashboard/observations.json')
        self.assertEqual(first['entry_sha256'],second['entry_sha256'])
        self.assertNotEqual(first['resource_manifest']['sha256'],second['resource_manifest']['sha256'])
        self.assertEqual([item['path'] for item in first['resource_manifest']['files']],['app.js','index.html'])
    def test_ui_resource_manifest_bounds_and_assessor_exclusion(self):
        directory=self.base/'assets';directory.mkdir();(directory/'index.html').write_text('hello')
        before=ui_asset_manifest(directory)
        (directory/'.assessor').mkdir();(directory/'.assessor/observations.json').write_text('owned evidence')
        self.assertEqual(before,ui_asset_manifest(directory))
        with self.assertRaises(BenchError):ui_asset_manifest(directory,max_bytes=4)
        with self.assertRaises(BenchError):ui_asset_manifest(directory,max_files=0)
    def test_ui_resource_manifest_rejects_symlinks(self):
        directory=self.base/'assets';directory.mkdir();(directory/'index.html').write_text('hello')
        symlink_or_skip(self,directory/'bundle.js',directory/'index.html')
        with self.assertRaises(BenchError):ui_asset_manifest(directory)
    def test_stage_artifacts_must_be_distinct(self):
        _,c,out,response=self.materialize('R-U05-iterative-edit');check=next(x for x in c['checks'] if x['kind']=='distinct_stage_artifacts')
        self.assertTrue(evaluate_artifact(check,response,out,self.root)[0])
        response['result']['ui_file']=response['result']['ui_initial_file']
        self.assertFalse(evaluate_artifact(check,response,out,self.root)[0])
    @unittest.skipUnless(os.environ.get('COUNSO_ARTIFACT_INTEGRATION')=='1','optional actual browser/Office controls')
    def test_all_ui_positive_and_dynamic_negative_controls(self):
        for case in self.bundle['scenarios']:
            if case['capability']!='generative_ui':continue
            _,contract,out,response=self.materialize(case['id'])
            checks=[ch for ch in contract['checks'] if ch['kind']=='ui_behavior']
            for check in checks:
                with self.subTest(case=case['id'],check=check['task']):self.assertIs(evaluate_artifact(check,response,out,self.root)[0],True)
            path=out/response['result']['ui_file'];content=path.read_text()
            mutations={
                'R-U01-dashboard':("r.type==='SALE'", "true"),
                'R-U02-form':("seats:Number(field('seats').value)","seats:1"),
                'R-U03-calculator':("u*p*(1-d/100)","u*p"),
                'R-U04-record-detail':("r.email||'Unknown'","r.email||'Approved'"),
                'R-U05-iterative-edit':("sort.value==='amount_desc'?b.amount-a.amount:a.amount-b.amount","a.amount-b.amount"),
                'R-U06-data-update':("get('dataset')||'base'","get('ignored')||'base'"),
            }
            before,after=mutations[case['id']];self.assertIn(before,content);path.write_text(content.replace(before,after))
            with self.subTest(negative=case['id']):self.assertIs(evaluate_artifact(checks[-1],response,out,self.root)[0],False)
    @unittest.skipUnless(os.environ.get('COUNSO_ARTIFACT_INTEGRATION')=='1','optional independent PPT authoring library')
    def test_independent_pptxgenjs_deck_and_office_render(self):
        _,contract,out,response=self.materialize('R-P01-create-brief')
        script="""const PptxGenJS=require('pptxgenjs');const p=new PptxGenJS();p.layout='LAYOUT_WIDE';let s=p.addSlide();s.addText('Quarterly sales',{x:1,y:1,w:10,h:1,fontSize:32});s.addText('SGD 4,500.00',{x:1,y:3,w:10,h:1,fontSize:24});s=p.addSlide();s.addText('Monthly sales',{x:1,y:.3,w:10,h:.6,fontSize:28});s.addChart(p.ChartType.bar,[{name:'Sales SGD',labels:['January','February','March'],values:[1200,1500,1800]}],{x:1,y:1.5,w:10,h:4,catAxisLabelFontSize:18,valAxisLabelFontSize:18,showLegend:false,showTitle:false});s=p.addSlide();s.addText('Next steps',{x:1,y:1,w:10,h:1,fontSize:32});s.addText('Review March demand',{x:1,y:2,w:10,h:1,fontSize:24});s.addText('Synthetic fixture',{x:1,y:4,w:10,h:1,fontSize:16});p.writeFile({fileName:process.argv[1]});"""
        node=os.environ.get('COUNSO_NODE') or shutil.which('node')
        result=subprocess.run([node,'-e',script,str(out/'brief.pptx')],capture_output=True,text=True,timeout=30)
        self.assertEqual(result.returncode,0,result.stderr)
        for check in contract['checks']:
            if check['kind'] in {'presentation_contract','presentation_render'}:
                with self.subTest(check=check['kind']):
                    passed,reason=evaluate_artifact(check,response,out,self.root)
                    self.assertIs(passed,True,reason)

if __name__=='__main__':unittest.main()

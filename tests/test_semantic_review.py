"""Fixed candidate self-review contract; no model or human reviewer needed."""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest

from counso_bench.io import MAX_FILE_BYTES, sha256, write_json
from counso_bench.semantic_review import TEMPLATE_VERSION, validate_self_review
from symlink_support import symlink_or_skip


class SemanticReviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.out=Path(self.tmp.name)
        write_json(self.out/'response.json',{'result':{'revenue':'500.00'}})
        (self.out/'page.html').write_text('<h1>Result</h1>\n<p>500.00</p>\n')

    def tearDown(self):
        self.tmp.cleanup()

    def review(self):
        return {'template_version':TEMPLATE_VERSION,'dimensions':{
            name:{'score':4,'reason':'已根据本次产物核对该维度。','evidence':[
                {'path':'response.json','locator':'/result/revenue','claim':'本次响应报告收入金额。'}]}
            for name in ('facts','completeness','usability')},
            'commentary':'当前 Agent 自评。','known_limitations':[]}

    def test_valid_review_binds_actual_file_bytes_and_preserves_raw(self):
        value=self.review()
        raw=deepcopy(value)
        result=validate_self_review(value,self.out)
        self.assertTrue(result['valid'],result['errors'])
        self.assertEqual(result['template_version'],TEMPLATE_VERSION)
        self.assertEqual(result['dimension_scores'],{'facts':4,'completeness':4,'usability':4})
        self.assertEqual(len(result['evidence']),3)
        self.assertTrue(all(item['sha256']==sha256(self.out/'response.json') for item in result['evidence']))
        self.assertEqual(value,raw)

    def test_unknown_dimensions_are_valid_without_evidence(self):
        value=self.review()
        for dim in value['dimensions'].values():
            dim.update(score=None,reason='当前没有足够观测，保留未知。',evidence=[])
        result=validate_self_review(value,self.out)
        self.assertTrue(result['valid'],result['errors'])
        self.assertTrue(all(score is None for score in result['dimension_scores'].values()))
        self.assertEqual(result['evidence'],[])

    def test_score_bounds_and_boolean_float_string_rejected(self):
        for score in [True,False,-1,5,4.0,'4']:
            value=self.review()
            value['dimensions']['facts']['score']=score
            self.assertFalse(validate_self_review(value,self.out)['valid'])
        for score in range(5):
            value=self.review()
            value['dimensions']['facts']['score']=score
            self.assertTrue(validate_self_review(value,self.out)['valid'])

    def test_wrong_root_missing_dimension_and_bad_version_do_not_raise(self):
        self.assertFalse(validate_self_review([],self.out)['valid'])
        for mutate in [lambda v:v.update(template_version='OLD'),
                       lambda v:v['dimensions'].pop('facts'),
                       lambda v:v.update(dimensions=[]),
                       lambda v:v.update(extra=True),
                       lambda v:v['dimensions']['facts'].pop('score')]:
            value=self.review();mutate(value)
            result=validate_self_review(value,self.out)
            self.assertFalse(result['valid'])
            self.assertTrue(result['errors'])

    def test_evidence_must_exist_and_use_safe_local_path(self):
        for path in ['missing.json','../outside.json',str(self.out/'response.json'),'.']:
            value=self.review()
            value['dimensions']['facts']['evidence'][0]['path']=path
            self.assertFalse(validate_self_review(value,self.out)['valid'])

    def test_evidence_rejects_symlink(self):
        symlink_or_skip(self,self.out/'alias.json',self.out/'response.json')
        value=self.review()
        value['dimensions']['facts']['evidence'][0]['path']='alias.json'
        self.assertFalse(validate_self_review(value,self.out)['valid'])

    def test_nonexistent_json_and_text_locator_rejected(self):
        value=self.review()
        item=value['dimensions']['facts']['evidence'][0]
        item['locator']='/result/does_not_exist'
        self.assertFalse(validate_self_review(value,self.out)['valid'])
        item.update(path='page.html',locator='lines:1-2')
        self.assertTrue(validate_self_review(value,self.out)['valid'])
        item['locator']='lines:99-100'
        self.assertFalse(validate_self_review(value,self.out)['valid'])

    def test_numeric_score_without_evidence_is_invalid(self):
        value=self.review()
        value['dimensions']['facts']['evidence']=[]
        self.assertFalse(validate_self_review(value,self.out)['valid'])

    def test_resource_and_text_bounds_do_not_abort(self):
        value=self.review()
        value['commentary']='x'*4001
        self.assertFalse(validate_self_review(value,self.out)['valid'])
        value=self.review()
        file=self.out/'too-large.png'
        with file.open('wb') as stream:
            stream.truncate(MAX_FILE_BYTES+1)
        value['dimensions']['facts']['evidence'][0].update(path=file.name,locator='image:whole')
        result=validate_self_review(value,self.out)
        self.assertFalse(result['valid'])
        self.assertTrue(result['errors'])

    def test_image_and_pdf_evidence_have_explicit_whole_file_locators(self):
        # Format signatures suffice for supplemental byte-binding; this test does
        # not assert these minimal bytes are rendered or visually meaningful.
        (self.out/'screen.png').write_bytes(b'\x89PNG\r\n\x1a\n'+b'fixture')
        (self.out/'slides.pdf').write_bytes(b'%PDF-1.4\n%fixture\n')
        value=self.review()
        value['dimensions']['usability']['evidence']=[
            {'path':'screen.png','locator':'image:whole','claim':'当前保存的截图文件。'},
            {'path':'slides.pdf','locator':'document','claim':'当前保存的PDF文件。'}]
        result=validate_self_review(value,self.out)
        self.assertTrue(result['valid'],result['errors'])
        value['dimensions']['usability']['evidence'][1]['locator']='pages:999'
        self.assertFalse(validate_self_review(value,self.out)['valid'])

    def test_content_changes_produce_new_evidence_hash(self):
        value=self.review()
        first=validate_self_review(value,self.out)['evidence'][0]['sha256']
        write_json(self.out/'response.json',{'result':{'revenue':'501.00'}})
        second=validate_self_review(value,self.out)['evidence'][0]['sha256']
        self.assertNotEqual(first,second)


if __name__=='__main__':
    unittest.main()

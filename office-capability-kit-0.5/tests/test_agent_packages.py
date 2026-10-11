import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src'))
from officekit.agent_packages import prepare_agent,verify_agent_bundle
from officekit.agent_submit import submit
from officekit.registry import REGISTRY

class AgentPublicTests(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory(prefix='officekit-agent-export-');self.root=Path(self.tmp.name)
 def tearDown(self):self.tmp.cleanup()
 def test_six_public_packages_exclude_evaluator_runtime_reference(self):
  for cid in REGISTRY:
   with self.subTest(case=cid):
    p=self.root/cid;z=self.root/(cid+'.zip');m=prepare_agent(cid,p,z);self.assertEqual(verify_agent_bundle(p)[0],cid)
    paths={x['artifact'] for x in m['artifacts']};self.assertTrue({'TASK.md','prompt.txt','ENVIRONMENT.json','FINAL_RESULT_SCHEMA.json','submit.py'}<=paths)
    self.assertFalse(any(any(word in Path(q).parts for word in ['evaluator','reference','mutations']) or q.endswith(('fixture.json','atoms.json','ledger.json','state.json','report.json')) for q in paths))
    with zipfile.ZipFile(z) as arc:self.assertIsNone(arc.testzip());self.assertEqual(set(arc.namelist()),paths|{'AGENT_TASK_MANIFEST.json'})
    self.assertFalse(m['contains_evaluator_gold']);self.assertFalse(m['contains_scorer']);self.assertEqual(len(REGISTRY),6)
    if m['family']=='office':self.assertIn('call.py',paths);self.assertIn('preflight',(p/'TASK.md').read_text())
    else:self.assertNotIn('call.py',paths);interface=json.loads((p/'TOOL_INTERFACE.json').read_text());self.assertEqual(list(interface['task_scopes']),[cid]);self.assertNotIn('canonical_definition',interface)
 def test_mutable_work_does_not_change_fixed_public_context(self):
  p=self.root/'bundle';prepare_agent('office-recovery',p);(p/'submission').mkdir();(p/'submission'/'candidate.json').write_text('{}');(p/'.bridge').mkdir();(p/'.bridge'/'status.json').write_text('{}');verify_agent_bundle(p)
 def test_rehashing_wrong_input_or_helper_still_rejected(self):
  for rel in ['inputs/request.json','call.py','TASK.md']:
   with self.subTest(path=rel):
    p=self.root/str(len(list(self.root.iterdir())));prepare_agent('office-recovery',p);(p/rel).write_text('modified')
    m=json.loads((p/'AGENT_TASK_MANIFEST.json').read_text());m['task_fingerprint']='0'*64;(p/'AGENT_TASK_MANIFEST.json').write_text(json.dumps(m))
    with self.assertRaises(ValueError):verify_agent_bundle(p)
 def test_public_extra_and_symlink_rejected(self):
  p=self.root/'bundle';prepare_agent('office-data',p);(p/'unexpected.json').write_text('{}')
  with self.assertRaises(ValueError):verify_agent_bundle(p)
  (p/'unexpected.json').unlink();target=p/'TASK.md';target.unlink();target.symlink_to(self.root/'other')
  with self.assertRaises(ValueError):verify_agent_bundle(p)
 def test_ui_static_handoff_never_grants_functional_pass(self):
  p=self.root/'ui';prepare_agent('ui-dashboard',p);out=p/'submission';out.mkdir();(out/'index.html').write_text('<button>Static test only</button>');(out/'response.json').write_text(json.dumps({'artifacts':['index.html']}));m=submit(p)
  self.assertEqual(m['functional_status'],'UNKNOWN_PENDING_INDEPENDENT_EVALUATION');self.assertEqual(m['tool_or_browser_authority'],'INDEPENDENT_ACTUAL_BROWSER_REQUIRED');self.assertTrue((p/'handoff.json').is_file())
 def test_ui_submission_escape_or_unlisted_assets_rejected(self):
  for paths in [['../TASK.md'],['missing.html'],['index.html','index.html'],[{}]]:
   with self.subTest(paths=paths):
    p=self.root/str(len(list(self.root.iterdir())));prepare_agent('ui-dashboard',p);out=p/'submission';out.mkdir();(out/'index.html').write_text('<p>Test</p>');(out/'response.json').write_text(json.dumps({'artifacts':paths}))
    with self.assertRaises(ValueError):submit(p)
  p=self.root/'extra';prepare_agent('ui-dashboard',p);out=p/'submission';out.mkdir();(out/'index.html').write_text('test');(out/'extra.js').write_text('test');(out/'response.json').write_text('{"artifacts":["index.html"]}')
  with self.assertRaises(ValueError):submit(p)
 def test_ui_response_host_symlink_rejected(self):
  p=self.root/'bundle';prepare_agent('ui-planner',p);(p/'submission').mkdir();(self.root/'response.json').write_text('{"artifacts":["index.html"]}');(p/'submission'/'response.json').symlink_to(self.root/'response.json')
  with self.assertRaises(ValueError):submit(p)
 def test_office_handoff_does_not_certify_candidate_ledger(self):
  p=self.root/'office';prepare_agent('office-tools',p);out=p/'submission';out.mkdir();(out/'candidate.json').write_text(json.dumps({'artifacts':['outputs/receipt.json'],'completed_actions':[],'facts':{},'text':'Synthetic handoff only'}));m=submit(p)
  self.assertEqual(m['tool_or_browser_authority'],'OPERATOR_HOST_RECEIPT_REQUIRED_NOT_CANDIDATE_LEDGER');self.assertEqual(m['functional_status'],'UNKNOWN_PENDING_INDEPENDENT_EVALUATION')
 def test_fresh_destinations_no_overwrite(self):
  p=self.root/'bundle';prepare_agent('office-data',p)
  with self.assertRaises(ValueError):prepare_agent('office-data',p)
  with self.assertRaises(ValueError):prepare_agent('office-data',self.root/'new',self.root/'new'/'recursive.zip')
 def test_stdio_cli_exports_task_without_controller_or_key(self):
  env={'PYTHONPATH':str(ROOT/'src')};p=self.root/'cli';r=subprocess.run([sys.executable,'-B','-m','officekit','prepare-agent','--case','ui-dashboard','--output',str(p)],env=env,capture_output=True,text=True)
  self.assertEqual(r.returncode,0,r.stderr);self.assertFalse(json.loads(r.stdout)['model_api_required']);self.assertTrue((p/'TASK.md').is_file())

if __name__=='__main__':unittest.main()

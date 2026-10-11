"""Build an explicit experiment-only publication whitelist, excluding live controls and traces."""
from pathlib import Path
import json,hashlib,shutil,argparse
ROOT=Path(__file__).resolve().parents[1]
ap=argparse.ArgumentParser();ap.add_argument('--destination',required=True);args=ap.parse_args();dest=Path(args.destination)
if dest.exists():raise SystemExit('Refuse to overwrite publication destination')
allow=set()
def add(p):
 if not p.is_file():raise SystemExit('Required file missing: '+str(p))
 allow.add(p.relative_to(ROOT).as_posix())
def tree(folder):
 for p in folder.rglob('*'):
  if p.is_file() and p.name!='candidate_trace.json' and '__pycache__' not in p.parts and p.suffix!='.pyc':add(p)
for name in ['README.md','report/counso-pilot-report-zh.pdf','report/semantic-summary.png','report/RESULTS.md','report/artifact-qa.json','report/baseline_matrix.csv','report/baseline_checks.csv','report/comparison_matrix.csv','report/revised_checks.csv','report/final-summary.json','report/build_report.py','evaluator/experiment.json','evaluator/experiment-v0.1.json','evaluator/baseline-evidence-manifest.json','evaluator/regrade_baseline.py','evaluator/regrade_baseline-0.2.py','evaluator/finalize_matrices.py','evaluator/make_matrix.py','evaluator/register_start.py','evaluator/score_and_blind.py','evaluator/manage_v2.py','evaluator/verify_published_evidence.py','evaluator/stage_publication.py','evaluator/bridge_client_template.py','evaluator/mock_file_bridge.py','evaluator/service-shutdown.json','evaluator/version-identities.json']:
 add(ROOT/name)
exp=json.loads((ROOT/'evaluator/experiment.json').read_text())
for c in exp['cells']:
 tree(ROOT/'candidates'/c['run_id']/'input');tree(ROOT/'candidates'/c['run_id']/'output');tree(ROOT/'evaluator/results'/c['run_id'])
 if c.get('service_dir'):add(ROOT/'evaluator'/Path(c['service_dir']).name/'observations.json')
for folder in ['blind-review','blind-review-v2','evaluator/regraded-v0.2','evaluator/regraded-v0.2.1','evaluator/compatibility','evaluator/adapter-controls-0.2.1-final']:
 tree(ROOT/folder)
vr=ROOT/'revisions/B17-contract-0.2'
for name in ['manifest.json','manifest-pre-review.json','candidate-evidence-manifest.json','experiment.json']:add(vr/name)
tree(vr/'input');tree(vr/'results')
for c in json.loads((vr/'experiment.json').read_text())['cells']:
 tree(vr/'candidates'/c['run_id']/'input');tree(vr/'candidates'/c['run_id']/'output')
# Timing report is optional only until its independent analysis completes.
for name in ['report/selection-signal.md','report/selection-signal-analysis.md','report/selection-signal.json']:
 add(ROOT/name)
for name in allow:
 if any(part in {'ipc','adapter','__pycache__'} for part in Path(name).parts) or Path(name).name in {'endpoint.json','transport.jsonl','candidate_trace.json'}:raise SystemExit('Denied publication path '+name)
files=[]
for name in sorted(allow):
 src=ROOT/name;tgt=dest/name;tgt.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,tgt)
 files.append({'path':name,'bytes':src.stat().st_size,'sha256':hashlib.sha256(src.read_bytes()).hexdigest()})
withheld=[]
for m in ['evaluator/baseline-evidence-manifest.json','revisions/B17-contract-0.2/candidate-evidence-manifest.json']:
 for f in json.loads((ROOT/m).read_text())['files']:
  if f['path'] not in allow:withheld.append({'path':f['path'],'sha256':f['sha256'],'original_manifest':m,'availability':'LOCAL_ONLY_NOT_IN_PUBLICATION','reason':'Self-reported execution trace or transient service endpoint/transport metadata excluded from publication; not required by deterministic response/artifact regrade'})
manifest={'kind':'EXPERIMENT_PUBLICATION_WHITELIST','suggested_repository_path':'experiments/pilot-20261010','benchmark_manifest_scope':'SEPARATE_FROM_BENCHMARK_PACKAGE_DO_NOT_ADD_TO_EXECUTION_FINGERPRINT','files':files,'file_count_excluding_this_manifest':len(files),'total_bytes_excluding_this_manifest':sum(f['bytes'] for f in files),'withheld_original_hashes':withheld,'exclusions':['Private agent coordination and raw chats were never publication inputs','No private chain of thought or model hidden reasoning','No candidate_trace.json self-reports','No credentials, Library URLs, live IPC, endpoints, transport controls, caches or draft PDFs'],'models_are_requested_aliases_not_verified_backend_snapshots':True}
(dest/'PUBLICATION_MANIFEST.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
(ROOT/'report/publication-whitelist.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'destination':str(dest),'files':len(files)+1,'bytes':sum(f['bytes'] for f in files)+(dest/'PUBLICATION_MANIFEST.json').stat().st_size,'withheld_original_manifest_entries':len(withheld)},ensure_ascii=False))

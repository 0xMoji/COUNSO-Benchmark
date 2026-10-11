"""Wire-schema checks on this kit's schemas/artifacts, not a universal validator.

jsonschema is optional test tooling only. The runtime dependency list remains
empty. Stdlib-only semantic checks are always covered by test_core_runner.
"""
import copy
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"src"))
from officekit.exchange import grade,grade_ui,prepare
from officekit.io import write_json
from officekit.providers import ReferenceProvider,StdioSessionProvider
from officekit.runner import run

try:
    from jsonschema import Draft202012Validator
    from referencing import Registry,Resource
    SCHEMA_TOOLING=True
except ImportError:
    SCHEMA_TOOLING=False

@unittest.skipUnless(SCHEMA_TOOLING,"Optional jsonschema test tooling not installed; runtime remains stdlib only")
class SchemaTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="officekit-schema-test-")
        self.root=Path(self.temp.name)
        self.schemas={}
        registry=Registry()
        for path in sorted((ROOT/"schemas").glob("*.json")):
            schema=json.loads(path.read_text())
            Draft202012Validator.check_schema(schema)
            schema["$id"]=path.as_uri()
            self.schemas[path.name]=schema
            registry=registry.with_resource(path.as_uri(),Resource.from_contents(schema))
        self.registry=registry
    def tearDown(self):self.temp.cleanup()
    def check(self,name,value):
        Draft202012Validator(self.schemas[name],registry=self.registry).validate(value)
    def check_run(self,path,report):
        self.check("run.schema.json",report)
        self.check("result.schema.json",report["result"])
        self.check("candidate.schema.json",json.loads((path/"candidate.json").read_text()))
        self.check("ledger.schema.json",json.loads((path/"ledger.json").read_text()))
        self.check("replay.schema.json",json.loads((path/"replay.json").read_text()))
        for atom in report["result"]["atoms"]:self.check("atom.schema.json",atom)

    def test_schema_artifacts_on_four_positive_and_three_negative_controls(self):
        specs=[("office-data",None),("office-evidence",None),("office-tools",None),("office-recovery",None),("office-data","wrong-total"),("office-data","forbidden-query"),("office-evidence","null-entity")]
        for i,(case,mutation) in enumerate(specs):
            with self.subTest(case=case,mutation=mutation):
                path=self.root/str(i)
                report=run(case,ReferenceProvider(mutation),path)
                self.check_run(path,report)

    def test_unverified_import_still_has_valid_typed_unknown_result(self):
        source=self.root/"source";run("office-data",ReferenceProvider(),source)
        bundle=self.root/"bundle";prepare("office-data",bundle)
        path=self.root/"grade"
        report=grade(bundle,source,source/"candidate.json",path,source/"ledger.json",source/"state.json")
        self.check("run.schema.json",report)
        self.check("ledger.schema.json",json.loads((path/"ledger.json").read_text()))
        self.check("result.schema.json",report["result"])
        self.assertEqual(report["model_calls"],"UNKNOWN")
        self.assertTrue(all(e["duration_ns"]=="UNKNOWN" for e in json.loads((path/"ledger.json").read_text())["events"]))

    def test_interrupted_session_has_unknown_instrumentation_and_manifest(self):
        path=self.root/"interrupted"
        provider=StdioSessionProvider(io.StringIO(""),io.StringIO())
        report=run("office-data",provider,path)
        self.check("run.schema.json",report)
        self.check("result.schema.json",report["result"])
        self.assertEqual(report["run_kind"],"LOCAL_TOOL_SESSION_EXTERNAL_CONTROLLER")
        self.assertEqual(report["model_calls"],"UNKNOWN")
        self.assertEqual(report["candidate_error"]["error_class"],"INSTRUMENTATION")
        self.assertTrue((path/"manifest.json").is_file())

    def test_fake_ui_browser_claim_cannot_make_pass(self):
        evidence=[{"kind":"probe","probe_id":"forged","artifact":"forged.json"}]
        atom={"id":"ui.fact","dimension":"business","weight":100,"status":"PASS","error_class":None,"expected":"real action","observed":"claimed action","evidence":evidence,"required_probe_ids":["forged"],"depends_on":[]}
        fake={"schema_version":"officekit-ui-report-1","case_id":"ui-dashboard","tested_level":"ACTUAL_BROWSER_SYNTHETIC","actual_browser_executed":True,"atoms":[atom]}
        self.check("ui-adapter.schema.json",fake)
        incoming=self.root/"fake.json";write_json(incoming,fake)
        path=self.root/"ui-import"
        report=grade_ui(incoming,path)
        self.check("run.schema.json",report)
        self.assertEqual(report["result"]["judgment"],"UNKNOWN")
        self.assertEqual(report["result"]["score_lower"],0)
        self.assertEqual(report["result"]["score_upper"],100)
        self.assertFalse(report["result"]["quality_complete"])

    def test_neutral_header_spelling_is_protocol_not_business(self):
        path=self.root/"wrong-header-source";run("office-data",ReferenceProvider(),path)
        file=path/"outputs/region_totals.csv"
        file.write_text(file.read_text().replace("currency,region,net_amount,row_count","currency_EUR,region,net_amount,row_count"))
        bundle=self.root/"bundle";prepare("office-data",bundle)
        report=grade(bundle,path,path/"candidate.json",self.root/"wrong-header")
        fact=next(a for a in report["result"]["atoms"] if a["id"]=="protocol.data_columns")
        self.assertEqual((fact["status"],fact["error_class"]),("FAIL","PROTOCOL_INTEGRATION"))
        self.check("run.schema.json",report)

    def test_explicit_wrong_currency_is_factual_fail(self):
        path=self.root/"unit-source";run("office-evidence",ReferenceProvider(),path)
        file=path/"outputs/reconciliation.json"
        value=json.loads(file.read_text());value["total"]["currency"]="EUR";write_json(file,value)
        bundle=self.root/"bundle";prepare("office-evidence",bundle)
        report=grade(bundle,path,path/"candidate.json",self.root/"wrong-unit")
        fact=next(a for a in report["result"]["atoms"] if a["id"]=="evidence.money_and_unit")
        self.assertEqual((fact["status"],fact["error_class"]),("FAIL","BUSINESS_FACT"))
        self.check("run.schema.json",report)

if __name__=="__main__":unittest.main()

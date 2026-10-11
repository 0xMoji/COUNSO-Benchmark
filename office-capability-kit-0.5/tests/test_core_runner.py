"""Stdlib regression tests. No model, account, network, npm, CI or browser calls."""
import csv
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"src"))
from officekit.contracts import validate_result
from officekit.exchange import grade,prepare
from officekit.io import load_fixture,public_resources,write_json
from officekit.model import CandidateResult,ProviderInfo
from officekit.providers import ReferenceProvider,ReplayProvider
from officekit.registry import REGISTRY
from officekit.runner import run
from officekit.scoring import score
from officekit.tools import LocalSession


def by_id(report,atom_id):
    return next(a for a in report["result"]["atoms"] if a["id"]==atom_id)

class WriteThenFailProvider:
    """Bounded coordinator-fault control, not a model sample."""
    info=ProviderInfo("write-then-fail","deliberate-coordinator-fault-fixture")
    def __init__(self,amount):self.amount=amount
    def execute(self,session):
        session.call("data.read_csv",{"file":"transactions.csv"})
        content="currency,region,net_amount,row_count\nEUR,East,"+self.amount+",2\nUSD,North,90.00,3\nUSD,South,50.00,1\n"
        response=session.call("files.write",{"path":"outputs/region_totals.csv","content":content})
        if not response["ok"]:raise RuntimeError("Control write was rejected")
        raise RuntimeError("Simulated coordinator/transport failure after accepted persisted write")

class CoreTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="officekit-core-test-")
        self.root=Path(self.temp.name)
        self.serial=0
    def tearDown(self):self.temp.cleanup()
    def dest(self,name="run"):
        self.serial+=1
        return self.root/f"{name}-{self.serial}"
    def run_ref(self,case="office-data",mutation=None,budget=32):
        path=self.dest(case)
        return path,run(case,ReferenceProvider(mutation),path,budget)

    def test_six_case_registry_four_core_two_reserved(self):
        self.assertEqual(len(REGISTRY),6)
        self.assertEqual(sum(v["family"]=="office" for v in REGISTRY.values()),4)
        for name in ("ui-dashboard","ui-planner"):
            self.assertEqual(REGISTRY[name]["status"],"RESERVED_ADAPTER")
            with self.assertRaisesRegex(ValueError,"UNKNOWN"):
                run(name,ReferenceProvider(),self.dest())

    def test_four_reference_chains_have_typed_facts(self):
        for case in [k for k,v in REGISTRY.items() if v["family"]=="office"]:
            with self.subTest(case=case):
                path,report=self.run_ref(case)
                self.assertEqual(report["result"]["earned"],100)
                self.assertTrue(report["result"]["quality_complete"])
                self.assertFalse(report["provider"]["is_live_model"])
                self.assertEqual(report["live_model_capability"],"UNKNOWN")
                self.assertEqual(report["provider"]["verified_model"],"UNKNOWN")
                self.assertEqual(report["model_calls"],0)
                self.assertEqual(report["rank_stability"],"NOT_MEASURED")
                self.assertGreater(report["timing"]["duration_ns"],0)
                self.assertGreater(report["timing"]["provider_duration_ns"],0)
                validate_result(report["result"])
                ledger=json.loads((path/"ledger.json").read_text())
                self.assertEqual(ledger["evidence_provenance"],"LOCAL_EXECUTED")
                self.assertTrue(all(e["duration_ns"]>=0 for e in ledger["events"]))
                self.assertEqual(len({e["event_id"] for e in ledger["events"]}),len(ledger["events"]))

    def test_all_manifest_hashes_match_bytes(self):
        path,report=self.run_ref()
        manifest=json.loads((path/"manifest.json").read_text())
        self.assertNotIn("manifest.json",[a["artifact"] for a in manifest["artifacts"]])
        for item in manifest["artifacts"]:
            self.assertEqual(hashlib.sha256((path/item["artifact"]).read_bytes()).hexdigest(),item["sha256"])
            self.assertEqual((path/item["artifact"]).stat().st_size,item["bytes"])
        for a in report["result"]["atoms"]:
            for ev in a["evidence"]:
                if ev.get("sha256"):
                    self.assertEqual(hashlib.sha256((path/ev["artifact"]).read_bytes()).hexdigest(),ev["sha256"])

    def test_wrong_amount_is_business_fail(self):
        _,report=self.run_ref(mutation="wrong-total")
        a=by_id(report,"data.group_totals")
        self.assertEqual((a["status"],a["error_class"]),("FAIL","BUSINESS_FACT"))
        self.assertEqual(report["result"]["score_lower"],80)
        self.assertEqual(by_id(report,"safety.forbidden_effects")["status"],"PASS")

    def test_unsupported_read_only_query_is_protocol_not_unsafe(self):
        path,report=self.run_ref(mutation="forbidden-query")
        self.assertEqual(report["result"]["score_lower"],95)
        self.assertEqual(by_id(report,"protocol.offered_tools")["error_class"],"PROTOCOL_INTEGRATION")
        self.assertEqual(by_id(report,"safety.forbidden_effects")["status"],"PASS")
        rejected=[e for e in json.loads((path/"ledger.json").read_text())["events"] if not e["accepted"]]
        self.assertEqual(len(rejected),1)
        self.assertFalse(rejected[0]["committed"])
        self.assertEqual(rejected[0]["effect"],"NONE")

    def test_missing_file_is_delivery_fail_and_facts_unknown(self):
        _,report=self.run_ref(mutation="missing-file")
        self.assertEqual(by_id(report,"delivery.files")["error_class"],"FUNCTIONAL_RESULT")
        self.assertEqual(by_id(report,"data.group_totals")["status"],"UNKNOWN")
        self.assertEqual(report["result"]["denominator"],100)
        self.assertEqual(report["result"]["unknown_weight"],40)
        self.assertFalse(report["result"]["quality_complete"])

    def test_null_entity_unknown_but_wrong_entity_fail(self):
        _,null=self.run_ref("office-evidence","null-entity")
        _,wrong=self.run_ref("office-evidence","wrong-entity")
        self.assertEqual(by_id(null,"evidence.identity")["status"],"UNKNOWN")
        self.assertEqual((null["result"]["score_lower"],null["result"]["score_upper"]),(90,100))
        self.assertEqual(by_id(wrong,"evidence.identity")["status"],"FAIL")
        self.assertEqual(wrong["result"]["score_upper"],90)

    def test_ack_loss_recovers_using_actual_results(self):
        path,report=self.run_ref("office-recovery")
        ledger=json.loads((path/"ledger.json").read_text())["events"]
        creates=[e for e in ledger if e["tool"]=="mail.create_draft"]
        self.assertEqual(len(creates),2)
        self.assertEqual(creates[0]["status"],"COMMITTED_ACK_LOST")
        self.assertTrue(creates[0]["committed"])
        self.assertEqual(creates[0]["result"]["request_status"],"UNKNOWN")
        self.assertTrue(creates[1]["result"]["deduplicated"])
        self.assertFalse(creates[1]["committed"])
        self.assertEqual(len(json.loads((path/"state.json").read_text())["drafts"]),1)
        self.assertEqual(by_id(report,"recovery.idempotent_retry")["status"],"PASS")

    def test_duplicate_retry_detected_without_prose_regex(self):
        _,report=self.run_ref("office-recovery","duplicate-retry")
        self.assertEqual(by_id(report,"recovery.exact_resource_counts")["status"],"FAIL")
        self.assertEqual(by_id(report,"recovery.idempotent_retry")["status"],"FAIL")

    def test_claim_requires_current_accepted_event_binding(self):
        _,report=self.run_ref("office-tools","unbound-claim")
        self.assertEqual(by_id(report,"tools.accepted_action_bindings")["status"],"FAIL")
        self.assertEqual(by_id(report,"tools.accepted_action_bindings")["error_class"],"PROTOCOL_INTEGRATION")
        self.assertEqual(by_id(report,"safety.forbidden_effects")["status"],"PASS")

    def test_action_identifier_types_unknown_without_crash_or_false_entity(self):
        original,_=self.run_ref("office-tools")
        original_tape=json.loads((original/"replay.json").read_text())
        for key in ("event_id","tool","resource_id"):
            for value in ([],{},None,True):
                with self.subTest(key=key,value=value):
                    tape=json.loads(json.dumps(original_tape))
                    tape["final"]["completed_actions"][0][key]=value
                    file=self.root/"unparsed-action.json";write_json(file,tape)
                    output=self.dest("unparsed-action")
                    report=run("office-tools",ReplayProvider(file),output)
                    self.assertEqual(by_id(report,"tools.accepted_action_bindings")["status"],"UNKNOWN")
                    self.assertEqual(by_id(report,"tools.recipient")["status"],"PASS")
                    self.assertTrue((output/"manifest.json").is_file())
        for value in ([],{},None,True):
            with self.subTest(collection=value):
                tape=json.loads(json.dumps(original_tape))
                tape["final"]["completed_actions"]=value
                file=self.root/"unparsed-collection.json";write_json(file,tape)
                report=run("office-tools",ReplayProvider(file),self.dest("unparsed-collection"))
                self.assertIn(by_id(report,"tools.accepted_action_bindings")["status"],("UNKNOWN","FAIL"))
                self.assertEqual(report["result"]["denominator"],100)

    def test_replay_reexecutes_requests_not_saved_results(self):
        first,original=self.run_ref("office-recovery")
        out=self.dest("replay")
        report=run("office-recovery",ReplayProvider(first/"replay.json"),out)
        self.assertEqual(report["result"]["earned"],100)
        self.assertEqual(report["provider"]["kind"],"recorded-action-replay-fixture")
        self.assertEqual((first/"outputs/receipt.json").read_bytes(),(out/"outputs/receipt.json").read_bytes())
        self.assertEqual(json.loads((out/"state.json").read_text())["drafts"][0]["id"],"draft-001")
        tape=json.loads((first/"replay.json").read_text())
        tape["steps"][0]["result"]={"ok":True,"made_up":True}
        poisoned=self.root/"poisoned.json";write_json(poisoned,tape)
        rejected=run("office-recovery",ReplayProvider(poisoned),self.dest("poisoned"))
        self.assertEqual(rejected["candidate_error"]["error_class"],"INSTRUMENTATION")
        self.assertEqual(rejected["result"]["unknown_weight"],100)

    def test_tool_budget_is_enforced_and_recorded(self):
        path,report=self.run_ref(budget=1)
        ledger=json.loads((path/"ledger.json").read_text())["events"]
        self.assertEqual(sum(e["accepted"] for e in ledger),1)
        self.assertTrue(all(not e["committed"] for e in ledger))
        self.assertEqual(by_id(report,"protocol.offered_tools")["status"],"FAIL")

    def test_existing_output_is_never_overwritten(self):
        path,_=self.run_ref()
        before=(path/"report.json").read_bytes()
        with self.assertRaisesRegex(ValueError,"fresh"):
            run("office-data",ReferenceProvider(),path)
        self.assertEqual((path/"report.json").read_bytes(),before)

    def test_tool_path_and_recipient_scope_rejections_have_no_effect(self):
        case="office-tools";path=self.dest();path.mkdir()
        fixture=load_fixture(case)
        desc=json.loads(public_resources(case).joinpath("tools.json").read_text())
        session=LocalSession(path,fixture,"",desc)
        denied=session.call("files.write",{"path":"../../outside.txt","content":"no"})
        self.assertFalse(denied["ok"])
        denied=session.call("mail.create_draft",{"idempotency_key":"employee","recipient":"employee@outside.example","subject":"X","body":"Y"})
        self.assertFalse(denied["ok"])
        self.assertEqual(session.state["drafts"],[])
        self.assertTrue(all(not e["committed"] for e in session.ledger))
        self.assertTrue(all(e["error_class"]=="PROTOCOL_INTEGRATION" for e in session.ledger))

    def test_proven_wrong_amount_survives_later_provider_fault(self):
        path=self.dest("wrong-amount-then-fault")
        report=run("office-data",WriteThenFailProvider("999.00"),path)
        self.assertEqual(by_id(report,"data.group_totals")["status"],"FAIL")
        self.assertEqual(by_id(report,"data.group_totals")["error_class"],"BUSINESS_FACT")
        self.assertEqual(by_id(report,"data.row_counts")["status"],"PASS")
        self.assertEqual(by_id(report,"data.summary")["status"],"UNKNOWN")
        self.assertEqual(report["result"]["judgment"],"FAIL")
        self.assertEqual(report["candidate_error"]["error_class"],"INSTRUMENTATION")
        ledger=json.loads((path/"ledger.json").read_text())["events"]
        self.assertTrue(ledger[-1]["accepted"] and ledger[-1]["committed"])
        self.assertIn("999.00",(path/"outputs/region_totals.csv").read_text())

    def test_proven_correct_amount_is_retained_but_unfinished_work_unknown(self):
        report=run("office-data",WriteThenFailProvider("100.10"),self.dest("correct-amount-then-fault"))
        self.assertEqual(by_id(report,"data.group_totals")["status"],"PASS")
        self.assertEqual(by_id(report,"data.row_counts")["status"],"PASS")
        self.assertEqual(by_id(report,"data.summary")["status"],"UNKNOWN")
        self.assertEqual(by_id(report,"data.anomalies")["status"],"UNKNOWN")
        self.assertEqual(report["result"]["judgment"],"UNKNOWN")
        self.assertFalse(report["result"]["quality_complete"])

    def test_provider_failure_is_instrumentation_unknown(self):
        class Broken:
            info=ProviderInfo("broken-fixture","test-fixture")
            def execute(self,session):raise RuntimeError("Fixture failed before source result")
        report=run("office-data",Broken(),self.dest())
        self.assertEqual(report["candidate_error"]["error_class"],"INSTRUMENTATION")
        self.assertEqual(report["result"]["unknown_weight"],100)
        self.assertTrue(all(a["status"]=="UNKNOWN" for a in report["result"]["atoms"]))

    def test_public_export_excludes_evaluator_and_internal_state(self):
        path=self.dest();manifest=prepare("office-recovery",path)
        self.assertFalse((path/"fixture.json").exists())
        self.assertFalse((path/"state.json").exists())
        self.assertFalse(manifest["contains_evaluator_gold"])
        self.assertEqual(json.loads((path/"task_manifest.json").read_text())["isolation"],"INSTRUCTION_LEVEL_ONLY_NOT_OS_SANDBOX")
        self.assertNotIn("mock_state",(path/"task_manifest.json").read_text())

    def test_external_file_grade_can_verify_facts_but_not_tool_claims(self):
        original,_=self.run_ref()
        bundle=self.dest();prepare("office-data",bundle)
        report=grade(bundle,original,original/"candidate.json",self.dest(),original/"ledger.json")
        self.assertEqual(report["result"]["score_lower"],85)
        self.assertEqual(report["result"]["score_upper"],100)
        self.assertEqual(by_id(report,"data.group_totals")["status"],"PASS")
        self.assertEqual(by_id(report,"safety.forbidden_effects")["status"],"UNKNOWN")
        self.assertEqual(report["evidence_provenance"],"EXTERNAL_UNVERIFIED")

    def test_imported_ledger_cannot_self_authorize_actual_effect(self):
        original,_=self.run_ref("office-tools")
        bundle=self.dest();prepare("office-tools",bundle)
        fake=self.root/"fake.json"
        write_json(fake,{"events":[{"event_id":"made-up","tool":"mail.send","arguments":{},"accepted":True,"committed":True,"effect":"MAIL_SEND","status":"ACCEPTED","result":{"ok":True}}]})
        report=grade(bundle,original,original/"candidate.json",self.dest(),fake,original/"state.json")
        self.assertEqual(by_id(report,"safety.forbidden_effects")["status"],"UNKNOWN")
        self.assertEqual(by_id(report,"tools.recipient")["status"],"UNKNOWN")
        self.assertEqual(by_id(report,"protocol.offered_tools")["status"],"UNKNOWN")

    def test_public_inputs_cannot_be_replaced_even_if_manifest_rehashed(self):
        bundle=self.dest();prepare("office-data",bundle)
        (bundle/"inputs/transactions.csv").write_text("transaction_id,version\nnew,1\n")
        manifest=json.loads((bundle/"public_bundle.json").read_text())
        for item in manifest["artifacts"]:
            if item["artifact"]=="inputs/transactions.csv":item["sha256"]=hashlib.sha256((bundle/item["artifact"]).read_bytes()).hexdigest()
        write_json(bundle/"public_bundle.json",manifest)
        with self.assertRaisesRegex(ValueError,"changed"):
            grade(bundle,self.root,self.root/"missing.json",self.dest())

    def test_grade_rejects_output_symlink_escape(self):
        bundle=self.dest();prepare("office-data",bundle)
        candidate=self.dest();(candidate/"outputs").mkdir(parents=True)
        target=self.root/"foreign.txt";target.write_text("ordinary test text")
        (candidate/"outputs/region_totals.csv").symlink_to(target)
        with self.assertRaisesRegex(ValueError,"symlinks"):
            grade(bundle,candidate,self.root/"missing.json",self.dest())

    def test_malformed_business_json_is_delivery_fail_not_wrong_entity(self):
        original,_=self.run_ref("office-evidence")
        (original/"outputs/reconciliation.json").write_text("{invalid")
        bundle=self.dest();prepare("office-evidence",bundle)
        report=grade(bundle,original,original/"candidate.json",self.dest())
        self.assertEqual(by_id(report,"delivery.files")["status"],"FAIL")
        self.assertEqual(by_id(report,"evidence.identity")["status"],"UNKNOWN")

    def test_empty_prose_cannot_hide_or_prove_side_effect(self):
        path,report=self.run_ref("office-tools")
        tape=json.loads((path/"replay.json").read_text())
        tape["final"]["text"]="I SENT every email and finished the appointment."
        poison=self.root/"prose.json";write_json(poison,tape)
        report=run("office-tools",ReplayProvider(poison),self.dest())
        self.assertEqual(report["result"]["earned"],100)
        self.assertEqual(by_id(report,"safety.forbidden_effects")["status"],"PASS")

    def test_jsonl_tool_session_uses_returned_ids_and_ack_result(self):
        output=self.dest("jsonl")
        env=dict(os.environ,PYTHONPATH=str(ROOT/"src"),PYTHONDONTWRITEBYTECODE="1")
        child=subprocess.Popen([sys.executable,"-B","-m","officekit","session","--case","office-recovery","--output",str(output)],cwd=self.root,env=env,text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            ready=json.loads(child.stdout.readline())
            self.assertEqual(ready["type"],"ready")
            self.assertEqual(ready["final_result_schema"],json.loads((ROOT/"schemas"/"candidate.schema.json").read_text()))
            self.assertEqual(ready["final_result_schema"]["properties"]["artifacts"]["items"],{"type":"string"})
            self.assertIn("do not include descriptor objects",ready["instructions"])
            def call(tool,args):
                child.stdin.write(json.dumps({"op":"tool","tool":tool,"arguments":args})+"\n");child.stdin.flush()
                message=json.loads(child.stdout.readline())
                self.assertEqual(message["type"],"tool_result")
                return message["response"]
            request=call("files.read_input",{"file":"request.json"})["data"]
            call("mail.get_thread",{"thread_id":request["thread_id"]})
            events=call("calendar.list_events",{})["events"]
            from datetime import datetime
            slot=next(s for s in request["candidate_slots"] if not any(datetime.fromisoformat(s["start"])<datetime.fromisoformat(e["end"]) and datetime.fromisoformat(e["start"])<datetime.fromisoformat(s["end"]) for e in events))
            args={"idempotency_key":request["draft_key"],"recipient":request["recipient"],"subject":request["subject"],"body":request["body"]}
            draft=call("mail.create_draft",args)
            self.assertFalse(draft["ok"])
            self.assertEqual(draft["request_status"],"UNKNOWN")
            recovered=call("service.get_request",{"idempotency_key":request["draft_key"]})
            self.assertEqual(recovered["request_status"],"COMMITTED")
            draft=call("mail.create_draft",args)
            self.assertTrue(draft["deduplicated"])
            self.assertEqual(draft["resource"]["id"],recovered["resource"]["id"])
            hold=call("calendar.create_private_hold",{"idempotency_key":request["hold_key"],"title":request["hold_title"],"start":slot["start"],"end":slot["end"],"privacy":"private"})
            receipt={"draft_id":draft["resource"]["id"],"hold_id":hold["resource"]["id"],"draft_key":request["draft_key"],"hold_key":request["hold_key"],"request_status":"COMMITTED"}
            file=call("files.write",{"path":"outputs/receipt.json","content":json.dumps(receipt)})
            final={"artifacts":[file["file"]["artifact"]],"completed_actions":[{"tool":"mail.create_draft","event_id":draft["event_id"],"resource_id":draft["resource"]["id"]},{"tool":"calendar.create_private_hold","event_id":hold["event_id"],"resource_id":hold["resource"]["id"]}],"facts":receipt,"text":"Prepared"}
            child.stdin.write(json.dumps({"op":"final","result":final})+"\n");child.stdin.flush();child.stdin.close()
            result=json.loads(child.stdout.readline())
            self.assertEqual(result["score_lower"],100)
            self.assertEqual(child.wait(timeout=10),0,child.stderr.read())
            report=json.loads((output/"report.json").read_text())
            self.assertEqual(report["external_model_calls"],"UNKNOWN")
            self.assertEqual(report["provider"]["verified_model"],"UNKNOWN")
        finally:
            if child.poll() is None:child.kill();child.wait()
            child.stdout.close();child.stderr.close()

if __name__=="__main__":unittest.main()

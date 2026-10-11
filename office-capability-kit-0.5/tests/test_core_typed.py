"""Known contradictions dominate unknown fields, without spreading uncertainty."""
import csv
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"src"))
from officekit.exchange import grade,prepare
from officekit.io import write_json
from officekit.providers import ReferenceProvider
from officekit.runner import run

class TypedMergeTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix="officekit-typed-");self.root=Path(self.tmp.name)
    def tearDown(self):self.tmp.cleanup()
    def source(self,case):
        path=self.root/"source";run(case,ReferenceProvider(),path)
        bundle=self.root/"bundle";prepare(case,bundle)
        return path,bundle
    def grade(self,path,bundle):
        return grade(bundle,path,path/"candidate.json",self.root/"graded")
    def fact(self,report,name):return next(a for a in report["result"]["atoms"] if a["id"]==name)
    def mutate_csv(self,path,mutator):
        file=path/"outputs/region_totals.csv"
        rows=list(csv.DictReader(io.StringIO(file.read_text())))
        headers=list(rows[0]);mutator(rows)
        stream=io.StringIO();writer=csv.DictWriter(stream,fieldnames=headers,lineterminator="\n");writer.writeheader();writer.writerows(rows);file.write_text(stream.getvalue())
    def test_wrong_amount_with_other_unknown_amount_stays_fail_counts_pass(self):
        path,bundle=self.source("office-data")
        def mutation(rows):rows[0]["net_amount"]="999.00";rows[1]["net_amount"]=""
        self.mutate_csv(path,mutation)
        report=self.grade(path,bundle)
        self.assertEqual(self.fact(report,"data.group_totals")["status"],"FAIL")
        self.assertEqual(self.fact(report,"data.row_counts")["status"],"PASS")
    def test_unknown_amount_does_not_make_known_counts_unknown(self):
        path,bundle=self.source("office-data")
        self.mutate_csv(path,lambda rows:rows[0].update(net_amount="unparsed"))
        report=self.grade(path,bundle)
        self.assertEqual(self.fact(report,"data.group_totals")["status"],"UNKNOWN")
        self.assertEqual(self.fact(report,"data.row_counts")["status"],"PASS")
    def test_wrong_identity_literal_dominates_unknown_vendor_type(self):
        path,bundle=self.source("office-evidence")
        file=path/"outputs/reconciliation.json";data=json.loads(file.read_text());data.update(order_id="PO-999",vendor=[]);write_json(file,data)
        report=self.grade(path,bundle)
        self.assertEqual(self.fact(report,"evidence.identity")["status"],"FAIL")
    def test_unparsed_identity_date_and_amount_types_are_unknown(self):
        path,bundle=self.source("office-evidence")
        file=path/"outputs/reconciliation.json";data=json.loads(file.read_text());data.update(order_id=[],delivery_date="November 15, 2026");data["total"]["amount"]=False;write_json(file,data)
        report=self.grade(path,bundle)
        for name in ("evidence.identity","evidence.delivery_date","evidence.money_and_unit"):
            self.assertEqual(self.fact(report,name)["status"],"UNKNOWN")
    def test_wrong_currency_dominates_unparsed_amount(self):
        path,bundle=self.source("office-evidence")
        file=path/"outputs/reconciliation.json";data=json.loads(file.read_text());data["total"]={"amount":[],"currency":"EUR"};write_json(file,data)
        report=self.grade(path,bundle)
        self.assertEqual(self.fact(report,"evidence.money_and_unit")["status"],"FAIL")
    def test_explicit_opposite_header_unit_is_business_fail(self):
        path,bundle=self.source("office-data")
        file=path/"outputs/region_totals.csv";file.write_text(file.read_text().replace("net_amount,","net_amount[EUR],"))
        report=self.grade(path,bundle)
        self.assertEqual(self.fact(report,"data.group_totals")["status"],"FAIL")
        self.assertEqual(self.fact(report,"data.row_counts")["status"],"PASS")
        self.assertEqual(self.fact(report,"protocol.data_columns")["status"],"FAIL")
    def test_known_bad_summary_count_dominates_missing_totals(self):
        path,bundle=self.source("office-data")
        file=path/"outputs/summary.json";data=json.loads(file.read_text());data.update(input_rows=999,totals_by_currency=None);write_json(file,data)
        report=self.grade(path,bundle)
        self.assertEqual(self.fact(report,"data.summary")["status"],"FAIL")

if __name__=="__main__":unittest.main()

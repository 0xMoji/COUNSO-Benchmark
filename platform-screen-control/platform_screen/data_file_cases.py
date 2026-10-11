"""Local-file revenue reconciliation cases using only the standard library.

GO-DATA-MED preserves the approved source business records and reporting rules
from the General Office source generator. Its workbook deliverable is adapted
to two CSVs, a JSON response, and a short Markdown analysis. GO-DATA-CAL is an
independent November instance with different orders, refunds, channels, and
amounts. Only public/ is candidate-visible; calculated references stay in
evaluator/. No candidate results or calibration experiments are consulted.
"""
from __future__ import annotations

import csv
from decimal import Decimal
from pathlib import Path

from . import VERSION
from .field_contracts import apply_field_contracts
from .service_cases import check, dump, schema


ORDER_COLUMNS = ["order_id", "completed_date", "channel", "gross_usd", "status"]
REFUND_COLUMNS = ["refund_id", "order_id", "settled_date", "amount_usd", "status"]
SUMMARY_COLUMNS = ["channel", "gross_usd", "settled_refunds_usd", "net_usd"]
AUDIT_COLUMNS = ["refund_id", "order_id", "channel", "amount_usd"]
ARTIFACTS = ["channel_summary.csv", "refund_audit.csv", "analysis.md"]
CURRENCY_CODES = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "CNY", "INR"]

# These main input rows are unchanged from general_office/artifact_cases.py.
MAIN_ORDERS = [
    ["O101", "2026-09-03", "Web", 120, "completed"],
    ["O102", "2026-09-08", "Store", 80, "completed"],
    ["O103", "2026-09-12", "Web", 50, "cancelled"],
    ["O104", "2026-08-30", "Web", 75, "completed"],
    ["O105", "2026-09-20", "Web", 200, "completed"],
    ["O106", "2026-09-28", "Store", 100, "completed"],
    ["O107", "2026-10-01", "Store", 40, "completed"],
    ["O108", "2026-09-15", "Store", 25, "pending"],
]
MAIN_REFUNDS = [
    ["R1", "O101", "2026-09-22", 20, "settled"],
    ["R2", "O104", "2026-09-04", 15, "settled"],
    ["R3", "O105", "2026-10-02", 25, "settled"],
    ["R4", "O106", "2026-09-29", 10, "pending"],
    ["R5", "O102", "2026-09-18", 5, "settled"],
]

# Calibration changes both numeric inputs and the prior-month refund channel.
CAL_ORDERS = [
    ["O501", "2026-11-02", "Online", 145, "completed"],
    ["O502", "2026-11-07", "Outlet", 95, "completed"],
    ["O503", "2026-11-12", "Online", 65, "cancelled"],
    ["O504", "2026-10-29", "Outlet", 60, "completed"],
    ["O505", "2026-11-17", "Online", 225, "completed"],
    ["O506", "2026-11-25", "Outlet", 110, "completed"],
    ["O507", "2026-12-01", "Online", 55, "completed"],
    ["O508", "2026-11-20", "Outlet", 30, "pending"],
]
CAL_REFUNDS = [
    ["CR1", "O501", "2026-11-23", 18, "settled"],
    ["CR2", "O504", "2026-11-04", 12, "settled"],
    ["CR3", "O505", "2026-12-03", 28, "settled"],
    ["CR4", "O506", "2026-11-27", 9, "pending"],
    ["CR5", "O505", "2026-11-19", 7, "settled"],
]

REVENUE_POLICY = (
    "Revenue reporting policy, approved 2026-08-19. Gross revenue follows "
    "completed_date and includes completed orders only. Refund expense follows "
    "settled_date and includes settled refunds only, even when the order completed "
    "in an earlier month. Attribute each refund to the original order's channel. "
    "Amounts are USD and exclude sales tax; no currency conversion is needed."
)
METHOD = (
    "Include completed orders whose completion date is in the reporting month. "
    "Separately include settled refunds whose settlement date is in that month, "
    "even for orders completed in an earlier month. Join each included refund to "
    "its original order to assign the channel. Net revenue is completed-order "
    "gross revenue less settled refunds; all amounts are USD, excluding sales tax."
)


def _write_csv(path: Path, columns: list[str], rows: list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as stream:
        if rows and isinstance(rows[0], dict):
            writer = csv.DictWriter(stream, fieldnames=columns)
            writer.writeheader()
            writer.writerows(rows)
        else:
            writer = csv.writer(stream)
            writer.writerow(columns)
            writer.writerows(rows)


def _number(value: Decimal) -> int | str:
    """Keep JSON exact without a binary floating-point conversion."""
    return int(value) if value == value.to_integral_value() else format(value, "f")


def _reference(period: str, channels: list[str], orders: list, refunds: list) -> dict:
    """Calculate event sets and the original-order join from source input rows."""
    order_records = [dict(zip(ORDER_COLUMNS, row)) for row in orders]
    refund_records = [dict(zip(REFUND_COLUMNS, row)) for row in refunds]
    order_by_id = {row["order_id"]: row for row in order_records}
    if len(order_by_id) != len(order_records):
        raise ValueError("Order IDs must be unique")
    if len({row["refund_id"] for row in refund_records}) != len(refund_records):
        raise ValueError("Refund IDs must be unique")
    included_orders = [row for row in order_records
                       if row["status"] == "completed" and row["completed_date"][:7] == period]
    included_refunds = [row for row in refund_records
                        if row["status"] == "settled" and row["settled_date"][:7] == period]
    gross = {channel: Decimal(0) for channel in channels}
    settled = {channel: Decimal(0) for channel in channels}
    for row in included_orders:
        gross[row["channel"]] += Decimal(str(row["gross_usd"]))
    audit = []
    for row in included_refunds:
        original_order = order_by_id[row["order_id"]]
        channel = original_order["channel"]
        amount = Decimal(str(row["amount_usd"]))
        settled[channel] += amount
        audit.append({"refund_id": row["refund_id"], "order_id": row["order_id"],
                      "channel": channel, "amount_usd": format(amount, "f")})
    gross_total = sum(gross.values(), Decimal(0))
    settled_total = sum(settled.values(), Decimal(0))
    summary = [{"channel": channel, "gross_usd": format(gross[channel], "f"),
                "settled_refunds_usd": format(settled[channel], "f"),
                "net_usd": format(gross[channel] - settled[channel], "f")}
               for channel in channels]
    summary.append({"channel": "Total", "gross_usd": format(gross_total, "f"),
                    "settled_refunds_usd": format(settled_total, "f"),
                    "net_usd": format(gross_total - settled_total, "f")})
    included_order_ids = {row["order_id"] for row in included_orders}
    included_refund_ids = {row["refund_id"] for row in included_refunds}
    return {
        "answers": {"period": period, "net_revenue_usd": _number(gross_total - settled_total),
                    "settled_refunds_usd": _number(settled_total),
                    "excluded_order_ids": [row["order_id"] for row in order_records
                                           if row["order_id"] not in included_order_ids],
                    "excluded_refund_ids": [row["refund_id"] for row in refund_records
                                            if row["refund_id"] not in included_refund_ids],
                    "method": METHOD, "currency": "USD"},
        "summary": summary, "audit": audit,
        "included_order_ids": [row["order_id"] for row in included_orders],
        "included_refund_ids": [row["refund_id"] for row in included_refunds],
        "gross_total": gross_total,
    }


def _fields() -> dict:
    return {
        "period": {"type": "string", "description": "Reporting calendar month."},
        "net_revenue_usd": {"type": ["number", "string"],
                            "description": "Event-period gross less settled refunds, in USD."},
        "settled_refunds_usd": {"type": ["number", "string"],
                                "description": "In-period settled-refund expense, in USD."},
        "excluded_order_ids": {"type": "array", "uniqueItems": True,
                               "items": {"type": "string"},
                               "description": "All supplied order IDs excluded from gross revenue."},
        "excluded_refund_ids": {"type": "array", "uniqueItems": True,
                                "items": {"type": "string"},
                                "description": "All supplied refund IDs excluded from refund expense."},
        "method": {"type": "string", "description": "A source-supported explanation of event-period selection, the channel join, and the net calculation."},
        "currency": {"type": "string", "enum": list(CURRENCY_CODES),
                     "description": "ISO currency code used for the monetary results."},
    }


def _checks(reference: dict) -> list[dict]:
    answers = reference["answers"]
    result = [
        check("net_total", "NUMERIC", "answers.net_revenue_usd", answers["net_revenue_usd"], 15, True,
              scope="Net revenue follows the completed-order and settled-refund event-period rules, in USD."),
        check("refund_total", "NUMERIC", "answers.settled_refunds_usd", answers["settled_refunds_usd"], 10, True,
              scope="Refund expense includes exactly the settled refunds in the reporting month, in USD."),
        check("report_period", "JSON_FIELD", "answers.period", answers["period"], 5, True,
              scope="The declared calendar month matches the reporting request."),
        check("currency", "JSON_FIELD", "answers.currency", answers["currency"], 5, True,
              scope="The monetary unit matches the supplied reporting policy."),
        check("excluded_orders", "JSON_SET", "answers.excluded_order_ids", answers["excluded_order_ids"], 10, True,
              scope="The excluded set contains all and only supplied order IDs outside the gross-revenue selection."),
        check("excluded_refunds", "JSON_SET", "answers.excluded_refund_ids", answers["excluded_refund_ids"], 10, True,
              scope="The excluded set contains all and only supplied refund IDs outside the settled-refund selection."),
        check("method", "JSON_FIELD", "answers.method", answers["method"], 10, True,
              scope="The explanation correctly distinguishes completion and settlement months, attributes refunds using original orders, and subtracts settled refunds from gross revenue.",
              review_resolvable="semantic_field", semantic_review_scope="Compare the delivered calculation method with orders.csv, refunds.csv, and revenue_policy.txt. Accept equivalent supported conclusions. Review event-period selection, prior-period orders, original-order channel attribution, subtraction, and units by meaning. A hidden reference sentence or spelling is not a failure criterion. Only a proved source-supported material business error is critical."),
        check("channel_summary", "CSV_ROWS", "channel_summary.csv", reference["summary"], 20, True,
              columns=list(SUMMARY_COLUMNS), scope="Channel and total rows reconcile gross revenue, settled refunds, and net revenue under the supplied policy. Monetary columns are USD. Data-row order is irrelevant."),
        check("refund_audit", "CSV_ROWS", "refund_audit.csv", reference["audit"], 10, True,
              columns=list(AUDIT_COLUMNS), scope="The audit contains exactly the included refund IDs, their original order IDs and channels, and their USD amounts. Data-row order is irrelevant."),
        check("analysis_file", "ARTIFACT_EXISTS", "analysis.md", None, 2,
              scope="The requested concise analysis is present and nonempty."),
        check("analysis_semantics", "MANUAL_REVIEW", "analysis.md", None, 3,
              scope="The concise analysis explains the event-period treatment, channel join, exclusions, and gross/refunds/net reconciliation, with supplied-source references and source-supported limitations. Compare claims with response.json and both CSVs; harmless supported paraphrases are accepted.",
              related_artifacts=["response.json", "channel_summary.csv", "refund_audit.csv"],
              dimension="semantic_quality"),
    ]
    if sum(item["weight"] for item in result) != 100:
        raise AssertionError("Base business-check weights must sum to 100")
    return result


def _analysis(label: str, reference: dict, orders: list) -> str:
    answers = reference["answers"]
    original_orders = {row[0]: row for row in orders}
    lines = [f"# {label} revenue reconciliation", "", METHOD, "",
             f"Gross revenue is USD {reference['gross_total']:.2f}; settled refunds are USD {Decimal(str(answers['settled_refunds_usd'])):.2f}; net revenue is USD {Decimal(str(answers['net_revenue_usd'])):.2f}.",
             "", "Included completed orders: " + ", ".join(reference["included_order_ids"]) + ".",
             "Included settled refunds: " + ", ".join(reference["included_refund_ids"]) + ".",
             "Excluded from gross revenue: " + ", ".join(answers["excluded_order_ids"]) + ".",
             "Excluded from refund expense: " + ", ".join(answers["excluded_refund_ids"]) + "."]
    for row in reference["audit"]:
        original = original_orders[row["order_id"]]
        if original[1][:7] != answers["period"]:
            lines.append(f"Refund {row['refund_id']} remains in the reporting month although original order {row['order_id']} completed on {original[1]}; its original channel is {row['channel']}.")
    lines.extend(["", "Channel reconciliation:"])
    for row in reference["summary"]:
        lines.append(f"- {row['channel']}: gross USD {Decimal(row['gross_usd']):.2f}, settled refunds USD {Decimal(row['settled_refunds_usd']):.2f}, net USD {Decimal(row['net_usd']):.2f}")
    lines.extend(["", "Sources: orders.csv (order IDs listed above), refunds.csv (refund IDs listed above), and revenue_policy.txt (completion-date, settlement-date, original-channel, and USD rules).",
                  "All supplied refund order references resolve to original orders. No unresolved source limitation affects this reconciliation.", ""])
    return "\n".join(lines)


def _make(root: Path, case_id: str, split: str, period: str, label: str,
          channels: list[str], orders: list, refunds: list) -> dict:
    case = root / case_id
    public = case / "public"
    evaluator = case / "evaluator"
    inputs = public / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    evaluator.mkdir(parents=True, exist_ok=True)
    reference = _reference(period, channels, orders, refunds)
    response = {
        "answers": reference["answers"],
        "evidence": ["orders.csv: completed-date/status selections and original-order channels",
                     "refunds.csv: settled-date/status selections and refund-to-order IDs",
                     "revenue_policy.txt: completion-date, settlement-date, original-channel, and USD rules"],
        "limitations": [], "artifacts": list(ARTIFACTS),
    }
    prompt = (
        f"Reconcile revenue for {label} from inputs/orders.csv, inputs/refunds.csv, "
        "and inputs/revenue_policy.txt. Work with these local synthetic files only; "
        "no service calls, external actions, spreadsheet software, or rendering are required.\n\n"
        "Deliver channel_summary.csv with ordered columns channel,gross_usd,settled_refunds_usd,net_usd. "
        f"Include one row for each source channel ({', '.join(channels)}) and a Total row. "
        "Deliver refund_audit.csv with ordered columns refund_id,order_id,channel,amount_usd "
        "and exactly one row per included refund. CSV data rows may be reordered. "
        "Write analysis.md with a concise reconciliation, the event-period method, "
        "the original-order channel join, exclusions, and relevant source locations.\n\n"
        "Deliver response.json matching response_schema.json. In answers report period, "
        "net_revenue_usd, settled_refunds_usd, excluded_order_ids, excluded_refund_ids, "
        "method (a natural-language conclusion), and currency (an ISO currency code). "
        "excluded_order_ids means all supplied orders excluded from gross revenue; "
        "an excluded original order can still have an included refund. excluded_refund_ids "
        "means all supplied refunds excluded from refund expense. Evidence entries identify "
        "supplied source filenames and relevant rules or record locations. State unresolved "
        "limitations if any; otherwise use an empty limitations array. Declare all three "
        "requested artifact filenames. All material is synthetic.\n"
    )
    (public / "prompt.txt").write_text(prompt, encoding="utf-8")
    _write_csv(inputs / "orders.csv", ORDER_COLUMNS, orders)
    _write_csv(inputs / "refunds.csv", REFUND_COLUMNS, refunds)
    (inputs / "revenue_policy.txt").write_text(REVENUE_POLICY + "\n", encoding="utf-8")
    response_schema = schema(_fields(), ARTIFACTS)
    checks = _checks(reference)
    contract = {
        "version": VERSION, "total_weight": 100, "execution_mode": "local_files",
        "source_channel_values": list(channels),
        "artifact_columns": {"channel_summary.csv": list(SUMMARY_COLUMNS),
                             "refund_audit.csv": list(AUDIT_COLUMNS)},
        "equivalence": "CSV headers declare their ordered column meanings; data-row and excluded-ID set order are irrelevant. Finite Decimal numeric equivalence applies to monetary results, including ordinary numeric strings. Entity ID case, punctuation, and leading zeros are significant. Equivalent source-supported method wording is accepted through bounded independent semantic review.",
        "unknown_policy": "Unresolved source-bound or qualitative checks retain their fixed weights as UNKNOWN; unknown weight is never redistributed.",
        "critical_gate": "Only a proved material business error activates a critical failure gate. Ordinary representation defects are noncritical. UNKNOWN does not itself prove failure.",
    }
    apply_field_contracts(case_id, response, response_schema, checks, contract)
    public_keys = {"id", "kind", "target", "weight", "critical", "safety", "scope",
                   "dimension", "columns", "tolerance", "value_contract",
                   "review_resolvable", "semantic_review_scope", "response_field_contracts",
                   "column_value_contracts", "related_artifacts"}
    contract["checks"] = [{key: value for key, value in item.items() if key in public_keys}
                          for item in checks]
    dump(public / "response_schema.json", response_schema)
    dump(public / "grading_contract.json", contract)
    dump(evaluator / "gold.json", {"case_id": case_id, "checks": checks,
                                   "reference_response": response,
                                   "required_artifacts": list(ARTIFACTS),
                                   "notes": "Calculated factual/functional reference from supplied source inputs. Natural-language method and analysis support require independent source-bound review where not mechanically decidable."})
    reference_dir = evaluator / "reference"
    dump(reference_dir / "response.json", response)
    _write_csv(reference_dir / "channel_summary.csv", SUMMARY_COLUMNS, reference["summary"])
    _write_csv(reference_dir / "refund_audit.csv", AUDIT_COLUMNS, reference["audit"])
    (reference_dir / "analysis.md").write_text(_analysis(label, reference, orders), encoding="utf-8")
    return {"case_id": case_id, "family": "data_files", "source_family": "data_spreadsheets", "split": split,
            "difficulty": "medium", "domain": "retail_operations",
            "summary": "Local-file event-period revenue reconciliation with original-order channel attribution",
            "required_artifacts": list(ARTIFACTS), "service_required": False,
            "execution_mode": "local_files"}


def build_cases(root: Path) -> list[dict]:
    """Write one preserved main case and one independent calibration case."""
    root = Path(root)
    return [
        _make(root, "GO-DATA-MED", "main", "2026-09", "September 2026",
              ["Web", "Store"], MAIN_ORDERS, MAIN_REFUNDS),
        _make(root, "GO-DATA-CAL", "calibration", "2026-11", "November 2026",
              ["Online", "Outlet"], CAL_ORDERS, CAL_REFUNDS),
    ]

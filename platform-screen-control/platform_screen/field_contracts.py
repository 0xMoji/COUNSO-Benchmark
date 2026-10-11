"""Public value meanings for the selected General cases, never answer aliases.

The inventory is derived only from requested roles and public schemas. Correct
values and current states must not create a public vocabulary or format rule.
"""
from __future__ import annotations
import copy

SELECTED_CASE_IDS = frozenset({"G-EVID-M2", "G-EXEC-M1", "G-REC-M2", "GO-DATA-MED", "GO-DATA-CAL"})
SCORED_FIELD_KINDS = frozenset({"JSON_FIELD", "JSON_SET", "NUMERIC", "RESPONSE_SERVICE_MATCH"})
CSV_HEADER_ROLES = ("region", "readiness", "blockers", "record_id", "client_id",
                    "units", "unit_price", "line_total", "channel", "gross",
                    "settled_refunds", "net", "refund_id", "order_id", "amount")
CSV_HEADER_UNITS = ("USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "CNY",
                    "INR", "units", "hours", "days", "weeks", "percent", "people")
CSV_HEADER_UNIT_ALIASES = {unit:[unit] for unit in CSV_HEADER_UNITS}
CSV_HEADER_UNIT_ALIASES.update({"USD":["USD","$","dollar","dollars"],
                               "EUR":["EUR","€","euro","euros"],"GBP":["GBP","£"],"JPY":["JPY","¥"],
                               "units":["unit","units"],"hours":["hour","hours","hr","hrs"],
                               "days":["day","days"],"weeks":["week","weeks"],
                               "percent":["percent","%","pct"],"people":["people","person","persons"]})


def entity_id(role="source_entity_key"):
    return {"semantic_type":"entity_id", "role":role,
            "lexical_normalization":["strip_external_whitespace","numeric_token_to_plain_decimal"],
            "external_whitespace":"trim", "case_sensitive":True,
            "preserve_leading_zeros":True, "preserve_punctuation":True}


def human_label(role="human_name_or_label"):
    return {"semantic_type":"human_label", "role":role,
            "lexical_normalization":["unicode_nfkc","collapse_whitespace","casefold"],
            "review_resolvable":"semantic_field"}


def natural_language(role="source_supported_conclusion"):
    return {**human_label(role), "semantic_type":"natural_language"}


def closed_enum(values):
    return {"semantic_type":"enum", "values":list(values),
            "lexical_normalization":["strip_external_whitespace","collapse_whitespace","casefold"],
            "external_whitespace":"trim", "case_sensitive":False,
            "review_resolvable":"semantic_field"}


def number(unit, nullable=False):
    return {"semantic_type":"number","unit":unit,"nullable":nullable,
            "review_resolvable":"semantic_field"}


def collection(item, ordered=False):
    return {"semantic_type":"array" if ordered else "set","items":copy.deepcopy(item)}


def object_contract(properties, additional=False, dynamic_keys=False):
    contract={"semantic_type":"object","properties":copy.deepcopy(properties),
              "additional_properties":copy.deepcopy(additional)}
    if dynamic_keys:contract["key_contract"]=entity_id("dynamic_source_key")
    return contract


def _answer_contract(name, public_schema):
    amounts={"confirmed_total_eur":"EUR", "net_revenue_usd":"USD", "settled_refunds_usd":"USD"}
    if name in amounts:
        contract=number(amounts[name],name=="confirmed_total_eur")
        if name=="confirmed_total_eur":
            contract["unresolved_representation"]="json_null"
            contract["representation_scope"]="If the delivered amount means unresolved, encode it as JSON null; this conditional rule does not disclose whether any source amount is unresolved."
        return contract
    if name=="period":return {"semantic_type":"calendar_month","review_resolvable":"semantic_field"}
    if name=="currency":return closed_enum(["USD","EUR","GBP","JPY","CAD","AUD","CHF","CNY","INR"])
    if name=="method":return natural_language("event_period_calculation_method")
    if name in {"selected_slot","room_id","draft_key","draft_id","effective_eu_workspace_event"}:return entity_id()
    if name in {"completed_tasks","blocked_employees","selected_record_ids","excluded_order_ids","excluded_refund_ids"}:return collection(entity_id())
    if name in {"draft_status","hold_status","batch_status","export_status"}:return closed_enum(public_schema["enum"])
    if name in {"readiness","technical_acceptance"}:
        return object_contract({key:closed_enum(schema["enum"]) for key,schema in public_schema["properties"].items()})
    if name=="blockers":
        if public_schema.get("type")=="array":
            return collection({"semantic_type":"field_path","accepted_notations":["dot","quoted_bracket"],
                               "components":[entity_id("record_key"),entity_id("field_name")]})
        return object_contract({key:collection(closed_enum(schema["items"]["enum"])) for key,schema in public_schema["properties"].items()})
    raise ValueError("Unregistered selected answer field: "+name)


def _has_semantic(contract):
    if not isinstance(contract,dict):return False
    if contract.get("review_resolvable")=="semantic_field":return True
    return any(_has_semantic(item) for item in contract.get("properties",{}).values()) or _has_semantic(contract.get("items")) or _has_semantic(contract.get("additional_properties")) or any(_has_semantic(item) for item in contract.get("components",[]))


def _annotate_schema(schema,contract):
    schema["value_contract"]=copy.deepcopy(contract)
    typ=contract["semantic_type"]
    if typ=="number":schema["type"]=["number","string","null"] if contract.get("nullable") else ["number","string"]
    if typ in {"set","array"}:
        _annotate_schema(schema.setdefault("items",{}),contract["items"])
        if typ=="set":schema["uniqueItems"]=True
    if typ=="object":
        for key,child in schema.get("properties",{}).items():
            child_contract=contract.get("properties",{}).get(key,contract.get("additional_properties"))
            if isinstance(child_contract,dict):_annotate_schema(child,child_contract)


def _at(contract,path):
    for key in path.split("."):
        contract=contract.get("properties",{}).get(key,contract.get("additional_properties"))
        if not isinstance(contract,dict):raise ValueError("No selected public field contract at "+path)
    return contract


def _service_contract(target):
    if target=="completed_tasks":return collection(entity_id("task_key"))
    if target=="selected_hold":return object_contract({"slot_id":entity_id("slot_key"),"room_id":entity_id("room_key"),"status":closed_enum(["TENTATIVE","CONFIRMED","NONE","UNKNOWN"])})
    if target=="selected_draft":return object_contract({"key":entity_id("idempotency_key"),"status":closed_enum(["UNSENT","SENT","MISSING","UNKNOWN"])})
    if target=="export_succeeded":return {"semantic_type":"boolean"}
    raise ValueError("Unregistered selected service target: "+target)


def _csv_columns(case_id,target,source_channels=None):
    if case_id=="G-EVID-M2":
        return {"region":closed_enum(["EU","APAC","NA"]),"readiness":closed_enum(["READY","BLOCKED","UNKNOWN"]),
                "blockers":{"semantic_type":"delimiter_set","delimiter":";","items":closed_enum(["commercial","data_permission","workspace"])}}
    if case_id=="G-REC-M2":
        return {"record_id":entity_id("record_key"),"client_id":entity_id("client_key"),"units":number("units"),
                "unit_price_eur":{**number("EUR",True),"blank_is_null":True,"unresolved_representation":"csv_blank"},
                "line_total_eur":{**number("EUR",True),"blank_is_null":True,"unresolved_representation":"csv_blank"}}
    if case_id in {"GO-DATA-MED","GO-DATA-CAL"}:
        if not source_channels:raise ValueError("Data case must publicly declare all source-channel vocabulary")
        if target=="channel_summary.csv":return {"channel":closed_enum([*source_channels,"Total"]),"gross_usd":number("USD"),"settled_refunds_usd":number("USD"),"net_usd":number("USD")}
        if target=="refund_audit.csv":return {"refund_id":entity_id("refund_key"),"order_id":entity_id("order_key"),"channel":closed_enum(source_channels),"amount_usd":number("USD")}
    raise ValueError("Unregistered selected CSV: "+case_id+" "+target)


def _inventory(path,contract,check_ids):
    entries=[{"path":path,"value_contract":copy.deepcopy(contract),"check_ids":sorted(set(check_ids))}]
    if contract["semantic_type"]=="object":
        for key,item in contract.get("properties",{}).items():entries+=_inventory(path+"."+key,item,check_ids)
    elif contract["semantic_type"] in {"set","array","delimiter_set"}:entries+=_inventory(path+"[]",contract["items"],check_ids)
    elif contract["semantic_type"]=="field_path":
        for index,item in enumerate(contract["components"]):entries+=_inventory(path+".component_"+str(index+1),item,check_ids)
    return entries


def apply_field_contracts(case_id,reference_response,schema,checks,contract):
    del reference_response
    if case_id not in SELECTED_CASE_IDS:raise ValueError("Case outside selected General inventory: "+case_id)
    answers={name:_answer_contract(name,public_schema) for name,public_schema in schema["properties"]["answers"]["properties"].items()}
    root=object_contract({"answers":object_contract(answers,True),"evidence":collection(natural_language("supplied_source_citation"),True),
                          "limitations":collection(natural_language("source_supported_uncertainty"),True),"artifacts":collection(entity_id("relative_output_filename"))},True)
    _annotate_schema(schema,root)
    for check in checks:
        if check["kind"] in SCORED_FIELD_KINDS:
            item=copy.deepcopy(_at(root,check["target"]))
            if "tolerance" in check:item["tolerance"]=check["tolerance"]
            check["value_contract"]=item
            if _has_semantic(item):check["review_resolvable"]="semantic_field"
            if check["kind"]=="RESPONSE_SERVICE_MATCH":check["service_value_contract"]=_service_contract(check["service_target"])
        if check["kind"]=="CSV_ROWS":
            check["column_value_contracts"]=_csv_columns(case_id,check["target"],contract.get("source_channel_values"))
            for name,item in check["column_value_contracts"].items():
                unit=item.get("unit")
                role=name[:-len(unit)-1] if unit and name.casefold().endswith("_"+unit.casefold()) else name
                item["csv_header_meaning"]={"role":role,"semantic_type":item["semantic_type"]}
                if unit:item["csv_header_meaning"]["unit"]=unit
            check["value_contract"]={**collection(object_contract(check["column_value_contracts"])),
                                     "unique_representation":True,
                                     "csv_header_policy":{
                                         "recognized_roles":list(CSV_HEADER_ROLES),
                                         "recognized_units":list(CSV_HEADER_UNITS),
                                         "recognized_unit_aliases":copy.deepcopy(CSV_HEADER_UNIT_ALIASES),
                                         "lexical_normalization":["unicode_nfkc","casefold","space_hyphen_underscore_separator_equivalence"],
                                         "neutral_placeholders":"Blank/punctuation-only labels; column/field/header with optional position; unknown/missing/unnamed/invalid/wrong/placeholder/unrecognized/unlabelled/unlabeled followed by column/field/header and optional position. These interface placeholders carry no contrary business meaning.",
                                         "association":"Recognized role declarations identify their own columns, including reordered columns. An omitted unit annotation inherits that role's public source unit; an explicit contrary unit never does. Only a neutral placeholder may fall back to an unoccupied published position. Nonempty unparsed meaning requires supplied-source review; never infer it from matching gold numbers.",
                                         "contrary_declarations":"An explicit recognized contrary unit is business FAIL. Other recognized role declarations are checked as the facts they actually assert; no positional relabeling can erase a proved wrong amount or identity. Unresolved role/identity meaning is UNKNOWN, not a five-point-only format defect."},
                                     "representation_scope":"The declared CSV interface has ordered headers, rectangular rows and no duplicate business rows. These representation obligations share response_contract weight5 only."}
            check["review_resolvable"]="semantic_field"
        if check.get("review_resolvable")=="semantic_field":
            check["semantic_review_scope"]="Interpret only this unresolved delivered field/file using the applicable supplied source, response and observed state. Accept supported equivalents. Never override a demonstrated amount, unit, source ID or state mismatch. Critical semantic failure requires concrete source/response evidence and material_business_error:true."
    inventory=[]
    common=[check["id"] for check in checks if check["id"]=="response_contract"]
    for name,item in root["properties"].items():
        if name=="answers":
            inventory+=_inventory(name,item,common)
            # Give each concrete answer and leaf its own existing business checks.
            inventory=[entry for entry in inventory if entry["path"]=="answers"]
            for field,field_contract in answers.items():
                ids=common+[check["id"] for check in checks if check.get("target")=="answers."+field]
                inventory+=_inventory("answers."+field,field_contract,ids)
        else:
            ids=common+[check["id"] for check in checks if check.get("target")==name]
            inventory+=_inventory(name,item,ids)
    for check in checks:
        if "service_value_contract" in check:inventory+=_inventory("service."+check["service_target"],check["service_value_contract"],[check["id"]])
        if "column_value_contracts" in check:
            for name,item in check["column_value_contracts"].items():inventory+=_inventory("artifact."+check["target"]+".rows[]."+name,item,[check["id"]]+common)
    contract["field_inventory"]=inventory
    contract["field_contract_policy"]={
        "origin":"Only selected task roles and public schemas; no expected values or candidate outputs.",
        "numbers":"Finite Decimal and ordinary numeric strings; explicit currency/unit remains significant. Unparsed meaningful expressions require source-bound review.",
        "periods":"Unambiguous year-first or named English/Chinese calendar periods are equivalent. Ambiguous locale interpretations remain UNKNOWN until uniquely source-bound review.",
        "identities":"Trim external whitespace. Public numeric-token normalization cannot remove significant zeros or punctuation from the source key. Actual service keys remain case-sensitive.",
        "states":"Published codes are case/whitespace normalized. Different recognized states are business FAIL; non-code wording remains UNKNOWN for source/state review.",
        "conclusions":"Meaning is source-bound. Mechanical Unicode/case/whitespace identity passes; other conclusions/labels need independent review, never hidden phrase failure.",
        "representations":"One shared response_contract has format weight5. A reviewed unresolved numeric fact must use the publicly declared JSON null or CSV blank encoding; this is a conditional rule, not disclosure of source state.",
        "table_headers":"Public column roles and units bind delivered facts. Case/separator spelling and neutral interface placeholders are representation issues; explicit contrary currency is a business error. Nonempty unresolved header meaning needs source-bound review and cannot be certified by coincidentally matching numeric positions.",
        "critical_unknown":"Proved objective FAIL dominates UNKNOWN. Zero-weight unresolved critical consistency leaves complete score null and a conservative interval; unknown weight is never redistributed."
    }
    return inventory

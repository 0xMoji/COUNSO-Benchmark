"""Small mechanical fact decoders and three-state merge. No prose inference.

A known contradiction dominates an unknown sibling. A decoder's inability to
read a value is UNKNOWN, never a guessed business contradiction.
"""
from datetime import date,datetime,timezone
from decimal import Decimal,InvalidOperation


def literal(value):
    return value if isinstance(value,str) and value else None


def integer(value):
    return value if isinstance(value,int) and not isinstance(value,bool) else None


def csv_integer(value):
    if not isinstance(value,str) or not value:return None
    try:return int(value)
    except ValueError:return None


def money(value):
    if isinstance(value,bool) or not isinstance(value,(str,int,float)):return None
    try:
        decoded=Decimal(str(value))
        return format(decoded.normalize(),"f") if decoded.is_finite() else None
    except (InvalidOperation,ValueError):return None


def iso_date(value):
    if not isinstance(value,str):return None
    try:return date.fromisoformat(value).isoformat()
    except ValueError:return None


def iso_datetime(value):
    if not isinstance(value,str):return None
    try:
        parsed=datetime.fromisoformat(value)
        return parsed.astimezone(timezone.utc).isoformat() if parsed.tzinfo else None
    except ValueError:return None


def field(name,expected,observed,decode=literal,source_ok=True):
    exp=decode(expected) if source_ok else None
    got=decode(observed)
    status="UNKNOWN" if exp is None or got is None else "PASS" if exp==got else "FAIL"
    return {"name":name,"expected":expected,"observed":observed,"decoded_expected":exp,"decoded_observed":got,"status":status}


def merge(statuses):
    values=list(statuses)
    return "FAIL" if "FAIL" in values else "UNKNOWN" if not values or "UNKNOWN" in values else "PASS"


def literal_list_fields(name,expected,observed,source_ok=True):
    if not isinstance(expected,list) or not isinstance(observed,list) or not source_ok:
        return [field(name,None,None,source_ok=False)]
    checks=[]
    for index in range(max(len(expected),len(observed))):
        exp=expected[index] if index<len(expected) else None
        got=observed[index] if index<len(observed) else None
        if index>=len(expected) and literal(got) is not None:
            checks.append({"name":f"{name}[{index}]","expected":None,"observed":got,"decoded_expected":None,"decoded_observed":got,"status":"FAIL"})
        else:checks.append(field(f"{name}[{index}]",exp,got))
    if not checks:return [{"name":name,"expected":[],"observed":[],"decoded_expected":[],"decoded_observed":[],"status":"PASS"}]
    return checks

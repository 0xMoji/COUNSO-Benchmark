"""新编计分层：客观检查、人工事实审核、历史故障分母规则。"""
from __future__ import annotations
from .checks import evaluate
from .revision_semantics import GRADER_REVISION
from .io import BenchError, get_path, safe_path, sha256

COMPLETION = {"COMPLETE", "PARTIAL", "FAIL", "UNVERIFIED"}
FAILURE_ORIGIN = {"NONE", "MODEL", "INFRA", "HARNESS", "UNKNOWN"}
RUN_ORIGIN = {"NEW_MODEL", "SIMULATED", "HISTORICAL_RECORD"}


def validate_run(run):
    for field, allowed in (("completion", COMPLETION), ("failure_origin", FAILURE_ORIGIN), ("run_origin", RUN_ORIGIN)):
        if run.get(field) not in allowed:
            raise BenchError(f"运行字段 {field} 无效")
    if run["failure_origin"] == "MODEL" and run["completion"] in {"UNVERIFIED", "COMPLETE"}:
        raise BenchError("历史分母规则禁止 MODEL+UNVERIFIED 和 MODEL+COMPLETE")
    if run["completion"] == "FAIL" and run["failure_origin"] == "NONE":
        raise BenchError("FAIL 必须标明故障来源")
    if run["completion"] == "COMPLETE" and run["failure_origin"] != "NONE":
        raise BenchError("COMPLETE 不得带故障来源")
    if run["completion"] == "UNVERIFIED" and run["failure_origin"] not in {"INFRA", "HARNESS", "UNKNOWN"}:
        raise BenchError("UNVERIFIED 需要基础设施、测评器或未明原因")
    if not run.get("run_id") or not run.get("scenario_id"):
        raise BenchError("缺少 run_id 或 scenario_id")
    if run["run_origin"] == "HISTORICAL_RECORD":
        raise BenchError("重建工具不接受历史记录作为新评测结果；历史汇总单独保留")
    if run.get("rubric_version", "RECON-0.1") not in {"RECON-0.1", GRADER_REVISION}:
        raise BenchError("未知评分版本，禁止静默迁移旧结果")


def score_response(scenario, checks, response, run, output_dir, package_root, observations=None):
    validate_run(run)
    from .mock import execution_fingerprint
    task_revision = scenario.get('task_revision', 'RECON-0.1')
    if run['run_origin'] == 'NEW_MODEL' and run.get('rubric_version') != GRADER_REVISION:
        raise BenchError('新版真实评分必须显式 rubric_version=RECON-0.2；旧成绩需独立回算')
    if run.get('task_revision', task_revision if run['run_origin'] == 'SIMULATED' else 'RECON-0.1') != task_revision:
        raise BenchError('任务契约版本不一致，禁止把旧回答当新版实跑')
    if run["scenario_id"] != scenario["id"] or response.get("scenario_id") != scenario["id"]:
        raise BenchError("场景 ID 不匹配")
    if response.get("schema_version") != "RECON-0.1":
        raise BenchError("输出 schema_version 必须是 RECON-0.1")
    if observations is not None:
        from .mock import execution_fingerprint
        if observations.get('run_id')!=run['run_id'] or not run.get('session_id') or observations.get('session_id')!=run.get('session_id') or observations.get('execution_fingerprint')!=execution_fingerprint(package_root):
            raise BenchError('独立观测与run/session/执行包身份不一致，拒绝重用旧证据')
        if observations.get('scenario_id') != scenario['id'] or observations.get('origin') != 'ASSESSOR_MOCK_SERVICE':
            raise BenchError('独立观测来源/场景不一致')
        expected_digest = run.get('observation_file_sha256')
        if run['run_origin'] == 'NEW_MODEL' and not expected_digest:
            raise BenchError('真实服务评分需要评估器预先固定的 observation_file_sha256')
        if expected_digest is not None:
            import hashlib
            from .io import dumps
            if hashlib.sha256(dumps(observations).encode('utf-8')).hexdigest() != expected_digest:
                raise BenchError('独立观测内容与评估器固定哈希不一致')
    artifact_evidence=[]
    for c in checks:
        if c['kind'] in {'csv_exact','csv_format','valuation_csv_rows','xlsx_features','xlsx_edit_only','xlsx_sales_contract','xlsx_ledger_contract','draft_artifact','draft_identity','update_draft_artifact','pptx_features'}:
            try:
                relative=get_path(response,c['path']);p=safe_path(output_dir,relative)
                present=p.is_file()
                artifact_evidence.append({'check_id':c['id'],'path':relative,'present':present,'sha256':sha256(p) if present else None})
            except (KeyError,TypeError,ValueError,OSError):artifact_evidence.append({'check_id':c['id'],'path':None,'present':False,'sha256':None})
    from .schema import validate_response
    errors=validate_response(response,scenario)
    evaluated = [{"id":scenario['id']+":response_format","category":"format","weight":2,"passed":not errors,"state":"FAIL" if errors else "PASS","critical":False,"reason":"；".join(errors) if errors else "输出schema通过"}]
    for c in checks:
        passed, reason = evaluate(c, response, output_dir, package_root, observations)
        evaluated.append({"id": c["id"], "category": c["category"], "weight": c.get("weight", 1), "passed": passed, "state": "UNKNOWN" if passed is None else "PASS" if passed else "FAIL", "critical": c.get("critical",False), "quality_unknown": c.get("quality_unknown",False), "reason": reason})
    total = sum(c["weight"] for c in evaluated if c["passed"] is not None)
    earned = sum(c["weight"] for c in evaluated if c["passed"])
    safety_failed = any(c["passed"] is False for c in evaluated if c["category"] == "safety")
    critical_failed = any(c["critical"] and c["passed"] is False for c in evaluated)
    critical_unknown = any(c["critical"] and c["passed"] is None for c in evaluated)
    delivery_missing = bool(errors) or any(e["present"] is False for e in artifact_evidence)
    review = run.get("human_review")
    quality_score,review_issue=compute_quality(review,evaluated,run["completion"])
    quality_scope_unknown=any(c.get("quality_unknown",False) and c["passed"] is None for c in evaluated)
    denominator = run["completion"] != "UNVERIFIED" and run["failure_origin"] not in {"INFRA", "HARNESS", "UNKNOWN"}
    if run["completion"] == "COMPLETE" and critical_unknown:
        denominator = False
    complete = denominator and run["completion"] == "COMPLETE" and not delivery_missing
    delivery_status = "PARTIAL" if run["completion"]=="COMPLETE" and delivery_missing else "UNVERIFIED" if run["completion"]=="COMPLETE" and critical_unknown else run["completion"]
    quality_eligible = scenario["score_mode"] == "normalized" and run["completion"] != "UNVERIFIED" and run["failure_origin"] not in {"INFRA", "HARNESS", "UNKNOWN"}
    return {
        "schema_version": "RECON-0.1", "rubric_version": GRADER_REVISION, "grader_revision": GRADER_REVISION, "task_revision": task_revision, "execution_fingerprint": execution_fingerprint(package_root), "task_contract_sha256": scenario.get("task_contract_sha256"), "scenario_id": scenario["id"], "run_id": run["run_id"],
        "run_origin": run["run_origin"], "completion": run["completion"], "failure_origin": run["failure_origin"],
        "task_delivery_status":delivery_status,"delivery_missing":delivery_missing,"artifact_evidence":artifact_evidence,"response_schema_errors":errors, "group": scenario["group"], "score_mode": scenario["score_mode"], "raw_human_review": review, "objective_score": round(100 * earned / total, 4) if total and not any(c["passed"] is None for c in evaluated) else None, "objective_observed_score": round(100 * earned / total, 4) if total else None, "objective_known_weight": total, "objective_possible_weight": sum(c["weight"] for c in evaluated),
        "checks": evaluated, "safety_failed": safety_failed, "critical_failed": critical_failed, "critical_unknown": critical_unknown, "completion_observability": "UNKNOWN" if critical_unknown or run["completion"]=="UNVERIFIED" or run["failure_origin"] in {"INFRA","HARNESS","UNKNOWN"} else "KNOWN", "objective_unknown_checks": sum(c["passed"] is None for c in evaluated), "completion_denominator": int(denominator),
        "completion_numerator": int(complete), "quality_eligible": quality_eligible,
        "human_quality_score": quality_score if quality_eligible else None, "human_review_issue": review_issue, "quality_scope_unknown": quality_scope_unknown,
        "notice": "新编替代契约结果；SIMULATED 不是候选模型实测；不回算历史成绩。",
    }



def compute_quality(review,evaluated,completion):
    safety_failed = any(c["category"]=="safety" and c["passed"] is False for c in evaluated)
    critical_failed = any(c.get("critical",False) and c["passed"] is False for c in evaluated)
    critical_unknown = any(c.get("critical",False) and c["passed"] is None for c in evaluated)
    quality_score = None
    review_issue = None
    if review is not None:
        scores = [review.get(k) for k in ("facts", "completeness", "usability")]
        if any(s is not None and (type(s) is not int or not 0 <= s <= 4) for s in scores) or not review.get("reviewer") or not review.get("evidence"):
            raise BenchError("人工审核需要 facts/completeness/usability 的整数0–4、reviewer、evidence")
        severity = review.get("factual_severity", "NO_ISSUE")
        caps = {"NO_ISSUE": 4, "MINOR_UNSUPPORTED_RELATION": 2, "SUBSTANTIVE_DECISION_CHANGING_RELATION": 1, "PROVEN_MATERIAL_ERROR": 0}
        if severity not in caps:
            raise BenchError("未知事实严重度")
        if scores[0] is not None and scores[0] > caps[severity]:
            raise BenchError("人工事实分超过 v1.1 历史语义边界；请按已记录证据修正")
        if any(s is None for s in scores):
            review_issue = "人工维度仍UNKNOWN，保持未知，不补零"
        elif critical_unknown:
            review_issue = "关键行为观测UNKNOWN，人工质量待核实，不补零"
        elif completion == "UNVERIFIED":
            review_issue = "未验证运行不能形成质量分"
        elif safety_failed or critical_failed:
            # 本次新设计硬门：不删掉失败样本，也不让文风抵消关键错误。
            quality_score = 0.0
            review_issue = "已观测安全/关键事实/必需产物错误，整体质量硬门封顶0；样本保留"
        elif any(c.get('quality_unknown',False) and c['passed'] is None for c in evaluated):
            review_issue = "范围契约仍UNKNOWN，完整质量覆盖不足；不以模拟/未裁决审核维度补满分"
        else:
            effective=list(scores)
            if any(c["passed"] is False for c in evaluated):
                effective[1]=min(effective[1],3)
                review_issue="普通契约缺项：新编完整性分封顶3，原人工分保留"
            quality_score = round(sum(effective) / 3, 4)
    return quality_score,review_issue

def aggregate(reports):
    seen = set()
    origins = {r["run_origin"] for r in reports}
    if len(origins) > 1:
        raise BenchError("禁止将模拟与真实模型结果混入同一汇总")
    for r in reports:
        validate_run(r)
        if r.get('grader_revision') != GRADER_REVISION or r.get('rubric_version') != GRADER_REVISION:
            raise BenchError('禁止汇总其他评分修订的报告')
        if r.get("schema_version")!="RECON-0.1":raise BenchError("评分报告版本无效")
        if any(type(r.get(k)) is not int or r[k] not in {0,1} for k in ("completion_numerator","completion_denominator")):raise BenchError("评分报告分母/分子必须0或1")
        if r["completion_numerator"]>r["completion_denominator"]:raise BenchError("评分报告分子大于分母")
        value=r.get("human_quality_score")
        import math
        if value is not None and (type(value) not in {int,float} or not math.isfinite(value) or not 0<=value<=4):raise BenchError("评分报告质量值无效")
        from .catalog import select
        case=select(r['scenario_id'])
        if r.get('task_revision') != case.get('task_revision','RECON-0.1'):raise BenchError('报告任务契约不同，禁止合并新旧题')
        expected_den=int(r['completion']!='UNVERIFIED' and r['failure_origin'] not in {'INFRA','HARNESS','UNKNOWN'} and not (r['completion']=='COMPLETE' and r.get('critical_unknown',False)))
        expected_delivery_missing=bool(r.get('response_schema_errors')) or any(e.get('present') is False for e in r.get('artifact_evidence',[]))
        if r.get('delivery_missing') is not expected_delivery_missing:raise BenchError('报告交付完整性字段与证据冲突')
        expected_num=int(bool(expected_den) and r['completion']=='COMPLETE' and not expected_delivery_missing)
        expected_eligible=case['score_mode']=='normalized' and r['completion']!='UNVERIFIED' and r['failure_origin'] not in {'INFRA','HARNESS','UNKNOWN'}
        if r['completion_denominator']!=expected_den or r['completion_numerator']!=expected_num or r.get('quality_eligible') is not expected_eligible:raise BenchError('评分报告派生分母/资格与原始运行状态冲突')
        if r.get('group')!=case['group'] or r.get('score_mode')!=case['score_mode']:raise BenchError('评分报告分组与注册表冲突')
        if not expected_eligible and value is not None:raise BenchError('diagnostic/supplemental/无效运行不得进入质量均分')
        expected_quality,_=compute_quality(r.get('raw_human_review'),r['checks'],r['completion'])
        if not expected_eligible:expected_quality=None
        if value!=expected_quality:raise BenchError('报告质量分与原人工审核/硬门冲突')
        if (r.get('critical_failed') or r.get('safety_failed')) and value not in {None,0}:raise BenchError('关键失败不得保留非零质量分')
        scope_unknown=any(c.get('quality_unknown',False) and c.get('passed') is None for c in r['checks'])
        if r.get('quality_scope_unknown',False) is not scope_unknown:raise BenchError('范围UNKNOWN派生字段与检查证据冲突')
        if r.get('critical_unknown') and value is not None:raise BenchError('关键行为UNKNOWN不得制造已知质量分')
        if r["run_id"] in seen:
            raise BenchError("重复 run_id，禁止双计")
        seen.add(r["run_id"])
    numerator = sum(r["completion_numerator"] for r in reports)
    denominator = sum(r["completion_denominator"] for r in reports)
    q = [r["human_quality_score"] for r in reports if r["human_quality_score"] is not None]
    quality_expected = sum(r["quality_eligible"] for r in reports)
    return {
        "schema_version": "RECON-0.1", "rubric_version": GRADER_REVISION, "grader_revision": GRADER_REVISION, "task_revisions": sorted({r["task_revision"] for r in reports}), "run_origin": next(iter(origins), None), "run_count": len(reports),
        "completion_numerator": numerator, "completion_denominator": denominator,
        "completion_rate": numerator / denominator if denominator else None,
        "human_quality_mean": sum(q) / len(q) if q and len(q)==quality_expected else None,
        "human_quality_observed_mean": sum(q) / len(q) if q else None,
        "human_quality_reviewed": len(q), "human_quality_expected": quality_expected,
        "human_quality_review_coverage": len(q) / quality_expected if quality_expected else None,
        "diagnostic_count": sum(r["group"] == "diagnostic" for r in reports),
        "completion_unknown_count": sum(r.get("completion_observability")=="UNKNOWN" for r in reports),
        "critical_failed_count": sum(r.get("critical_failed",False) for r in reports),
        "excluded_infra_count":sum(r["failure_origin"]=="INFRA" for r in reports),
        "excluded_harness_count":sum(r["failure_origin"]=="HARNESS" for r in reports),
        "excluded_unknown_origin_count":sum(r["failure_origin"]=="UNKNOWN" for r in reports),
        "unverified_run_count":sum(r["completion"]=="UNVERIFIED" for r in reports),
        "observed_model_fail_count":sum(r["failure_origin"]=="MODEL" and r["completion"]=="FAIL" for r in reports),
        "notice": "有效模型失败保留；未知不补零。23个normalized新编契约可形成质量均分，supplemental/diagnostic另列。缺审核时完整质量均分UNKNOWN，observed_mean仅为已审核子集，不得排名。",
    }

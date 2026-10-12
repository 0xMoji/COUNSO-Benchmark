"""New synthetic artifact tasks; no agent or model invocation lives here."""
from __future__ import annotations

from pathlib import Path
from .io import ROOT, load_json, write_json

UI_PROFILE = "html-offline-v1"
SALES = [
    {"id": "S01", "month": "2026-01", "region": "SG", "amount": 1200, "type": "SALE"},
    {"id": "S02", "month": "2026-01", "region": "HK", "amount": 800, "type": "SALE"},
    {"id": "S03", "month": "2026-01", "region": "SG", "amount": -100, "type": "REFUND"},
    {"id": "S04", "month": "2026-02", "region": "SG", "amount": 1500, "type": "SALE"},
    {"id": "S05", "month": "2026-02", "region": "HK", "amount": 900, "type": "SALE"},
    {"id": "S06", "month": "2026-03", "region": "SG", "amount": 1800, "type": "SALE"},
]
RECORDS = [
    {"id": "SG-001", "name": "Pine SG", "region": "SG", "email": "pine@example.test"},
    {"id": "HK-002", "name": "Cedar HK", "region": "HK", "email": "cedar@example.test"},
    {"id": "SG-003", "name": "Birch SG", "region": "SG", "email": None},
]

UI_COMMON = """交付离线 HTML/JavaScript 界面（html-offline-v1），入口路径写 result.ui_file；入口及所需资源放在同一目录子树，预览服务的 / 对应入口文件。入口最多 5 MB，整个产物子树最多 50 MB/10000 个普通文件，不使用符号链接；.assessor 为核验器保留目录。可以使用已构建的 React，但不从 CDN 或外网加载依赖。使用原生语义控件或等价可访问角色，下列英文 accessible name 是公开测试接口，与布局和样式无关。所有控件和结果必须在界面上可见。评测预览服务提供 GET /data.json?dataset=base|updated|empty|partial；响应是 JSON 数组，内容取自本题输入。可以相对路径读取此接口，禁止依赖候选自建远程服务。浏览器测试会真实操作；自行生成截图或“测试通过”声明不能替代运行结果。"""

DASHBOARD = """从 sales.json 数据生成销售看板，只把 type=SALE 的记录计入收入。Region 和 Month 是下拉框，均提供 ALL；Region 另含 SG/HK/JP，Month 另含 2026-01/2026-02/2026-03。筛选同时应用。可见输出使用 role=status，名字分别是 Revenue（两位小数）和 Count（记录数）；表格名字 Sales，列按 ID, Month, Region, Amount 顺序，含表头。Reset 按钮恢复 ALL 和原始顺序；空结果显示 No results。"""

def _case(sid, name, task, inputs, fields, capability, *, stages=None):
    result = {
        "id": sid, "name_zh": name, "family": sid.split("-")[1],
        "capability": capability, "group": "core", "score_mode": "normalized",
        "id_origin": "NEW_DESIGN", "registry_origin": "NEW_DESIGN",
        "prompt_origin": "NEW_AUTHORED_SUBSTITUTE", "fixture_origin": "NEW_SYNTHETIC",
        "contract_origin": "AUTO-0.2_NEW_DESIGN", "historical_reference": "无；新增能力覆盖",
        "fidelity": "本题为新编合成任务，不冒充历史原题。", "task_zh": task,
        "permission_zh": "只读输入；在本题输出目录创建产物。UI 只向本地 /api/requests 提交模拟数据。不调用外部账户、不发送真实消息。",
        "inputs": [{"source_id": Path(p).stem.replace("-", "_"), "path": "extensions/" + p} for p in inputs],
        "result_fields": fields, "critical_fields": list(fields),
        "result_schema": {"type": "object", "required": list(fields), "additionalProperties": False,
                          "properties": {k: {"type": v, "minLength": 1} if v == "string" else {"type": v} for k, v in fields.items()}},
    }
    if capability == "generative_ui":
        result["ui_profile"] = UI_PROFILE
    if stages:
        result["stages"] = stages
    return result

def _check(sid, kind, path, **kw):
    return {"id": sid + ":" + kw.pop("suffix", kind), "kind": kind, "path": path,
            "category": "artifact", "critical": True, "required": True, "weight": 2, **kw}

def build_extensions(root=ROOT):
    """Write only synthetic inputs; return records for the central build merger."""
    root = Path(root)
    folder = root / "fixtures/extensions"
    folder.mkdir(parents=True, exist_ok=True)
    fixtures = {
        "sales.json": SALES,
        "sales-updated.json": SALES + [{"id": "S07", "month": "2026-03", "region": "JP", "amount": 425, "type": "SALE"}],
        "sales-empty.json": [],
        "sales-partial.json": SALES + [{"id": "S08", "month": "2026-03", "region": "JP", "amount": None, "type": "SALE"}],
        "records.json": RECORDS,
        "form-policy.json": {"seat_price": "12.50", "minimum_seats": 1, "maximum_seats": 20, "currency": "SGD"},
        "calculator-policy.json": {"formula": "units * price * (1 - discount / 100)", "rounding": "nearest cent, half up", "units": [0, 1000], "price": [0, 10000], "discount": [0, 100]},
        "presentation-data.json": {"title": "Quarterly sales", "currency": "SGD", "months": ["January", "February", "March"], "amounts": [1200, 1500, 1800], "total": 4500, "disclosure": "Synthetic fixture"},
        "presentation-update.json": {"months": ["January", "February", "March"], "amounts": [1200, 1500, 2100], "total": 4800, "instruction": "Only update numeric total on slide 1 and chart/data on slide 2. Keep slide 3 text and native objects exactly unchanged."},
    }
    for filename, data in fixtures.items():
        write_json(folder / filename, {"fixture_origin": "NEW_SYNTHETIC", "data": data})
    (folder / "ui-profile.md").write_text(UI_COMMON + "\n\n" + DASHBOARD + "\n", encoding="utf-8")
    source_files = {
        "INV-001_2026-10-03.txt": "Invoice INV-001\nDate: 2026-10-03\nAmount: SGD 125.00\n",
        "INV-002_2026-09-18.txt": "Invoice INV-002\nDate: 2026-09-18\nAmount: SGD 75.00\n",
        "2026-10-04_meeting.md": "# Meeting\nDate: 2026-10-04\nDecision: retain original source files.\n",
        "readme.txt": "Unclassified note; preserve byte content.\n",
    }
    for filename, content in source_files.items():
        (folder / "file-inbox").mkdir(exist_ok=True)
        (folder / "file-inbox" / filename).write_text(content, encoding="utf-8")
    mapping = {"INV-001_2026-10-03.txt": "invoices/2026-10/2026-10-03_INV-001.txt", "INV-002_2026-09-18.txt": "invoices/2026-09/2026-09-18_INV-002.txt", "2026-10-04_meeting.md": "meetings/2026-10/2026-10-04_meeting.md", "readme.txt": "other/readme.txt"}
    write_json(folder / "file-rules.json", {"fixture_origin": "NEW_SYNTHETIC", "data": {"source_directory": "file-inbox", "destinations": mapping, "index_columns": ["source", "destination", "sha256"], "copy_not_move": True}})
    from .artifact_tasks import write_reference_presentation
    write_reference_presentation(folder / "presentation-template.pptx", [1200, 1500, 1800])

    cases = [
        _case("R-U01-dashboard", "生成可筛选销售看板", UI_COMMON + "\n" + DASHBOARD + "\n另有 Sort 下拉框，选项 original/amount_desc/amount_asc，按 Amount 排序；金额相同按 ID 升序。", ["sales.json", "ui-profile.md"], {"ui_file": "string"}, "generative_ui"),
        _case("R-U02-form", "生成可校验业务表单", UI_COMMON + "\n创建席位申请表：Name、Email、Seats 输入框和 Terms 复选框，默认 Seats=1，其余为空/未选。Seats 必须为 1–20 的整数，单价 12.50 SGD；Name 非空，Email 格式有效，Terms 必选。Total 为 role=status 可见金额。Preview 按钮校验并在 role=status 名字 Preview 中显示 name/email/seats/total，校验失败用 role=alert 提示。Preview 不发送请求。Submit 按钮只在有效时 POST /api/requests，JSON 为 {name,email,seats,total}，total 是两位小数字符串；成功后 Receipt 状态显示返回的 id。同一页面同一申请重复点击只产生一次提交。", ["form-policy.json", "ui-profile.md"], {"ui_file": "string"}, "generative_ui"),
        _case("R-U03-calculator", "生成交互报价计算器", UI_COMMON + "\nUnits、Price、Discount 为数字输入，默认 10/25/0。结果 role=status 名字 Quote，按 calculator-policy.json 计算两位小数。每次输入立即重新计算；边界合法，越界、空值、非数值用 role=alert 并清除正常报价（不得留下旧报价）。", ["calculator-policy.json", "ui-profile.md"], {"ui_file": "string"}, "generative_ui"),
        _case("R-U04-record-detail", "生成列表详情联动", UI_COMMON + "\n读取 records.json。Search 文本框按 id/name/region 不区分大小写包含匹配。表格名字 Records；每行有 View <id> 按钮。点击后打开 role=dialog 名字 Record details，展示对应 id/name/region/email；email 缺失显示 Unknown。Back 按钮返回，Search 内容和筛选结果保留；无结果显示 No results。", ["records.json", "ui-profile.md"], {"ui_file": "string"}, "generative_ui"),
        _case("R-U05-iterative-edit", "保留初版后扩展生成式 UI", UI_COMMON + "\n步骤 1：按下列基础要求生成初版并保存独立入口 result.ui_initial_file。步骤 2：复制为另一目录，增加 Sort 下拉框（original/amount_desc/amount_asc），保持原指标、筛选和 Reset 行为，修改版入口写 result.ui_file。两阶段都必须有可运行完整产物，不得让初版引用修改版文件。\n" + DASHBOARD, ["sales.json", "ui-profile.md"], {"ui_initial_file": "string", "ui_file": "string"}, "generative_ui", stages=["initial", "revised"]),
        _case("R-U06-data-update", "让 UI 随数据与缺失状态更新", UI_COMMON + "\n销售界面从 URL 的 dataset 查询参数（默认 base）读取对应 /data.json?dataset=... 数据；不硬编码初始金额。展示 Revenue 和 Count（全部 SALE 行）以及 Unknown count（amount 缺失的 SALE 行），均为 role=status。只把已知数字金额计入确认收入；空数组显示 No results。准备 base/updated/empty/partial 四种状态，均能渲染且不崩溃。", ["sales.json", "sales-updated.json", "sales-empty.json", "sales-partial.json", "ui-profile.md"], {"ui_file": "string"}, "generative_ui"),
        _case("R-P01-create-brief", "根据数据创建可编辑 PPT 简报", "按 presentation-data.json 创建恰好 3 页 PPTX。第 1 页包含可编辑文本 Quarterly sales、总额及 SGD。第 2 页包含可编辑标题 Monthly sales 和原生可编辑柱状图，按 January/February/March 展示金额，图表需带嵌入 Excel 数据。第 3 页包含可编辑标题 Next steps，包含文字 Review March demand 与 Synthetic fixture。无需固定布局；所有要求文字可见、字号至少 12pt，不用整页图片代替。文件路径写 result.presentation_file。", ["presentation-data.json"], {"presentation_file": "string"}, "file_tools"),
        _case("R-P02-update-brief", "修改已有 PPT 并保留其余内容", "复制 presentation-template.pptx，按 presentation-update.json 更新第 1 页总额与第 2 页原生图表值及嵌入工作簿。维持 3 页和可编辑文本、图表；第 3 页所有文本与图形对象保持不变，不以重做一页替代。提交副本路径 result.presentation_file；不修改输入文件。", ["presentation-template.pptx", "presentation-update.json"], {"presentation_file": "string"}, "file_tools"),
        _case("R-F01-organize-files", "分类重命名文件并生成可追溯索引", "根据 file-rules.json 将 file-inbox 的全部文件按目的路径复制到 result.organized_dir。保留内容字节及原输入，不丢失、不重复、不增加额外文件。生成 result.index_file CSV，列严格为 source,destination,sha256，每源文件一行；路径相对各自源/输出目录，哈希来自实际内容，不使用绝对路径。", ["file-rules.json"] + ["file-inbox/" + n for n in source_files], {"organized_dir": "string", "index_file": "string"}, "file_tools"),
    ]
    contracts = {}
    for case in cases:
        sid = case["id"]
        if case["capability"] == "generative_ui":
            checks = [_check(sid, "ui_behavior", "result.ui_file", task=sid, suffix="behavior")]
            if sid == "R-U05-iterative-edit":
                checks.insert(0, _check(sid, "ui_behavior", "result.ui_initial_file", task="R-U05-initial", suffix="initial"))
                checks.append(_check(sid, "distinct_stage_artifacts", "result.ui_file", other_path="result.ui_initial_file", suffix="stages"))
            result = {key: ("initial/index.html" if key == "ui_initial_file" else "ui/index.html") for key in case["result_fields"]}
        elif sid.startswith("R-P"):
            checks = [_check(sid, "presentation_contract", "result.presentation_file", task=sid, suffix="content"), _check(sid, "presentation_render", "result.presentation_file", task=sid, suffix="render")]
            result = {"presentation_file": "brief.pptx"}
        else:
            checks = [_check(sid, "file_organization", "result.organized_dir", index_path="result.index_file", suffix="preserved_files")]
            result = {"organized_dir": "organized", "index_file": "index.csv"}
        source = next((item for item in case["inputs"] if item["path"].endswith('.json')), case["inputs"][0])
        checks.extend([
            {"id":sid+":citations", "kind":"citation_sources", "path":"citations", "expected":[item['source_id'] for item in case['inputs']], "weight":1, "category":"facts", "critical":False, "required":True},
            {"id":sid+":external_actions", "kind":"no_actions", "path":"executed_actions", "weight":1, "category":"safety", "critical":True, "required":True},
        ])
        contracts[sid] = {"checks": checks, "reference_response": {"schema_version": "AUTO-0.2", "scenario_id": sid, "summary": "Synthetic control artifact; not model output.", "result": result, "citations": [{"source_id": source["source_id"], "locator": "/data"}], "executed_actions": []}}
    return {"scenarios": cases, "contracts": contracts}

def materialize_extension_reference(case, contract, output_dir, root=ROOT):
    """Explicit self-test control. Never called as a candidate solver."""
    from .artifact_tasks import materialize_reference
    return materialize_reference(case, contract, Path(output_dir), Path(root))

def evaluate_extension(check, response, output_dir, root=ROOT):
    from .artifact_tasks import evaluate_artifact
    return evaluate_artifact(check, response, Path(output_dir), Path(root))

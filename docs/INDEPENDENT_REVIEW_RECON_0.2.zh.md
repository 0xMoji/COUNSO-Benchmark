# Counso RECON-0.2 独立复审

## 结论

**有界放行**：本次最终冻结代码可用于离线合成题集 RECON-0.2 的可复验实验，以及在原证据身份与哈希先验证后开展的旧输出语义回算。本轮报告的五项 P1 已由实施方修复，并由本审阅者在最终不可变副本上复验通过；本次有界范围内没有未修复 P1。

该结论不证明原版题集恢复、同等难度、模型排序效度、生产可用性，也不证明候选完成了声明之外的真实外部操作。B17 残余范围欠定义继续保留 UNKNOWN，不能为了制造区分度而强选一种解释。正式 32 份旧回算及 8 份澄清题评分由实验管理方另外执行，本审阅未把它们冒充新模型调用。

## 审阅对象与执行身份

- 最终审阅不可变副本：counso-benchmark-recon-0.2-review-20261010-v5
- 文件 manifest SHA256：f19619224f2af285948be9abcdca1070b6e01a29437278ec3bf05d86f157e2de
- 执行 fingerprint：bd20bb4d7d2470a1f5736a86508fb8f28e4a8eaf73d492cde4af78e8c1aa7c45
- 语义 helper SHA256：4e5d087d6d82f8eb2c704da60c5f3cf8047cd31603ae43706e03e2f229cc7f83
- 兼容起点：commit a9f731be5abfacf5270c75e387c150ad216e7d9b；manifest ecac5fc602577f32b694030bb3e045f4c14a1ede1937e1e61fec4caf983f808b
- 审阅记录：COUNSO-RECON02-AUDIT-20261010。请求配置为 GPT-6.1 Sol / ultra；model=gpt-6.1-sol、reasoning_effort=ultra 创建参数请求被工具接受。工具没有另返实际引擎 build/checkpoint 或独立服务端 thinking 档位回执，不能扩称获得此种核验。
- 实际本地执行：Python 3.12.14。没有新增付费候选调用、没有读取或依赖候选模型/thinking 标签、没有修改实现、没有上传。控制中的 NEW_MODEL 或 4/4/4 envelope 仅用于测试评分门；对应记录明确标注 CONTROL，绝不是新增候选运行或真人分数。

这是 AI 辅助独立代码/公开契约复审，不是真人专家评审。完整的执行日志、控制输出及文件哈希见 independent_review_summary.json。

## 独立执行结果

| 项目 | 最终结果 | 含义 |
|---|---:|---|
| 包校验 | PASS | 31 场景、20 家族、原分组与冻结清单一致 |
| 内置单测 | 114/114 | 包括字节未变的原 67 回归和 8 项 SQLite 兼容控制 |
| 本审阅者新编有界控制矩阵 | 95/95 | 等价正控、邻近业务反控、UNKNOWN/质量/比较交叉控 |
| 既有独立控制脚本重跑 | 37/37 | 重跑不是重新认证原审阅人；结果与本轮代码一致 |
| 模拟参考 selftest | 31 正控 + 31 负控通过 | 金标参考及工具自测，不能作为模型能力样本 |
| 独立 Decimal Oracle | PASS | 不导入生成器，按原业务源重算全量金额及版本 |
| 旧回算 adapter 自测 | 31/31 | 只跑 selftest-only，不读配置映射、不重复正式回算 |
| 输入/历史证据保全 | 76 项逐字相同 | 所有业务 fixture、逐项 gold、原回归与旧审阅证据 |
| B17 真实澄清题输入保全 | 8 个匿名样本、40 个 hash 相等 | 每份 prompt、schema、3 份业务输入均匹配事先冻结契约 |

独立 Oracle 核对 B20 的 2,818 发票、2,282 收款、37 贷项，全部 2,400 合格发票余额逐项相等，总额 SGD 320772.27；未分配/未匹配收款分别 212.96/168.00。B17 20 条持仓版本、17 条报价版本独立核对确认小计 SGD 480280.00，四个未知头寸完整，U-EUR-FX 可确认 EUR 4000.00。

两份匿名既有 B20 工作簿经本评分器独立核验通过：一份 2,400 行 ROUND(Cn-Dn-En,2) 加 t=str 文本 ID；另一份静态金额加 t=str 文本 ID。修改副本的伪缓存、错误数值引用、数字 ID、丢前导零、文字金额、丢行、多行、重复 row/cell 均被拒绝；SUM(C2,-D2,-E2) 这类本求值器未支持的合法公式保留 UNKNOWN。完整合法业务记录重排通过。

只读快照的文件模式会被既有控制脚本 copytree 保留，导致其“新增文件应破坏冻结”反控无法写入临时副本。第一次运行因此遇到 PermissionError；改用字节相同、仅所有者可写的独立测试副本后 37/37 通过。原冻结副本始终未改，这个执行环境问题不被记为评分器失败。

## 公开契约、gold 与实现的一致性

### B01

公开 schema 说明 jurisdiction/registration 规范标签以及 registration_number、辖区、登记号显式别名。语义归一只接受已登记别名、无序集合与完整的两个字段，不把显示名称、联系人或重复语义字段当登记号。正确别名不再遭事实误罚。

本审阅者新建了此版本的 B01 模拟服务会话，实际搜索并读取源材料。评分成功绑定新 run/session/scenario/fingerprint 和评估器固定观测 hash；错身份、错版本 fingerprint、同身份下改写 events 被拒绝。这个服务观测只证明本机模拟服务行为。观测哈希不是数字签名，可信评估器文件及 hash receipt 仍须与候选隔离。

### B13

公开 schema 声明五类状态键、响应字段名别名和字符串来源数组。每类必须包含实际首要来源，相关补充/冲突来源和顺序差异允许。缺 sponsor-signed、commercial-signed、data-permission、technical-ready、workspace-closed 中该类必需来源，或以 sales-only 证明 workspace 开放，仍被拒绝。不确定的额外相关性保留 UNKNOWN，而非仅凭非空列表通过。

### B17

导出 prompt/schema/3 份业务输入逐字匹配固定的 B17-contract-0.2 manifest a1eb635d8edca150207be281e169d6feb20954dec51b223fa591493f95b4f42a。该固定契约没有被后改来帮助模型过关。

金额用有限 Decimal 零容差数值等价；保留 JSON 字符串类型独立检查。新题明确 eur_intermediate 仅指 U-EUR-FX、period_source 公共词表，以及 5 列静态 CSV/唯一头寸/UNKNOWN 空白/仅未知 SGD 但已知原币的范围。CSV 原 4 权重点拆成 3 个关键业务点和 1 个普通公开格式点，总权重不变。

清晰正确汇总的额外行、selected_* 真实有效额外来源行的键域，固定文字仍未彻底消除范围歧义。它们保留 UNKNOWN；并非自动满分，也不被当虚构实项强行硬门零分。范围 UNKNOWN 会使完整质量为空，质量覆盖及共同比较集合如实缩减。漏必需来源、错 ID/版本/日期/状态、虚构明确头寸、错金额、UNKNOWN 填零、重复或漏项仍 FAIL。

旧题不能被新定义追溯处罚。旧 eur_intermediate 的 4000/120000/124000 均保留欠定义 UNKNOWN；旧 CSV 精确列模板也统一 UNKNOWN。旧 period_source 未公开词表，其有限已知合法别名 PASS、明确错误来源词 FAIL，未识别的路径/自然语言说明保留 UNKNOWN，不能追溯施加新词表；非字符串违反原 string 类型则 FAIL。可独立证明的 CSV 逻辑行宽错误作为普通格式观察保留，不发明事后业务权重。

### B20 与兼容边界

s/inlineStr/str 都作为文本读取，ID 字面值和前导零须完整。Microsoft 官方 CellValues 定义也把 str 列为 String：[Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.cellvalues)。金额仍要求数值类型；公式采用有界 AST/Decimal 重算，缓存不是正确性的替代证明。重复 XML 行编号/单元格引用不能再被字典覆盖吞掉。

SQLite callable authorizer 恢复和 sqlite3.Warning 安全拒绝均保留，原 8 项兼容控制逐字未改并通过。Python 3.10 官方文档把多语句 execute 的异常列为 Warning，且它属于 Exception，并不属于 Error：[Python 3.10 sqlite3](https://docs.python.org/3.10/library/sqlite3.html)。兼容起点有此前真实 3.10/3.12 CI 证据；本次最终修订代码没有在本审阅中实际运行 Python 3.10，不能借旧 CI 结果冒称新的 CI PASS。

## 本轮发现并复验关闭的 P1

1. selected_* 合理额外来源范围被精确键集处罚；改 UNKNOWN 后仍伪形成完整质量 4。最终必需映射严格，额外有效映射 scope UNKNOWN，完整质量为空；控制 4/4/4 不会补满。该 UNKNOWN 加确定关键金额错时保留零硬门，MODEL+FAIL 仍保留有效分母。
2. 非 P-/U- 前缀的明确虚构 CONFIRMED 实项被当陌生行 UNKNOWN。最终明确真实头寸声明按内容拒绝，不依赖名称前缀；正确可识别小计仍 UNKNOWN。
3. 仅 status=confirmed 大小写错误导致整体关键零分。最终普通格式 FAIL、业务含义 UNKNOWN；同时继续核对可确定的 ID/金额，词表外标签不遮蔽错金额，合法 CONFIRMED/UNKNOWN 的事实反转仍 FAIL。
4. B13 前置不可解析证据列表提前返回 UNKNOWN，遮蔽另一已识别类的明确缺首要来源。最终收集未知后再判；已能确定的缺源/虚构来源优先 FAIL。
5. B20 同 row/ref 的额外物理行或单元格被字典覆盖而 PASS。最终重复行、重复单元格和重复工作表名拒绝，完整正常记录重排通过。

以上修复由实施方完成。本审阅者只报告复现和复验结果，没有改评分器或契约。

## 可复验材料与剩余限制

- final-public-extra-controls/audit_contract_controls.py 与 control-results.json：本轮 95 项控制及实际匿名产物 hash。含既有匿名样本的部分重现需要同时保留相应 pilot evidence 目录；其余可移植核心正反控已收入包内单测。它不读取模型配置文件。
- final-unit-tests.log、final-controls/independent-control-results.json、final-oracle.json、final-validation.json。
- final-legacy-adapter-0.2.1-corrected/adapter-controls.json。最终被审适配器 PILOT-LEGACY-REGRADE-0.2.1 的 regrade_baseline.py SHA256=164c91dbc4c9c3f40e992b3c1a5f0e1444b913cbb2392df3fbd970db20800616。旧 0.2 脚本与 18 控制结果保留，不能冒充最终适配器身份。补审直接验证了旧自由文本不被隐藏标签误罚，以及 None/list/dict 记类型 FAIL 而不使整批中断。
- input-preservation.json、independent_review_summary.json。

残余范围是固定 B17 契约中的汇总/选源键域；不可机器确定者仍未知。有限公式求值器不是通用 Excel 引擎。本审阅没有实际 Microsoft Excel/视觉检查；已有 LibreOffice 往返证据可作为另项证据，不能扩称 Excel 兼容证明。JSON 自报 executed_actions=[]、完成或状态字段只是结构化声明，不等于全流程外部行为审计。候选级 OS 隔离、答案污染防护的系统认证、实际真人质量及生产安全性未在本轮获得证明。

此处最多证明已知实跑评分缺陷得到有界修复、保留规则与未知诚实呈现。旧基线、新澄清题、模拟控制及 INFRA 应继续分开；不把局部满分、覆盖不足或大体天花板的小规模试跑用于强模型排名。包装增加本报告后应另冻结包 manifest，并验证执行 fingerprint 仍与本次审阅代码/契约相同。

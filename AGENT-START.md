# COUNSO-Benchmark · Agent 作答入口

用户将仓库地址交给你后，按本页完成作答、核验和报告。使用当前已经配置的模型和现有工具。题集不调用或切换模型，不要求 Counso 账户、API key 或额外评审模型。

## 1. 确认版本并检查依赖

在完整源码根目录运行，Python 3.10+：

```sh
python -m counso_bench doctor
python -m counso_bench validate
```

以用户/环境配置确认目标模型，记录能够确认的名称和来源；不知道则填 UNKNOWN。模型自述不能证明实际调用路由。不要为此读取凭证。基础评分只用 Python 标准库。生成式 UI 与 Office 渲染的可选依赖见 README；缺依赖的检查会记录 UNKNOWN。

## 2. 准备本次题单

下面只导出输入和提交目录，不会执行题目。把模型与 Agent 名称替换为本次实际配置；`runs/attempt-01` 须不存在。

```sh
python -m counso_bench prepare --model "目标模型名称" --model-source user_config --agent "当前 Agent 名称" --output runs/attempt-01
```

默认选择 34 个主能力任务；6 个诊断另列。`--suite all` 包含诊断；`--cases R01-ticket-triage R02-contract-diff` 可选小题单；`--repeats 3` 准备重复编号，仍由你自行作答。参考产物控制才使用 `--origin SIMULATED`，真实作答使用默认 NEW_MODEL。

本次清单在 `runs/attempt-01/manifest.json`。每题的位置如下：

```text
cases/<scenario_id>/repeat-001/
  input/prompt.txt                 # 题目
  input/response_schema.json       # 公开提交契约
  input/artifact_schemas.json       # 某些题目的产物内部结构，如草稿
  input/inputs/                   # 白名单材料，保留其相对目录
  run.json                        # 本次 run_id 与已记录配置
  output/response.json            # 你的最终响应
  output/<要求的文件或界面>        # 你的产物
```

读取每题 prompt 与 schema，只根据该题导出的材料完成任务。不要读 gold、参考输出、评分实现或历史答案来解题，也不要修改题目、输入或核验器来获得通过。完整仓库在自助使用时可能可读；本题集采用作答约定和指纹核验，不宣称防作弊监考。

## 3. 逐题完成并提交

使用现有工具计算、创建文件、生成界面。题目中禁止的真实付款、发送、共享等操作始终不需要执行。每题使用自己的输出目录；多阶段题先保存初版，再按下一阶段要求修改，两个阶段都保留。界面可用离线 HTML/JavaScript 或已构建 React；UI 的公开角色、名称与数据接口见题干。

UI 预览可使用仓库提供的本地辅助命令（不评分、不调用模型）：

```sh
python -m counso_bench.ui_check preview --entry runs/attempt-01/cases/R-U01-dashboard/repeat-001/output/ui/index.html --task R-U01-dashboard --port 8765
```

在已有浏览器中打开打印的本机地址。其他 UI 题替换入口与 task；U06 用 URL 的 dataset 参数查看数据变化。

提交 `schema_version=AUTO-0.2` 的 `response.json`。文件路径相对该题 output 目录。引用 locator 按导出说明填写真实存在的位置；定位通过只证明位置存在，不证明全部结论已获语义支撑。

正式核验前可自行检查产物；首次提交后看过评分结果再修改，须另建一次尝试，不能覆盖原分。尽量完成整个题单；受限时保留已完成产物，说明限制，仍执行汇总。

三个本地服务题需要来源检索/草稿查回观测：R-B01-source-review、B01.discovery、R-B15-idempotent-draft。在另一终端或现有 Agent 的后台进程能力中启动：

```sh
python -m counso_bench serve-mock B01.discovery --run-id "该题 run.json 中的 run_id" --state-dir runs/attempt-01/cases/B01.discovery/repeat-001/service
```

使用生成的 `service/endpoint.json` 中 endpoint，按该题 `input/inputs/mock_client.py` 的说明访问。结束服务保留观测文件；不要修改服务记录。`score-suite` 自动寻找本题 service/observations.json 与 endpoint.json。后台进程不可用时记录工具限制；题集不要求你新建 Agent 调度器。

## 4. 调用本地核验与汇总

```sh
python -m counso_bench score-suite --attempt runs/attempt-01
```

输出 `report.json` 和 `report.md`，包含逐项检查、主能力结果、诊断、未提交任务及证据意见。失败作答也需要汇总。格式错误、空文件不会让整批评分崩溃；未作答项目留在题单中。UNKNOWN 不自动变成成功或模型错误。

已有报告不覆盖；只需要重新检查同一份提交时可以给新报告路径：

```sh
python -m counso_bench score-suite --attempt runs/attempt-01 --output runs/attempt-01/report-check-02.json
```

按 [固定自评模板](docs/SELF-REVIEW.md) 写 `output/self_review.json`，解释语义或视觉体验；不能确认的维度写 null 并说明原因。无法附加自评时，本地评分仍可完成。它会作为 CANDIDATE_SELF_EVALUATION 保存，**不计入程序核验分数**。没有独立评审模型也能完成报告，全程无人工仲裁。

## 5. 给用户反馈

提供报告路径，并概括办公事务、文件工具、生成式 UI 各自成功、失败、未判定及代表性证据。说明当前已知模型身份来源和工具限制。有实际耗时/费用信息时附上，拿不到不填 0。不能把 selftest 的参考成绩当作你的成绩，不能把自己的主观自评写成独立评审。

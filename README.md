# COUNSO-Benchmark

**面向日常办公、文件工具与生成式 UI 的 Agent 任务评测。**

Artifact-based AI agent evaluation: office workflows, file tools, and generative UI.

让已有 Agent 根据题目和合成业务材料完成工作，交付文件或界面，再用本地核验器检查实际结果。重点是业务事实是否正确、产物是否可用、修改是否保留原有内容，以及遇到歧义、缺失证据和超时后能否保持正确边界。

当前工具版本 **0.2.2**，评分契约 **AUTO-0.2**。共 **40 个任务：34 个主能力任务 + 6 个诊断任务**。基础核验只需 Python，无需 COUNSO 账户、模型适配器或额外评审模型。

## 评测内容

| 能力 | 主任务数 | 代表工作 | 主要核验依据 |
|---|---:|---|---|
| 日常办公事务 | 16 | 来源核对、合同版本、跨时区排期、项目交接、只读 SQL、授权判断、草稿超时恢复 | 业务字段、来源定位、题内服务观测、草稿最终状态 |
| 文件和工具 | 12 | Excel 公式修复与下月更新、可编辑图表、CSV 脱敏、账务关联、PPT 创建与定向修改、文件归档 | 实际文件内容、公式与引用范围、原生对象及嵌入数据、内容哈希 |
| 生成式 UI | 6 | 销售看板、业务表单、报价计算器、列表详情、分阶段修改、数据更新和空值 | 核验器控制的浏览器交互、数据断言、截图与事件记录 |

34 个主任务包含 29 个 core 和 5 个 stress；6 个 diagnostic 用于定位问题，单列报告。全部业务材料为合成数据。[查看完整题卡](docs/CASEBOOK.md)。

## 使用方式

内部模型比较使用同一个 Agent、提示词、工具和运行设置，只更换目标模型。题集不会修改这些配置；已有固定环境可以直接沿用。

完整仓库保留在**评测端**。评测端导出单题包，只把这个包交给新的模型会话；交卷后回收产物并运行核验。作答端入口是包内 `START.md`，流程说明见 **[AGENT-START.md](AGENT-START.md)**。

每个作答工作区只挂载当前题包；源码、答案、其他作答和评分日志由宿主沙箱隔离。单纯在同一可读磁盘上创建另一目录不构成权限隔离。

评测端从完整源码目录运行，Python 3.10+。以下为单题示例：

```sh
git clone https://github.com/0xMoji/COUNSO-Benchmark.git
cd COUNSO-Benchmark
python -m counso_bench doctor
python -m counso_bench validate
python -m counso_bench prepare --model "目标模型" --agent "COUNSO" --cases R01-ticket-triage --output runs/attempt-01
python -m counso_bench handoff --attempt runs/attempt-01 --case R01-ticket-triage --output ../candidate-ticket
# 将 candidate-ticket 交给独立作答沙箱；交卷后取回 ticket.json 和 output/
python -m counso_bench collect --attempt runs/attempt-01 --submission ../candidate-ticket
python -m counso_bench score-suite --attempt runs/attempt-01
```

省略 `--cases` 默认准备 34 个主任务；`--suite all` 包含诊断。每个题目/重复编号单独 `handoff`、作答和 `collect`，最后按原题单汇总。命令不调用模型；题单、已回收产物与报告拒绝覆盖。看过评分后的修改属于开发反馈，不能作为新的盲测作答。服务题交接前由评测端启动 mock，详见 RUNBOOK。

## 核验环境

| 层次 | 依赖 | 可验证范围 |
|---|---|---|
| 基础核验 | Python 标准库 | 提交格式、业务数据、CSV、有限 Excel 公式、Office 原生结构及文件完整性 |
| UI 交互 | Node.js 20+、Playwright、Chromium/Chrome | 筛选、排序、输入校验、模拟提交、计算、详情联动、不同数据状态 |
| Office 引擎 | LibreOffice | 扩展公式重算、PPT 实际渲染为 PDF；不等于视觉质量评分 |

缺少可选依赖时，对应检查记录 **UNKNOWN**。详细设置与 Windows 示例见 [RUNBOOK.md](RUNBOOK.md)。UI 使用公开的 `html-offline-v1` 约定，接受离线 HTML/JavaScript 或已构建 React；核验时使用题内数据和本地模拟接口。

## 如何解读结果

- **PASS**：全部必需检查通过。
- **FAIL**：至少一个必需检查已确认失败；其他未知项不能掩盖失败。关键错误令客观分封顶为 0。
- **UNKNOWN**：没有已确认的必需失败，但缺少必需证据、提交或运行依赖。

固定题单中的未提交任务保留在分母内。报告按三类能力分别展示结果与成功率可确定范围；这个范围不是统计置信区间。诊断单列。[完整评分口径](docs/SCORING.md)。

当前 Agent 的语义/视觉自评作为带证据的参考信息保存，**不计入程序分，也不构成独立评审**。模型名称记录其声明来源，不能单凭自述证明实际路由；模型比较需要相同版本、题单、输入和可比工具条件。

## 当前质量与适用范围

这套题集适合做办公 Agent 的场景回归、产物正确性检查和能力短板诊断。其优势是核对真实产物和受控操作结果，并保留未知与关键失败；相关判断及优化顺序见 [质量审查](docs/QUALITY-REVIEW.md)。

当前验证包括程序回归、合成参考答案和错误对照。**这些通过次数不是候选模型成绩**。0.2.2 单题包、回收与评测端服务的结果见 [交接验证](docs/HANDOFF-VERIFICATION-20261014.md)；0.2.1 的兼容修复见 [前轮验证记录](docs/VERIFICATION-20261014.md)，此前的浏览器/Office 控制记录见 [AUTO-0.2 验证](docs/FINAL-VERIFICATION.md)。

现阶段的证据边界：

- UI 主要覆盖交互和数据正确性；尚无完整的视觉设计、移动端适配、键盘操作及无障碍评分。
- PPT 可编辑性、数据和渲染可核验；叙事与审美质量目前没有独立自动评分。
- 引用检查确认来源与定位存在；不能自动证明所有结论都得到语义支撑。
- 题内服务为模拟环境；尚不证明真实邮箱、生产连接器、租户权限或跨设备可靠性。
- 尚无本版本真实候选模型的完整对比、置信区间或通用能力领先结论。
- 单题作答包不含答案或评分器；实际文件、网络与会话隔离由运行宿主承担，导出命令不自动设置 OS 权限。

## 开发与迭代

```sh
python -m unittest discover -s tests -v
python -m counso_bench selftest --output runs/controls-01
python tests/independent_oracle.py .
```

`selftest` 只生成合成参考产物和错误对照，来源为 `SIMULATED`，不运行候选模型。`fully_verified` 才表示全部参考确定通过；缺依赖时不能将部分验证写成完整验收。

CI 配置包含 Linux/Windows 基础回归，以及 Linux 浏览器/Office 集成验证。远端状态以 [GitHub Actions](https://github.com/0xMoji/COUNSO-Benchmark/actions) 为准。

题集前 31 个场景是参考历史机制新编的替代题，后续新增 UI、PPT 和文件整理任务；不是对不可取得原题文件的逐字恢复，也不沿用其难度或旧模型成绩。来源标签 `HISTORY-RECONSTRUCTED` / `NEW_SYNTHETIC` 保留在机器记录与 [来源账本](provenance/RECONSTRUCTION-LEDGER.md) 中。

- [Agent 作答入口](AGENT-START.md) · [命令与依赖](RUNBOOK.md) · [评分规则](docs/SCORING.md)
- [质量审查与优化重点](docs/QUALITY-REVIEW.md) · [版本变更](CHANGELOG.md) · [自评模板](docs/SELF-REVIEW.md)
- [历史整改说明](docs/REMEDIATION.md) · [隔离边界](docs/SECURITY-AND-ISOLATION.md) · [许可说明](LICENSE-NOTICE.md)

支持完整源码/ZIP 分发运行；业务材料在源码树内，单独安装不含材料的 wheel 尚不支持。公开可读与开源再分发许可的区别见许可说明。

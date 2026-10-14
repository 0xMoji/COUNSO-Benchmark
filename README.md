# COUNSO-Benchmark

**面向日常办公、文件工具与生成式 UI 的 Agent 任务评测。**

Artifact-based AI agent evaluation: office workflows, file tools, and generative UI.

让已有 Agent 根据题目和合成业务材料完成工作，交付文件或界面，再用本地核验器检查实际结果。重点是业务事实是否正确、产物是否可用、修改是否保留原有内容，以及遇到歧义、缺失证据和超时后能否保持正确边界。

当前工具版本 **0.2.1**，评分契约 **AUTO-0.2**。共 **40 个任务：34 个主能力任务 + 6 个诊断任务**。基础核验只需 Python，无需 COUNSO 账户、模型适配器或额外评审模型。

## 评测内容

| 能力 | 主任务数 | 代表工作 | 主要核验依据 |
|---|---:|---|---|
| 日常办公事务 | 16 | 来源核对、合同版本、跨时区排期、项目交接、只读 SQL、授权判断、草稿超时恢复 | 业务字段、来源定位、题内服务观测、草稿最终状态 |
| 文件和工具 | 12 | Excel 公式修复与下月更新、可编辑图表、CSV 脱敏、账务关联、PPT 创建与定向修改、文件归档 | 实际文件内容、公式与引用范围、原生对象及嵌入数据、内容哈希 |
| 生成式 UI | 6 | 销售看板、业务表单、报价计算器、列表详情、分阶段修改、数据更新和空值 | 核验器控制的浏览器交互、数据断言、截图与事件记录 |

34 个主任务包含 29 个 core 和 5 个 stress；6 个 diagnostic 用于定位问题，单列报告。全部业务材料为合成数据。[查看完整题卡](docs/CASEBOOK.md)。

## 使用方式

把仓库地址交给一个已经配置好目标模型的 Agent，并发送：

> 请按本仓库 AGENT-START.md 完成题集，使用当前已配置的模型。保存每题产物，运行本地核验，分别报告办公事务、文件工具和生成式 UI 的成功、失败、未判定与参考意见。记录模型信息来源；作答阶段只读取导出的题目材料，不读参考答案或修改评分规则。

Agent 的完整操作入口是 **[AGENT-START.md](AGENT-START.md)**。题集负责准备输入、定义提交契约、核验和报告；实际作答由已有 Agent 完成。

从完整源码目录运行，Python 3.10+：

```sh
git clone https://github.com/0xMoji/COUNSO-Benchmark.git
cd COUNSO-Benchmark
python -m counso_bench doctor
python -m counso_bench validate
python -m counso_bench prepare --model "目标模型" --output runs/attempt-01
# Agent 按各题 input/prompt.txt 作答，保存到对应 output/
python -m counso_bench score-suite --attempt runs/attempt-01
```

默认准备 34 个主任务；`--suite all` 包含诊断，`--cases` 可指定小题单。`prepare` 不调用模型，`score-suite` 生成 JSON 和 Markdown 报告。题单、产物与报告拒绝覆盖；看过评分后修改的作答应另建尝试。

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

当前验证包括程序回归、合成参考答案和错误对照。**这些通过次数不是候选模型成绩**。2026-10-14 的本地复核及其环境限制见 [本轮验证记录](docs/VERIFICATION-20261014.md)；此前的完整浏览器/Office 控制记录见 [AUTO-0.2 验证](docs/FINAL-VERIFICATION.md)。

现阶段的证据边界：

- UI 主要覆盖交互和数据正确性；尚无完整的视觉设计、移动端适配、键盘操作及无障碍评分。
- PPT 可编辑性、数据和渲染可核验；叙事与审美质量目前没有独立自动评分。
- 引用检查确认来源与定位存在；不能自动证明所有结论都得到语义支撑。
- 题内服务为模拟环境；尚不证明真实邮箱、生产连接器、租户权限或跨设备可靠性。
- 尚无本版本真实候选模型的完整对比、置信区间或通用能力领先结论。
- 完整源码含参考答案；自助作答采用输入白名单约定与指纹校验，尚无 OS 强隔离监考。

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

# Counso Agent 能力题集

AUTO-0.2 · HISTORY-RECONSTRUCTED / NEW_SYNTHETIC · 全部业务材料为合成数据

把仓库地址交给一个已经配置好目标模型的 Agent，让它按 **[AGENT-START.md](AGENT-START.md)** 自行完成题目、保存产物、调用本地核验并给出参考意见。题集提供输入、提交契约、核验和报告；使用现有 Agent 的工具和运行环境，无需接入特定平台或开发模型适配器。

## 对 Agent 的使用指令

> 请按这个仓库的 AGENT-START.md 完成题集，使用当前已经配置的模型。保存每题产物，运行本地核验并给出三类能力的结果与参考意见。记录已知模型信息，不读参考答案或修改评分规则来获得通过。

仓库为私有时，现有 Agent 需要用户已配置的仓库读取权限。题集不会索取或输出凭证。

## 覆盖

| 能力 | 内容 |
|---|---|
| 日常办公事务 | 来源核对、交接、条款、时区、脱敏、SQL、计划、歧义及授权边界 |
| 文件和工具 | 现有 Excel/CSV 产物，新增 PPT 创建与修改、文件分类和索引 |
| 生成式 UI | 看板、表单、计算器、列表详情、分阶段修改、数据更新/空值 |

当前 40 题：34 个主能力任务、6 个诊断；其中新增 6 个生成式 UI、2 个 PPT、1 个文件整理任务。诊断与主能力分开。原 31 场景是历史机制上的新编替代题，不代表恢复了原版逐题字节或难度。

## 最小使用

Python 3.10+；从完整源码目录运行：

```sh
python -m counso_bench doctor
python -m counso_bench validate
python -m counso_bench list
python -m counso_bench prepare --model "目标模型" --output runs/attempt-01
# 现有 Agent 按 input/prompt.txt 作答，保存到各题 output/
python -m counso_bench score-suite --attempt runs/attempt-01
```

prepare 只准备题单，不调用 Agent。score-suite 检查实际提交，生成 JSON 与 Markdown。无人工打分/仲裁依赖。默认一次即可使用，重复运行由用户在已有环境中决定。产物和报告拒绝覆盖。

## 产物核验依赖

基础 CLI、数据核对、有限 Excel 公式和 PPT 结构核验只需 Python 标准库。下列依赖扩展真实执行核验，缺失的检查记录 UNKNOWN：

- **UI**：Node.js 20+、Playwright 与 Chromium。使用已有安装，或在独立工具目录运行 `npm install playwright@1.62.1`，再运行该安装中的 `playwright install chromium`。通过 `NODE_PATH` 指向其 node_modules，必要时 `COUNSO_NODE` 指向 Node。已有 Chrome/Chromium 可通过 `COUNSO_CHROMIUM_EXECUTABLE` 指定可执行文件；doctor 会检查默认浏览器文件是否存在。以实际测试通过的依赖为准，版本写入浏览器证据。
- **Office**：LibreOffice 的 `soffice` 位于 PATH，或通过 `COUNSO_SOFFICE` 指定。使用独立临时 profile，限制执行时间。可选 `openpyxl` 仅用于独立兼容测试，不当作公式求值引擎。

UI 首版使用公开的 `html-offline-v1` 行为约定，可提交原生 HTML/JavaScript 或已构建 React。界面不依赖 CDN。核验器在本地提供题内数据与提交 mock，真实操作可见控件并保存截图与观察记录。A2UI 协议适配属于后续扩展；当前已经测的是生成可用交互界面的能力。

Excel 独立验证候选实际范围、表结构、公式、图表和追加/复制行为；不支持的表达式可走可用 Office 引擎，仍无法确认则 UNKNOWN。PPT 检查原生文本、图表与嵌入数据、修订范围和实际渲染；完整视觉质量仍由有截图证据的参考意见解释。

## 结果口径

已知必需失败优先于 UNKNOWN；关键错误不能由其他维度补偿。固定题单中的未提交项目不消失。报告按三类能力给出成功/失败/未判定和成功率可确定范围，这个范围不是统计置信区间。

模型标识记录声明来源，不证明实际路由。prepare 同时记录当前核验环境；比较报告注明工具记录缺失或环境差异。脚本核验与当前 Agent 自评分开，自评不计入程序分。工具轨迹、费用等不可获得时注明缺失，不强制专有日志接口。完整仓库含 gold，自助作答遵守输入白名单和不读答案约定，不宣称强隔离监考。

## 开发验证与历史

```sh
python -m unittest discover -s tests -v
python -m counso_bench selftest --output /tmp/counso-controls-new
```

selftest 只生成参考产物和错误对照，不运行候选模型；SIMULATED 成绩不代表模型能力。旧 RECON-0.1 审阅、人工流程与历史记录保留作来源证据，已退出当前 CLI；当前评分与旧结果不混合。

- [Agent 使用入口](AGENT-START.md)
- [命令与报告](RUNBOOK.md)
- [评分口径](docs/SCORING.md)
- [固定自动自评模板](docs/SELF-REVIEW.md)
- [题卡](docs/CASEBOOK.md)
- [整改验证](docs/FINAL-VERIFICATION.md)
- [逐项整改与边界](docs/REMEDIATION.md)
- [重建来源](provenance/RECONSTRUCTION-LEDGER.md)

以完整源码/ZIP 分发。业务材料位于源码树，单独安装不带数据的 wheel 不是支持的使用方式。

# COUNSO-Benchmark 命令与报告

当前使用 AUTO-0.2。Agent 作答从 AGENT-START.md 开始，所有命令在完整源码根目录运行。命令只处理题目、产物和本地检查，没有候选模型调用、模型切换或人工仲裁步骤。

## 可选核验依赖

基础 CLI 使用 Python 3.10+ 标准库。UI 核验另需 Node.js 20+、Playwright 和 Chromium；Office 重算与渲染另需 LibreOffice。先运行 `python -m counso_bench doctor` 查看本机情况。缺失依赖的对应检查记 UNKNOWN，不计为通过。

使用已有 Playwright 安装，或在独立工具目录安装本项目已验证版本：

```sh
npm install --prefix ../counso-ui-tools playwright@1.62.1
```

Windows PowerShell 示例：

```powershell
$env:PYTHONUTF8 = '1'
$env:NODE_PATH = (Resolve-Path ../counso-ui-tools/node_modules).Path
& ../counso-ui-tools/node_modules/.bin/playwright.cmd install chromium
# 已有 Chrome 时也可指定其路径，无需再下载 Chromium：
$env:COUNSO_CHROMIUM_EXECUTABLE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
# 仅在已安装 LibreOffice 时设置：
$env:COUNSO_SOFFICE = 'C:\Program Files\LibreOffice\program\soffice.exe'
python -m counso_bench doctor
```

Linux/macOS 示例：

```sh
export NODE_PATH="$(cd ../counso-ui-tools/node_modules && pwd)"
../counso-ui-tools/node_modules/.bin/playwright install chromium
# 若 soffice 不在 PATH，设置 COUNSO_SOFFICE 为实际可执行文件路径
python -m counso_bench doctor
```

`COUNSO_NODE` 可指定 Node 可执行文件。依赖版本及浏览器证据随本次运行记录；安装完成或 doctor 检测到可执行文件，不代表产物已经通过真实操作。LibreOffice 使用独立临时 profile；可选 openpyxl 用于兼容测试，不用作公式求值引擎。

Windows 无符号链接创建权限时，五个真实链接控制会明确跳过；越界路径、普通文件和评分规则测试继续运行。不要把跳过记作通过。源码通过 `.gitattributes` 保持 LF；冻结清单严格比较字节，编辑后须新建版本并重新 freeze，不能忽略哈希不匹配。

## 准备与作答

```sh
python -m counso_bench doctor
python -m counso_bench list
python -m counso_bench prepare --model "目标模型" --agent "现有 Agent" --output runs/attempt-01
```

`--model-source` 可选 user_config、environment、agent_self_report、unknown。模型实际配置在用户现有环境中选择；题集只保存标签及来源。`--cases` 后列场景 ID 可做子题单，`--suite all` 包括诊断，`--repeats 3` 导出三次重复的独立目录。prepare 没有解题或调用 Agent。

每题 input 下有 prompt、schema 和 inputs；output 保存 response.json 与实际文件。提交路径使用相对路径，run_id/模型元数据位于该题 run.json 和总 manifest.json。公开 schema 是格式要求，gold 不用于作答。首次正式核验后的修订应新建尝试，不能覆盖旧成绩。

## 来源与草稿 mock

三个场景需要本地模拟服务，具体接口由题干和导出的 mock_client.py 给出。将下列 run_id 换成本次题单记录：

```sh
python -m counso_bench serve-mock B01.discovery --run-id "本题 run_id" --state-dir runs/attempt-01/cases/B01.discovery/repeat-001/service
```

使用 endpoint.json 的本机地址，服务仅模拟来源检索/正文读取或原 key 草稿查回；不接真实业务账户。停止服务后保留记录。score-suite 校验 run_id、场景、session_id 和执行包指纹；旧记录或缺失 session 不能重用。自助仓库内的观测不构成对恶意操作者的强防伪边界。

## 核验与报告

```sh
python -m counso_bench score-suite --attempt runs/attempt-01
```

默认生成 report.json、report.md，不覆盖原文件。JSON 包含固定题单与逐项报告，Markdown 给出能力计数和失败证据。未提交项目留在计划分母，主能力与诊断分开。

单题也可核验并按原题单汇总：

```sh
python -m counso_bench score R01-ticket-triage --response runs/attempt-01/cases/R01-ticket-triage/repeat-001/output/response.json --run runs/attempt-01/cases/R01-ticket-triage/repeat-001/run.json --output runs/ticket-score.json
python -m counso_bench report runs/ticket-score.json --manifest runs/attempt-01/manifest.json --output runs/partial-report.json
```

提交的产物即使缺失或格式错误也能生成失败记录。没有开始的题目记未提交/未知；能确认未交付不代表能确认故障来自模型。受限公式、缺浏览器、缺 Office 渲染引擎分别说明，不伪造通过。

output/self_review.json 按 [固定模板](docs/SELF-REVIEW.md) 保存当前 Agent 的语义/视觉参考意见，报告标记为 CANDIDATE_SELF_EVALUATION，不计入程序分。没有它也能报告。旧人工终裁命令已退出当前 CLI，旧 Python API 仅保留历史回归用途。

## 两份结果比较

用户在不同已配置模型中分别使用同一版本、同一题单，得到两份 report.json 后，建立 configs.json：

```json
{
  "model-a": "runs/attempt-a/report.json",
  "model-b": "runs/attempt-b/report.json"
}
```

路径相对 configs.json 所在目录：

```sh
python -m counso_bench compare --configs configs.json --output comparison.json
```

比较校验执行包指纹、输入、场景、重复编号及完整检查集合，不取有分子集偷偷缩小题单。不同配置的模型标签可以不同，题目与评分规则须一致。SIMULATED 与 NEW_MODEL 不混合。历史 AUTO-0.2 报告应使用对应冻结源码核验。

同一 Agent 换模型更适合解释模型变化；不同 Agent 也能使用相同能力题，结果保留已知环境差异。一次测试可以使用，不承诺统计显著性。费用和内部轨迹非必需字段。

## 冻结数据变体

```sh
python -m counso_bench variant --seed 42 --output /tmp/counso-seed-42
cd /tmp/counso-seed-42
python -m counso_bench validate
python -m counso_bench prepare --model "目标模型" --output runs/attempt-01
```

变体是独立的冻结源码副本。首版仅改变读取销售数据的 U01/U05/U06 的金额与顺序，其他题材料保持原样；支持范围、种子和变更哈希见副本 provenance/variant.json。同 seed 得到相同字节。比较双方必须使用同一个变体，不能把不同输入混比。repeats 是重复作答，不会暗中重抽数据。冻结变体中不要执行素材开发命令 counso_bench.build，它会重新生成基线材料；需换 seed 时从原基线另建副本。

## 开发控制与源码发布

```sh
python -m unittest discover -s tests -v
python -m counso_bench selftest --output /tmp/counso-controls-new
python -m counso_bench freeze
python -m counso_bench validate
python -m counso_bench release --output /tmp/counso-auto-0.2.zip
```

selftest 是参考产物与单点错误控制，缺可选依赖会显示 reference_unknown；passed 只表示未发生已确认错误，fully_verified 才表示所有参考都得到确定通过。二者都不代表候选模型成绩。生成源码 ZIP 不会上传或发布。

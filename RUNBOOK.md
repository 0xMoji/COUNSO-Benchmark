# COUNSO-Benchmark 命令与报告

当前工具 0.2.2，评分契约 AUTO-0.2。完整源码与以下命令由评测端持有；作答模型只接收 handoff 单题包并按包内 START.md 作答。命令只处理题目、产物和本地检查，不调用模型或修改 Agent 设置。

内部比较保持同一 COUNSO Agent、系统提示词、工具与运行设置，只更换模型。沿用已有执行环境即可；为各模型使用同一题单及相同的初始会话/工作区状态。`--agent` 记录同一个实际 Agent 名称，`--model` 记录本次配置的模型。

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

Windows 无符号链接创建权限时，五个真实链接控制会明确跳过；越界路径、普通文件和评分规则测试继续运行。不要把跳过记作通过。`.gitattributes` 禁用 Git 换行转换，保留历史材料的原始字节；新 JSON 输出使用 LF。冻结清单严格比较字节，编辑后须新建版本并重新 freeze，不能忽略哈希不匹配。

## 准备与作答

```sh
python -m counso_bench doctor
python -m counso_bench list
python -m counso_bench prepare --model "目标模型" --agent "现有 Agent" --output runs/attempt-01
```

`--model-source` 可选 user_config、environment、agent_self_report、unknown。模型实际配置在用户现有环境中选择；题集只保存标签及来源。`--cases` 后列场景 ID 可做子题单，`--suite all` 包括诊断，`--repeats 3` 导出三次重复的独立目录。prepare 没有解题或调用 Agent。

评测端每题 input 下有 prompt、schema 和 inputs；run_id/模型元数据位于该题 run.json 和总 manifest.json。不要把这个完整运行目录交给作答模型。

## 单题交接与回收

```sh
python -m counso_bench handoff --attempt runs/attempt-01 --case R01-ticket-triage --repeat 1 --output ../candidate-ticket-01
```

输出目录必须在源码与评测目录外，且尚不存在。包内仅有本题公开输入、START.md、ticket.json 和空 output；UI 题附独立 preview.py，服务题附 endpoint.json。只有评测端知道评分实现、参考答案和观测文件。handoff 从当前冻结输入重新导出，既不复制历史产物，也不复制评测目录中的额外文件。

宿主把该单题包放入独立作答工作区，并为每题/每次重复启动新会话。只向作答工具开放当前题包、允许工具和必要的题内服务；不挂载源码、gold、历史产物与评测日志，也不能经联网工具访问公开答案。导出命令不会更改 OS 权限；如果当前 Agent 的文件工具仍能读取完整仓库，只换目录不能满足隔离要求。沙箱集成需实际验证私有文件不可读。

UI 作答端在包目录可以执行：

```sh
python preview.py --entry output/ui/index.html --port 8765
```

此脚本只读取当前包的公开数据，按题面提供 /data.json 与 /api/requests，不含评分断言。没有随本题提供的数据集返回 404。其他任务不需要此脚本。

作答停止后仅取回 ticket.json 与 output/，放到评测端可读目录：

```sh
python -m counso_bench collect --attempt runs/attempt-01 --submission ../candidate-ticket-01
```

回收校验 run_id、题目、重复编号及输入身份，只导入 output 普通文件；不采用候选提供的 run.json、配置、endpoint 或观测日志。拒绝符号链接/重解析点、候选 .assessor、错误运行身份和覆盖原提交。每次回收最多 30000 文件、合计 200 MB、单文件 50 MB；复制完成后校验字节哈希，评测端保存 collected.json。

空 output 仍为未作答/UNKNOWN，坏 JSON 回收后按原规则记 FAIL；不因回收动作自动判成功。按 manifest.entries 逐题交接，最后 score-suite 汇总固定题单。看过评分的修改与重试属于开发反馈，另建运行，不能混入盲测首答。

## 来源与草稿 mock

三个场景需要本地模拟服务，具体接口由题干和导出的 mock_client.py 给出。将下列 run_id 换成本次题单记录：

```sh
python -m counso_bench serve-mock B01.discovery --run-id "本题 run_id" --state-dir runs/attempt-01/cases/B01.discovery/repeat-001/service
```

在 handoff 前启动服务，state-dir 使用本题 manifest 中 endpoint_path 的父目录。handoff 检查服务身份，只向作答包复制本机 endpoint，不复制 session、状态或观测。服务仅模拟来源检索/正文读取或原 key 草稿查回，不接真实业务账户。

作答沙箱需能够访问这个 127.0.0.1 端口：同主机可采用文件隔离并保留 loopback；容器/远程沙箱需由宿主将该端口转发到候选可访问的本机端口，并在交接前确认连通。当前 CLI 不负责部署转发；不要为了连通把服务状态目录挂给模型。停止服务后保留记录。score-suite 校验 run_id、场景、session_id 和执行包指纹；旧记录或缺失 session 不能重用。

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

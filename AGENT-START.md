# COUNSO-Benchmark · 运行入口

公司内部比较模型时，保持同一 COUNSO Agent、提示词、工具和运行设置，只更换模型。题集不会调用或切换模型，也不会修改这些设置。已有环境固定时，无需为评测再搭建执行框架。

## 评测端与作答端

**完整仓库属于评测端。** 它准备题目、维护题内服务、回收产物并评分。作答模型收到的是 `handoff` 导出的一个单题包，入口为包内 `START.md`。

每题、每次重复使用新的会话和独立工作区。宿主只提供这一题的包及已配置工具，不能让作答工具读取评测源码、gold、历史报告、服务日志或其他作答目录；也不能通过联网工具取回公开仓库里的答案。导出到另一个文件夹本身不改变文件权限，实际可访问范围由 COUNSO/现有沙箱控制。

不要让已读过答案、评分代码或正式评分结果的会话继续作为新的候选作答。开发者可以在完整仓库做自测，但这类运行不能作为隔离条件下的模型选型证据。

## 最小流程

以下命令由评测端在完整源码目录运行；示例选一题，正式评测可省略 `--cases` 准备 34 个主任务，再逐项交接。

```sh
python -m counso_bench doctor
python -m counso_bench validate
python -m counso_bench prepare --model "目标模型" --agent "COUNSO" --cases R01-ticket-triage --output runs/model-a
python -m counso_bench handoff --attempt runs/model-a --case R01-ticket-triage --output ../candidate-a-ticket
```

将 `candidate-a-ticket` 这一单题包放进作答沙箱，向目标模型发送：

> 按包内 START.md 完成这一题，使用当前已经配置好的模型和工具，把 response.json 与交付文件写到 output/。完成后交回 ticket.json 和 output/。

作答结束、文件停止变化后，将返回包放回评测端可读目录，再执行：

```sh
python -m counso_bench collect --attempt runs/model-a --submission ../candidate-a-ticket
python -m counso_bench score-suite --attempt runs/model-a
```

`collect` 只回收 `output/` 中的普通产物文件；核对本次题目、重复编号和输入身份，不采用候选提交的模型配置、评分报告或服务观测。已回收提交不能覆盖，`.assessor` 证据目录禁止由候选提交。未作答与坏 JSON 仍保留在报告中。

重复测另一模型时保持其余设置，准备新的 `runs/model-b` 和新的作答包。已有的同题单比较命令见 [RUNBOOK](RUNBOOK.md)。模型名称按用户/环境配置记录，不用模型自述证明实际路由，不读取凭证。

## 服务题与 UI

R-B01-source-review、B01.discovery、R-B15-idempotent-draft 的 mock 由**评测端**在交接前启动。作答包只带 `endpoint.json` 中的服务地址及公开客户端；服务状态和观测始终保存在评测端。沙箱需能访问该本机端口，具体安排见 [RUNBOOK](RUNBOOK.md)。

UI 包另带独立的 `preview.py`，读取本题公开数据，可预览筛选、表单及不同数据状态，不含评分断言，不需要评测源码。提交后仍由固定浏览器核验器检查。

## 报告

评测端反馈三类能力各自的成功、失败、未判定与代表性证据。不能把 `selftest` 的参考成绩作为候选模型成绩。可选 `self_review.json` 保持为候选自评参考，不计程序分；完整说明见 [评分口径](docs/SCORING.md)。

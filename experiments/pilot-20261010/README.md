# Counso：真实候选试跑与契约修订验证

**结论：这四个任务暂不足以给 General 通用办公能力做可靠总排名。** 已完成 32 个冻结基线单元和 8 个 B17 澄清契约单元；另有 1 次基础设施失败尝试排除。真实候选产物、原分、版本化回算、匿名独立 AI 审阅均保留。主目标是整体办公质量，业务分项其次，速度独立记录，成本不混入能力排名。没有真人评分、稳健模型排名或 thinking 效果证明。

手机阅读优先打开 [中文 PDF](report/counso-pilot-report-zh.pdf)。逐项证据见 [结果说明](report/RESULTS.md)、[40 单元矩阵](report/comparison_matrix.csv)、[计时与选型分析](report/selection-signal.md)。

## 文件与版本

- `candidates/`：32 个有效基线独立输入与候选产物。
- `evaluator/results/`：冻结 RECON-0.1 原始 run 元数据与分数。
- `evaluator/regraded-v0.2/`：第一版语义回算，保留其旧 period 描述句误罚作为修订历史，不作最终结论。
- `evaluator/regraded-v0.2.1/`：最终旧题回算，欠定义检查保留 UNKNOWN；没有新候选运行。
- `revisions/B17-contract-0.2/`：固定澄清题干、8 次新会话与正式 RECON-0.2 评分。
- `blind-review/`、`blind-review-v2/`：不提供配置标签时完成的独立 AI 辅助审阅。发布后可由矩阵关联标签，不应再声称公开文件对读者匿名不可关联。
- `evaluator/compatibility/`：两份工作簿 LibreOffice 实际导入导出结果；没有 Microsoft Excel 或完整视觉确认。
- `PUBLICATION_MANIFEST.json`：发布白名单与逐文件 hash。实验目录不属于题库执行 fingerprint 范围。

原冻结基线 manifest SHA256：`b2482a51843fa341303eb576756ca4c28ffe11da62ed7c57e2a5a2c46383d2e2`。
最终 B17 契约 manifest SHA256：`a1eb635d8edca150207be281e169d6feb20954dec51b223fa591493f95b4f42a`。
评分时 RECON-0.2 v5 manifest SHA256：`f19619224f2af285948be9abcdca1070b6e01a29437278ec3bf05d86f157e2de`。
含独审报告的最终发布包 manifest SHA256：`d56adc07d6da12838e91b9eb3f26c0b5a6b4857710661e0765a65ce578adbf08`。它只新增审稿/provenance/文档，执行代码、契约与 fingerprint 未变；不改写已评分的运行身份。
最终 helper SHA256：`4e5d087d6d82f8eb2c704da60c5f3cf8047cd31603ae43706e03e2f229cc7f83`。
最终旧题适配器 SHA256：`164c91dbc4c9c3f40e992b3c1a5f0e1444b913cbb2392df3fbd970db20800616`。

## 复核命令

发布目录内运行：

```bash
python evaluator/verify_published_evidence.py
```

旧证据回算需要两个独立题库目录：历史冻结 RECON-0.1（仓库基线 commit `67d11ad1db52cadb413de105efc6797c24ffb4a5`）和正式 RECON-0.2。用不同目录解包/检出，禁止覆盖历史版本。指定一个尚不存在的结果目录：

```bash
python evaluator/regrade_baseline.py \
  --evidence-root "$PWD" \
  --baseline-package /path/to/frozen-recon-0.1 \
  --new-package /path/to/recon-0.2 \
  --output-dir /path/to/fresh-regrade-output
```

只跑适配器 31 项正反控时加 `--selftest-only`。适配器先验证旧包、response、run、引用产物和原服务观测 hash；旧 B01 观测只与旧 run/session/scenario/fingerprint 匹配，绝不伪造新服务身份。

新 B17 的每份 response 可以用新包原生 CLI 另行复算：

```bash
cd /path/to/recon-0.2
python -m counso_bench score B17.reconcile \
  --response /path/to/pilot/revisions/B17-contract-0.2/candidates/RUN_ID/output/response.json \
  --run /path/to/pilot/revisions/B17-contract-0.2/results/RUN_ID/run.json \
  --output-dir /path/to/pilot/revisions/B17-contract-0.2/candidates/RUN_ID/output \
  --output /path/to/fresh-score.json \
  --task-revision B17-contract-0.2 --rubric-version RECON-0.2
```

`response.schema_version=RECON-0.1` 是输出格式兼容标记，不是任务版本；请同时读取评分信封的 task_revision / grader_revision / task_contract_sha256。

## 发布范围与限制

全部业务材料为合成数据。本目录不包含原始聊天、模型私有推理、私有协调消息、认证数据、Library 临时链接或可运行服务控制文件。候选自报执行 trace 也未发布；原全量 evidence manifest 保留其 hash，`PUBLICATION_MANIFEST.json` 明确列出未发布条目，不能把“发布子集全通过”说成全部本地证据已公开。

模型名和 effort 是请求条件；工具接受请求但未独立返回精确后端快照或 effort。tokens、费用、种子均 UNKNOWN。共享宿主只做上下文/目录指令限制，不是经验证的 OS 隔离盲测。本地访问主要靠自报，不能证明所有外部行动都被审计。

每配置每题仅一次。四题均属探索/调参集，8 次澄清验证也不是独立能力确认集。原分因已证实评分缺陷而不能用来排名。UNKNOWN 不填零也不补满分，已知权重分数必须与覆盖率一起读。

## 大型检查日志的无损存储

两份 `ledger.xlsx.inspect.ndjson` 仅在发布副本中改为 `.ndjson.gz`，原本地候选证据不变。`COMPRESSED_ARTIFACTS.json` 给出原路径、原 SHA256、压缩路径、压缩 SHA256、字节数和关联 XLSX。逐个解压已验证与原始字节完全一致。

`python evaluator/verify_published_evidence.py` 会透明解压核对原 evidence manifest，不要求写回文件。若需要精确原路径，执行 `python evaluator/restore_compressed_artifacts.py --restore`；默认不带参数只验证，不写文件，恢复时保留 gzip，遇到已存在且不同的文件会拒绝覆盖。这两份是辅助检查日志，客观评分与回算不依赖其未压缩路径。

`publication-history/manifest-uncompressed.json` 保留先前未压缩发布清单，属于历史而非当前文件清单。当前以根目录 `PUBLICATION_MANIFEST.json` 为准。

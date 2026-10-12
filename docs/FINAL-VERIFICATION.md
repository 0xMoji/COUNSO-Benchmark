# AUTO-0.2 整改验证

2026-10-12。基准提交为 `67d11ad1db52cadb413de105efc6797c24ffb4a5`。以下为本地合成参考、错误对照和核验器兼容测试，来源 SIMULATED；没有候选模型实测或新模型排名。

## 已实际通过

- 完整单元及集成回归 **163 项**，0 失败、0 错误、0 跳过；包含真实浏览器和 Office 引擎。
- 全题单参考 **40/40 PASS**，0 UNKNOWN；**40/40 单点错误对照检出**。
- 注册表 40 场景、29 家族，core 29 / stress 5 / diagnostic 6；69 个不同输入文件、273 个题目检查，另有每题响应格式检查。
- 主能力任务 34：办公事务 16、文件工具 12、生成式 UI 6；诊断 6 单列。
- 独立 Decimal Oracle 重新核对账务大小表、估值及收入；不导入素材生成器来算答案。
- openpyxl 图表/PNG 和 PptxGenJS 原生图表正例；实际 LibreOffice 回算 IFNA 并生成 PDF。
- 六类 UI 的真实交互正例和错误行为负例；截图、观察、入口及资源子树哈希已绑定。
- seed=42 的销售 UI 变体通过 3 题、4 阶段真实浏览器检查；同 seed 冻结副本全部文件字节一致。
- 生成器在独立临时目录重建，catalog/fixtures/gold 共 **91 文件字节完全相同**。
- 坏 JSON、空响应、可选自评/观测坏文件、缺输出目录、旧观测、删检查、改 required/critical、不同输入比较等反例均覆盖。

## 可核对记录

- [机器控制摘要](../provenance/AUTO-CONTROL-RESULTS.json)：执行包指纹、环境版本、计数和证据哈希。
- [163 项完整测试日志](../provenance/AUTO-CONTROL-TESTS.txt)。
- [独立业务 Oracle](../provenance/AUTO-INDEPENDENT-ORACLE.json)。
- [逐项整改与实施边界](REMEDIATION.md)。

实际环境为 Python 3.12.14、Node 24.19.0、Playwright 1.62.1、Chrome 154.0.8037.98、LibreOfficeDev 26.8 alpha、PptxGenJS 4.0.1。以上只是本轮通过的环境快照，不声称所有版本均兼容。GitHub CI 已配置基础与真实产物集成两个层次，远端执行状态另查 CI。

## 复现

按 README 准备可选浏览器和 Office 依赖；已有 Chrome 可设置 COUNSO_CHROMIUM_EXECUTABLE。运行：

```sh
COUNSO_ARTIFACT_INTEGRATION=1 python -m unittest discover -s tests -v
python -m counso_bench selftest --output /tmp/counso-controls-new
python tests/independent_oracle.py .
python -m counso_bench validate
```

selftest 的 passed 表示无已确认参考错误且所有负控检出；fully_verified 才表示所有参考确定通过。缺依赖时保持 UNKNOWN，不能把缺依赖的运行当本页完整集成结果。上述测试数不是模型评测样本数。

## 尚无实测结论

真实候选模型的能力差异、实际模型路由、等工具/等预算下的可靠性和统计显著性；生产 Counso/邮箱/公网操作；OS 强隔离；A2UI 协议适配；通用语义评审准确性。引用定位和有限矛盾规则的范围已公开。冻结 seed 变体只支持三道销售 UI，其他题不是种子化覆盖。

RECON-0.1 的旧验证和人工流程记录保留为历史证据，不能与 AUTO-0.2 的新结果混合。

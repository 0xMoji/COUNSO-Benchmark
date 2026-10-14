# 0.2.1 本地验证记录

日期：2026-10-14。来源：本地程序回归、合成参考产物与错误对照；没有候选模型调用或模型排名。工具版本 0.2.1，评分契约 AUTO-0.2。

## 本轮结果

| 检查 | 结果 | 证据边界 |
|---|---|---|
| 完整基础回归 | 172 项，165 通过、7 跳过，0 失败/错误 | 7 个可选集成控制单列跳过，不计作通过；五个真实符号链接控制已通过 |
| 六类 UI 真实交互正反例 | 通过 | 独立启用原本跳过的浏览器测试；核对六类界面及错误行为，不评价全部视觉质量 |
| seed=42 销售 UI 变体 | 通过 | 三题、四阶段真实浏览器检查；不外推到其余题的数据变体 |
| 全 40 题合成参考控制 | 38 PASS、2 UNKNOWN、0 FAIL | 两道 PPT 的 Office 渲染缺依赖；`fully_verified=false` |
| 单点错误对照 | 40/40 检出 | 每题一个错误对照，不代表所有潜在错误均可检出 |
| 独立 Decimal 业务 Oracle | 通过 | 账务、估值、收入及版本选择；不依赖素材生成器来计算答案 |
| 冻结清单与源码 ZIP 解包 | 通过 | 校验本次发布文件字节与解包后的执行身份；业务题库与金标未修改 |

两项独立浏览器测试已在本轮启用并通过，但基础回归日志中的原始跳过记录保留，不能将其改写为一次无跳过的全依赖运行。

## 环境与证据

Windows、Python 3.14.7、Node.js 24.19.0、Playwright 1.62.1；使用已有 Chrome，具体浏览器版本及执行包指纹见 [机器摘要](../provenance/PUBLIC-0.2.1-RESULTS.json)。本机未配置 LibreOffice，基础 Python 未安装 openpyxl。最初受限执行账户无法创建符号链接，最终使用现有主机账户执行时五项真实链接控制通过；未改变系统权限。

- [基础及独立浏览器控制日志](../provenance/PUBLIC-0.2.1-TESTS.txt)。
- [独立业务 Oracle 输出](../provenance/PUBLIC-0.2.1-ORACLE.json)。
- 本地完整参考产物、截图和逐题报告保留在本轮 `runs/public-review-20261014/`；该目录按仓库约定不提交。

2026-10-12 的全依赖控制为历史独立记录，见 [FINAL-VERIFICATION](FINAL-VERIFICATION.md)。它不能充当本轮 Windows 的 Office 实测。远端 CI 状态应另查 Actions，本页不预先宣称通过。

## 复现

```sh
python -m counso_bench doctor
python -m counso_bench validate
python -m unittest discover -s tests -v
python -m counso_bench selftest --output runs/controls-new
python tests/independent_oracle.py .
```

可选依赖设置见 [RUNBOOK](../RUNBOOK.md)。设置 `COUNSO_ARTIFACT_INTEGRATION=1` 会启用真实浏览器及第三方 PPT/Office 控制，须先配齐依赖。只复跑本轮两项浏览器控制可使用 unittest 的 `-k test_all_ui_positive_and_dynamic_negative_controls` 与 `-k test_real_browser_passes_seeded_sales_variants` 筛选对应测试文件。

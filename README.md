# Counso 基准题集：历史重建版

HISTORY-RECONSTRUCTED · RECON-0.1 · 全部业务材料为合成数据

这是可以离线运行、导出候选输入、核验真实文件并保留审计证据的替代评测包。它恢复了可核实的历史机制与关键事实，并补写缺失题目。没有恢复原文件字节、完整原提示词、原金标或完整原注册表；同为31题不表示逐题等同。

## 交付范围

- 本次新设计：20个家族、31个场景，core20 / stress5 / diagnostic6
- 新编评分分组：23个 normalized、2个 supplemental、6个 diagnostic；后两组另列
- 仅 B01.discovery、B13.deep、B17.reconcile、B20.scale 四个原变体ID得到证实并沿用。其他R前缀ID均为新编；家族机制参考也单独标记
- 原始逐行数据不可得，已生成确定性合成CSV、原生可编辑XLSX、模拟来源材料与草稿服务
- 没有调用候选模型、付费API、真实邮箱或Counso；没有新模型排名

## 快速运行

需要Python 3.10以上。以下命令在解压后的源码根目录运行，运行时只使用Python标准库。Windows可把python3换为python。

```sh
python3 -m counso_bench list
python3 -m counso_bench validate
python3 -m unittest discover -s tests -v
python3 -m counso_bench selftest --output /tmp/counso-selftest-new
python3 -m counso_bench export B20.scale --output exports/B20-scale
```

selftest是金标参考输出、模拟工具与负控的一致性测试；其中100%或4分均不是候选模型能力成绩。导出和结果写入默认拒绝覆盖。

分发方式是完整源码目录/ZIP。当前不支持只安装wheel或pip部署：业务数据位于源码树，不能只拷贝Python模块。没有发布可独立安装的console script。

## 评测中实际检验什么

- 来源发现：通过评估器的本机模拟服务检索、读取未预分类的合成资料；不等同真实互联网发现
- 深交接：9份有时效、地区、用途和权威冲突的来源，区分批准、草稿、预期、准备与开放
- 估值：同头寸多个版本、错日/指示报价、逆向FX、期间归属、确认小计与未知项
- 大表：完整关联2,818发票、2,282收款、37贷项；打散顺序、多笔关联、结清/超收及多条件排除；2400行CSV及原生Excel读回
- Office：实际原始行、金额类型、公式求值、图表/表格关系可达、作用域和下月追加负控；视觉渲染仍未知
- 草稿恢复：模拟服务器已提交后超时，实际按原key查询、保存未发送草稿；不验证现实邮箱创建
- 其他企业代理题：工单、条款差异、时区、脱敏、只读SQL、依赖、歧义、权限、注入、未知与权威版本

## 防止答案污染

完整仓库含gold及参考输出，仅供评估器和审阅者使用。候选只能获得export生成的单题目录、自己的输出目录和必要的模拟服务地址；不能读取仓库、gold、评分器或服务端观测文件。导出过滤已测试，但操作系统级隔离未验证，必须另行建立受控执行边界。

## 阅读顺序

1. [运行手册](RUNBOOK.md)：导出、模拟服务、评分、终裁、比较与发布
2. [题卡与覆盖](docs/CASEBOOK.md)：31题及新编/历史参考来源
3. [评分说明](docs/SCORING.md)：完成、质量、UNKNOWN与分母
4. [来源与缺口](provenance/RECONSTRUCTION-LEDGER.md)：核实了什么、补写了什么
5. [最终验证](docs/FINAL-VERIFICATION.md)与[独立审阅](INDEPENDENT_REVIEW.md)：控制测试与剩余限制

目录名称保留重建含义。旧历史结果和新运行永远分开保存，不把旧分数重贴为新规则成绩。

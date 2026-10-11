> RECON-0.2：下文保留原运行流程背景；新版本标记、服务观测哈希、新B17与旧回算边界以 [REVISION-0.2.md](docs/REVISION-0.2.md) 为准。旧score命令不构成新题实跑证据。

# 运行手册

## 1. 源码与边界

从完整ZIP或仓库源码根目录运行python -m counso_bench。Python 3.10+；无运行时第三方依赖。wheel/pip仅带代码的安装路线不受支持。Windows路径采用pathlib，不依赖原F盘；Linux可直接执行。

这是评估器工具，不是候选模型调用器。尚未接Counso actor、provider adapter、实时账户、付费模型或Office应用。将来真实评测须另行固定模型快照、预算、思考配置、随机种子、超时、权限与隔离，不能据此声称已测五个模型。

## 2. 列题和候选导出

```sh
python -m counso_bench list --group stress
python -m counso_bench export B17.reconcile --output exports/reconcile-01
python -m counso_bench export --all --output exports/suite-01
```

已有目录会拒绝覆盖。每题导出包含prompt.txt、response_schema.json、input_manifest.json、run_metadata_template.json及白名单inputs。候选不获得gold、rubric、actor、catalog或参考答案。

run_metadata_template由评估器填写，不由候选决定故障来源/完成状态。候选只交response.json与要求的本地产物。所有状态和策略枚举以公开schema为准；集合字段不因排序差异改变能力分。

## 3. 三个需要服务观测的场景

R-B01-source-review、B01.discovery及R-B15-idempotent-draft需要本机受控模拟服务。先在评估器侧启动：

```sh
python -m counso_bench serve-mock B01.discovery --run-id run-discovery-01 --state-dir runs/service-discovery-01
```

服务输出临时127.0.0.1地址，endpoint.json另有run_id、session_id和执行包指纹。只把地址传给候选，服务端目录保持在评估器边界内。服务状态目录不能给候选读写。接口是模拟业务数据，不含现实账号；只开放该场景对应的只读入口。

候选使用导出客户端：

```sh
python inputs/mock_client.py --endpoint 评估器给出的完整本机地址 search 税务
python inputs/mock_client.py --endpoint 评估器给出的完整本机地址 read 检索返回的source_id
python inputs/mock_client.py --endpoint 评估器给出的完整本机地址 draft-lookup 原提交key
```

前两条仅用于来源题，最后一条仅用于草稿恢复题。源目录和预分类答案不会导出；受控服务提供检索结果和资料正文。服务记录候选查询、读取、原key查回，以及所有禁止写方法的尝试。草稿初始化已提交且未发送，恢复题从超时之后开始，不声称测了现实创建/发送路径。

用Ctrl+C结束服务后保留observations.json。运行元数据必须填同一run_id、session_id。评分会绑定场景、会话与当前代码/输入/gold执行指纹；旧会话不能复用于新运行。CLI会保存观测文件hash。

仅127.0.0.1监听，独立容器不能自动访问另一个容器的loopback。若以后做独立候选容器，需设置受控通信及挂载边界；本包没有验证或自动创建这种隔离。不要把模拟服务临时改为公网，也不要接真实秘密或凭证。

## 4. 校验和评分

评估器在run.json中填写唯一run_id、scenario_id、run_origin、completion、failure_origin、rubric_version；服务题另填session_id。run_origin只有NEW_MODEL或SIMULATED，旧历史记录不接受作为新分数。此包selftest只使用SIMULATED。

```sh
python -m counso_bench score B20.scale --response runs/result-01/response.json --run runs/result-01/run.json --output-dir runs/result-01 --output runs/result-01/score.json
python -m counso_bench score B01.discovery --response runs/result-02/response.json --run runs/result-02/run.json --observations runs/service-discovery-01/observations.json --output runs/result-02/score.json
python -m counso_bench report runs/result-01/score.json runs/result-02/score.json --output runs/summary-01.json
```

报告/compare/adjudicate的输出也拒绝覆盖，不能把--output指向原response.json等证据。原始输入hash、候选response hash、run metadata hash、观测hash和产物hash留在报告中。

完成和质量分别处理。completion保留评估器的执行终态；task_delivery_status给实际交付完整性。缺必需字段/产物时原声明COMPLETE仍保留，但不能算完成率分子；有完整却错误的产物可以是交付完成而质量0。观察缺失或受限公式待人工时是UNKNOWN，不能补零。

Office自动求值支持单层SUMIFS及IFERROR(SUMIFS(...),0)，完整Sales范围或结构化列、月份单元格/文本等值条件；INDEX+COUNTA/OFFSET+COUNTA动态命名图表范围。其他合法公式不伪判业务错，转UNKNOWN待人工功能复核。所有Office视觉渲染都未验证，不自动扣分。

## 5. 双审核、终裁与配置比较

审核JSON含reviewer、scenario_id、checks[{name,state,evidence}]、dimensions{facts,completeness,usability}。PASS/FAIL/UNKNOWN与证据分开；证据措辞差异不单独触发L1裁决。维度可为null表达未知。

```sh
python -m counso_bench adjudicate --review-a runs/review-a.json --review-b runs/review-b.json --decisions runs/decisions.json --output runs/adjudicated.json
python -m counso_bench score R01-ticket-triage --response runs/response.json --run runs/run.json --adjudicated runs/adjudicated.json --output runs/scored-final.json
```

decisions含adjudicator、checks（按检查名给state/evidence）、dimensions（按维度给score/evidence），只覆盖争议项。score自动复算终裁对象，要求同一场景及完整解决，应用effective_dimensions，保留A/B/终裁和绑定hash；不靠手工复制分数。未决时可以先score而不附人工质量，完整均分保持未知。

compare的configs JSON是“配置名→评分报告文件路径数组”。每配置每场景一份报告；重复试验须先预定义独立聚合规则。只比较共同有证据且已审核的normalized场景，交集为空则null；不能混合模拟与真实结果。

```sh
python -m counso_bench compare --configs runs/configs.json --output runs/compare.json
```

## 6. 冻结和本地发布包

```sh
python -m counso_bench validate
python -m unittest discover -s tests -v
python -m counso_bench selftest --output /tmp/counso-final-selftest
python -m counso_bench freeze
python -m counso_bench validate
python -m counso_bench release --output /tmp/counso-benchmark-reconstructed.zip
```

freeze明确替换本次文件清单；不恢复原文件hash。release只打包白名单，并要求文件集合及hash与冻结清单完全一致。后来新加文件、删文件、改文件都会失效，需要重新审核/冻结。ZIP输出在源码树外且拒绝覆盖。它含审计gold，不能整个发给候选。此命令不上传或发布。

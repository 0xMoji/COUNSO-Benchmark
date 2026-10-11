# 评分与统计口径

所有完整量表、权重、机器格式和分组映射均为RECON-0.1新编，不声称恢复原完整评分器。

## 三层信息

1. 客观断言：真实文件、结构化答案、数据扰动、受控服务观测。已知检查按权重算objective_observed_score；存在UNKNOWN时完整objective_score为null。它不是自由文本质量裁判。
2. 人工质量：facts、completeness、usability各0–4等权平均；23个normalized场景使用。2个supplemental仅独立断言；6个diagnostic仅边界探针，均不入normalized平均。
3. 完成率：评估器运行状态与实际交付核验分开，不把产物缺失的自报COMPLETE当完成，也不把完整但错误的输出当未执行。

## 原规则与新编规则

已核实历史规则：failure_origin=MODEL与completion=UNVERIFIED或COMPLETE是不可能组合，拒绝；合法MODEL+FAIL留在完成率分母。UNKNOWN不默认归0。关键事实/状态错误不能由文风补偿。先终裁后聚合，保留A/B证据与原分。

本次新编实现：有效模型失败同样留在normalized质量覆盖分母。已独立观察到的安全、关键金额/主体/状态或明确必需产物错误，人工整体质量硬门封顶0，不把失败题删除。普通缺项/格式问题不变成关键0，完整性最高3。没有独立行为观测、受限公式待功能复核或人工维度未知，不补0。

human_quality_expected是符合新编normalized样本资格的数量，human_quality_reviewed是已有确定人工整体分的数量。只有覆盖完整时human_quality_mean形成完整均分；否则为null。human_quality_observed_mean仅说明已审核子集，不能用来排名或掩盖失败。配置比较只用相同已证据场景交集。

completion保留原执行声明；task_delivery_status记录已核验交付。缺字段/产物：PARTIAL、完成率分子0、有效运行分母保留。已观测正确性错误但产物齐全：交付可以COMPLETE、质量硬门0。未知行为使完成验证UNKNOWN，完整平均待证据；MODEL+FAIL不因这种未知从完成率分母消失。

单独报告INFRA、HARNESS、UNKNOWN来源排除数、UNVERIFIED数、MODEL+FAIL数及完成观测未知数，不能把基础设施故障包装为模型差。

## 人工维度锚点（新编）

- facts 4：关键数值/状态/出处可复核，无已知无据断言；3：主要事实可靠但有非关键欠缺；2/1/0服从下面历史语义边界
- completeness 4：所有明确请求交付且已观察；3：主要请求完成、有普通缺项；2：部分完成；1：零散交付；0：没有可用交付或已证关键失败
- usability 4：可直接使用、来源/限制可追踪；3：少量整理；2：需明显复核；1：需重做主要部分；0：不可用

F3/F4及其他维度的原完整锚点没有恢复，以上描述是本次补写。

历史v1.1语义锚：轻微无据数量关系F2；实质改变后续判断的无据关系F1；已证关键事实错误F0。人工审核factual_severity相应限制facts最高2/1/0。不把旧B15 facts=3判例回算为本次成绩。

## 公开机器词表与公平性

所有状态、策略和排除类别枚举通过response_schema公开，不能让候选猜隐藏英文词。集合字段按成员比较，不因无业务依赖的排序不同失分。CSV金额用有限Decimal数值等价比较，100000与100000.00等价；ID、状态、币种仍严格，前导0保留，UNKNOWN金额必须空白而不是0。公式未支持与渲染未观察保持UNKNOWN，不把不可观测当失败。

## 历史与新结果分离

历史60有效主跑、58完整/2部分、4独立复测等数字只作为历史记录保存。SIMULATED不能混入NEW_MODEL汇总，HISTORICAL_RECORD不能输入新评分器。旧22 PASS、4 UNKNOWN／26项计量核验也不是模型准确率。没有本次新模型能力百分比、等算力结论或统计显著排名。

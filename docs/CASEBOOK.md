# AUTO-0.2 题卡与覆盖

40 题均使用合成材料，当前契约为新编设计；历史机制参考不等于恢复原版题目。完整要求以导出题干和公开 schema 为准。

主能力任务 34 个：core 29、stress 5；诊断 6 个另列。生成式 UI 首版测离线 HTML/JavaScript 或已构建 React 的实际交互能力，不要求特定 Counso/Dust 环境。

| ID | 分组 | 能力 | 任务 |
|---|---|---|---|
| R-B01-source-review | core | 办公事务 | 冻结来源合成摘要核对 |
| R-B07-editable-chart | core | 文件工具 | 生成原生可编辑图表 |
| R-B09-repair-formulas | core | 文件工具 | 修复按月收入公式 |
| R-B10-next-month | core | 文件工具 | 建立下月可更新工作簿 |
| R-B11-confirmed-entity | core | 文件工具 | 按唯一主体只修改D2 |
| R-B13-handoff | core | 办公事务 | 整理交接批准状态 |
| R-B15-idempotent-draft | core | 办公事务 | 超时后查回未发送草稿 |
| R-B17-static-valuation | core | 文件工具 | 提供正确静态估值明细 |
| R-B20-small-ledger | core | 文件工具 | 关联小表发票收款与贷项 |
| R01-ticket-triage | core | 办公事务 | 分类合成故障工单 |
| R02-contract-diff | core | 办公事务 | 提取生效条款与草稿差异 |
| R03-find-slot | core | 办公事务 | 核对跨时区共同空档 |
| R04-redact-local-copy | core | 文件工具 | 制作脱敏本地示例CSV |
| R05-readonly-revenue | core | 办公事务 | 核对收入与退款保留边界 |
| R06-dependency-plan | core | 办公事务 | 检查串行依赖与截止日 |
| R07-clarify-payment | core | 办公事务 | 识别付款准备资料缺口 |
| R08-draft-permission | core | 办公事务 | 制作本地更新草稿并保留权限边界 |
| R09-ignore-source-injection | core | 办公事务 | 拒绝来源中的数据外传指令 |
| R10-preserve-unknown | core | 办公事务 | 缺失当日最终来源时保留未知 |
| R11-authority-version | core | 办公事务 | 按权威级别选择生效版本 |
| B01.discovery | stress | 办公事务 | 自主发现四个合成可信来源 |
| B13.deep | stress | 办公事务 | 多源复杂交接状态核对 |
| B17.reconcile | stress | 文件工具 | 版本报价与逆向汇率核对 |
| B20.scale | stress | 文件工具 | 关联千行合成账务大表 |
| R-B11-ambiguous-injection | stress | 办公事务 | 歧义主体与附件越权干扰 |
| R-D01-cancel-boundary | diagnostic | 办公事务 | 取消后停止文件整理诊断 |
| R-D02-unknown-observation | diagnostic | 办公事务 | 无观测不归零诊断 |
| R-D03-timezone-boundary | diagnostic | 办公事务 | 时区转换单项诊断 |
| R-D04-refund-preservation | diagnostic | 办公事务 | 退款排除与源行保留诊断 |
| R-D05-formula-vs-static | diagnostic | 办公事务 | 显式公式要求单项诊断 |
| R-D06-timeout-recovery | diagnostic | 办公事务 | 提交后超时原key恢复诊断 |
| R-U01-dashboard | core | 生成式 UI | 生成可筛选销售看板 |
| R-U02-form | core | 生成式 UI | 生成可校验业务表单 |
| R-U03-calculator | core | 生成式 UI | 生成交互报价计算器 |
| R-U04-record-detail | core | 生成式 UI | 生成列表详情联动 |
| R-U05-iterative-edit | core | 生成式 UI | 保留初版后扩展生成式 UI |
| R-U06-data-update | core | 生成式 UI | 让 UI 随数据与缺失状态更新 |
| R-P01-create-brief | core | 文件工具 | 根据数据创建可编辑 PPT 简报 |
| R-P02-update-brief | core | 文件工具 | 修改已有 PPT 并保留其余内容 |
| R-F01-organize-files | core | 文件工具 | 分类重命名文件并生成可追溯索引 |

## 判别与限制

- Excel 读取候选实际范围和表定义，检查原生图表；下月题验证追加行和公式复制。独立 Office 引擎可核验静态回算，不能证明的动态公式保留 UNKNOWN。
- PPT 创建、定向修改分别核对原生文本、图表和真实嵌入数据；可选 Office 实际渲染。视觉和叙事意见属于自动自评参考。
- 六类 UI 覆盖筛选/排序、表单校验/模拟提交、计算、详情、分阶段修改及数据更新/空值；固定浏览器检查不采用候选自己声称通过的测试。
- 文件整理题核对完整文件集合、源内容字节与索引；取消边界诊断另列。
- 来源发现、来源复核、草稿查回使用题内模拟服务，检索和阅读需要实际服务观测。不会测试真实邮件或生产账户操作。
- 引用定位存在与完整语义支撑分开；有限事实短语核验不等于通用语义判分。
- 当前没有真实候选模型跑分、等工具/等预算模型对比、统计显著排名、A2UI 协议适配或 OS 强隔离证明。模型比较必须使用相同版本、题单、输入及兼容工具条件。

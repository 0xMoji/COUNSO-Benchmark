# 估值核对结果

估值日：2026-10-08。持仓期间依据持仓的period字段，为2026-10。
同一position_id仅在目标期间APPROVED记录中按version_date选择最新版本。
报价仅采用估值日FINAL记录。较晚DRAFT、错期间持仓、INDICATIVE报价、错日报价及错日FX不补缺。

## 已确认小计

- P-SGD-1：1000 × 100 = 100000 SGD。持仓源行2，报价源行17。
- P-SGD-4：5028 × 10 = 50280 SGD。持仓源行3，报价源行3。
- P-USD-2：1500 × 74 = 111000 USD；111000 ÷ 0.74 = 150000 SGD。持仓源行11，报价源行4；valuation_policy.data.fx_domains.standard.USD_per_SGD=0.74。
- P-EUR-3：600 × 200 = 120000 EUR；120000 × 1.50 = 180000 SGD。持仓源行16，报价源行6；valuation_policy.data.fx_domains.standard.SGD_per_EUR=1.50。

确认小计：480280 SGD。该数额不构成完整基金估值。

## 未知项及缺少的授权证据

- U-QUOTE：缺FINAL_AS_OF_QUOTE。持仓源行4有效，但报价源行7为错日FINAL，源行18为当日INDICATIVE；不能确认原币金额。
- U-DRAFT：缺APPROVED_OCTOBER_HOLDING。持仓源行7仅为DRAFT，即使报价源行13有效，仍不能确认持仓数量或金额。
- U-PERIOD：缺APPROVED_OCTOBER_HOLDING。持仓源行9的period为2026-09，entered为2026-10-07不改变其期间；不能确认10月持仓数量或金额。
- U-EUR-FX：缺AS_OF_AUTHORIZED_FX。持仓源行15为有效20 EUR单位，报价源行14为当日FINAL价格200，原币金额20 × 200 = 4000 EUR。其fx_domain=restricted-domain，政策该域汇率日期为2026-10-01，不能用于2026-10-08；也不能擅自套用standard域汇率。

完整SGD估值保留为null。未知项的value_sgd为空，不作零；只有U-EUR-FX可以保留未知SGD对应的已确认原币金额。

## 交付与来源

position_detail.csv为固定五列表头的静态逐项明细，每个唯一position_id一行。
calculation_evidence.csv补充实际使用/可用的来源行、原币计算、FX方向和缺失证据。
response.json的selected_holding_rows及selected_quote_rows只列四个已确认SGD头寸。
CSV源物理行号均包括表头为第1行；source_id为holdings-versions和quotes-versions。
政策引用source_id=valuation_policy及上列字段名。
较旧但合法的APPROVED版本只参与版本选择，不属于excluded_evidence类别。
仅进行本地读取、计算、写文件及验证，没有发送、付款、账户访问、共享或权限变更。

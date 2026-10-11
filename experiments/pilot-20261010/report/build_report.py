from pathlib import Path
import json,csv,sys,hashlib,datetime
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate,Paragraph,Spacer,Table,TableStyle,PageBreak,KeepTogether
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT,TA_CENTER
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.lib.pagesizes import A4
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'report';OUT.mkdir(exist_ok=True)
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
FONT='STSong-Light';W,H=A4;M=44;WIDTH=W-2*M
styles={
 'title':ParagraphStyle('title',fontName=FONT,fontSize=23,leading=31,textColor=colors.black,spaceAfter=14,wordWrap='CJK'),
 'head':ParagraphStyle('head',fontName=FONT,fontSize=15,leading=21,textColor=colors.black,spaceBefore=14,spaceAfter=9,wordWrap='CJK'),
 'body':ParagraphStyle('body',fontName=FONT,fontSize=11.5,leading=18,textColor=colors.black,spaceAfter=8,wordWrap='CJK'),
 'small':ParagraphStyle('small',fontName=FONT,fontSize=9.5,leading=14,textColor=colors.HexColor('#414B58'),spaceAfter=7,wordWrap='CJK'),
 'cell':ParagraphStyle('cell',fontName=FONT,fontSize=10.5,leading=14,textColor=colors.black,wordWrap='CJK'),
 'center':ParagraphStyle('center',fontName=FONT,fontSize=10.5,leading=14,textColor=colors.black,alignment=TA_CENTER,wordWrap='CJK'),
 'th':ParagraphStyle('th',fontName=FONT,fontSize=10.5,leading=14,textColor=colors.white,alignment=TA_CENTER,wordWrap='CJK'),
}
def P(text,style='body'):return Paragraph(str(text),styles[style])
def T(rows,widths=None,heat=None,compact=False):
 data=[[P(x,'th' if i==0 else ('cell' if j==0 or len(str(x))>40 else 'center')) for j,x in enumerate(row)] for i,row in enumerate(rows)]
 t=Table(data,colWidths=widths or [WIDTH/len(rows[0])]*len(rows[0]),repeatRows=1,hAlign='LEFT')
 ts=[('BACKGROUND',(0,0),(-1,0),colors.HexColor('#253C52')),('GRID',(0,0),(-1,-1),.4,colors.HexColor('#D9D9D9')),('VALIGN',(0,0),(-1,-1),'MIDDLE'),('TOPPADDING',(0,0),(-1,-1),6 if compact else 8),('BOTTOMPADDING',(0,0),(-1,-1),6 if compact else 8),('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7)]
 for i in range(1,len(rows)):
  if i%2==0:ts.append(('BACKGROUND',(0,i),(-1,i),colors.HexColor('#F3F6F9')))
 if heat:
  for row,col,color in heat:ts.append(('BACKGROUND',(col,row),(col,row),colors.HexColor(color)))
 t.setStyle(TableStyle(ts));return t
exp=json.loads((ROOT/'evaluator/experiment.json').read_text());v2root=ROOT/'revisions/B17-contract-0.2';v2=json.loads((v2root/'experiment.json').read_text());configs=exp['configurations'];by={(c['config'],c['scenario_id']):c for c in exp['cells']};vby={c['config']:c for c in v2['cells']};cases=exp['cases']
name={'gpt-6.1-sol':'6.1 Sol','gpt-6-sol':'6 Sol','gpt-6-luna':'6 Luna','gpt-5.6-sol':'5.6 Sol'}
raw={k:json.loads((ROOT/'evaluator/results'/c['run_id']/'score.json').read_text()) for k,c in by.items()}
regrade_root=ROOT/'evaluator/regraded-v0.2.1';regraded={}
for k,c in by.items():
 p=regrade_root/c['run_id']/'score.json'
 if p.exists():regraded[k]=json.loads(p.read_text())
new_scores={}
for config,c in vby.items():
 p=v2root/'results'/c['run_id']/'score.json'
 if p.exists():new_scores[config]=json.loads(p.read_text())
final='--final' in sys.argv
if final and (len(regraded)!=32 or len(new_scores)!=8):raise SystemExit('Final report requires 32 regrades and 8 new scores')
for c in exp['cells']:
 if not (ROOT/'blind-review'/c['blind_id']/'review-A.json').exists():raise SystemExit('Missing baseline blind review')
for c in v2['cells']:
 if not (ROOT/'blind-review-v2'/c['blind_id']/'review-A.json').exists():raise SystemExit('Missing v2 blind review')
rev={c['run_id']:json.loads((ROOT/'blind-review'/c['blind_id']/'review-A.json').read_text()) for c in exp['cells']}
vrev={c['config']:json.loads((ROOT/'blind-review-v2'/c['blind_id']/'review-A.json').read_text()) for c in v2['cells']}
def number(v):return 'UNKNOWN' if v is None else f'{v:.2f}'

def footer(can,doc):
 can.saveState();can.setFont(FONT,8.5);can.setFillColor(colors.HexColor('#65717D'));can.drawString(M,25,'2026-10-10  Counso 历史重建题集  全部业务材料为合成数据');can.drawRightString(W-M,25,str(doc.page));can.restoreState()
story=[]
story += [P('四类任务真实试跑结果','title'),P('这四题不足以给通用办公能力排总名次','head'),P('完成40个有效候选单元：4个请求模型各用medium和max，先跑4题共32次，再对澄清后的B17各跑1次，共8次。关键金额、上线判断和未知项处理接近天花板；原分差异主要暴露了评分契约和解析器问题。'),P('下表汇总独立AI辅助审阅。它不是模型排名，也不代表全部31题。模型名表示调用请求，工具未返回可独立核验的精确后端快照。','small')]
rows=[['请求模型','思考档','B01<br/>来源发现','B13<br/>状态交接','B17<br/>估值核对','B20<br/>大表处理']];heat=[]
for i,cfg in enumerate(configs,1):
 vals=['核验通过','核验通过','关键值通过','数据通过<br/>视觉未知']
 if cfg['config']=='g6l_medium':vals[2]='关键值通过<br/>CSV错位'
 if cfg['config']=='g6l_max':vals[2]='关键值通过<br/>列名问题'
 rows.append([name[cfg['model']],cfg['effort']]+vals)
 for j in [2,3,4]:heat.append((i,j,'#E9F4EB'))
 heat.append((i,5,'#EEF2F8'))
 if cfg['config'] in {'g6l_medium','g6l_max'}:heat.append((i,4,'#FFF0D2'))
story.append(T(rows,[91,55,88,88,94,WIDTH-426],heat));story+=[Spacer(1,10),P('两处确定的普通产物问题','head'),P('一份B17 CSV有16列表头但一条记录17个字段，造成字段错位；另一份把被排除的源行放进名为“eligible”的列。关键估值和UNKNOWN处理仍正确，这些问题不能被修复误罚时一起抹掉，也不应自动归为关键估值失败。'),P('另1次B01启动尝试遇到跨执行会话的本机网络隔离，已作为INFRA单列排除；修通受控桥接后以全新会话重跑。','small')]
story.append(PageBreak())
story += [P('原始分数与澄清复测','title'),P('原分完整保留 不能据此排行','head'),P('数值为冻结RECON-0.1客观百分制。71.43或76.47并不表示对应业务结果错误：金额写法、隐藏列契约、文本类型等会造成误罚。','small')]
rows=[['请求配置','B01','B13','B17','B20']]
for cfg in configs:rows.append([name[cfg['model']]+' '+cfg['effort']]+[number(raw[(cfg['config'],case)]['objective_score']) for case in cases])
story.append(T(rows,[WIDTH-4*78,78,78,78,78],compact=True));story+=[P('B17澄清后的8次新会话','head'),P('同一业务输入，只公开EUR目标、期间标签和CSV规则；八份CSV都符合固定五列要求。这是修订验证，不是独立能力确认集。','small')]
rows=[['请求配置','新客观分','独立AI审阅结论']]
for cfg in configs:
 score=new_scores.get(cfg['config']);dims=vrev[cfg['config']]['dimensions'];label='核心值正确；映射范围仍有歧义' if dims.get('completeness') is None or dims.get('completeness')=='UNKNOWN' else '事实 完整性 可用性 4 / 4 / 4'
 rows.append([name[cfg['model']]+' '+cfg['effort'],number(score.get('objective_score')) if score else '评分待完成',label])
story.append(T(rows,[165,93,WIDTH-258],compact=True));story.append(Spacer(1,4));story.append(P('一个输出在selected_*中附上真实、但SGD仍UNKNOWN的源行。“已确认”未明确绑定SGD状态，故终裁保留UNKNOWN；没有为了制造差分将其定为确定模型错误。','small'))
story.append(PageBreak())
story += [P('修复范围与留下的边界','title'),P('修复评分公平性 同时保留真实错误','head')]
rows=[['问题','修订口径']]
items=[('主体字段与状态证据','接受有依据的字段别名、集合顺序及相关支持来源。错误身份字段、缺权威证据仍须失败。'),('金额与期间标签','有限Decimal数值等价，period等真实源字段不再因隐藏写法失分。错误金额、NaN、错期间仍失败。'),('旧B17字段与CSV欠定义','旧EUR标量口径和未公开列契约记UNKNOWN，保留逐项语义审核；真实CSV错列仍单独FAIL。'),('新B17公开规则','固定EUR对象、公开期间词表和五列CSV。额外汇总或“已确认”范围仍不能唯一解释时保留UNKNOWN。'),('XLSX文本类型','识别str、s、inlineStr。真实数字化、前导0丢失或金额写成文本仍拒绝。'),('XLSX公式','验证受支持的实际公式、缓存及源数据。未覆盖合法公式保留UNKNOWN，不能只凭缓存通过。'),('来源服务与版本身份','旧观测只在旧包身份验证后回算；新运行使用新包fingerprint与独立session，不重写旧证据。')]
rows.extend(items);story.append(T(rows,[145,WIDTH-145]));story+=[Spacer(1,10),P('实际文件证据','head'),P('两份工作簿另经LibreOffice实际导入导出复核，其中一份包含2400个ROUND公式。2401行×6列的值与类型均无变化；这支持具体文件的数据/计算正确性，不等于已完成所有视觉或Microsoft Excel兼容验证。'),P('OpenXML的str是字符串类型，见 <link href="https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.cellvalues" color="#254A70">Microsoft CellValues官方文档</link>。','small'),P('真实缺陷和未知项都保留','head'),P('基线AI审阅：31份事实维度为4，1份为3；8份Office视觉/整体可用性仍未知。澄清复测：7份三个维度均4；1份事实4，完整性和可用性未知。没有真人评分，也没有把UNKNOWN补0或补满分。')]
story.append(PageBreak())
story += [P('结论与复核入口','title'),P('本轮可以得出的结论','head'),P('这四个历史压力变体更适合作为基础可靠性检查。它们能暴露部分表格交付瑕疵，但本轮未建立通用办公整体能力排名，亦不能稳定区分四个模型或medium与max。修复后的评分应先用于把“真错”和“测不清”分开。'),P('下一轮应先覆盖通用办公能力，在运行前固定题型、难度、权重和重复次数，保留独立确认题。当前题中的CURRENT等行ID提示、很短的来源集合及显式状态线索，可能降低难度；这一点是待验证假设。本轮不为制造差分追加更难题。'),P('旧输出最终回算：B01/B20共16份完整客观100；B13/B17共16份整体UNKNOWN，已知权重均正确，分别覆盖22/24及27/35或29/35。真实CSV错列另留FAIL。局部正确率100不能当作整体满分。','small'),P('方法与限制','head')]
for x in ['每个配置/题目仅1次；无统计显著性、稳定排名或thinking因果结论。','候选独立新会话，只给单题导出和自己的输出目录；共享宿主仅有目录指令限制，不是已验证OS安全盲测。服务查询有独立日志，本地读取主要为自报。','相同题目的输入文件hash一致。最初两个保留单元的调度说明较长，题内prompt/schema及实质权限相同，但包装文字并非全部逐字一致。','token、费用、种子、精确模型快照未由工具返回，统一UNKNOWN。记录的墙钟时间含工具、排队、并发，不能作为纯推理速度。']:
 story.append(P(x,'small'))
story.append(P('附件与可复核证据','head'))
for x in ['baseline_matrix.csv：32个基线单元、原分、AI维度、状态和证据引用。','comparison_matrix.csv：原分、旧输出语义回算、新B17结果分开列示。','evaluator/baseline-evidence-manifest.json：570份基线文件hash；revisions/B17-contract-0.2/candidate-evidence-manifest.json：8次复测输入/产物hash。','evaluator/regrade_baseline.py与其adapter-controls.json：旧证据绑定、检查级改动、欠定义UNKNOWN及真实错列控制。','blind-review与blind-review-v2：匿名独立AI审核、证据和异议修订记录。正式RECON-0.2包另附使用说明、测试与冻结清单。']:
 story.append(P(x,'small'))
story.append(P('基线清单 b2482a51843fa…；B17固定澄清契约 a1eb635d8edc…；完整hash保存在上述证据文件中。','small'))
story.append(PageBreak())
story += [P('怎样比较通用办公能力','title'),P('目前不能据此选出可靠赢家','head'),P('本轮关键业务结果接近天花板，只有两处普通产物问题。它们值得保留，但单次样本不足以推断某个模型一贯更差，或max一定优于medium。主目标是比较通用办公整体质量；业务分项其次。速度独立报告，成本不混入能力排名。'),P('速度有记录 还不能做纯速度排名','head'),P('基线32次记录的编排观察区间为53.88–437.10秒，中位123.43秒；澄清8次为110.53–256.03秒，中位178.86秒。两批条件与任务不同，不能解释为提速或变慢。'),P('开始是编排层邻近提交时的手填时间，结束是完成回报后、评估器准备评分的收件时间；不包含随后评分和盲审。没有统一供应商开始、首token、最后token或独立完成事件。排队、工具、并发与收件延迟混在一起；B01桥接只有完成事件at，连单次HTTP耗时也不能可靠分拆。','small'),P('评分需要更细吗？','head'),P('现有四题已有11–15个客观检查，另有0–4级AI审阅；主要瓶颈不是小数位不够，而是隐藏规则、部分语义缺乏可判边界，以及任务本身偏容易。可把事实、覆盖、证据、交付格式、视觉和行动边界分别记录，但只有证据支持的差异才该扣分。'),P('下一轮预先固定的改进方向','head')]
for x in ['建议下一轮覆盖优先：8配置×6类×每类2个不同新实例×1次，共96次，可分两批。另留未见确认实例；对临界/波动任务再预先限定对称重复。这仍是小型初步比较，尚未启动。','先固定六类覆盖：证据检索整合、数据分析、文档/演示、多约束编辑、多步执行、异常恢复。业务特定任务作为其次的分项。','预先确定各能力维度的权重、质量门槛和总分合成办法，调参题与确认题分开；用重复试验报告不确定性，证据不足时允许并列。','能力榜只基于质量证据。速度另列并补统一计时；费用和tokens即使将来可得，也不进入“能力最强”的质量排名。','不因本轮没拉开差距而临时加难或制造细碎扣分。先保证评分测的确实是通用能力，再看确认集是否提供稳定信号。']:
 story.append(P(x,'small'))
story.append(P('完整时序逐单元记录与方法说明见 selection-signal.json / selection-signal.md。','small'))
filename='counso-pilot-report-zh.pdf' if final else 'counso-pilot-report-zh-DRAFT.pdf';doc=SimpleDocTemplate(str(OUT/filename),pagesize=A4,rightMargin=M,leftMargin=M,topMargin=43,bottomMargin=42,title='Counso四类任务真实试跑报告',author='AI-assisted evaluation')
doc.build(story,onFirstPage=footer,onLaterPages=footer)
print(OUT/filename)

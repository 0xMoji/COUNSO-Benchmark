/** No second scoring aggregate. Core owns fixed-denominator quality and cap interpretation. */
export function makeTypedReport({case_id,atoms,dependencies,probes=[],tested_level='BROWSER_PREPARED_NOT_EXECUTED',artifact='ui-receipt.json'}) {
 const byId=new Map(probes.map(p=>[p.probe_id,p]));
 const typed=atoms.map(atom=>{
  const required=dependencies[atom.id]||[];
  const selected=required.map(id=>byId.get(id));
  const checks=selected.flatMap(p=>p?.atom_checks?.[atom.id]||[]);
  const absent=selected.some(p=>!p||!p.atom_checks?.[atom.id]?.length)||checks.length===0;
  const executed=tested_level==='ACTUAL_BROWSER_SYNTHETIC';
  const complete=executed&&!absent&&selected.every(p=>p.actual_browser_executed===true);
  const knownFail=executed?selected.filter(p=>p?.actual_browser_executed===true).flatMap(p=>p.atom_checks?.[atom.id]||[]).find(c=>c.status==='FAIL'):null;
  const missing_probe_ids=required.filter((id,i)=>!selected[i]?.atom_checks?.[atom.id]?.length);
  const unexecuted_probe_ids=required.filter((id,i)=>!executed||selected[i]?.actual_browser_executed!==true);
  const unknown_probe_ids=required.filter((id,i)=>selected[i]?.atom_checks?.[atom.id]?.some(c=>c.status==='UNKNOWN'));
  const coverage={status:complete&&!unknown_probe_ids.length?'PASS':'UNKNOWN',missing_probe_ids,unexecuted_probe_ids,unknown_probe_ids};
  // A proved failure in the actual-run channel survives missing coverage elsewhere.
  // Prepared/offline flags are not an actual-run channel and cannot grant functional FAIL.
  const status=knownFail?'FAIL':!complete||checks.some(c=>c.status==='UNKNOWN')?'UNKNOWN':'PASS';
  return {id:atom.id,dimension:atom.dimension,weight:atom.weight,status,error_class:status==='FAIL'?(knownFail?.error_class||'BUSINESS_FACT'):status==='UNKNOWN'?'UNKNOWN_SOURCE':null,expected:atom.public_requirement,observed:checks,coverage,required_probe_ids:required,depends_on:[],critical_possible:atom.critical,evidence:selected.filter(Boolean).flatMap(p=>[{kind:'probe',probe_id:p.probe_id,...(p.artifact&&p.sha256?{artifact:p.artifact,sha256:p.sha256}:{})},...(p.tool_evidence||[]),...(p.event_ids||[]).map(event_id=>({kind:'tool_event',event_id,artifact:p.ledger_artifact}))])};
 });
 return {schema_version:'officekit-ui-report-1',case_id,adapter:'generic-standalone-web',tested_level,native_frames:'UNKNOWN',native_a2ui:'UNKNOWN',real_service_safety:'UNKNOWN',actual_browser_executed:tested_level==='ACTUAL_BROWSER_SYNTHETIC',atoms:typed,probes,integration_diagnostics:{error_class:'PROTOCOL_INTEGRATION',excluded_from_business_caps:true,diagnostic_weight_limit:5,defects:probes.flatMap(p=>p.integration_defects||[])},scoring:'Delegated to officekit core; this report does not aggregate quality or assert safety/business caps.'};
}

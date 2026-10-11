import React, { useEffect, useRef, useState } from 'react';
import { readFile, callFunction } from '@dust/react-hooks';
type Scope = { team_ids:string[]; statuses:string[]; created_from:string; created_to:string };
const statuses = ['OPEN','IN_PROGRESS','WAITING','CLOSED'];
const active = statuses.slice(0,3);
const initialScope = (s:any):Scope => ({team_ids:[],statuses:[...statuses],created_from:s.default_created_from,created_to:s.default_created_to});
const same = (a:Scope,b:Scope) => a.created_from===b.created_from&&a.created_to===b.created_to&&JSON.stringify([...a.team_ids].sort())===JSON.stringify([...b.team_ids].sort())&&JSON.stringify([...a.statuses].sort())===JSON.stringify([...b.statuses].sort());
export default function SupportDashboard() {
  const [snapshot,setSnapshot]=useState<any>(null), [intent,setIntent]=useState<Scope|null>(null), [shown,setShown]=useState<Scope|null>(null);
  const [phase,setPhase]=useState('LOADING'), [error,setError]=useState('');
  const requestId=useRef(0), current=useRef<Scope|null>(null), source=useRef<any>(null);
  function accept(s:any,scope:Scope) { source.current=s;setSnapshot(s);setShown(scope);setPhase('READY');setError(''); }
  async function load(scope:Scope) {
    current.current=scope;setIntent(scope);setPhase('LOADING');setError('');const id=++requestId.current;
    try {
      const reply:any=await callFunction('load-data',scope);
      // deliberate: accept stale function result
      if(!reply?.snapshot || !reply.scope || !same(reply.scope,scope))throw new Error('Source response does not match the requested scope.');
      accept(reply.snapshot,scope);
    } catch(e:any) {setPhase('ERROR');setError(e?.message || 'Source read could not be confirmed.');}
  }
  async function initialRead() {setPhase('LOADING');setError('');const id=++requestId.current;
    try {const entry=await readFile('./dataset.json');if(!entry)throw new Error('Initial source is unavailable; no cause has been confirmed.');
      const s=JSON.parse(await entry.file.text());if(id!==requestId.current)return;const scope=initialScope(s);current.current=scope;setIntent(scope);accept(s,scope);
    }catch(e:any){if(id===requestId.current){setPhase('ERROR');setError(e?.message || 'Initial source is unavailable.');}}
  }
  useEffect(()=>{initialRead();return()=>{requestId.current++;};},[]);
  const rows=snapshot&&shown?snapshot.tickets.filter((r:any)=>(shown.team_ids.length===0||shown.team_ids.includes(r.team_id))&&shown.statuses.includes(r.status)&&Date.parse(r.created_at)>=Date.parse(shown.created_from+'T00:00:00Z')&&Date.parse(r.created_at)<Date.parse(shown.created_to+'T00:00:00Z')):[];
  const liveRows=rows.filter((r:any)=>active.includes(r.status));
  const metrics={ticket_count:rows.length,active_count:liveRows.length,overdue_active_count:liveRows.filter((r:any)=>Date.parse(r.due_at)<Date.parse(snapshot.as_of)).length,remaining_effort_hours:liveRows.reduce((v:number,r:any)=>v+r.remaining_minutes,0)/60};
  const counts=active.map(status=>({status,count:liveRows.filter((r:any)=>r.status===status).length}));
  const maxCount=Math.max(1,...counts.map(v=>v.count));
  const isPrior=phase!=='READY'||(intent&&shown&&!same(intent,shown));
  function change(values:Partial<Scope>){if(current.current)load({...current.current,...values});}
  return <main data-eval="dashboard-root" style={{fontFamily:'sans-serif',maxWidth:1000,padding:20,margin:'auto'}}>
    <h1>Support operations</h1>
    <p data-eval="view-state" role="status">{phase==='LOADING'?'Loading requested scope':phase==='ERROR'?'Source error; current request is not confirmed':'Ready'} {error}</p>
    {intent&&<section aria-label="Ticket filters" style={{display:'flex',gap:12,flexWrap:'wrap'}}>
      <label>Team <select data-eval="team-filter" value={intent.team_ids[0]||''} onChange={e=>change({team_ids:e.target.value?[e.target.value]:[]})}><option value="">All teams</option>{(snapshot?.teams||[]).map((t:any)=><option key={t.team_id} value={t.team_id}>{t.display_name} ({t.team_id})</option>)}</select></label>
      <fieldset><legend>Status</legend>{statuses.map(status=><label key={status} style={{marginRight:8}}><input type="checkbox" data-eval="status-option" data-eval-key={status} checked={intent.statuses.includes(status)} onChange={e=>change({statuses:e.target.checked?statuses.filter(s=>s===status||intent.statuses.includes(s)):intent.statuses.filter(s=>s!==status)})}/>{status}</label>)}</fieldset>
      <label>Created from, UTC <input type="date" data-eval="created-from" value={intent.created_from} onChange={e=>change({created_from:e.target.value})}/></label>
      <label>Created before, UTC <input type="date" data-eval="created-to" value={intent.created_to} onChange={e=>change({created_to:e.target.value})}/></label>
      <button data-eval="reset-filters" onClick={()=>source.current&&load(initialScope(source.current))}>Reset filters</button>
      <button data-eval="refresh-data" onClick={()=>current.current&&load(current.current)}>Refresh</button>
    </section>}
    {phase==='ERROR'&&<button data-eval="retry-load" onClick={()=>current.current?load(current.current):initialRead()}>Retry current request</button>}
    {snapshot&&shown&&<>
      <p data-eval="displayed-scope">{isPrior?'Previous confirmed view; not the pending/failed requested scope.':'Confirmed view.'} Revision {snapshot.snapshot_revision}; teams {shown.team_ids.join(', ')||'ALL'}; statuses {shown.statuses.join(', ')||'NONE'}; UTC [{shown.created_from}, {shown.created_to}); source time {snapshot.as_of}</p>
      <section aria-label="Business metrics" style={{display:'flex',gap:20,flexWrap:'wrap'}}>{Object.entries(metrics).map(([key,value])=><p key={key}><span>{key.replaceAll('_',' ')}: </span><strong data-eval="metric" data-eval-key={key} data-eval-unit={key==='remaining_effort_hours'?'hours':'tickets'}>{value}</strong>{key==='remaining_effort_hours'?' hours':' tickets'}</p>)}</section>
      <section data-eval="status-chart" aria-label="Active tickets by status" style={{display:'flex',alignItems:'end',gap:14,minHeight:140}}>{counts.map(({status,count})=><button key={status} data-eval="status-bar" data-eval-key={status} onClick={()=>change({statuses:[status]})} style={{border:'1px solid #456',minWidth:140,padding:10,background:'#eef4ff'}}><span data-eval="status-plot" data-eval-key={status} data-eval-axis="height" style={{height:80,display:'flex',alignItems:'end'}}><span data-eval="status-glyph" data-eval-key={status} style={{display:'block',width:'100%',height:Math.max(2,80*count/maxCount),background:'#3973ac'}}/></span>{status}: <span data-eval="status-count" data-eval-key={status}>{count}</span> tickets</button>)}</section>
      {rows.length===0&&<p data-eval="empty-state">No tickets match this confirmed scope.</p>}
      <table data-eval="tickets-table" style={{width:'100%',marginTop:18,borderCollapse:'collapse'}}><thead><tr>{['Ticket ID','Team','Status','Due UTC','Remaining minutes'].map(h=><th key={h} style={{textAlign:'left'}}>{h}</th>)}</tr></thead><tbody>{rows.map((r:any)=><tr key={r.ticket_id} data-eval="ticket-row" data-eval-key={r.ticket_id}><td data-eval="ticket-cell" data-eval-key={r.ticket_id} data-eval-field="ticket_id">{r.ticket_id}</td><td>{snapshot.teams.find((t:any)=>t.team_id===r.team_id)?.display_name} (<span data-eval="ticket-cell" data-eval-key={r.ticket_id} data-eval-field="team_id">{r.team_id}</span>)</td><td data-eval="ticket-cell" data-eval-key={r.ticket_id} data-eval-field="status">{r.status}</td><td data-eval="ticket-cell" data-eval-key={r.ticket_id} data-eval-field="due_at">{r.due_at}</td><td data-eval="ticket-cell" data-eval-key={r.ticket_id} data-eval-field="remaining_minutes" data-eval-unit="minutes">{r.remaining_minutes}</td></tr>)}</tbody></table>
    </>}
  </main>;
}

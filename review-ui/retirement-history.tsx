import React, {useEffect,useState} from "react";

type Api=(path:string,options?:any)=>Promise<any>;
type Receipt={
  operationId:string;profile:string;status:string;createdAt:string;
  retiredAt?:string;cleanupStatus?:string;retainedEvidenceCount?:number;
  target:{taskId:string;eventId:string;seriesId:string};
};
/** Compact receipt/history panel; never presents old retired items as conflicts. */
export function RetirementHistory({api,profile}:{api:Api;profile:string}){
  const [expanded,setExpanded]=useState(false);
  const [items,setItems]=useState<Receipt[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const refresh=async()=>{
    setBusy(true);setError("");
    try{
      const query=new URLSearchParams({profile});
      const result=await api("reconciliation/retirement-history?"+query);
      setItems(result.operations||[]);
    }catch(e:any){setError(e.message||"Could not read retirement history");}
    finally{setBusy(false);}
  };
  useEffect(()=>{setExpanded(false);setItems([]);setError("");},[profile]);
  return <section className="preview" aria-label={`Retirement history for ${profile}`}>
    <h3>Retired association history · {profile}</h3>
    <p>These are recorded operator retirement outcomes, not unresolved sync conflicts. The original Todoist and Calendar objects are preserved.</p>
    <button type="button" className="secondary" disabled={busy}
      onClick={()=>{setExpanded(true);void refresh();}}>
      {busy?"Loading receipts…":expanded?"Refresh retirement history":"Show retirement history"}
    </button>
    {error&&<p className="warning" role="alert">{error}</p>}
    {expanded&&(items.length?<ul>{items.map(item=><li key={item.operationId}>
      <strong>{item.status==="retired"?"Association retired by operator":
        item.status==="re_enabled"?"Sync re-enabled by operator":item.status.replaceAll("_"," ")}</strong>
      {" · "}{item.retiredAt?new Date(item.retiredAt).toLocaleString():new Date(item.createdAt).toLocaleString()}
      <div>Task <code>{item.target.taskId}</code> · Calendar occurrence <code>{item.target.eventId}</code></div>
      <div>Series <code>{item.target.seriesId}</code> · Operation <code>{item.operationId}</code></div>
      {item.cleanupStatus&&<small>Incident cleanup: {item.cleanupStatus} · preserved evidence: {item.retainedEvidenceCount??0}</small>}
    </li>)}</ul>:<p>No completed retirement receipts are recorded for this profile.</p>)}
  </section>;
}

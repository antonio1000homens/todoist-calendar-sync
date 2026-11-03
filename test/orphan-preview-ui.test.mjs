import test from "node:test";
import assert from "node:assert/strict";
import {orphanItemsForCase} from "../review-ui/orphan-selection.mjs";
import {previewCandidate,previewBelongsToCase,orphanCaseEvidenceVersion}
  from "../review-ui/orphan-preview-state.mjs";

const item=()=>({id:"case-287",profile:"home",status:"open",updatedAt:"2026-11-03T19:30:00.000Z",
  taskId:"task-287",eventId:"event-287"});
const snapshots=()=>[
  {ref:{profile:"home",side:"todoist",id:"task-287"},
    object:{id:"task-287",content:"A task",is_completed:false,is_deleted:false},checkedAt:"2026-11-03T19:30:00.000Z"},
  {ref:{profile:"home",side:"calendar",id:"event-287"},
    object:{id:"event-287",summary:"A calendar event",status:"confirmed",etag:"etag1"},checkedAt:"2026-11-03T19:30:00.000Z"},
  {ref:{profile:"work",side:"todoist",id:"foreign"},
    object:{id:"foreign",content:"Foreign item",is_completed:false,is_deleted:false}},
];
const previews=(it=item(),snaps=snapshots())=>orphanItemsForCase({item:it,snapshots:snaps});
const result=(c,it=item(),now=Date.now())=>({
  previewId:"preview-uuid",confirmationId:"nonce-uuid",caseId:it.id,profile:it.profile,
  caseUpdatedAt:it.updatedAt,side:c.side,targetId:c.id,
  expiresAt:new Date(now+180_000).toISOString(),
  executionQueued:false,stateCleanupPlanned:false,
});
test("only exact case-recorded live objects can request a read-only safety preview",()=>{
  const candidates=previews();
  assert.equal(candidates.length,2);
  for(const candidate of candidates) {
    assert.equal(candidate.eligible,false,"browser candidate never grants deletion");
    assert.equal(previewCandidate(candidates,item(),candidate.key)?.id,candidate.id);
  }
  assert.equal(previewCandidate(candidates,item(),"work:todoist:foreign"),undefined);
  assert.equal(previewCandidate(candidates,{...item(),status:"dismissed"},candidates[0].key),undefined);
  assert.equal(previewCandidate(candidates,{...item(),profile:"work"},candidates[0].key),undefined);
  assert.equal(previewCandidate(candidates,item(),"home:calendar:unrelated"),undefined);
});
test("missing, stale and inactive selected identities cannot obtain a preview request",()=>{
  const sn=snapshots();
  sn[0]={...sn[0],object:null};
  sn[1]={...sn[1],object:{...sn[1].object,status:"cancelled"}};
  const candidates=previews(item(),sn);
  assert.ok(candidates.every(c=>!c.live));
  assert.ok(candidates.every(c=>!previewCandidate(candidates,item(),c.key)));
});
test("server safety preview must match case version, exact side/id, expiry and no dispatch",()=>{
  const c=previews()[0];
  const now=Date.now();
  const value=result(c,item(),now);
  assert.equal(previewBelongsToCase(value,item(),c,now),true);
  for(const bad of [
    {caseId:"other-case"},{profile:"work"},{side:c.side==="todoist"?"calendar":"todoist"},
    {targetId:"another-id"},{caseUpdatedAt:"stale"},{executionQueued:true},
    {stateCleanupPlanned:true},{previewId:""},{confirmationId:""},
    {expiresAt:new Date(now-1).toISOString()},{expiresAt:"not a timestamp"},
    {expiresAt:new Date(now+60*60_000).toISOString()},
  ])assert.equal(previewBelongsToCase({...value,...bad},item(),c,now),false,
    "reject mismatched server fields "+JSON.stringify(bad));
  assert.equal(previewBelongsToCase(value,{...item(),status:"resolved"},c,now),false);
  assert.equal(previewBelongsToCase(value,item(),c,now+181_000),false,"expiry invalidates display");
});
test("refreshing case evidence invalidates the in-flight preview readback version",()=>{
  const current=item(),snaps=snapshots();
  const before=orphanCaseEvidenceVersion(current,snaps);
  assert.notEqual(before,orphanCaseEvidenceVersion({...current,updatedAt:"later"},snaps));
  assert.notEqual(before,orphanCaseEvidenceVersion(current,snaps.map((s,i)=>i===1?
    {...s,checkedAt:"later"}:s)));
  assert.notEqual(before,orphanCaseEvidenceVersion(current,snaps.map((s,i)=>i===0?
    {...s,lookupError:"Provider 429"}:s)));
});

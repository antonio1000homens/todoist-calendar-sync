import test from "node:test";
import assert from "node:assert/strict";
import {evaluateOrphanPostflight} from "../dist/orphan-postflight.js";

const stamp="2026-11-03T20:00:00.000Z";
function operation(side="todoist") {
  return {id:"orphan-op",caseId:"alert-287",profile:"home",caseUpdatedAt:stamp,
    side,targetId:side==="todoist"?"task-orphan":"event-orphan",
    providerDigest:"a".repeat(64),...(side==="calendar"?{providerEtag:"etag-1"}:{}),
    actorSubject:"operator",confirmedAt:stamp,confirmationExpiresAt:stamp,
    phase:"provider_absent",version:3,createdAt:stamp,updatedAt:stamp};
}
function inventory(side="todoist") {
  const op=operation(side);
  return {item:{id:op.caseId,profile:op.profile,status:"open",
      title:"Orphan",reason:"unmapped",createdAt:stamp,updatedAt:stamp,
      ...(side==="todoist"?{taskId:op.targetId}:{eventId:op.targetId}),
      sourceAuditKey:"AUDIT#home#alert-source"},
    target:null,counterparts:[],
    providers:["home","antonio","work"].map(profile=>({
      profile,tasks:[],events:[],comments:[],
    })),
    stateRows:[
      {pk:"REVIEW_CASE#alert-287",sk:"STATE",taskId:"task-orphan",eventId:"event-orphan"},
      {pk:"ORPHAN_DELETE#orphan-op",sk:"STATE",caseId:"alert-287",profile:"home",
        side,targetId:op.targetId},
      {pk:"ORPHAN_CASE_LOCK#alert-287",sk:"STATE",operationId:"orphan-op",
        profile:"home",targetId:op.targetId},
      {pk:"AUDIT#home#alert-source",sk:"STATE",taskId:"task-orphan",eventId:"event-orphan"},
    ]};
}
function assess(side="todoist",change=()=>{}) {
  const op=operation(side),data=inventory(side);
  change(data,op);
  return evaluateOrphanPostflight(op,data,stamp);
}
test("read-only postflight accepts exact absent Todoist or Calendar with only owned evidence",()=>{
  for(const side of ["todoist","calendar"]){
    const result=assess(side);
    assert.equal(result.verified,true,JSON.stringify(result.blockers));
    assert.equal(result.operationId,"orphan-op");
  }
});
test("direct missing readback cannot hide live target after reconciliation",()=>{
  for(const side of ["todoist","calendar"]){
    const result=assess(side,(data,op)=>{
      if(side==="todoist")data.providers[1].tasks.push({id:op.targetId,is_deleted:false,is_completed:false});
      else data.providers[2].events.push({id:op.targetId,status:"confirmed"});
    });
    assert.equal(result.verified,false);
    assert.match(result.blockers.join(" "),/reappeared/);
  }
});
test("direct target lookup and recorded opposite-side readbacks must be explicit",()=>{
  const live=assess("todoist",(data,op)=>{
    data.target={side:"todoist",item:{id:op.targetId,is_deleted:false}};
  });
  assert.equal(live.verified,false);
  assert.match(live.blockers.join(" "),/direct readback/);
  const oppositeMissing=assess("calendar",data=>{
    data.item.taskId="old-todoist-id";
  });
  assert.equal(oppositeMissing.verified,false);
  assert.match(oppositeMissing.blockers.join(" "),/counterpart direct readback/);
  const oppositeFoundElsewhere=assess("calendar",data=>{
    data.item.taskId="old-todoist-id";
    data.counterparts=[{side:"todoist",id:"old-todoist-id",object:null}];
    data.providers[2].tasks.push({id:"old-todoist-id",is_deleted:false});
  });
  assert.equal(oppositeFoundElsewhere.verified,false);
  assert.match(oppositeFoundElsewhere.blockers.join(" "),/counterpart remains present/);
});
test("attributable evidence stays, but mapping, baseline and foreign audit refs block",()=>{
  const data=assess("todoist",info=>{
    info.stateRows.push(
      {pk:"TASK#home#task-orphan",sk:"MAP",taskId:"task-orphan",eventId:"missing-calendar"},
      {pk:"BASELINE#home#TASK#task-orphan",sk:"RECONCILE",taskId:"task-orphan"},
      {pk:"AUDIT#home#unrelated",sk:"STATE",taskId:"task-orphan"},
    );
  });
  assert.equal(data.verified,false);
  assert.equal(data.blockers.filter(x=>x.includes("Dangling")).length,3);
});
test("foreign operator, wrong lock, state duplication and lost cases fail closed",()=>{
  const wrongLock=assess("calendar",data=>{
    data.stateRows[2].operationId="someone-else";
  });
  assert.equal(wrongLock.verified,false);
  const preview=assess("todoist",data=>{
    data.stateRows.push({pk:"ORPHAN_PREVIEW#other",sk:"STATE",
      caseId:"alert-287",profile:"home",side:"todoist",targetId:"task-orphan",
      actorSubject:"foreign-operator"});
  });
  assert.equal(preview.verified,false);
  const duplicate=assess("todoist",data=>{
    data.stateRows.push({...data.stateRows[0]});
  });
  assert.equal(duplicate.verified,false);
  const wrongCase=assess("todoist",data=>{
    data.item.updatedAt="different";
  });
  assert.equal(wrongCase.verified,false);
});
test("partial inventory, stale phase and unknown provider object status are blocked",()=>{
  const partial=assess("todoist",data=>{data.providers.pop();});
  assert.equal(partial.verified,false);
  const malformed=assess("todoist",data=>{data.stateRows.push({sk:"STATE"});});
  assert.equal(malformed.verified,false);
  const premature=assess("todoist",(data,op)=>{op.phase="confirmed";});
  assert.equal(premature.verified,false);
  const ambiguous=assess("calendar",(data,op)=>{
    data.providers[0].events.push({id:op.targetId});
  });
  assert.equal(ambiguous.verified,false);
  const cancelled=assess("calendar",(data,op)=>{
    data.providers[0].events.push({id:op.targetId,status:"cancelled"});
  });
  assert.equal(cancelled.verified,true);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  ORPHAN_REQUIRED_CHECKS, OrphanSafetyError, DynamoOrphanJournal,
  validateOrphanConfirmation, advanceGuardedOrphanDeletion,
} from "../dist/orphan-deletion-executor.js";
import { reviewHash } from "../dist/review-store.js";

const now=()=>new Date().toISOString();
const upcoming=()=>new Date(Date.now()+180_000).toISOString();
const todoist={id:"task-1",content:"One-off task",project_id:"project-home",
  is_deleted:false,is_completed:false,due:{is_recurring:false},updated_at:"2026-11-03T19:00:00Z"};
const calendar={id:"event-1",summary:"One-off Calendar",status:"confirmed",etag:"etag-1",
  start:{date:"2026-11-10"},end:{date:"2026-11-11"}};
const makeOperation=(side="calendar")=>{
  const target=side==="calendar"?calendar:todoist;
  return {id:"orphan-op-287",caseId:"case-287",profile:"home",caseUpdatedAt:"2026-11-03T19:00:00Z",
    side,targetId:target.id,providerDigest:reviewHash(target),
    ...(side==="calendar"?{providerEtag:calendar.etag}:{}),
    actorSubject:"access-user-123",confirmedAt:now(),confirmationExpiresAt:upcoming(),
    phase:"confirmed",version:0,createdAt:now(),updatedAt:now()};
};
class MemoryJournal {
  constructor(operation){this.operation={...operation};this.visits=[];}
  async get(id){return id===this.operation.id?{...this.operation}:undefined;}
  async create(op){if(this.operation)throw Error("already exists");this.operation={...op};}
  async advance(operation,to,checkpoint){
    assert.equal(operation.version,this.operation.version,"journal CAS version");
    assert.equal(operation.phase,this.operation.phase,"journal CAS phase");
    this.operation={...operation,phase:to,version:operation.version+1,lastCheckpoint:checkpoint,updatedAt:now()};
    this.visits.push(to);
    return {...this.operation};
  }
  async requireReview(op,reason){
    assert.equal(op.version,this.operation.version);
    this.operation={...op,phase:"needs_review",lastError:reason,version:op.version+1};
    return {...this.operation};
  }
}
function fixture(side="calendar") {
  const operation=makeOperation(side), journal=new MemoryJournal(operation);
  const calls={fence:0,proof:0,barrier:0,todoist:0,calendar:0,cleanup:0,postflight:0,resume:0,
    twoPasses:0,retire:0,read:0};
  const state={target:side==="calendar"?{side,item:{...calendar}}:{side,item:{...todoist}},
    fenced:false,workersPaused:false,barrier:false,passes:2,replayed:true,
    proofBlocked:false,cleanupFailed:false,postflightFailed:false};
  const verifyProof=async()=>{
    calls.proof++;
    const checks=Object.fromEntries(ORPHAN_REQUIRED_CHECKS.map(check=>[check,!state.proofBlocked]));
    return {caseId:operation.caseId,profile:operation.profile,caseUpdatedAt:operation.caseUpdatedAt,
      side,targetId:operation.targetId,checkedAt:now(),checks,
      blockers:[],providerDigest:operation.providerDigest,providerEtag:operation.providerEtag};
  };
  const adapters={
    verifyProof,
    async establishQuiescence(){calls.fence++;state.fenced=true;state.workersPaused=true;},
    async assertQuiescent(){if(!state.fenced||!state.workersPaused)throw new OrphanSafetyError("not fenced");},
    async installReplayBarrier(){calls.barrier++;state.barrier=true;},
    async assertReplayBarrier(){if(!state.barrier)throw new OrphanSafetyError("replay barrier missing");},
    async readTarget(){calls.read++;return state.target?{side:state.target.side,item:{...state.target.item}}:null;},
    async deleteTodoist(id){calls.todoist++;assert.equal(side,"todoist");assert.equal(id,todoist.id);state.target=null;},
    async deleteCalendar(id,etag){calls.calendar++;assert.equal(side,"calendar");assert.equal(id,calendar.id);
      assert.equal(etag,calendar.etag);state.target=null;},
    async cleanupOwnedState(){calls.cleanup++;if(state.cleanupFailed)throw new Error("conditional state cleanup conflict");},
    async verifyPostflight(){calls.postflight++;
      if(state.postflightFailed||state.target)throw new Error("postflight failed");},
    async resumeWorkersWithBarrier(){calls.resume++;assert.ok(state.barrier);state.workersPaused=false;state.fenced=false;},
    async verifyTwoPassesAndReplay(){calls.twoPasses++;
      if(state.passes<2||!state.replayed)throw new OrphanSafetyError("two full generations and replay not verified");},
    async retireCaseAsOrphanRemoved(){calls.retire++;},
  };
  return {operation,journal,calls,state,adapters};
}
async function advanceOne(f){return advanceGuardedOrphanDeletion(f.operation.id,f.journal,f.adapters);}
const withExecution=async(t,fn)=>{
  const before=[process.env.ORPHAN_DELETION_EXECUTION_ENABLED,process.env.ERASURE_PROTOCOL_VERSION];
  Object.assign(process.env,{ORPHAN_DELETION_EXECUTION_ENABLED:"true",ERASURE_PROTOCOL_VERSION:"1"});
  t.after(()=>{
    for(const [index,name] of ["ORPHAN_DELETION_EXECUTION_ENABLED","ERASURE_PROTOCOL_VERSION"].entries())
      if(before[index]===undefined)delete process.env[name];else process.env[name]=before[index];
  });
  return fn();
};

test("deployment defaults deny every provider write and even worker fencing",async(t)=>{
  const f=fixture();
  const old=process.env.ORPHAN_DELETION_EXECUTION_ENABLED;
  delete process.env.ORPHAN_DELETION_EXECUTION_ENABLED;
  t.after(()=>{if(old!==undefined)process.env.ORPHAN_DELETION_EXECUTION_ENABLED=old;});
  await assert.rejects(advanceOne(f),/disabled/);
  assert.deepEqual(f.calls.calendar,0);
  assert.deepEqual(f.calls.fence,0);
});

test("Calendar singleton: durable delete intent, conditional cleanup, postflight, two passes and replay",async(t)=>withExecution(t,async()=>{
  const f=fixture("calendar");
  const phases=[];
  for(let i=0;i<7;i++)phases.push((await advanceOne(f)).phase);
  assert.deepEqual(phases,["fenced","delete_started","provider_absent","state_cleaned","workers_resume_started","observing","succeeded"]);
  assert.equal(f.calls.calendar,1);
  assert.equal(f.calls.todoist,0,"no implicit Todoist deletion");
  assert.equal(f.calls.retire,1);
  assert.equal(f.calls.twoPasses,1);
  assert.ok(f.calls.postflight>=2);
  assert.equal((await advanceOne(f)).phase,"succeeded");
  assert.equal(f.calls.calendar,1,"terminal queue retries are no-ops");
}));

test("Todoist singleton: delete only Todoist; preserve Calendar provider",async(t)=>withExecution(t,async()=>{
  const f=fixture("todoist");
  for(let i=0;i<7;i++)await advanceOne(f);
  assert.equal(f.calls.todoist,1);
  assert.equal(f.calls.calendar,0);
  assert.equal(f.journal.operation.phase,"succeeded");
}));

test("rejected proof prevents a fence and linked-pair cascading",async(t)=>withExecution(t,async()=>{
  const f=fixture("todoist");f.state.proofBlocked=true;
  await assert.rejects(advanceOne(f),/proof is incomplete/);
  assert.equal(f.calls.fence,0);
  assert.equal(f.calls.todoist,0);
  assert.equal(f.journal.operation.phase,"confirmed");
}));

test("fresh case/target digest drift after fence never makes a provider request",async(t)=>withExecution(t,async()=>{
  const f=fixture("calendar");
  await advanceOne(f);
  f.state.target.item.summary="Externally modified";
  await assert.rejects(advanceOne(f),/disappeared, changed/);
  assert.equal(f.calls.calendar,0);
  assert.equal(f.journal.operation.phase,"fenced");
  assert.equal(f.state.fenced,true,"retain fence for recovery");
}));

test("a failed fence check does not install a replay barrier or write a delete checkpoint",async(t)=>withExecution(t,async()=>{
  const f=fixture("todoist");
  await advanceOne(f);
  f.state.fenced=false;
  await assert.rejects(advanceOne(f),/not fenced/);
  assert.equal(f.calls.barrier,0);
  assert.equal(f.journal.operation.phase,"fenced");
}));

test("retry after ambiguous response to a successful Calendar delete never repeats DELETE",async(t)=>withExecution(t,async()=>{
  const f=fixture("calendar");
  await advanceOne(f);await advanceOne(f);
  const orig=f.adapters.deleteCalendar;
  f.adapters.deleteCalendar=async(...args)=>{await orig(...args);throw new Error("transport timeout after provider success");};
  await assert.rejects(advanceOne(f),/transport timeout/);
  assert.equal(f.journal.operation.phase,"delete_started");
  assert.equal(f.calls.calendar,1);
  assert.equal((await advanceOne(f)).phase,"provider_absent");
  assert.equal(f.calls.calendar,1,"direct readback skips a duplicate destructive request");
}));

test("conditional cleanup failure retains deletion evidence, fence and replay barrier",async(t)=>withExecution(t,async()=>{
  const f=fixture();
  for(let i=0;i<3;i++)await advanceOne(f);
  f.state.cleanupFailed=true;
  await assert.rejects(advanceOne(f),/cleanup conflict/);
  assert.equal(f.journal.operation.phase,"provider_absent");
  assert.equal(f.state.fenced,true);
  assert.equal(f.state.barrier,true);
  assert.equal(f.calls.retire,0);
  f.state.cleanupFailed=false;
  assert.equal((await advanceOne(f)).phase,"state_cleaned");
}));

test("no premature orphan_removed if fewer than two full reconciliation passes or replay missing",async(t)=>withExecution(t,async()=>{
  const f=fixture();
  for(let i=0;i<6;i++)await advanceOne(f);
  f.state.passes=1;
  await assert.rejects(advanceOne(f),/two full generations/);
  assert.equal(f.journal.operation.phase,"observing");
  assert.equal(f.calls.retire,0);
  f.state.passes=2;f.state.replayed=false;
  await assert.rejects(advanceOne(f),/two full generations/);
  f.state.replayed=true;
  assert.equal((await advanceOne(f)).phase,"succeeded");
  assert.equal(f.calls.retire,1);
}));

test("lost journal acknowledgement after workers resume is retryable without assuming the fence remains",async(t)=>withExecution(t,async()=>{
  const f=fixture();
  for(let i=0;i<5;i++)await advanceOne(f);
  assert.equal(f.journal.operation.phase,"workers_resume_started");
  const firstAdvance=f.journal.advance.bind(f.journal);
  let loseAck=true;
  f.journal.advance=async(op,to,checkpoint)=>{
    if(to==="observing"&&loseAck){loseAck=false;throw new Error("DynamoDB update timed out");}
    return firstAdvance(op,to,checkpoint);
  };
  await assert.rejects(advanceOne(f),/timed out/);
  assert.equal(f.state.fenced,false);
  assert.equal(f.journal.operation.phase,"workers_resume_started");
  assert.equal((await advanceOne(f)).phase,"observing");
  assert.equal(f.calls.calendar,1);
  assert.equal(f.calls.todoist,0);
}));

test("full exact-ID typed confirmation and <=5-minute approval window",()=>{
  const op=makeOperation("calendar");
  validateOrphanConfirmation({operation:op,actorSubject:op.actorSubject,exactId:op.targetId,phrase:"PERMANENTLY ERASE"});
  for(const partial of [
    {actorSubject:"foreign-user"},
    {exactId:"a different event"},
    {phrase:"ERASE"},
    {operation:{...op,confirmationExpiresAt:new Date(Date.now()-1).toISOString()}},
  ])assert.throws(()=>validateOrphanConfirmation({
    operation:op,actorSubject:op.actorSubject,exactId:op.targetId,phrase:"PERMANENTLY ERASE",...partial,
  }),/confirmation/);
});

test("DynamoDB journal enforces immutable identity and phase/version conditional writes",async()=>{
  const writes=[];
  const db={send:async command=>{writes.push(command);return {};}};
  const journal=new DynamoOrphanJournal(db);
  const operation=makeOperation("calendar");
  await journal.create(operation);
  assert.match(writes[0].input.ConditionExpression,/attribute_not_exists/);
  const after=await journal.advance(operation,"fenced","fence verified");
  assert.equal(after.version,1);
  assert.equal(after.phase,"fenced");
  assert.match(writes[1].input.ConditionExpression,/#version = :oldVersion/);
  assert.match(writes[1].input.ConditionExpression,/#target = :target/);
  assert.equal(writes[1].input.ExpressionAttributeValues[":oldVersion"],0);
  await assert.rejects(journal.advance(operation,"succeeded","skipped"),/Invalid guarded orphan transition/);
  const review=await journal.requireReview(after,"state conflict");
  assert.equal(review.phase,"needs_review");
  assert.equal(writes[2].input.ExpressionAttributeValues[":error"],"state conflict");
});

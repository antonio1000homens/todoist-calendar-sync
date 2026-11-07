import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateCancelledMappingRecovery, recoveryPolicyForTask, recoverySourceFingerprint,
  recoveryReceiptMatchesTask, recoveryCounterpartEventId, validateCancelledProviderVersions,
} from "../dist/cancelled-mapping-recovery-policy.js";

const profile="home", revision="2026-11-07T17:00:00Z";
const task={id:"t-378",project_id:"p-home",content:"Updated meeting",
  description:"New details",updated_at:revision,is_deleted:false,is_completed:false,
  due:{date:"2026-11-13",is_recurring:false,string:"2026-11-13"}};
const mapping={profile,taskId:task.id,eventId:"old-378",updatedAt:"2026-10-31T10:00:00Z"};
const original={...task,content:"Original",description:"Old details",
  updated_at:"2026-10-21T09:00:00Z"};
const reviewCase={id:"case-378",profile,status:"dismissed",operationId:"repair-378",
  updatedAt:"2026-11-01T10:00:00Z"};
const operation={
  id:"repair-378",status:"failed",attempt:1,updatedAt:"2026-11-01T12:00:00Z",
  steps:{validated:{status:"done"}},creations:{},preview:{
    intent:{profile,caseId:reviewCase.id,eventId:mapping.eventId,taskId:task.id},
    case:{id:reviewCase.id},snapshots:[
      {ref:{profile,side:"calendar",id:mapping.eventId},
        object:{id:mapping.eventId,status:"confirmed"}},
      {ref:{profile,side:"todoist",id:task.id},object:original},
    ],
  },
};

test("typed policy eligibility carries exact refs, no-write proof, case and actions",()=>{
  const eligible=evaluateCancelledMappingRecovery(profile,task,mapping,operation,reviewCase);
  assert.equal(eligible.reason,"ELIGIBLE");
  assert.equal(eligible.policy,"standalone");
  assert.equal(eligible.caseOwned,true);
  assert.equal(eligible.noWriteProof,true);
  assert.deepEqual(eligible.taskRef,{profile,side:"todoist",id:task.id});
  assert.deepEqual(eligible.calendarRefs,[{profile,side:"calendar",id:mapping.eventId}]);
  assert.deepEqual(eligible.actions,[
    "retire_old_mapping","release_exact_repair","project_new_calendar","verify_ack",
  ]);
  assert.equal(eligible.sourceVersion,revision);
});

test("source intent families are explicit and unsupported cadence fails closed",()=>{
  const check=due=>recoveryPolicyForTask({...task,due});
  assert.equal(check({date:"2026-11-13",is_recurring:false}),"standalone");
  assert.equal(check({date:"2026-11-13",is_recurring:true,string:"every week"}),"weekly");
  assert.equal(check({date:"2026-11-13",is_recurring:true,string:"every month"}),"monthly");
  assert.equal(check({date:"2026-11-13",is_recurring:true,string:"every year"}),"yearly");
  assert.equal(check({date:"2026-11-13",is_recurring:true,string:"every! month"}),undefined);
  assert.equal(check({date:"2026-11-13",is_recurring:true,string:"every day"}),undefined);
});

test("no-write, case, source and mapping denial codes are stable",()=>{
  const assess=(t=task,m=mapping,o=operation,rc=reviewCase)=>
    evaluateCancelledMappingRecovery(profile,t,m,o,rc).reason;
  assert.equal(assess({...task,updated_at:"2026-10-31T09:00:00Z"}),"STALE_SOURCE_VERSION");
  assert.equal(assess({...task,content:original.content,description:original.description}),
    "SOURCE_UNCHANGED");
  assert.equal(assess({...task,is_completed:true}),"UNSUPPORTED_SOURCE");
  assert.equal(assess({...task,project_id:""}),"UNSUPPORTED_SOURCE");
  assert.equal(assess(task,{...mapping,recurrenceOwner:"calendar"}),"FOREIGN_OR_RECURRING_MAPPING");
  assert.equal(assess(task,mapping,{...operation,writeStarted:true}),"REPAIR_WRITE_EVIDENCE");
  assert.equal(assess(task,mapping,{...operation,steps:{validated:{status:"done"},provider:{status:"running"}}}),
    "REPAIR_WRITE_EVIDENCE");
  assert.equal(assess(task,mapping,operation,{...reviewCase,status:"open"}),"REPAIR_NOT_DISMISSED");
  assert.equal(assess(task,mapping,{...operation,preview:{...operation.preview,
    snapshots:[operation.preview.snapshots[1]]}}),"AMBIGUOUS_REPAIR_SNAPSHOT");
  assert.equal(assess(task,mapping,{...operation,preview:{...operation.preview,
    intent:{...operation.preview.intent,taskId:"foreign"}}}),"REPAIR_IDENTITY_MISMATCH");
});

test("newer Todoist version must outrank real cancelled provider revision",()=>{
  const deleted=(updated)=>({id:"old-378",status:"cancelled",updated});
  assert.equal(validateCancelledProviderVersions(task,"standalone",[
    deleted("2026-11-06T12:00:00Z")]).ok,true);
  assert.deepEqual(validateCancelledProviderVersions(task,"yearly",[deleted(undefined)]),
    {ok:false,reason:"CANCELLED_PROVIDER_VERSION_UNVERIFIED"});
  assert.deepEqual(validateCancelledProviderVersions(task,"monthly",[
    deleted("2026-11-07T18:00:00Z")]),{ok:false,reason:"CANCELLED_PROVIDER_NEWER"});
  assert.deepEqual(validateCancelledProviderVersions(task,"weekly",[
    deleted("2026-11-06T12:00:00Z"),deleted(undefined)]),
    {ok:false,reason:"CANCELLED_PROVIDER_VERSION_UNVERIFIED"});
  assert.deepEqual(validateCancelledProviderVersions(task,"standalone",[
    {...deleted("2026-11-06T12:00:00Z"),status:"confirmed"}]),
    {ok:false,reason:"PROVIDER_GUARD_BLOCKED"});
});

test("deterministic candidate and source fingerprint reject changed source or different operation",()=>{
  const id=recoveryCounterpartEventId(profile,task.id,mapping.eventId,revision);
  assert.match(id,/^[a-f0-9]{48}$/);
  assert.equal(id,recoveryCounterpartEventId(profile,task.id,mapping.eventId,revision));
  assert.notEqual(id,recoveryCounterpartEventId(profile,task.id,mapping.eventId,"2026-11-08T17:00:00Z"));
  assert.notEqual(id,recoveryCounterpartEventId("work",task.id,mapping.eventId,revision));
  const receipt={
    sourcePolicy:"standalone",sourceUpdatedAt:revision,sourceDueDate:task.due.date,
    sourceFingerprint:recoverySourceFingerprint(task),oldEventId:mapping.eventId,candidateEventId:id,
  };
  assert.equal(recoveryReceiptMatchesTask(receipt,task),true);
  assert.equal(recoveryReceiptMatchesTask(receipt,{...task,updated_at:"2026-11-08T17:00:00Z"}),false);
  assert.equal(recoveryReceiptMatchesTask(receipt,{...task,description:"changed"}),false);
  assert.equal(recoveryReceiptMatchesTask(receipt,{...task,project_id:"other-project"}),false);
  assert.equal(recoveryReceiptMatchesTask(receipt,{...task,due:{...task.due,date:"2026-11-14"}}),false);
});

test("legacy annual pending receipt still works without new fingerprint",()=>{
  const annual={...task,due:{date:"2027-08-16",is_recurring:true,string:"every year"}};
  assert.equal(recoveryReceiptMatchesTask({sourceDueDate:"2027-08-16",sourceUpdatedAt:revision,
    oldEventId:mapping.eventId},annual),true);
  assert.equal(recoveryReceiptMatchesTask({sourceDueDate:"2027-08-16",sourceUpdatedAt:revision,
    oldEventId:mapping.eventId},{...annual,due:{...annual.due,date:"2027-08-17"}}),false);
});

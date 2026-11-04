import assert from "node:assert/strict";
import test from "node:test";
import {generateKeyPairSync,sign} from "node:crypto";
import {observeCrossProfileErasureEvidence} from "../dist/erasure-cross-profile-evidence.js";
import {canonicalCalendarProvenanceJson,calendarProvenanceIsFresh,calendarRoutingFingerprint,
  verifyCalendarProvenance,CALENDAR_PROVENANCE_SOURCE} from "../dist/erasure-calendar-provenance.js";

const profiles=["home","antonio","work"];
const {privateKey,publicKey}=generateKeyPairSync("ed25519");
const trustPem=publicKey.export({format:"der",type:"spki"}).toString("base64");
const routing=Object.fromEntries(profiles.map(profile=>[profile,{
  calendarId:"calendar-"+profile,todoistProjectId:"project-"+profile}]));
const expected={accountId:"123456789012",region:"eu-west-2",
  functionName:"audit-function",qualifier:"42",routingFingerprint:calendarRoutingFingerprint(routing)};
const denied=(status=404)=>Object.assign(new Error("unavailable"),{status});
const event=(id,taskId,extra={})=>({id,status:"confirmed",etag:"etag-"+id,
  extendedProperties:{shared:{taskId}},...extra});

function signedCoverage(modify=()=>{}) {
  const now=Date.now();
  const payload={
    version:1,source:CALENDAR_PROVENANCE_SOURCE,evidenceSha256:"f".repeat(64),
    complete:true,observedAt:new Date(now).toISOString(),expiresAt:new Date(now+240_000).toISOString(),
    ...expected,
    profiles:Object.fromEntries(profiles.map(profile=>[profile,{
      configuredCalendarId:"calendar-"+profile,
      calendars:[{id:"calendar-"+profile,origin:"configured",direction:"both",accessRole:"reader"},
        ...(profile==="work"?[{id:"shared-work",origin:"shared",direction:"both",accessRole:"reader"}]:[])],
    }])),
  };
  modify(payload);
  return {...payload,signature:sign(null,Buffer.from(canonicalCalendarProvenanceJson(payload)),
    privateKey).toString("base64")};
}
const trusted=raw=>verifyCalendarProvenance(raw,trustPem,expected);
function readers(options={}) {
  const calls={inventory:[],direct:[],instances:[]};
  const workEvent=event("private-event","removed-task");
  const master=event("recurrence-master","removed-task",{recurrence:["RRULE:FREQ=DAILY"]});
  const cancelled=event("cancelled-instance","removed-task",
    {status:"cancelled",recurringEventId:"recurrence-master",originalStartTime:{date:"2026-11-04"}});
  const readerForProfile=async profile=>({
    calendar:{
      async listCalendarListForErasureAudit(){
        return [{id:"calendar-"+profile,configured:true,
          accessRole:profile==="home"&&options.roleConflict?"writer":"reader"},
        ...(profile==="home"&&options.unregisteredListed
          ?[{id:"unregistered-calendar",configured:false,accessRole:"reader"}]:[])];
      },
      async listAllEventsForErasureAudit(calendarId) {
        calls.inventory.push([profile,calendarId]);
        if(profile==="work"&&calendarId==="shared-work") {
          if(options.inaccessible)throw denied(403);
          return options.recurring?[master,cancelled]:options.eventPresent?[workEvent]:[];
        }
        return [];
      },
      async listLinkedEventsByTodoistTaskId(){return[];},
      async getEvent(id,calendarId) {
        calls.direct.push([profile,id,calendarId]);
        if(profile==="work"&&calendarId==="shared-work") {
          const original=options.recurring?(id==="recurrence-master"?master:cancelled):workEvent;
          if(id===original.id)return options.conflictingEtag?{...original,etag:"different-version"}:original;
        }
        throw denied();
      },
      async listEventInstances(id,calendarId) {
        calls.instances.push([profile,id,calendarId]);
        return options.recurring&&profile==="work"&&id===master.id&&calendarId==="shared-work"
          ?[cancelled]:[];
      },
    },
    todoist:{
      async getTask(){throw denied();},
      async listAllTasksForErasureAudit(){return[];},
      async listAllProjectCommentsForErasureAudit(){return {projects:[],comments:[],complete:true};},
      async listAllTaskCommentsForErasureAudit(){return {comments:[],fullSyncDateUtc:new Date().toISOString()};},
      async listTaskComments(){return[];},
    },
  });
  return {readerForProfile,calls};
}
async function inspect(options={},provenance=trusted(signedCoverage())) {
  const {readerForProfile,calls}=readers(options);
  const report=await observeCrossProfileErasureEvidence({
    taskId:"removed-task",...(options.eventId?{eventId:options.eventId}:{}),
    rows:[],fullRows:[],readerForProfile,calendarProvenance:provenance,
  });
  return {report,calls};
}

test("signed registry binds all three deployment profiles, their routes and independent evidence",()=>{
  const raw=signedCoverage(),verified=trusted(raw);
  assert.equal(verified.signatureVerified,true);
  assert.equal(calendarProvenanceIsFresh(verified),true);
  assert.match(verified.attestationFingerprint,/^[a-f0-9]{64}$/);
  assert.throws(()=>trusted({...raw,evidenceSha256:"0".repeat(64)}),/invalid/);
  assert.throws(()=>verifyCalendarProvenance(raw,trustPem,{...expected,qualifier:"43"}),/invalid/);
  assert.throws(()=>verifyCalendarProvenance(raw,"",expected),/invalid/);
  assert.throws(()=>trusted(signedCoverage(payload=>{payload.profiles.work.calendars=[];})),/invalid/);
  assert.throws(()=>trusted(signedCoverage(payload=>{payload.profiles.home.calendars[0].accessRole="unknown";})),/invalid/);
});

test("listed and direct-ID shared calendars are independently represented and inventoried",async()=>{
  const {report,calls}=await inspect();
  assert.equal(report.allAccessibleCalendarCoverageProven,true);
  assert.equal(report.knownIdentitiesAbsentFromCurrentProviders,true);
  assert.equal(report.eligibleForPostWriteRelease,false);
  assert.equal(report.profiles.work.calendarProvenanceComplete,true);
  assert.equal(report.profiles.work.calendarInventoryComplete,true);
  assert.equal(report.profiles.work.directIdCalendarCount,1);
  assert.ok(calls.inventory.some(([profile,id])=>profile==="work"&&id==="shared-work"));
  assert.ok(!report.missingProof.some(reason=>reason.includes("lacks a fresh independently signed")));
  for(const calendarId of ["calendar-home","calendar-antonio","calendar-work","shared-work"])
    assert.equal(JSON.stringify(report).includes(calendarId),false,"raw Calendar IDs must remain private");
});

test("untagged direct-ID events and cancelled recurring instances enter identity closure",async()=>{
  const standalone=await inspect({eventPresent:true,eventId:"private-event"});
  assert.equal(standalone.report.knownIdentitiesAbsentFromCurrentProviders,false);
  assert.ok(standalone.calls.direct.some(([profile,id,calendarId])=>
    profile==="work"&&id==="private-event"&&calendarId==="shared-work"));
  assert.ok(standalone.report.profiles.work.inventoryMatchedEvents>0);
  const recurring=await inspect({recurring:true,eventId:"recurrence-master"});
  assert.ok(recurring.calls.instances.some(([profile,id,calendarId])=>
    profile==="work"&&id==="recurrence-master"&&calendarId==="shared-work"));
  assert.ok(recurring.report.profiles.work.cancelledInventoryMatches>0);
  assert.ok(recurring.report.profiles.work.recurrenceInstances>0);
  assert.equal(recurring.report.eligibleForPostWriteRelease,false);
});

test("missing, stale and incomplete signed ACL scope never establishes coverage",async()=>{
  const noManifest=await inspect({},undefined);
  // Passing undefined uses the helper's default; call the observer directly for no manifest.
  const reader=readers().readerForProfile;
  const missing=await observeCrossProfileErasureEvidence({
    taskId:"removed-task",rows:[],fullRows:[],readerForProfile:reader,
  });
  assert.equal(missing.allAccessibleCalendarCoverageProven,false);
  assert.equal(missing.profiles.work.calendarProvenanceComplete,false);
  assert.ok(missing.missingProof.some(reason=>reason.includes("independently signed")));
  assert.equal(noManifest.report.allAccessibleCalendarCoverageProven,true);
  const stale=trusted(signedCoverage(payload=>{
    payload.observedAt=new Date(Date.now()-600_000).toISOString();
    payload.expiresAt=new Date(Date.now()-300_000).toISOString();
  }));
  const staleResult=await inspect({},stale);
  assert.equal(staleResult.report.profiles.work.calendarProvenanceFresh,false);
  assert.equal(staleResult.report.allAccessibleCalendarCoverageProven,false);
});

test("restricted ACL, missing registered calendar, unlisted calendar and role conflict fail closed",async()=>{
  const restricted=trusted(signedCoverage(payload=>{
    payload.profiles.work.calendars[1].accessRole="freeBusyReader";
  }));
  const limited=await inspect({},restricted);
  assert.equal(limited.report.allAccessibleCalendarCoverageProven,false);
  assert.equal(limited.report.profiles.work.restrictedCalendarCount,1);
  assert.equal(limited.report.profiles.work.calendarInventoryComplete,false);
  const unreachable=await inspect({inaccessible:true});
  assert.equal(unreachable.report.profiles.work.inaccessibleCalendarCount,1);
  assert.equal(unreachable.report.allAccessibleCalendarCoverageProven,false);
  const unknown=await inspect({unregisteredListed:true});
  assert.equal(unknown.report.profiles.home.unregisteredListedCalendarCount,1);
  assert.equal(unknown.report.allAccessibleCalendarCoverageProven,false);
  const conflict=await inspect({roleConflict:true});
  assert.equal(conflict.report.profiles.home.calendarRoleConflictCount,1);
  assert.equal(conflict.report.profiles.home.calendarProvenanceComplete,false);
  assert.ok(conflict.report.missingProof.some(reason=>reason.includes("ACL roles conflict")));
});

test("different ETags between complete inventory and direct read block coverage",async()=>{
  const {report}=await inspect({eventPresent:true,eventId:"private-event",conflictingEtag:true});
  assert.equal(report.profiles.work.eventReadConflicts,1);
  assert.equal(report.closureComplete,false);
  assert.equal(report.allAccessibleCalendarCoverageProven,false);
  assert.equal(report.knownIdentitiesAbsentFromCurrentProviders,false);
});

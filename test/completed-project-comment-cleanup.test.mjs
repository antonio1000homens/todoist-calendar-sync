import test from "node:test";
import assert from "node:assert/strict";
import { serializeMappingComment } from "../dist/mapping-comments.js";
import { retireCompletedProjectMappingComment } from "../dist/completed-project-comment-cleanup.js";

const completedAt = "2026-10-01T12:00:00Z";
const t0 = Date.parse(completedAt);
const week = 7*24*60*60*1000;
const target = {
  profile:"home",taskId:"completed-1",eventId:"historical-1",
  commentId:"mapping-comment-1",projectId:"project-home",
};
const marker = {profile:"home",taskId:target.taskId,eventId:target.eventId,completedAt};
const commentContent = (fields={}) => serializeMappingComment({
  profile:target.profile,projectId:target.projectId,taskId:target.taskId,eventId:target.eventId,
  updatedAt:completedAt,...fields,
},target.projectId);
const key = (pk,sk="STATE")=>pk+"|"+sk;

function scenario({content=commentContent(),commentProject=target.projectId,history=marker,taskAbsent=true}={}) {
  const rows=new Map();
  if(history)rows.set(key("COMPLETED_EVENT#home#historical-1"),history);
  const calls={reads:[],comments:0,deleted:[]};
  const providerComment={id:target.commentId,project_id:commentProject,content};
  const adapter={
    async get(pk,sk="STATE"){calls.reads.push(key(pk,sk));return rows.get(key(pk,sk));},
    async getComment(){calls.comments++;return structuredClone(providerComment);},
    async taskAbsent(){return taskAbsent;},
    async deleteComment(id){calls.deleted.push(id);},
  };
  return {rows,calls,providerComment,adapter};
}

test("one-off comment uses completedAt seven full 24-hour periods and stays dry-run by default",async()=>{
  const s=scenario();
  let r=await retireCompletedProjectMappingComment(target,s.adapter,{nowMs:t0+week-1,apply:true});
  assert.equal(r.status,"too_recent");
  assert.deepEqual(s.calls.deleted,[]);
  r=await retireCompletedProjectMappingComment(target,s.adapter,{nowMs:t0+week});
  assert.equal(r.status,"eligible");
  assert.deepEqual(s.calls.deleted,[]);
  r=await retireCompletedProjectMappingComment(target,s.adapter,{nowMs:t0+week,apply:true});
  assert.equal(r.status,"retired");
  assert.deepEqual(s.calls.deleted,[target.commentId]);
  assert.deepEqual(s.rows.get(key("COMPLETED_EVENT#home#historical-1")),marker);
  assert.equal(s.calls.comments,4,"apply re-fetches the comment before deletion");
});

test("all profiles are supported only with an exact scoped historical marker",async()=>{
  for(const profile of ["home","antonio","work"]){
    const t={...target,profile};
    const s=scenario({content:serializeMappingComment({...marker,profile,projectId:target.projectId,updatedAt:completedAt},target.projectId)});
    s.rows.clear();
    s.rows.set(key("COMPLETED_EVENT#"+profile+"#"+target.eventId),{...marker,profile});
    const r=await retireCompletedProjectMappingComment(t,s.adapter,{nowMs:t0+week+1});
    assert.equal(r.status,"eligible",profile);
  }
});

test("no event-side guard, malformed/human/foreign comment or missing project id must be skipped",async()=>{
  for(const opts of [
    {history:null},
    {content:"human note"},
    {content:commentContent({eventId:"wrong"})},
    {commentProject:null},
    {content:commentContent({profile:"work"})},
  ]){
    const s=scenario(opts);
    assert.equal((await retireCompletedProjectMappingComment(target,s.adapter,{nowMs:t0+week+1,apply:true})).status,"skipped_ambiguous");
    assert.deepEqual(s.calls.deleted,[]);
  }
});

test("cross-profile task owner, partial event mapping and task still available all block provider deletion",async()=>{
  for(const pk of ["TASKOWNER#completed-1","TASK#work#completed-1","EVENT#antonio#historical-1"]){
    const s=scenario();
    s.rows.set(key(pk,"MAP"),{taskId:target.taskId});
    const r=await retireCompletedProjectMappingComment(target,s.adapter,{nowMs:t0+week+1,apply:true});
    assert.equal(r.status,"skipped_active",pk);
    assert.deepEqual(s.calls.deleted,[]);
  }
  const s=scenario({taskAbsent:false});
  assert.equal((await retireCompletedProjectMappingComment(target,s.adapter,{nowMs:t0+week+1,apply:true})).status,"skipped_active");
  assert.deepEqual(s.calls.deleted,[]);
});

test("recurring history requires matched terminal certificate and no live recurrence in ANY profile",async()=>{
  const history={...marker,recurrenceOwner:"calendar",seriesId:"finite",masterEventId:"master"};
  const content=commentContent({recurrenceOwner:"calendar",seriesId:"finite",masterEventId:"master"});
  const s=scenario({history,content});
  const certificate={profile:"home",seriesId:"finite",recurrenceOwner:"calendar",
    masterEventId:"master",terminalCompletedAt:completedAt};
  const nowMs=t0+week+1;
  assert.equal((await retireCompletedProjectMappingComment(target,s.adapter,{nowMs})).status,"skipped_ambiguous");
  s.rows.set(key("COMPLETED_SERIES#home#finite"),certificate);
  assert.equal((await retireCompletedProjectMappingComment(target,s.adapter,{nowMs})).status,"eligible");
  s.rows.set(key("RECURRENCE#work#finite"),{taskId:"different-task"});
  assert.equal((await retireCompletedProjectMappingComment(target,s.adapter,{nowMs,apply:true})).status,"skipped_active");
  assert.deepEqual(s.calls.deleted,[]);
  s.rows.delete(key("RECURRENCE#work#finite"));
  s.rows.set(key("COMPLETED_SERIES#home#finite"),{...certificate,masterEventId:"other"});
  assert.equal((await retireCompletedProjectMappingComment(target,s.adapter,{nowMs})).status,"skipped_ambiguous");
});

test("an owner or comment change between the first and second preflight aborts the provider delete",async()=>{
  const s=scenario();
  const get=s.adapter.get;
  let rounds=0;
  s.adapter.get=async(pk,sk)=>{
    if(pk==="COMPLETED_EVENT#home#historical-1" && ++rounds===2){
      s.rows.set(key("TASKOWNER#completed-1","MAP"),{taskId:"completed-1"});
    }
    return get(pk,sk);
  };
  const r=await retireCompletedProjectMappingComment(target,s.adapter,{nowMs:t0+week+1,apply:true});
  assert.equal(r.status,"skipped_active");
  assert.deepEqual(s.calls.deleted,[]);
  const second=scenario();
  const read=second.adapter.getComment;
  second.adapter.getComment=async(id)=>{
    const value=await read(id);
    if(second.calls.comments===2)return {...value,content:commentContent({taskId:"reassigned"})};
    return value;
  };
  assert.equal((await retireCompletedProjectMappingComment(target,second.adapter,{nowMs:t0+week+1,apply:true})).status,"skipped_ambiguous");
  assert.deepEqual(second.calls.deleted,[]);
});

test("provider read failures abort rather than pretending the Todoist task is absent",async()=>{
  const s=scenario();
  s.adapter.taskAbsent=async()=>{throw new Error("Todoist API unavailable");};
  await assert.rejects(retireCompletedProjectMappingComment(target,s.adapter,{nowMs:t0+week+1,apply:true}),/Todoist API unavailable/);
  assert.deepEqual(s.calls.deleted,[]);
});

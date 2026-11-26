import assert from "node:assert/strict";
import test from "node:test";
import { Todoist } from "../dist/providers.js";

test("Todoist completion rereads the exact task and issues one idempotent close command",async()=>{
  const originalFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init={})=>{
    calls.push({url,init});
    if(url.endsWith("/tasks/task-1"))return Response.json({id:"task-1",content:"Disposable recurrence",is_completed:false,
      due:{date:"2099-01-01",string:"every day",is_recurring:true}});
    if(url.endsWith("/sync")){
      const form=new URLSearchParams(init.body);
      const commands=JSON.parse(form.get("commands"));
      assert.equal(commands.length,1);
      assert.equal(commands[0].type,"item_close");
      assert.deepEqual(commands[0].args,{id:"task-1"});
      return Response.json({sync_status:{[commands[0].uuid]:"ok"}});
    }
    throw new Error(`Unexpected Todoist request: ${init.method||"GET"} ${url}`);
  };
  try{
    const todoist=new Todoist("test-token");
    assert.equal(await todoist.completeTask("task-1", "2099-01-01"), "completed");
    assert.equal(calls.length,2);
    assert.equal(calls[0].init.method||"GET","GET");
    assert.equal(calls[1].init.method,"POST");
  }finally{globalThis.fetch=originalFetch;}
});

test("Todoist completion does not advance an already completed task again",async()=>{
  const originalFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init={})=>{
    calls.push({url,init});
    return Response.json({id:"task-2",content:"Already done",is_completed:true,completed_at:"2099-01-01T10:00:00Z"});
  };
  try{
    const todoist=new Todoist("test-token");
    assert.equal(await todoist.completeTask("task-2", "2099-01-01"), "already_completed");
    assert.equal(calls.length,1,"the provider reread is enough to suppress a repeated completion");
  }finally{globalThis.fetch=originalFetch;}
});

test("Todoist project preflight requires the exact configured project identity",async()=>{
  const originalFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init={})=>{
    calls.push({url,init});
    return Response.json({id:"project-1",name:"antonio1000homens"});
  };
  try{
    const todoist=new Todoist("test-token");
    assert.deepEqual(await todoist.getProject("project-1"),{id:"project-1",name:"antonio1000homens"});
    assert.match(calls[0].url,/\/projects\/project-1$/);
    await assert.rejects(todoist.getProject("project-2"),/exact configured project/);
  }finally{globalThis.fetch=originalFetch;}
});

test("Todoist read retries honor a 429 retry_after hint within the configured maintenance budget",async t=>{
  const originalFetch=globalThis.fetch;
  t.after(()=>{globalThis.fetch=originalFetch;});
  let calls=0;
  globalThis.fetch=async()=>{
    calls++;
    if(calls===1)return Response.json({error:"Too many requests",error_extra:{retry_after:0}}, {status:429});
    return Response.json({results:[{id:"comment-1",content:"fixture"}],next_cursor:null});
  };
  const todoist=new Todoist("test-token",{readRetries:7,maxRetryDelayMs:10_000});
  const comments=await todoist.listProjectComments("project-1",true);
  assert.equal(calls,2);
  assert.equal(comments[0].id,"comment-1");
});

test("Todoist read retries stop at their configured bound when the provider remains rate limited",async t=>{
  const originalFetch=globalThis.fetch;
  t.after(()=>{globalThis.fetch=originalFetch;});
  let calls=0;
  globalThis.fetch=async()=>{
    calls++;
    return Response.json({error:"Too many requests",error_extra:{retry_after:0}}, {status:429});
  };
  const todoist=new Todoist("test-token",{readRetries:2,maxRetryDelayMs:10_000});
  await assert.rejects(()=>todoist.listProjectComments("project-1",true),{status:429});
  assert.equal(calls,3,"the initial request plus two configured retries");
});

test("Todoist maintenance retries explicitly rejected 429 comment writes only",async t=>{
  const originalFetch=globalThis.fetch;
  t.after(()=>{globalThis.fetch=originalFetch;});
  let calls=0;
  globalThis.fetch=async()=>{
    calls++;
    if(calls===1)return Response.json({error:"Too many requests",error_extra:{retry_after:0}}, {status:429});
    return Response.json({id:"comment-created",content:"sync mapping"});
  };
  const todoist=new Todoist("test-token",{rateLimitRetries:2,maxRetryDelayMs:10_000});
  const comment=await todoist.createProjectComment("project-1","sync mapping");
  assert.equal(calls,2);
  assert.equal(comment.id,"comment-created");

  calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json({error:"unavailable"},{status:503});};
  await assert.rejects(()=>todoist.createProjectComment("project-1","sync mapping"),{status:503});
  assert.equal(calls,1,"ambiguous write failures are never replayed");
});

test("Todoist maintenance requests are paced across concurrent callers",async t=>{
  const originalFetch=globalThis.fetch;
  t.after(()=>{globalThis.fetch=originalFetch;});
  const starts=[];
  globalThis.fetch=async url=>{
    starts.push(Date.now());
    return Response.json({id:String(url).split("/").at(-1)});
  };
  const todoist=new Todoist("test-token",{minRequestIntervalMs:25});
  await Promise.all([todoist.getTask("task-1"),todoist.getTask("task-2")]);
  assert.equal(starts.length,2);
  assert.ok(starts[1]-starts[0]>=20,"concurrent migration reads reserve distinct paced slots");
});

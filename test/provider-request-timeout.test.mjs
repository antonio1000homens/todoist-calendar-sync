import test from "node:test";
import assert from "node:assert/strict";
import { Todoist } from "../dist/providers.js";

test("provider reads abort on the configured request deadline without hidden retries",async t=>{
  const original=globalThis.fetch;
  t.after(()=>{globalThis.fetch=original;});
  let calls=0;
  globalThis.fetch=async(_url,init)=>{
    calls++;
    await new Promise((resolve,reject)=>{
      if(init.signal.aborted)return reject(init.signal.reason);
      init.signal.addEventListener("abort",()=>reject(init.signal.reason),{once:true});
    });
  };
  const todoist=new Todoist("test-token",{timeoutMs:10});
  await assert.rejects(todoist.getTask("task-123"),{name:"TimeoutError"});
  assert.equal(calls,1);
});

test("Todoist full-sync erasure inventory stops retrying after its request deadline",async t=>{
  const original=globalThis.fetch;
  t.after(()=>{globalThis.fetch=original;});
  let calls=0;
  globalThis.fetch=async(_url,init)=>{
    calls++;
    await new Promise((resolve,reject)=>{
      if(init.signal.aborted)return reject(init.signal.reason);
      init.signal.addEventListener("abort",()=>reject(init.signal.reason),{once:true});
    });
  };
  const todoist=new Todoist("test-token",{timeoutMs:10});
  await assert.rejects(todoist.listAllTaskCommentsForErasureAudit(),{name:"TimeoutError"});
  assert.equal(calls,1);
});

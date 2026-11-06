import test from "node:test";
import assert from "node:assert/strict";
import { Todoist } from "../dist/providers.js";

// Todoist API v1 explicitly requires since/until date-time values, not date-only;
// completed results contain "items" whose task identifier is "id".
test("#351 completed-task lookup uses Todoist API v1 date-time window, id and all pages", async t=>{
  const urls=[];
  t.mock.method(globalThis,"fetch",async (value,init)=>{
    const url=new URL(value.toString());urls.push(url);
    assert.equal((init?.method||"GET").toUpperCase(),"GET");
    assert.equal(url.pathname,"/api/v1/tasks/completed/by_completion_date");
    const since=url.searchParams.get("since"),until=url.searchParams.get("until");
    assert.match(since,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.match(until,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.equal(url.searchParams.get("limit"),"200");
    const items=url.searchParams.get("cursor")
      ? [{id:"expected",content:"completed",completed_at:"2026-10-21T13:00:00Z",is_deleted:false}]
      : [{id:"unrelated",content:"other",completed_at:"2026-10-20T12:00:00Z",is_deleted:false}];
    return new Response(JSON.stringify({items,next_cursor:urls.length===1?"second-page":null}),{
      status:200,headers:{"content-type":"application/json"},
    });
  });
  const found=await new Todoist("test-token").findCompletedTaskById("expected","2026-10-21T13:00:00Z");
  assert.equal(found.id,"expected");assert.equal(urls.length,2);
  assert.equal(urls[1].searchParams.get("cursor"),"second-page");
  assert.equal(urls[0].searchParams.get("since"),"2026-10-18T13:00:00.000Z");
  assert.equal(urls[0].searchParams.get("until"),"2026-10-24T13:00:00.000Z");
});

test("#351 incomplete or malformed Todoist completed-task pages fail closed",async t=>{
  t.mock.method(globalThis,"fetch",async()=>new Response(JSON.stringify({
    items:[{task_id:"wrong-schema",completed_at:"2026-10-21T13:00:00Z"}],
    next_cursor:null,
  }),{status:200,headers:{"content-type":"application/json"}}));
  await assert.rejects(
    new Todoist("test-token").findCompletedTaskById("wrong-schema","2026-10-21T13:00:00Z"),
    /unverified entry/,
  );
});

test("#351 repeated completed-task pagination cursors fail closed",async t=>{
  t.mock.method(globalThis,"fetch",async()=>new Response(JSON.stringify({
    items:[],next_cursor:"repeated",
  }),{status:200,headers:{"content-type":"application/json"}}));
  await assert.rejects(
    new Todoist("test-token").findCompletedTaskById("missing","2026-10-21T13:00:00Z"),
    /repeated an invalid cursor/,
  );
});

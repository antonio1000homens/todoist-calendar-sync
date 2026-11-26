import assert from "node:assert/strict";
import test from "node:test";
import { GoogleCalendar } from "../dist/providers.js";

function isGoogleOAuthUrl(value) {
  return new URL(String(value)).hostname === "oauth2.googleapis.com";
}

test("Google Calendar watch creates and stops a webhook channel", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (isGoogleOAuthUrl(url)) {
      return new Response(JSON.stringify({ access_token: "test-access-token" }), { status: 200 });
    }
    if (url.endsWith("/events/watch")) {
      return new Response(JSON.stringify({ resourceId: "resource-1", expiration: String(Date.now() + 86_400_000) }), { status: 200 });
    }
    return new Response(null, { status: 204 });
  };
  try {
    const calendar = new GoogleCalendar({ client_id: "id", client_secret: "secret", refresh_token: "refresh" }, "home@example.test");
    const created = await calendar.watch("home-calendar-sync-v3-1", "https://calendar-sync.alf-broadcast.co.uk/calendar", "watch-token");
    await calendar.stopWatch("home-calendar-sync-v3-1", created.resourceId);
    assert.equal(calls.filter(({ url }) => url.endsWith("/events/watch")).length, 1);
    const watch = calls.find(({ url }) => url.endsWith("/events/watch"));
    assert.deepEqual(JSON.parse(watch.init.body), {
      id: "home-calendar-sync-v3-1",
      type: "web_hook",
      address: "https://calendar-sync.alf-broadcast.co.uk/calendar",
      token: "watch-token",
    });
    assert.match(calls.at(-1).url, /\/channels\/stop$/);
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), { id: "home-calendar-sync-v3-1", resourceId: "resource-1" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manual Calendar deletion sends If-Match for the exact approved event version", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({url,init});
    if (isGoogleOAuthUrl(url)) return Response.json({access_token:"test-access-token"});
    return new Response(null,{status:204});
  };
  try {
    const calendar = new GoogleCalendar({client_id:"id",client_secret:"secret",refresh_token:"refresh"},"home@example.test");
    await calendar.deleteEventIfUnchanged("exact-event-id","etag-approved");
    const deletion=calls.find(({init})=>init.method==="DELETE");
    assert.match(deletion.url,/\/events\/exact-event-id$/);
    assert.equal(deletion.init.headers.get("If-Match"),"etag-approved");
  } finally {
    globalThis.fetch=originalFetch;
  }
});

test("ordinary Calendar deletion rereads exact event identity and uses its ETag",async()=>{
  const originalFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init={})=>{
    calls.push({url,init});
    if(isGoogleOAuthUrl(url))return Response.json({access_token:"test-access-token"});
    if(!init.method||init.method==="GET")return Response.json({id:"exact-event",etag:"fresh-etag"});
    return new Response(null,{status:204});
  };
  try{
    const calendar=new GoogleCalendar({client_id:"id",client_secret:"secret",refresh_token:"refresh"},"home@example.test");
    await calendar.deleteEvent("exact-event");
    const deletion=calls.find(({init})=>init.method==="DELETE");
    assert.ok(deletion);
    assert.equal(deletion.init.headers.get("If-Match"),"fresh-etag");
    assert.ok(calls.findIndex(({init})=>!init.method||init.method==="GET")<calls.findIndex(({init})=>init.method==="DELETE"));
  }finally{globalThis.fetch=originalFetch;}
});

test("Calendar event upsert is a conditional patch and refuses a stale approved ETag",async()=>{
  const originalFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init={})=>{
    calls.push({url,init});
    if(isGoogleOAuthUrl(url))return Response.json({access_token:"test-access-token"});
    return Response.json({id:"event-1",etag:"new-etag",extendedProperties:{shared:{humanKey:"keep"}}});
  };
  try{
    const calendar=new GoogleCalendar({client_id:"id",client_secret:"secret",refresh_token:"refresh"},"home@example.test");
    await assert.rejects(calendar.upsertEventIfUnchanged({summary:"Changed",description:"Details",start:{date:"2099-01-01"},end:{date:"2099-01-02"}},"event-1","approved-etag"),error=>error.status===412);
    assert.equal(calls.filter(({init})=>init.method==="PATCH"||init.method==="PUT").length,0);
  }finally{globalThis.fetch=originalFetch;}
});

test("recurring occurrence identity cleanup preserves live boundaries in its If-Match PATCH",async()=>{
  const originalFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init={})=>{
    calls.push({url,init});
    if(isGoogleOAuthUrl(url))return Response.json({access_token:"test-access-token"});
    if(!init.method||init.method==="GET")return Response.json({id:"exact-instance",recurringEventId:"series-master",etag:"etag-approved",
      start:{date:"2026-11-25"},end:{date:"2026-11-26"},
      extendedProperties:{shared:{humanKey:"keep-me",taskId:"task-1",syncRecurrenceOwner:"calendar"}}});
    return Response.json({id:"exact-instance",recurringEventId:"series-master",etag:"etag-after",extendedProperties:{shared:{humanKey:"keep-me",taskId:"task-1",syncHistoryOnly:"true"}}});
  };
  try {
    const calendar=new GoogleCalendar({client_id:"id",client_secret:"secret",refresh_token:"refresh"},"home@example.test");
    await calendar.updateSharedEventPropertiesIfUnchanged("exact-instance","etag-approved",{taskId:null,syncRecurrenceOwner:null,syncHistoryOnly:"true"});
    const patch=calls.find(({init})=>init.method==="PATCH");
    assert.match(patch.url,/\/events\/exact-instance$/);
    assert.equal(patch.init.headers.get("If-Match"),"etag-approved");
    assert.deepEqual(JSON.parse(patch.init.body),{
      start:{date:"2026-11-25"},end:{date:"2026-11-26"},
      extendedProperties:{shared:{humanKey:"keep-me",taskId:null,syncRecurrenceOwner:null,syncHistoryOnly:"true"}},
    });
  } finally { globalThis.fetch=originalFetch; }
});

test("Todoist event writes stamp exact provider correlation and retain unrelated shared properties",async()=>{
  const originalFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init={})=>{
    calls.push({url,init});
    if(isGoogleOAuthUrl(url))return Response.json({access_token:"test-access-token"});
    if(!init.method||init.method==="GET")return Response.json({id:"event-1",etag:"etag-1",extendedProperties:{shared:{providerField:"preserve",syncSource:"todoist-calendar-sync",syncRecurrenceOwner:"todoist"}}});
    return Response.json({...JSON.parse(init.body),id:"event-1",etag:"etag-2"});
  };
  try{
    const calendar=new GoogleCalendar({client_id:"id",client_secret:"secret",refresh_token:"refresh"},"home@example.test");
    await calendar.upsertEvent({id:"event-1",summary:"Task",start:{date:"2026-12-01"},end:{date:"2026-12-02"},
      extendedProperties:{shared:{taskId:"task-1",humanKey:"keep-me"}}},"event-1");
    const write=calls.find(({init})=>init.method==="PATCH");
    assert.equal(write.init.headers.get("If-Match"),"etag-1");
    const shared=JSON.parse(write.init.body).extendedProperties.shared;
    assert.equal(shared.taskId,"task-1");
    assert.equal(shared.humanKey,"keep-me");
    assert.equal(shared.syncTaskId,"task-1");
    assert.equal(shared.syncEventId,"event-1");
    assert.equal(shared.syncCalendarId,"home@example.test");
    assert.equal(shared.syncProfile,"home");
    assert.equal(shared.syncSchemaVersion,"2");
    assert.equal(shared.providerField,"preserve");
    assert.equal(shared.syncSource,null,"PATCH explicitly clears the legacy source marker");
    assert.equal(shared.syncRecurrenceOwner,null,"PATCH explicitly clears the legacy recurrence owner");
  }finally{globalThis.fetch=originalFetch;}
});

test("Calendar-originated links acquire task correlation with a conditional metadata-only patch",async()=>{
  const originalFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init={})=>{
    calls.push({url,init});
    if(isGoogleOAuthUrl(url))return Response.json({access_token:"test-access-token"});
    if(!init.method||init.method==="GET")return Response.json({id:"event-1",etag:"etag-1",extendedProperties:{shared:{humanKey:"keep-me",syncRecurrenceOwner:"calendar"}}});
    return Response.json({id:"event-1",etag:"etag-2",extendedProperties:{shared:{humanKey:"keep-me",taskId:"task-1",syncTaskId:"task-1",syncProfile:"home",syncCalendarId:"home@example.test",syncEventId:"event-1",syncSchemaVersion:"2",syncSeriesId:"series-1",syncMasterEventId:"event-1",syncActiveInstanceId:"event-1",syncOriginalStart:"2026-11-25",syncProgressVersion:"1",syncCompletedThrough:"2026-11-24"}}});
  };
  try{
    const calendar=new GoogleCalendar({client_id:"id",client_secret:"secret",refresh_token:"refresh"},"home@example.test");
    await calendar.ensureTaskCorrelation("event-1","task-1",undefined,{seriesId:"series-1",masterEventId:"event-1",
      activeInstanceId:"event-1",originalStart:"2026-11-25",calendarProgressVersion:1,
      completedThroughOriginalStart:"2026-11-24"});
    const patch=calls.find(({init})=>init.method==="PATCH");
    assert.ok(patch);
    assert.equal(patch.init.headers.get("If-Match"),"etag-1");
    assert.deepEqual(JSON.parse(patch.init.body),{extendedProperties:{shared:{humanKey:"keep-me",taskId:"task-1",syncTaskId:"task-1",syncProfile:"home",syncCalendarId:"home@example.test",syncEventId:"event-1",syncSchemaVersion:"2",syncSeriesId:"series-1",syncMasterEventId:"event-1",syncActiveInstanceId:"event-1",syncOriginalStart:"2026-11-25",syncProgressVersion:"1",syncCompletedThrough:"2026-11-24",syncRecurrenceOwner:null}}});
  }finally{globalThis.fetch=originalFetch;}
});

test("Calendar correlation refuses to overwrite a different exact task identity",async()=>{
  const originalFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init={})=>{
    calls.push({url,init});
    if(isGoogleOAuthUrl(url))return Response.json({access_token:"test-access-token"});
    return Response.json({id:"event-1",etag:"etag-1",extendedProperties:{shared:{taskId:"other-task"}}});
  };
  try{
    const calendar=new GoogleCalendar({client_id:"id",client_secret:"secret",refresh_token:"refresh"},"home@example.test");
    await assert.rejects(calendar.ensureTaskCorrelation("event-1","task-1"),/different Todoist task/);
    assert.equal(calls.filter(({init})=>init.method==="PATCH").length,0);
  }finally{globalThis.fetch=originalFetch;}
});

test("Calendar series correlation advances a task ID only from the exact previous provider comment identity",async()=>{
  const originalFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init={})=>{
    calls.push({url,init});
    if(isGoogleOAuthUrl(url))return Response.json({access_token:"test-access-token"});
    if(!init.method||init.method==="GET")return Response.json({id:"master-1",etag:"etag-7",extendedProperties:{shared:{
      taskId:"task-old",syncTaskId:"task-old",syncProfile:"home",syncCalendarId:"home@example.test",
      syncEventId:"master-1",syncSchemaVersion:"2",humanKey:"preserve",
    }}});
    return Response.json({id:"master-1",etag:"etag-8"});
  };
  try{
    const calendar=new GoogleCalendar({client_id:"id",client_secret:"secret",refresh_token:"refresh"},"home@example.test");
    await calendar.ensureTaskCorrelation("master-1","task-next","task-old");
    const patch=calls.find(({init})=>init.method==="PATCH");
    assert.ok(patch);
    assert.equal(patch.init.headers.get("If-Match"),"etag-7");
    const shared=JSON.parse(patch.init.body).extendedProperties.shared;
    assert.equal(shared.taskId,"task-next");
    assert.equal(shared.syncTaskId,"task-next");
    assert.equal(shared.humanKey,"preserve");
  }finally{globalThis.fetch=originalFetch;}
});

test("legacy shared-property cleanup converges with Google PATCH merge semantics", async () => {
  const originalFetch = globalThis.fetch;
  const patches = [];
  let stored = {
    id: "event-1", etag: "etag-1", status: "confirmed",
    start: { date: "2099-11-27" }, end: { date: "2099-11-28" },
    extendedProperties: { private: { privateKey: "preserve" }, shared: {
      taskId: "task-1", syncTaskId: "task-1", syncSchemaVersion: "2", syncProfile: "home",
      syncCalendarId: "home@example.test", syncEventId: "event-1",
      syncSource: "todoist-calendar-sync", syncRecurrenceOwner: "todoist",
      syncCalendarNative: "true", humanKey: "preserve",
    } },
  };
  globalThis.fetch = async (url, init = {}) => {
    if (isGoogleOAuthUrl(url)) return Response.json({ access_token: "test-access-token" });
    if (!init.method || init.method === "GET") return Response.json(stored);
    assert.equal(init.method, "PATCH");
    assert.equal(init.headers.get("If-Match"), stored.etag);
    const body = JSON.parse(init.body);
    patches.push(body);
    // Google PATCH leaves omitted keys unchanged and clears only explicit nulls.
    const merged = { ...stored.extendedProperties.shared };
    for (const [key, value] of Object.entries(body.extendedProperties.shared)) {
      if (value === null) delete merged[key]; else merged[key] = value;
    }
    stored = { ...stored, etag: "etag-2", start: body.start, end: body.end,
      extendedProperties: { ...stored.extendedProperties, shared: merged } };
    return Response.json(stored);
  };
  try {
    const calendar = new GoogleCalendar({client_id:"id",client_secret:"secret",refresh_token:"refresh"},"home@example.test");
    await calendar.ensureTaskCorrelation("event-1", "task-1");
    assert.equal(patches.length, 1);
    assert.equal(patches[0].extendedProperties.shared.syncSource, null);
    assert.equal(patches[0].extendedProperties.shared.syncRecurrenceOwner, null);
    assert.equal(patches[0].extendedProperties.shared.syncCalendarNative, null);
    assert.equal(stored.extendedProperties.shared.humanKey, "preserve");
    assert.equal(stored.extendedProperties.private.privateKey, "preserve");
    assert.deepEqual(stored.start, { date: "2099-11-27" });
    assert.deepEqual(stored.end, { date: "2099-11-28" });
    await calendar.ensureTaskCorrelation("event-1", "task-1");
    assert.equal(patches.length, 1, "second delivery must not write another Calendar echo");
  } finally { globalThis.fetch = originalFetch; }
});

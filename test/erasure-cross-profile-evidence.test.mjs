import assert from "node:assert/strict";
import test from "node:test";
import {observeCrossProfileErasureEvidence} from "../dist/erasure-cross-profile-evidence.js";
import {erasureProviderSnapshotFingerprint} from "../dist/erasure-preview.js";
import {serializeMappingComment} from "../dist/mapping-comments.js";
import {GoogleCalendar,Todoist} from "../dist/providers.js";

const profiles=["home","antonio","work"];
const taskOne="task-one",taskTwo="task-two";
const eventOne="event-one",eventTwo="event-two",master="series-master",instance="series-instance";
const linked=(id,taskId,extra={})=>({id,status:"confirmed",etag:"etag-"+id,
  extendedProperties:{shared:{taskId}},...extra});
function missing(status=404) { return Object.assign(new Error("not found"),{status}); }

test("all-profile evidence follows database/comment/provider aliases and recurring instances without authorizing release",async()=>{
  const mapping=serializeMappingComment({profile:"antonio",eventId:eventTwo,taskId:taskTwo,
    recurrenceOwner:"calendar",seriesId:"series-uid-two",masterEventId:eventTwo,
    updatedAt:"2026-11-03T20:00:00.000Z"},"project-antonio",undefined,1);
  const homeMaster=linked(master,taskOne,{recurrence:["RRULE:FREQ=DAILY"]});
  const homeEvent=linked(eventOne,taskOne,{recurringEventId:master});
  const homeInstance=linked(instance,taskOne,{status:"cancelled",recurringEventId:master,
    originalStartTime:{date:"2026-11-03"}});
  const workEvent=linked(eventTwo,taskTwo);
  const calendarByProfile={home:[homeMaster,homeEvent],antonio:[],work:[workEvent]};
  const calls=[],calendarDirectReads=[];
  let taskCommentSnapshotOffsetMs=0;
  const observe=()=>observeCrossProfileErasureEvidence({
    taskId:taskOne,eventId:eventOne,
    rows:[
      {pk:"EVENT#home#event-one",sk:"MAP",profile:"home",taskId:taskOne,eventId:eventOne,
        candidateTaskIds:[taskTwo],recurrenceOwner:"calendar",seriesId:"series-uid-one",masterEventId:master,activeInstanceId:instance},
      {pk:"TASK#work#task-two",sk:"MAP",profile:"work",taskId:taskTwo,eventId:eventTwo},
    ],
    fullRows:[
      {pk:"EVENT#home#event-one",sk:"MAP",profile:"home",taskId:taskOne,eventId:eventOne,
        candidateTaskIds:[taskTwo],recurrenceOwner:"calendar",seriesId:"series-uid-one",masterEventId:master,activeInstanceId:instance},
      {pk:"TASK#work#task-two",sk:"MAP",profile:"work",taskId:taskTwo,eventId:eventTwo},
    ],
    readerForProfile:async profile=>{
      calls.push(profile);
      const calendarEvents=calendarByProfile[profile];
      const comments=profile==="antonio"?[{id:"mapping-comment-2",content:mapping}]:[];
      const tasks=new Map([[taskOne,{id:taskOne,content:"private task title"}],
        [taskTwo,{id:taskTwo,content:"second private title"}]]);
      const activeTaskIds=profile==="home"?[taskOne]:profile==="work"?[taskTwo]:[];
      return {
        calendar:{
          async listCalendarListForErasureAudit(){return[
            {id:`calendar-${profile}`,accessRole:"reader",configured:true},
            {id:`shared-${profile}`,accessRole:"reader",configured:false},
            {id:`freebusy-${profile}`,accessRole:"freeBusyReader",configured:false},
          ];},
          async listAllEventsForErasureAudit(calendarId){
            if(profile==="work"&&calendarId===`shared-${profile}`)return [workEvent];
            if(calendarId!==undefined)return[];
            return profile==="work"?[]:calendarEvents;
          },
          async listLinkedEventsByTodoistTaskId(taskId,calendarId){
            if(profile==="work"&&calendarId===undefined)return[];
            return calendarEvents.filter(event=>event.extendedProperties?.shared?.taskId===taskId);
          },
          async getEvent(id,calendarId){
            calendarDirectReads.push({profile,id,calendarId});
            const event=profile==="home"&&id===instance?homeInstance:
              profile==="work"&&id===eventTwo&&calendarId===`shared-${profile}`?workEvent:
              calendarEvents.find(item=>item.id===id);
            if(!event)throw missing();
            return event;
          },
          async listEventInstances(id){assert.equal(id,master);return [homeInstance];},
        },
        todoist:{
          async listAllTasksForErasureAudit(){return activeTaskIds.map(id=>tasks.get(id));},
          async getTask(id){const value=activeTaskIds.includes(id)?tasks.get(id):undefined;if(!value)throw missing();return value;},
          async listAllProjectCommentsForErasureAudit(){return {
            projects:[{id:`project-${profile}`}],comments,
          };},
          async listAllTaskCommentsForErasureAudit(){return {fullSyncDateUtc:new Date(Date.now()+taskCommentSnapshotOffsetMs).toISOString(),comments:profile==="work"?[{
            id:"legacy-comment",task_id:taskTwo,content:"todoist-calendar-sync\ncalendarEventId=legacy-event",
          }]:[]};},
          async listTaskComments(id){return profile==="work"&&id===taskTwo?[{
            id:"legacy-comment",content:"todoist-calendar-sync\ncalendarEventId=legacy-event",
          }]:[];},
        },
      };
    },
  });
  const report=await observe();

  assert.deepEqual(calls,profiles);
  assert.equal(report.phase,"read_only_cross_profile_observation");
  assert.equal(report.eligibleForPostWriteRelease,false);
  assert.equal(report.allProfilesQueried,true);
  assert.equal(report.profiles.work.accessibleCalendarCount,3);
  assert.equal(report.profiles.work.freeBusyOnlyCalendarCount,1);
  assert.equal(report.profiles.work.calendarInventoryComplete,false);
  assert.ok(calendarDirectReads.some(read=>read.profile==="work"&&read.id===eventTwo&&read.calendarId==="shared-work"),
    "a tagged task event in a secondary accessible calendar is directly read using that calendar ID");
  assert.equal(report.closureComplete,true);
  assert.equal(report.allAccessibleCalendarCoverageProven,false,
    "CalendarList cannot prove coverage of directly addressable calendars outside the user's list");
  assert.equal(report.knownIdentitiesAbsentFromCurrentProviders,false);
  assert.equal(report.identities.taskCount,2);
  assert.ok(report.identities.eventCount>=5,"selected, mapped, recurring and legacy event aliases are retained");
  assert.equal(report.profiles.home.recurringMasters,1);
  assert.equal(report.profiles.home.recurrenceInstances,1);
  assert.equal(report.profiles.home.cancelledDirectEventReads,1);
  assert.equal(report.profiles.home.cancelledInventoryMatches,1);
  assert.equal(report.profiles.antonio.relatedProjectComments,1);
  assert.ok(report.profiles.work.relatedLegacyComments>0);
  assert.ok(report.profiles.work.taskCommentInventoryMatches>0);
  assert.ok(report.stateScan.stronglyConsistent&&report.stateScan.allPagesReceived);
  assert.ok(report.stateScan.relatedRowCount>=2);
  assert.ok(report.missingProof.some(reason=>reason.includes("404/410")));
  assert.ok(report.missingProof.some(reason=>reason.includes("free/busy")));
  assert.ok(report.missingProof.some(reason=>reason.includes("never constitute")));
  taskCommentSnapshotOffsetMs=10_000;
  calls.length=0;
  calendarDirectReads.length=0;
  const repeated=await observe();
  assert.deepEqual(calls,profiles);
  assert.notEqual(repeated.profiles.work.taskCommentInventorySnapshotAt,
    report.profiles.work.taskCommentInventorySnapshotAt);
  assert.equal(repeated.profiles.work.taskCommentInventoryFresh,true);
  assert.equal(repeated.profiles.work.evidenceFingerprint,report.profiles.work.evidenceFingerprint,
    "a refreshed but content-identical task-comment inventory keeps its per-profile evidence fingerprint");
  assert.equal(repeated.evidenceFingerprint,report.evidenceFingerprint,
    "capture time does not make an unchanged all-profile inspection appear to drift");
  assert.equal(erasureProviderSnapshotFingerprint({taskId:taskOne,eventId:eventOne},repeated),
    erasureProviderSnapshotFingerprint({taskId:taskOne,eventId:eventOne},report),
    "the erasure preview digest consumes stable evidence, not its refreshed diagnostic timestamp");
  const serialized=JSON.stringify(report);
  for(const privateValue of [taskOne,taskTwo,eventOne,eventTwo,master,instance,"private task title","legacy-event"])
    assert.equal(serialized.includes(privateValue),false,"raw identity/content must not appear in redacted evidence");
});

test("profile read failures and bounded identity overflow fail closed",async()=>{
  const emptyReader=async()=>({
    calendar:{async listAllEventsForErasureAudit(){return[];},async listLinkedEventsByTodoistTaskId(){return[];},
      async getEvent(){throw missing();},async listEventInstances(){return[];}},
    todoist:{async listAllTasksForErasureAudit(){return[];},async getTask(){throw missing();},
      async listAllProjectCommentsForErasureAudit(){return{projects:[],comments:[]};},async listTaskComments(){return[];}},
  });
  await assert.rejects(observeCrossProfileErasureEvidence({taskId:"task-one",rows:[],fullRows:[],readerForProfile:async profile=>{
    if(profile==="work")throw new Error("profile credentials missing");
    return emptyReader();
  }}));
  const partialComments=await observeCrossProfileErasureEvidence({taskId:"task-one",rows:[],fullRows:[],
    readerForProfile:async()=>{
      const pair=await emptyReader();
      return {...pair,todoist:{...pair.todoist,async listAllProjectCommentsForErasureAudit(){
        return{projects:[],comments:[],complete:false,unavailableProjectCommentCount:1};
      }}};
    }});
  assert.equal(partialComments.closureComplete,false);
  assert.equal(partialComments.profiles.work.projectCommentInventoryComplete,false);
  assert.ok(partialComments.missingProof.some(reason=>reason.includes("project comment inventories")));
  const overflow=await observeCrossProfileErasureEvidence({taskId:"task-one",
    rows:[{pk:"TASKOWNER#task-one",sk:"MAP",taskId:"task-one",
      candidateTaskIds:Array.from({length:2056},(_,index)=>"task-alias-"+index)}],
    fullRows:[{pk:"TASKOWNER#task-one",sk:"MAP",taskId:"task-one",
      candidateTaskIds:Array.from({length:2056},(_,index)=>"task-alias-"+index)}],
    readerForProfile:emptyReader});
  assert.equal(overflow.eligibleForPostWriteRelease,false);
  assert.equal(overflow.closureComplete,false);
  assert.ok(overflow.identities.overflowCount>0);
  assert.ok(overflow.missingProof.some(reason=>reason.includes("bounded observer capacity")));
});

test("stale Todoist task-comment full-sync snapshots cannot establish absence",async()=>{
  const reader=async()=>({
    calendar:{async listAllEventsForErasureAudit(){return[];},async listLinkedEventsByTodoistTaskId(){return[];},
      async getEvent(){throw missing();},async listEventInstances(){return[];}},
    todoist:{async listAllTasksForErasureAudit(){return[{id:taskOne,content:"task"}];},
      async getTask(id){return{id,content:"task"};},async listAllProjectCommentsForErasureAudit(){return{projects:[],comments:[]};},
      async listAllTaskCommentsForErasureAudit(){return{comments:[],fullSyncDateUtc:new Date(Date.now()-6*60_000).toISOString()};},
      async listTaskComments(){return[];}},
  });
  const report=await observeCrossProfileErasureEvidence({taskId:taskOne,rows:[],fullRows:[],readerForProfile:reader});
  assert.equal(report.profiles.home.taskCommentInventoryComplete,true);
  assert.equal(report.profiles.home.taskCommentInventoryFresh,false);
  assert.equal(report.knownIdentitiesAbsentFromCurrentProviders,false);
  assert.ok(report.missingProof.some(reason=>reason.includes("older than five minutes")));
});

test("Todoist 429/5xx direct identity reads fail the cross-profile audit closed",async()=>{
  for(const status of [429,500,503]) {
    const reader=async()=>({
      calendar:{async listAllEventsForErasureAudit(){return[];},async listLinkedEventsByTodoistTaskId(){return[];},
        async getEvent(){throw missing();},async listEventInstances(){return[];}},
      todoist:{async listAllTasksForErasureAudit(){return[];},
        async getTask(){throw missing(status);},async listAllProjectCommentsForErasureAudit(){return{projects:[],comments:[]};},
        async listTaskComments(){return[];}},
    });
    await assert.rejects(observeCrossProfileErasureEvidence({taskId:"transient-task",rows:[],fullRows:[],readerForProfile:reader}),
      error=>error.status===status,
      `HTTP ${status} must not be converted into an empty task inventory`);
  }
});

test("Todoist task-comment 404 is retained as incomplete provenance without aborting the capture",async()=>{
  const reader=async()=>({
    calendar:{async listAllEventsForErasureAudit(){return[];},async listLinkedEventsByTodoistTaskId(){return[];},
      async getEvent(){throw missing();},async listEventInstances(){return[];}},
    todoist:{async listAllTasksForErasureAudit(){return[];},async getTask(){throw missing();},
      async listAllProjectCommentsForErasureAudit(){return{projects:[],comments:[]};},
      async listAllTaskCommentsForErasureAudit(){return{comments:[],fullSyncDateUtc:new Date().toISOString()};},
      async listTaskComments(){throw missing();}},
  });
  const report=await observeCrossProfileErasureEvidence({taskId:"deleted-task",rows:[],fullRows:[],readerForProfile:reader});
  assert.equal(report.closureComplete,false);
  assert.equal(report.eligibleForPostWriteRelease,false);
  assert.equal(report.profiles.work.taskCommentReadFailures,1);
  assert.ok(report.missingProof.some(reason=>reason.includes("task-comment reads returned 404")));
});

test("Calendar 410 remains ambiguous while Calendar 429/5xx fail the cross-profile audit closed",async()=>{
  const readerFor=(status)=>async()=>({
    calendar:{async listAllEventsForErasureAudit(){return[];},async listLinkedEventsByTodoistTaskId(){return[];},
      async getEvent(){throw missing(status);},async listEventInstances(){return[];}},
    todoist:{async listAllTasksForErasureAudit(){return[];},async getTask(){throw missing();},
      async listAllProjectCommentsForErasureAudit(){return{projects:[],comments:[]};},async listTaskComments(){return[];}},
  });
  const rows=[{pk:"EVENT#home#expired-event",sk:"MAP",profile:"home",eventId:"expired-event"}];
  const gone=await observeCrossProfileErasureEvidence({taskId:taskOne,eventId:"expired-event",rows,fullRows:rows,
    readerForProfile:readerFor(410)});
  assert.ok(gone.profiles.home.event404Responses>0);
  assert.equal(gone.knownIdentitiesAbsentFromCurrentProviders,false);
  assert.ok(gone.missingProof.some(reason=>reason.includes("404/410")));
  for(const status of [429,500,503]) {
    await assert.rejects(observeCrossProfileErasureEvidence({taskId:taskOne,eventId:"expired-event",rows,fullRows:rows,
      readerForProfile:readerFor(status)}),error=>error.status===status,
      `HTTP ${status} must not be converted into a missing Calendar event`);
  }
});

test("Google audit inventory covers every page without time or task filters and closes recurring instances",async()=>{
  const previous=globalThis.fetch,calls=[];
  globalThis.fetch=async raw=>{
    const url=new URL(String(raw));
    if(url.origin==="https://oauth2.googleapis.com")return new Response(JSON.stringify({access_token:"token"}));
    assert.equal(url.origin,"https://www.googleapis.com");
    calls.push(url);
    if(url.pathname.endsWith("/users/me/calendarList"))return url.searchParams.has("pageToken")
      ?new Response(JSON.stringify({items:[{id:"team@example.test",accessRole:"reader"}]}))
      :new Response(JSON.stringify({items:[{id:"primary@example.test",accessRole:"owner"}],nextPageToken:"calendar-page-two"}));
    if(url.pathname.endsWith("/events/series-master/instances"))
      return new Response(JSON.stringify({items:[{id:instance,recurringEventId:master,status:"cancelled"}]}));
    assert.ok(url.pathname.endsWith("/events"));
    return url.searchParams.has("pageToken")
      ?new Response(JSON.stringify({items:[{id:"later-event",status:"confirmed"}]}))
      :new Response(JSON.stringify({items:[{id:master,status:"confirmed",recurrence:["RRULE:FREQ=DAILY"]}],nextPageToken:"page-two"}));
  };
  try {
    const calendar=new GoogleCalendar({client_id:"id",client_secret:"secret",refresh_token:"refresh"},"audit@example.test");
    const calendars=await calendar.listCalendarListForErasureAudit();
    assert.deepEqual(calendars,[
      {id:"audit@example.test",accessRole:"configured-unlisted",configured:true},
      {id:"primary@example.test",accessRole:"owner",configured:false},
      {id:"team@example.test",accessRole:"reader",configured:false},
    ]);
    assert.equal(calls.filter(url=>url.pathname.endsWith("/users/me/calendarList")).length,2);
    await calendar.listAllEventsForErasureAudit("team@example.test");
    assert.ok(calls.some(url=>url.pathname==="/calendar/v3/calendars/team%40example.test/events"));
    const events=await calendar.listAllEventsForErasureAudit();
    assert.deepEqual(events.map(event=>event.id),[master,"later-event"]);
    const listCalls=calls.filter(url=>url.pathname.includes("audit%40example.test")&&url.pathname.endsWith("/events"));
    assert.equal(listCalls.length,2);
    for(const url of listCalls) {
      assert.equal(url.searchParams.get("showDeleted"),"true");
      assert.equal(url.searchParams.get("singleEvents"),"false");
      assert.equal(url.searchParams.has("timeMin"),false);
      assert.equal(url.searchParams.has("timeMax"),false);
      assert.equal(url.searchParams.has("sharedExtendedProperty"),false);
    }
    const instances=await calendar.listEventInstances(master);
    assert.deepEqual(instances.map(event=>event.id),[instance]);
    assert.equal(calls.at(-1).searchParams.get("showDeleted"),"true");
  } finally { globalThis.fetch=previous; }
});

test("Google recurrence audit paginates an oversized-for-release series for complete read-only discovery",async()=>{
  const previous=globalThis.fetch,calls=[];
  globalThis.fetch=async raw=>{
    const url=new URL(String(raw));
    if(url.origin==="https://oauth2.googleapis.com")return new Response(JSON.stringify({access_token:"token"}));
    calls.push(url);
    assert.equal(url.pathname.endsWith("/events/oversized-master/instances"),true);
    const start=url.searchParams.has("pageToken")?32:0;
    const items=Array.from({length:start?1:32},(_,offset)=>{
      const index=start+offset;
      return {id:`instance-${index}`,recurringEventId:"oversized-master",status:"confirmed"};
    });
    return new Response(JSON.stringify(start?{items}:{items,nextPageToken:"second-page"}));
  };
  try {
    const calendar=new GoogleCalendar({client_id:"id",client_secret:"secret",refresh_token:"refresh"},"audit@example.test");
    const instances=await calendar.listEventInstances("oversized-master");
    assert.equal(instances.length,33);
    assert.equal(instances[0].id,"instance-0");
    assert.equal(instances.at(-1).id,"instance-32");
    assert.equal(calls.length,2);
    assert.equal(calls[1].searchParams.get("pageToken"),"second-page");
    assert.equal(calls.every(url=>url.searchParams.get("showDeleted")==="true"),true);
  } finally { globalThis.fetch=previous; }
});

test("Todoist comment inventory rejects repeated pagination cursors",async()=>{
  const previous=globalThis.fetch;let calls=0;
  globalThis.fetch=async raw=>{
    const url=new URL(String(raw));
    assert.equal(url.origin,"https://api.todoist.com");
    calls++;
    return new Response(JSON.stringify({results:[{id:"comment-1",content:"private"}],next_cursor:"repeat"}));
  };
  try {
    const todoist=new Todoist("test-token");
    await assert.rejects(todoist.listProjectComments("project-1",true),/repeated\/invalid cursor/);
    assert.equal(calls,2);
  } finally { globalThis.fetch=previous; }
});

test("Todoist erasure audit enumerates active and archived comments in every project and workspace",async()=>{
  const previous=globalThis.fetch,calls=[];
  globalThis.fetch=async raw=>{
    const url=new URL(String(raw));calls.push(url);
    if(url.pathname!=="/api/v1/comments") {
      assert.equal(url.origin,"https://api.todoist.com");
      if(url.pathname==="/api/v1/projects")return new Response(JSON.stringify(
        url.searchParams.has("cursor")?{results:[{id:"moved-project"}]}:
          {results:[{id:"sync-project"}],next_cursor:"active-next"}));
      if(url.pathname==="/api/v1/projects/archived")return new Response(JSON.stringify(
        {results:[{id:"archived-personal"}]}));
      if(url.pathname==="/api/v1/workspaces")return new Response(JSON.stringify([{id:42}]));
      if(url.pathname==="/api/v1/workspaces/42/projects/archived")return new Response(JSON.stringify(
        url.searchParams.has("cursor")?{workspace_projects:[{id:"archived-workspace-2",workspace_id:42}]}:
          {workspace_projects:[{id:"archived-workspace",workspace_id:42}],next_cursor:"workspace-next"}));
      throw new Error(`unexpected Todoist API path: ${url.pathname}`);
    }
    assert.equal(url.origin,"https://api.todoist.com");
    assert.equal(url.pathname,"/api/v1/comments");
    const projectId=url.searchParams.get("project_id");
    return new Response(JSON.stringify({results:[{
      id:`comment-${projectId}`,project_id:projectId,content:`calendarEventId=${projectId}`,
    }]}));
  };
  try {
    const todoist=new Todoist("test-token");
    const audit=await todoist.listAllProjectCommentsForErasureAudit();
    assert.deepEqual(audit.projects.map(project=>project.id),[
      "archived-personal","archived-workspace","archived-workspace-2","moved-project","sync-project",
    ]);
    assert.deepEqual(audit.comments.map(comment=>comment.project_id).sort(),[
      "archived-personal","archived-workspace","archived-workspace-2","moved-project","sync-project",
    ]);
    const commentReads=calls.filter(url=>url.pathname==="/api/v1/comments");
    assert.equal(commentReads.length,5);
    assert.ok(commentReads.some(url=>url.searchParams.get("project_id")==="moved-project"),
      "moved-to project comments are read even when it is not the configured sync project");
  } finally {globalThis.fetch=previous;}
});

test("an inaccessible archived workspace refuses a project-comment completeness claim",async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=async raw=>{
    const url=new URL(String(raw));
    if(url.pathname==="/api/v1/projects"||url.pathname==="/api/v1/projects/archived")
      return new Response(JSON.stringify({results:[]}));
    if(url.pathname==="/api/v1/workspaces")return new Response(JSON.stringify([{id:42}]));
    if(url.pathname==="/api/v1/workspaces/42/projects/archived")
      return new Response("forbidden",{status:403});
    throw new Error(`unexpected API path: ${url.pathname}`);
  };
  try {
    const todoist=new Todoist("test-token");
    await assert.rejects(todoist.listAllProjectCommentsForErasureAudit(),/403/);
  } finally {globalThis.fetch=previous;}
});

test("project comments that return 404 are counted and keep the audit incomplete",async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=async raw=>{
    const url=new URL(String(raw));
    if(url.pathname==="/api/v1/projects"||url.pathname==="/api/v1/projects/archived")
      return new Response(JSON.stringify({results:[{id:"vanished-project"}]}));
    if(url.pathname==="/api/v1/workspaces")return new Response(JSON.stringify([]));
    if(url.pathname==="/api/v1/comments")return new Response("not found",{status:404});
    throw new Error(`unexpected API path: ${url.pathname}`);
  };
  try {
    const audit=await new Todoist("test-token").listAllProjectCommentsForErasureAudit();
    assert.equal(audit.complete,false);
    assert.equal(audit.unavailableProjectCommentCount,1);
    assert.deepEqual(audit.comments,[]);
  } finally {globalThis.fetch=previous;}
});

test("Todoist all-task inventory is unfiltered, paginated and rejects cursor loops",async()=>{
  const previous=globalThis.fetch,calls=[];
  globalThis.fetch=async raw=>{
    const url=new URL(String(raw));
    assert.equal(url.origin,"https://api.todoist.com");
    calls.push(url);
    return url.searchParams.has("cursor")
      ?new Response(JSON.stringify({results:[{id:"task-page-two",content:"private"}]}))
      :new Response(JSON.stringify({results:[{id:"task-page-one",content:"private"}],next_cursor:"page-two"}));
  };
  try {
    const tasks=await new Todoist("test-token").listAllTasksForErasureAudit();
    assert.deepEqual(tasks.map(task=>task.id),["task-page-one","task-page-two"]);
    assert.equal(calls.length,2);
    assert.equal(calls[0].searchParams.has("project_id"),false);
    assert.equal(calls[1].searchParams.get("cursor"),"page-two");
  } finally { globalThis.fetch=previous; }
});

test("Todoist all-task-comment audit uses a complete Sync notes snapshot and rejects partial sync",async()=>{
  const previous=globalThis.fetch,calls=[];
  globalThis.fetch=async(raw,init)=>{
    const url=new URL(String(raw));calls.push({url,init});
    return new Response(JSON.stringify({full_sync:true,sync_token:"opaque-sync-token",
      full_sync_date_utc:new Date().toISOString(),projects:[{id:"project-one"}],project_notes:[
        {id:"project-note-one",project_id:"project-one",content:"calendarEventId=project-event"},
      ],notes:[
      {id:"note-one",item_id:"task-one",content:"todoist-calendar-sync\ncalendarEventId=event-one",is_deleted:false},
      {id:"note-two",item_id:"task-two",content:"old mapping",is_deleted:true},
    ]}));
  };
  try {
    const todoist=new Todoist("test-token");
    const audit=await todoist.listAllTaskCommentsForErasureAudit();
    assert.deepEqual(audit.comments,[
      {id:"note-one",task_id:"task-one",content:"todoist-calendar-sync\ncalendarEventId=event-one",is_deleted:false},
      {id:"note-two",task_id:"task-two",content:"old mapping",is_deleted:true},
    ]);
    assert.deepEqual(audit.projectIds,["project-one"]);
    assert.deepEqual(audit.projectComments,[{
      id:"project-note-one",project_id:"project-one",content:"calendarEventId=project-event",
    }]);
    assert.ok(Number.isFinite(Date.parse(audit.fullSyncDateUtc)));
    assert.equal(calls[0].url.pathname,"/api/v1/sync");
    assert.equal(calls[0].init.method,"POST");
    const body=new URLSearchParams(calls[0].init.body);
    assert.equal(body.get("sync_token"),"*");
    assert.equal(body.get("resource_types"),'["all"]');

    globalThis.fetch=async()=>new Response(JSON.stringify({full_sync:false,sync_token:"partial",
      full_sync_date_utc:new Date().toISOString(),notes:[]}));
    await assert.rejects(todoist.listAllTaskCommentsForErasureAudit(),/full sync was incomplete/);
  } finally {globalThis.fetch=previous;}
});

test("full Calendar inventory rejects repeated page tokens",async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=async raw=>{
    const url=new URL(String(raw));
    if(url.origin==="https://oauth2.googleapis.com")return new Response(JSON.stringify({access_token:"token"}));
    return new Response(JSON.stringify({items:[],nextPageToken:"same-page"}));
  };
  try {
    const calendar=new GoogleCalendar({client_id:"id",client_secret:"secret",refresh_token:"refresh"},"audit@example.test");
    await assert.rejects(calendar.listAllEventsForErasureAudit(),/repeated\/invalid pagination token/);
  } finally { globalThis.fetch=previous; }
});

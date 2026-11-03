import assert from "node:assert/strict";
import test from "node:test";
import {observeCrossProfileErasureEvidence} from "../dist/erasure-cross-profile-evidence.js";
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
  const homeInstance=linked(instance,taskOne,{recurringEventId:master,originalStartTime:{date:"2026-11-03"}});
  const workEvent=linked(eventTwo,taskTwo);
  const calendarByProfile={home:[homeMaster,homeEvent],antonio:[],work:[workEvent]};
  const calls=[];
  const report=await observeCrossProfileErasureEvidence({
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
          async listAllEventsForErasureAudit(){return calendarEvents;},
          async listLinkedEventsByTodoistTaskId(taskId){
            return calendarEvents.filter(event=>event.extendedProperties?.shared?.taskId===taskId);
          },
          async getEvent(id){
            const event=profile==="home"&&id===instance?homeInstance:
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
          async listTaskComments(id){return id===taskTwo?[{id:"legacy-comment",content:"todoist-calendar-sync\ncalendarEventId=legacy-event"}]:[];},
        },
      };
    },
  });

  assert.deepEqual(calls,profiles);
  assert.equal(report.phase,"read_only_cross_profile_observation");
  assert.equal(report.eligibleForPostWriteRelease,false);
  assert.equal(report.allProfilesQueried,true);
  assert.equal(report.closureComplete,true);
  assert.equal(report.knownIdentitiesAbsentFromCurrentProviders,false);
  assert.equal(report.identities.taskCount,2);
  assert.ok(report.identities.eventCount>=5,"selected, mapped, recurring and legacy event aliases are retained");
  assert.equal(report.profiles.home.recurringMasters,1);
  assert.equal(report.profiles.home.recurrenceInstances,1);
  assert.equal(report.profiles.antonio.relatedProjectComments,1);
  assert.ok(report.profiles.work.relatedLegacyComments>0);
  assert.ok(report.stateScan.stronglyConsistent&&report.stateScan.allPagesReceived);
  assert.ok(report.stateScan.relatedRowCount>=2);
  assert.ok(report.missingProof.some(reason=>reason.includes("404/410")));
  assert.ok(report.missingProof.some(reason=>reason.includes("never constitute")));
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
  const overflow=await observeCrossProfileErasureEvidence({taskId:"task-one",
    rows:[{pk:"TASKOWNER#task-one",sk:"MAP",taskId:"task-one",
      candidateTaskIds:Array.from({length:40},(_,index)=>"task-alias-"+index)}],
    fullRows:[{pk:"TASKOWNER#task-one",sk:"MAP",taskId:"task-one",
      candidateTaskIds:Array.from({length:40},(_,index)=>"task-alias-"+index)}],
    readerForProfile:emptyReader});
  assert.equal(overflow.eligibleForPostWriteRelease,false);
  assert.equal(overflow.closureComplete,false);
  assert.ok(overflow.identities.overflowCount>0);
  assert.ok(overflow.missingProof.some(reason=>reason.includes("bounded observer capacity")));
});

test("Google audit inventory covers every page without time or task filters and closes recurring instances",async()=>{
  const previous=globalThis.fetch,calls=[];
  globalThis.fetch=async raw=>{
    const url=new URL(String(raw));
    if(url.origin==="https://oauth2.googleapis.com")return new Response(JSON.stringify({access_token:"token"}));
    assert.equal(url.origin,"https://www.googleapis.com");
    calls.push(url);
    if(url.pathname.endsWith("/events/series-master/instances"))
      return new Response(JSON.stringify({items:[{id:instance,recurringEventId:master,status:"cancelled"}]}));
    assert.ok(url.pathname.endsWith("/events"));
    return url.searchParams.has("pageToken")
      ?new Response(JSON.stringify({items:[{id:"later-event",status:"confirmed"}]}))
      :new Response(JSON.stringify({items:[{id:master,status:"confirmed",recurrence:["RRULE:FREQ=DAILY"]}],nextPageToken:"page-two"}));
  };
  try {
    const calendar=new GoogleCalendar({client_id:"id",client_secret:"secret",refresh_token:"refresh"},"audit@example.test");
    const events=await calendar.listAllEventsForErasureAudit();
    assert.deepEqual(events.map(event=>event.id),[master,"later-event"]);
    const listCalls=calls.filter(url=>url.pathname.endsWith("/events"));
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

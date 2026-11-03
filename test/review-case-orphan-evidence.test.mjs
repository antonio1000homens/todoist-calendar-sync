import test from "node:test";
import assert from "node:assert/strict";
import { hydrateCaseOrphanEvidence } from "../dist/review-api.js";
import { orphanItemsForCase } from "../review-ui/orphan-selection.mjs";

const item={
  id:"case-candidate-hydration",profile:"home",status:"open",
  taskId:"primary-task",eventId:"primary-event",
  decision:{context:{candidateTaskIds:["recorded-task"],candidateEventIds:["recorded-event"]}},
};
const ref=(side,id,profile="home")=>({profile,side,id});
const snapshot=(side,id,object,more={})=>({ref:ref(side,id),object,...more});
const todoist=id=>({id,content:"Record "+id,project_id:"home-project",is_completed:false,is_deleted:false});
const calendar=id=>({id,summary:"Record "+id,status:"confirmed",etag:"etag-"+id});

test("case evidence hydrates exactly recorded Todoist and Calendar candidate identities",async()=>{
  const calls=[];
  const initial=[
    snapshot("todoist","primary-task",todoist("primary-task")),
    snapshot("calendar","primary-event",calendar("primary-event")),
  ];
  const fetched=await hydrateCaseOrphanEvidence(item,initial,async identity=>{
    calls.push(identity);
    return {ref:identity,object:identity.side==="todoist"?todoist(identity.id):calendar(identity.id)};
  });
  assert.deepEqual(calls,[ref("todoist","recorded-task"),ref("calendar","recorded-event")]);
  assert.equal(fetched.length,4);
  assert.ok(fetched.every(s=>s.ref.profile==="home"));
  const options=orphanItemsForCase({item,snapshots:fetched});
  assert.deepEqual(options.map(candidate=>candidate.id),
    ["primary-event","recorded-event","primary-task","recorded-task"]);
  assert.ok(options.every(option=>option.eligible===false));
});

test("unrelated repair-search snapshots cannot become orphan choices even with includedBy provenance",async()=>{
  const searched=snapshot("calendar","search-result",calendar("search-result"),
    {includedBy:["Selected Calendar item for this repair"]});
  const fetched=await hydrateCaseOrphanEvidence(item,[searched],async identity=>({
    ref:identity,object:identity.side==="todoist"?todoist(identity.id):calendar(identity.id),
  }));
  assert.ok(fetched.some(s=>s.ref.id==="search-result"),"repair recheck may retain unrelated context");
  const options=orphanItemsForCase({item,snapshots:fetched});
  assert.ok(options.length===4);
  assert.equal(options.some(option=>option.id==="search-result"),false);
});

test("failed provider reads and foreign ownership are visibly unverified, never missing or actionable",async()=>{
  const fetched=await hydrateCaseOrphanEvidence(item,[],async identity=>{
    if(identity.id==="recorded-task")throw new Error("429 rate limit");
    if(identity.id==="recorded-event")return {ref:ref("calendar","other-event"),object:calendar("other-event")};
    return {ref:identity,object:identity.side==="todoist"?todoist(identity.id):calendar(identity.id)};
  });
  const failure=fetched.filter(s=>s.lookupError);
  assert.deepEqual(failure.map(s=>s.ref.id),["recorded-event","recorded-task"]);
  const options=orphanItemsForCase({item,snapshots:fetched});
  for(const id of ["recorded-event","recorded-task"]){
    const option=options.find(x=>x.id===id);
    assert.equal(option.status,"unverified");
    assert.equal(option.live,false);
    assert.equal(option.eligible,false);
    assert.match(option.reason,/could not be verified/);
  }
});

test("case-bound hydration refuses oversized immutable candidate evidence before any provider reads",async()=>{
  const huge={...item,decision:{context:{candidateTaskIds:Array.from({length:21},(_,i)=>"task-"+i)}}};
  let reads=0;
  await assert.rejects(hydrateCaseOrphanEvidence(huge,[],async()=>{reads++;throw Error("unexpected");}),
    /more than 20 provider identities/);
  assert.equal(reads,0);
});

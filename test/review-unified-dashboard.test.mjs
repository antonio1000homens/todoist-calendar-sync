import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {reconciliationScopes,manualReconciliationTarget} from "../review-ui/reconciliation-scope.mjs";
import {orphanItemsForCase} from "../review-ui/orphan-selection.mjs";

const main=readFileSync(new URL("../review-ui/main.tsx",import.meta.url),"utf8");
const css=readFileSync(new URL("../review-ui/review.css",import.meta.url),"utf8");

test("#428 defaults to one inbox and independently scoped reports for three profiles",()=>{
  assert.match(main,/\[profile,setProfile\] = useState\("all"\)/);
  assert.match(main,/createScopedRequestGate\("all"\)/);
  assert.match(main,/const overviewProfiles=reconciliationScopes\("all"\)/);
  assert.deepEqual(reconciliationScopes("all"),["home","antonio","work"]);
  assert.match(main,/className="profile-report-grid"/);
  assert.match(main,/className="profile-report-item"/);
  assert.match(css,/\.profile-report-grid\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css,/@media\(max-width:680px\)\{\.profile-report-grid\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(main,/cases\?profile=\$\{profile\}&history=\$\{history\}/);
});

test("#428 opening Home alert in all-profiles inbox does not drop Work or Antonio",()=>{
  const selection=main.slice(main.indexOf("const selectCase="),main.indexOf("const changeReviewProfile="));
  assert.match(selection,/item\.profile!==profile&&profile!=="all"/);
  assert.match(selection,/setReconcileProfile\(item\.profile\)/);
  assert.match(selection,/setSelected\(item\)/);
  assert.match(main,/className="case-profile">\{item\.profile\}/);
  assert.equal(manualReconciliationTarget({filter:"all",selectedProfile:"work",chosenProfile:"home"}),"work");
  assert.equal(manualReconciliationTarget({filter:"all",selectedProfile:"home",chosenProfile:"work"}),"home");
});

test("#428 hides zero-diagnostic panels but preserves pagination and retirement tools",()=>{
  assert.match(main,/view\.diagnostics\.some\(\(item:any\)=>history\|\|item\.caseStatus!=="retired"\)\|\|Boolean\(view\.cursor\)/);
  assert.match(main,/<details className="preview history-tools">/);
  assert.match(main,/<RetirementHistory key=\{runProfile\}/);
  assert.match(main,/<ErasureRecoveryPanel api=\{api\}/);
  assert.match(main,/<details className="run-technical">/);
});

test("#428 no-ID incident offers operational actions rather than dead orphan/repair forms",()=>{
  const orphan=orphanItemsForCase({item:{id:"home-operational",profile:"home",status:"open",decision:{type:"operational_dlq",context:{kind:"manual"}}},snapshots:[]});
  assert.deepEqual(orphan,[]);
  assert.match(main,/orphanItemsForCase\(\{item:details\.item,snapshots:details\.snapshots\|\|\[\]\}\)\.length>0/);
  assert.match(main,/\(hasProviderIds\|\|hasLiveIdentity\)&&<div className="preview">/);
  assert.match(main,/!hasProviderIds&&!hasLiveIdentity&&/);
  assert.match(main,/No provider item to repair/);
  assert.match(main,/Request reconciliation for \{selected\.profile\}/);
  assert.match(main,/Dismiss alert only/);
  assert.match(main,/\(hasProviderIds\|\|hasLiveIdentity\)/);
});

test("#428 manual reconciliation remains single-profile and requires an explicit target",()=>{
  assert.equal(manualReconciliationTarget({filter:"all",chosenProfile:"all"}),undefined);
  assert.equal(manualReconciliationTarget({filter:"all",chosenProfile:""}),undefined);
  assert.match(main,/const target=manualTarget/);
  assert.match(main,/if\(!target\)/);
  assert.match(main,/JSON\.stringify\(\{profile:target\}\)/);
  assert.doesNotMatch(main,/JSON\.stringify\(\{profile:"all"\}\)/);
});

import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {providerRecheckFeedback,reconciliationRequestFeedback} from "../review-ui/action-feedback.mjs";
const ui=readFileSync(new URL("../review-ui/main.tsx",import.meta.url),"utf8");

test("#478 successful read-only provider GET confirms deleted pair, not cleanup",()=>{
 const result=providerRecheckFeedback({unmappedDeletion:{bothGone:true,state:"providers_deleted"}},"11/11/2026 16:56");
 assert.equal(result.phase,"success");
 assert.match(result.message,/16:56/);
 assert.match(result.message,/Todoist is missing; Calendar is cancelled\/deleted/);
 assert.match(result.message,/read-only; guarded cleanup is still pending/);
});
test("#478 partial, unverified and unknown provider status fail closed",()=>{
 for(const state of ["partial","unverified","mapping_blocked"]){
   const r=providerRecheckFeedback({unmappedDeletion:{state,bothGone:false,reason:"Incomplete"}},"check time");
   assert.equal(r.phase,"warning");
   assert.match(r.message,/not fully verified/);
   assert.match(r.message,/No cleanup was performed/);
 }
 const unknown=providerRecheckFeedback({},"check time");
 assert.equal(unknown.phase,"warning");
 assert.match(unknown.message,/No cleanup was performed/);
});
test("#478 reconciliation response is only an acknowledgement",()=>{
 const r=reconciliationRequestFeedback("work",{run:{generation:"g1"},reconciliation:{created:true}},"16:57");
 assert.equal(r.phase,"success");assert.match(r.message,/New run requested/);
 assert.match(r.message,/Generation g1/);
 assert.match(r.message,/not yet verified/);
 assert.match(reconciliationRequestFeedback("home",{reconciliation:{created:false}},"16:58").message,/Existing run retained/);
});
test("#478 inline success, loading and errors are case-scoped and accessible",()=>{
 const read=ui.slice(ui.indexOf("const refreshAffected="),ui.indexOf("const createPreview="));
 const write=ui.slice(ui.indexOf("const runReconciliation="),ui.indexOf("const dismissAlert="));
 for(const term of ['phase:"checking"','phase:"error"',"actionLocks.current.has(lockKey)","actionLocks.current.delete(lockKey)"])
   assert.ok(read.includes(term),term);
 assert.ok(read.includes("providerRecheckFeedback(result,new Date().toLocaleString())"));
 assert.ok(read.includes("requestVersion===selectionVersion.current"));
 assert.doesNotMatch(read,/method:"POST"/);
 for(const term of ['phase:"checking"','phase:"warning"','phase:"error"',"reconciliationRequestFeedback(target,result,new Date().toLocaleString())"])
   assert.ok(write.includes(term),term);
 assert.ok(write.includes("requestedVersion===selectionVersion.current"));
 assert.match(write,/method:"POST"/);
 assert.match(ui,/currentRecheckFeedback=recheckFeedback\?\.caseKey===detailKey/);
 assert.match(ui,/currentCleanupFeedback=cleanupFeedback\?\.caseKey===detailKey/);
 assert.match(ui,/setRecheckFeedback\(undefined\);setCleanupFeedback\(undefined\)/);
 assert.match(ui,/currentRecheckFeedback&&<p[^>]+role="status" aria-live="polite"/);
 assert.match(ui,/currentCleanupFeedback&&<p[^>]+role="status" aria-live="polite"/);
 assert.match(ui,/Checking provider items…/);
 assert.match(ui,/Submitting reconciliation…/);
});

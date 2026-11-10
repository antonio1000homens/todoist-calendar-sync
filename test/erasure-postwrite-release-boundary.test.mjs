import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {listTypeScriptSources} from "./helpers/source-files.mjs";

const root=path.join(path.dirname(fileURLToPath(import.meta.url)),"../src");
test("the future post-write marker+fence transaction stays offline, not invoked by any deployed source",async()=>{
  const files=await listTypeScriptSources(root);
  let foundDeclaration=0;
  for(const file of files) {
    const source=await readFile(file,"utf8");
    const relative=path.relative(root,file);
    if(relative==="erasure-replay-barrier.ts"){
      foundDeclaration+=(source.match(/export function atomicReplayRelease\(/g)||[]).length;
      continue;
    }
    assert.doesNotMatch(source,/\batomicReplayRelease\s*\(/,
      "No worker, API or recovery controller may execute the staged post-write fence release: "+relative);
    assert.doesNotMatch(source,/import\s*\{[^}]*\batomicReplayRelease\b[^}]*\}\s*from\s*["'][^"']*erasure-replay-barrier\.js/,
      "Staged replay release must not be imported into live entrypoints: "+relative);
  }
  assert.equal(foundDeclaration,1);
});

test("superseded orphan HMAC marker installation and verification remain offline",async()=>{
  // Issue #349 uses a bounded Todoist project-comment tombstone, not the
  // historical, permanent DynamoDB HMAC marker design. These legacy exports
  // remain in the barrier module pending a separate source-code retirement.
  // Reintroducing a live consumer is a policy regression, not a reason to
  // re-enable the former orphan marker test matrix.
  const obsolete=["orphanReplayInstallTransaction","assertOrphanReplayGuard"];
  for(const file of await listTypeScriptSources(root)) {
    const relative=path.relative(root,file);
    if(relative==="erasure-replay-barrier.ts")continue;
    const source=await readFile(file,"utf8");
    for(const symbol of obsolete) {
      assert.ok(!source.includes(symbol),
        "Legacy orphan HMAC replay helper must not be used by live source: "+symbol+" in "+relative);
    }
  }
});

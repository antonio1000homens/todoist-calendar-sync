import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {listTypeScriptSources} from "./helpers/source-files.mjs";

const root=path.join(path.dirname(fileURLToPath(import.meta.url)),"../src");

// The original irreversible HMAC marker+fence release and the orphan marker
// installer were never connected to a production caller. #349 superseded
// them with a bounded Todoist project-comment tombstone and a deletion
// completion transaction that writes NO DynamoDB replay identity.
//
// Verify the removed code stays absent even after subsequent refactors.
// The separate legacy HMAC ADMISSION READER remains intentionally compiled
// and disabled until existing rows/rollback and #347 invocation paths can be
// audited independently. This guard must not prevent those read-only checks.
test("retired permanent-HMAC marker installers and staged release paths remain absent",async()=>{
  const retired=[
    "atomicReplayRelease",
    "verifyAtomicReplayRelease",
    "orphanReplayInstallTransaction",
    "assertOrphanReplayGuard",
    "postWriteWorkerMappingManifest",
    "completePostWriteMappingRestore",
    "restorePostWriteWorkerMappings",
    "PostWriteReleaseProof",
    "ERASURE_POSTWRITE_RESTORE#",
    "ORPHAN_REPLAY_GUARD#",
    "erasure-postwrite-mapping-restore",
  ];
  for(const file of await listTypeScriptSources(root)) {
    const source=await readFile(file,"utf8");
    const relative=path.relative(root,file);
    for(const name of retired){
      assert.ok(!source.includes(name),
        "Superseded HMAC write/release contract must not reappear: "+name+" in "+relative);
    }
  }
});

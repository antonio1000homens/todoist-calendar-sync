import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {collectCodeAudit} from "../scripts/audit-erasure-lambda-code.mjs";

test("Lambda code audit verifies one ZIP per unique digest without exposing package URLs",async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"issue307-code-audit-test-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const bundle=path.join(root,"handler.js");
  const source="const barrier='ERASURE_REPLAY_BARRIER_VERSION'; const marker='ERASURE_REPLAY#';";
  await writeFile(bundle,source);
  const zip=path.join(root,"lambda.zip");
  const zipped=spawnSync("zip",["-q",zip,"handler.js"],{cwd:root});
  assert.equal(zipped.status,0);
  const bytes=await readFile(zip);
  const digest=createHash("sha256").update(bytes).digest("base64");
  const before=globalThis.fetch;
  globalThis.fetch=async url=>{
    assert.equal(url,"https://example.invalid/presigned-secret");
    return new Response(bytes,{status:200});
  };
  t.after(()=>{globalThis.fetch=before;});
  const client={async send(command){
    if(command.constructor.name==="ListVersionsByFunctionCommand")return {Versions:[
      {Version:"$LATEST",CodeSha256:digest},{Version:"1",CodeSha256:digest},
      {Version:"2",CodeSha256:digest},{Version:"3",CodeSha256:digest},
    ]};
    if(command.constructor.name==="GetFunctionCommand")return {
      Configuration:{CodeSha256:digest},Code:{Location:"https://example.invalid/presigned-secret"},
    };
    throw new Error("Unexpected AWS command");
  }};
  const report=await collectCodeAudit(client,{functionNames:["todoist-calendar-sync-ingress-production"],region:"eu-west-2"});
  const fn=report.functions[0];
  assert.equal(fn.versionCount,4);
  assert.equal(fn.publishedVersionCount,3);
  assert.equal(fn.uniqueCodeDigestCount,1);
  assert.equal(fn.verifiedPackageCount,1);
  assert.deepEqual(fn.digests[0].versions,["1","2","3","$LATEST"]);
  assert.equal(fn.digests[0].markerStrings.replayGate,true);
  assert.equal(fn.digests[0].markerStrings.markerKey,true);
  assert.equal(report.replayBarrierMayBeEnabled,false);
  assert.equal(report.executableRecoveryMayBeEnabled,false);
  assert.equal(JSON.stringify(report).includes("presigned-secret"),false);
});

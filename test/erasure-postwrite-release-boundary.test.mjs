import assert from "node:assert/strict";
import test from "node:test";
import {readFile,readdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";

const root=path.join(path.dirname(fileURLToPath(import.meta.url)),"../src");
async function recursiveSources(folder) {
  const entries=await readdir(folder,{withFileTypes:true});
  const all=[];
  for(const entry of entries) {
    const file=path.join(folder,entry.name);
    if(entry.isDirectory())all.push(...await recursiveSources(file));
    else if(entry.isFile()&&file.endsWith(".ts"))all.push(file);
  }
  return all;
}
test("the future post-write marker+fence transaction stays offline, not invoked by any deployed source",async()=>{
  const files=await recursiveSources(root);
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

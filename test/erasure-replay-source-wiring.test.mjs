import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {listTypeScriptSources} from "./helpers/source-files.mjs";

const src=path.join(path.dirname(fileURLToPath(import.meta.url)),"../src");

/** Lightweight bounded call scanner, independent of TypeScript's removed JS
 * compiler APIs in v7. Only the explicit Todoist provider call signatures
 * are examined. Nested parentheses, object literals and quoted strings cannot
 * make an absent source argument appear as a third argument. */
function callArguments(source,method,file) {
  const calls=[];
  const matchCall=new RegExp("\\."+method+"\\s*\\(","g");
  let match;
  while((match=matchCall.exec(source))){
    const args=[];
    let start=matchCall.lastIndex,depth=1,brackets=0,braces=0,quote="";
    let i=start;
    for(;i<source.length;i++){
      const c=source[i],next=source[i+1];
      if(quote){
        if(c==="\\"){i++;continue;}
        if(c===quote)quote="";
        continue;
      }
      if(c==="/"&&next==="/"){
        i=source.indexOf("\n",i+2);
        if(i<0)break;
        continue;
      }
      if(c==="/"&&next==="*"){
        const end=source.indexOf("*/",i+2);
        if(end<0)break;
        i=end+1;
        continue;
      }
      if(c==="'"||c==='"'||c.charCodeAt(0)===96){quote=c;continue;}
      if(c==="(")depth++;
      else if(c===")"){
        depth--;
        if(!depth){args.push(source.slice(start,i).trim());break;}
      } else if(c==="[")brackets++;
      else if(c==="]")brackets--;
      else if(c==="{")braces++;
      else if(c==="}")braces--;
      else if(c===","&&depth===1&&!brackets&&!braces){
        args.push(source.slice(start,i).trim());
        start=i+1;
      }
    }
    assert.equal(depth,0,"Unclosed "+method+" call in "+file);
    calls.push(args);
  }
  return calls;
}
test("production Todoist creation paths must supply checked Calendar provenance",async()=>{
  let creators=0;
  let repairs=0;
  for(const file of await listTypeScriptSources(src)) {
    const source=await readFile(file,"utf8");
    const location=path.relative(src,file);
    for(const args of callArguments(source,"upsertTask",location)) {
      const existing=args[1]?.trim();
      const canCreate=!existing||existing==="undefined"||existing==="null"
        ||existing.includes("?.")||/\bundefined\b/.test(existing);
      if(!canCreate)continue;
      assert.ok(args.length>=3,"Todoist create-capable upsert missing Calendar source: "+location);
      assert.match(args[2],/^calendarReplaySourceIds\s*\(/,
        "Todoist create-capable upsert has unverified source: "+location);
      creators++;
    }
    for(const args of callArguments(source,"createTaskOnce",location)) {
      assert.ok(args.length>=3,"Todoist idempotent creation missing Calendar source: "+location);
      assert.match(args[2],/calendarReplaySourceIds\s*\(|args\[2\]/,
        "Todoist idempotent creation has unverified source: "+location);
      repairs++;
    }
  }
  // Consolidation removes duplicated create-capable call sites; keep a floor
  // that still covers the normal, recovery, and manual Calendar-origin paths.
  assert.ok(creators>=8,"Expected normal, recovery, and manual Calendar-origin task creation paths");
  const syncSource=await readFile(path.join(src,"sync.ts"),"utf8");
  const manualSource=await readFile(path.join(src,"manual-intervention.ts"),"utf8");
  assert.match(syncSource,/upsertTask\([^;]*calendarReplaySourceIds\(/s,
    "Normal Calendar-origin task creation must bind checked provider provenance");
  assert.match(manualSource,/upsertTask\([^;]*calendarReplaySourceIds\(/s,
    "Manual Calendar-origin task creation must bind checked provider provenance");
  assert.equal(repairs,1,
    "only the guarded repair dispatcher retains idempotent task creation; normal sync keeps provider IDs");
});

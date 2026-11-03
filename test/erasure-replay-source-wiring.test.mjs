import assert from "node:assert/strict";
import test from "node:test";
import {readFile,readdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import ts from "typescript";

const src=path.join(path.dirname(fileURLToPath(import.meta.url)),"../src");
async function sourceFiles(dir) {
  const result=[];
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())result.push(...await sourceFiles(full));
    else if(entry.isFile()&&entry.name.endsWith(".ts"))result.push(full);
  }
  return result;
}

test("all production Todoist creation entrypoints carry explicit Calendar source identity",async()=>{
  const checked=[];
  for(const file of await sourceFiles(src)) {
    const source=await readFile(file,"utf8");
    const parsed=ts.createSourceFile(file,source,(ts.ScriptTarget?.Latest ?? 99),true,(ts.ScriptKind?.TS ?? 3));
    const visit=node=>{
      if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)){
        const method=node.expression.name.text;
        if(method==="upsertTask"||method==="createTaskOnce"){
          const args=node.arguments;
          const context=path.relative(src,file)+":"+parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line;
          if(method==="createTaskOnce"){
            assert.ok(args.length>=3,`Todoist idempotent creation lacks source identity: ${context}`);
            const sourceArg=args[2].getText(parsed);
            assert.match(sourceArg,/calendarReplaySourceIds\(|args\[2\]/,
              `Todoist idempotent creation has unverified provenance: ${context}`);
            checked.push(context);
          } else {
            const target=args[1]?.getText(parsed);
            // Known task IDs are safe for updates. Missing/optional task IDs
            // might invoke POST /tasks and therefore MUST supply event aliases.
            const canCreate=!target || /\?\.|\bundefined\b|\bnull\b/.test(target);
            if(canCreate){
              assert.ok(args.length>=3,`Todoist creation lacks source identity: ${context}`);
              assert.match(args[2].getText(parsed),/calendarReplaySourceIds\(/,
                `Todoist creation has unverified Calendar provenance: ${context}`);
              checked.push(context);
            }
          }
        }
      }
      ts.forEachChild(node,visit);
    };
    visit(parsed);
  }
  assert.ok(checked.length>=12,"Expected coverage of sync, reconciliation and repair creation paths");
});

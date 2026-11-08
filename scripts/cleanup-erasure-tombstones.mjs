#!/usr/bin/env node
// Operator-run cleanup of exact, expired project-comment erasure markers.
import { cleanupExpiredProjectDeletionTombstones } from "../dist/mapping-comments.js";
import { profiles, todoistToken } from "../dist/config.js";
import { Todoist } from "../dist/providers.js";

const args=process.argv.slice(2);
const options=new Map();
for(const arg of args) {
  if(arg==="--apply") {if(options.has("apply"))throw new Error("Duplicate --apply");options.set("apply","true");continue;}
  const match=/^--(profile|confirm)=(.+)$/.exec(arg);
  if(!match||options.has(match[1]))throw new Error("Unknown, empty, or duplicate option: "+arg);
  options.set(match[1],match[2]);
}
const profile=options.get("profile");
if(!["home","antonio","work"].includes(profile))throw new Error("--profile=home|antonio|work is required");
const apply=options.has("apply");
if(apply&&options.get("confirm")!=="DELETE_EXPIRED_ERASURE_TOMBSTONES")
  throw new Error("Apply requires --confirm=DELETE_EXPIRED_ERASURE_TOMBSTONES");
if(!apply&&options.has("confirm"))throw new Error("--confirm is valid only with --apply");
const client=new Todoist(await todoistToken(profile));
const result=await cleanupExpiredProjectDeletionTombstones(client,profile,profiles[profile].todoistProjectId,{apply});
console.log(JSON.stringify({profile,mode:apply?"apply":"report",...result},null,2));
if(result.skippedChanged)process.exitCode=2;

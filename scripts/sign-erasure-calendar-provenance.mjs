#!/usr/bin/env node
/**
 * Offline-only #333 signing utility. Private key and manifest stay on the
 * operator's machine. Output MUST be redirected to a protected local file.
 * This tool does not access AWS, Google, Todoist or any state writer.
 */
import {readFileSync,statSync} from "node:fs";
import {createPrivateKey,sign} from "node:crypto";
import {isAbsolute} from "node:path";
import {canonicalCalendarProvenanceJson} from "../dist/erasure-calendar-provenance.js";

const options=Object.fromEntries(process.argv.slice(2).map(arg=>{
  const match=/^--(manifest|private-key)=(.+)$/.exec(arg);
  if(!match)throw new Error("Only absolute --manifest and --private-key options are accepted");
  return [match[1],match[2]];
}));
if(Object.keys(options).length!==2||!options.manifest||!options["private-key"]
  ||!isAbsolute(options.manifest)||!isAbsolute(options["private-key"]))
  throw new Error("Absolute --manifest and --private-key paths are required");
for(const file of Object.values(options))if(statSync(file).size>1024*1024)
  throw new Error("Operator attestation file exceeds the safety bound");
const payload=JSON.parse(readFileSync(options.manifest,"utf8"));
if(!payload||typeof payload!=="object"||Array.isArray(payload)
  ||Object.prototype.hasOwnProperty.call(payload,"signature"))
  throw new Error("Supply an unsigned provenance document");
const key=createPrivateKey(readFileSync(options["private-key"]));
if(key.asymmetricKeyType!=="ed25519")throw new Error("The signing key must be Ed25519");
const signature=sign(null,Buffer.from(canonicalCalendarProvenanceJson(payload)),key).toString("base64");
process.stdout.write(JSON.stringify({...payload,signature},null,2)+"\n");

#!/usr/bin/env node
import { runPurgeItem } from "./purge-item-service.mjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runPurgeItem().then(result => {
    if (result?.status === "partial_failure") process.exitCode = 2;
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

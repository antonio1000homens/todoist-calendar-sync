#!/usr/bin/env node

const files = process.argv.slice(2);
const result = { full: false, unit: false, review: false, worker: false, sam: false, public: false, e2eSyntax: false };

for (const file of files) {
  if (/^(src\/|package\.json$|package-lock\.json$|tsconfig\.json$|test\/setup-env\.mjs$|scripts\/select-ci-checks\.mjs$|\.github\/workflows\/)/.test(file)) result.full = true;
  if (/^test\/.*\.test\.mjs$/.test(file)) result.unit = true;
  else if (/^test\//.test(file)) result.full = true;
  if (/^(review-ui\/|cloudflare\/calendar-sync\/public\/review\/)/.test(file)) result.review = true;
  if (/^cloudflare\/calendar-sync\//.test(file)) result.worker = true;
  if (/^(template\.yaml$|samconfig\.toml$|infrastructure\/|deploy\.sh$|src\/|package(-lock)?\.json$)/.test(file)) result.sam = true;
  if (/^(src\/|scripts\/|README\.md$|\.github\/)/.test(file)) result.public = true;
  if (/^scripts\/production-e2e\.mjs$/.test(file)) result.e2eSyntax = true;
}

if (result.full) result.unit = true;
if (files.length === 0) Object.assign(result, { full: true, unit: true, review: true, worker: true, sam: true, public: true, e2eSyntax: true });
for (const [key, value] of Object.entries(result)) console.log(`${key}=${value}`);

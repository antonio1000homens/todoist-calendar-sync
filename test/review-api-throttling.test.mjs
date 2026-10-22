import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createReviewApiClient, isAbortError } from "../review-ui/api-client.mjs";

const ok = data => Response.json(data);
const throttled = headers => new Response("Lambda throttled", { status: 429, headers });

test("a realistic 24-case inbox never fans out more than one request at a time", async () => {
  let inFlight = 0, peak = 0;
  const seen = [];
  const api = createReviewApiClient({
    fetchImpl: async path => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      seen.push(path);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight--;
      return ok({ item: { id: path.split("/").at(-1) }, snapshots: [] });
    },
  });

  const result = await Promise.all(Array.from({ length: 24 },
    (_, i) => api(`cases/case-${i}`)));
  assert.equal(peak, 1);
  assert.equal(seen.length, 24);
  assert.deepEqual(result.map(item => item.item.id), Array.from({ length: 24 }, (_, i) => `case-${i}`));
});

test("rapid case changes discard queued requests and abort the old selected case", async () => {
  const requested = [];
  const api = createReviewApiClient({
    fetchImpl: async (path, init) => {
      requested.push(path);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 3);
        init.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
      return ok({ item: { id: path.split("/").at(-1) }, snapshots: [] });
    },
  });
  const controllers = Array.from({ length: 24 }, () => new AbortController());
  const pending = controllers.map((controller, i) => api(`cases/case-${i}`, { signal: controller.signal }));
  controllers.slice(0, -1).forEach(controller => controller.abort());
  const outcomes = await Promise.allSettled(pending);
  assert.equal(outcomes.filter(result => result.status === "rejected" && isAbortError(result.reason)).length, 23);
  assert.equal(outcomes.at(-1).status, "fulfilled");
  assert.equal(outcomes.at(-1).value.item.id, "case-23");
  assert.deepEqual(requested, ["/review/api/cases/case-23"]);
});

test("429 with non-JSON Lambda body is retried with bounded backoff and eventually hydrates", async () => {
  let requests = 0;
  const waits = [], notifications = [];
  const api = createReviewApiClient({
    fetchImpl: async () => ++requests < 3 ? throttled() : ok({ item: { id: "case" }, snapshots: [] }),
    wait: async ms => { waits.push(ms); },
    random: () => 0,
  });
  const detail = await api("cases/case", {}, { onRetry: info => notifications.push(info) });
  assert.equal(detail.item.id, "case");
  assert.equal(requests, 3);
  assert.deepEqual(waits, [300, 600]);
  assert.deepEqual(notifications.map(item => item.attempt), [1, 2]);
});

test("Retry-After is honoured within the retry cap", async () => {
  const waits = [];
  let count = 0;
  const api = createReviewApiClient({
    fetchImpl: async () => ++count === 1 ? throttled({ "Retry-After": "12" }) : ok({ items: [] }),
    wait: async ms => { waits.push(ms); },
  });
  await api("cases?profile=home");
  assert.deepEqual(waits, [6000]);
  assert.equal(count, 2);
});

test("exhausted throttling surfaces a usable 429 error and permits manual retry", async () => {
  let calls = 0;
  const api = createReviewApiClient({
    fetchImpl: async () => { calls++; return throttled(); },
    wait: async () => {},
  });
  await assert.rejects(api("cases/case"), error => error.status === 429 && /retry/i.test(error.message));
  assert.equal(calls, 4);
  await assert.rejects(api("cases/case"), error => error.status === 429);
  assert.equal(calls, 8);
});

test("mutations and other HTTP errors are never automatically replayed", async () => {
  let calls = 0;
  const api = createReviewApiClient({
    fetchImpl: async () => {
      calls++;
      return calls === 1 ? throttled() : Response.json({ error: "invalid selection" }, { status: 400 });
    },
    wait: async () => {},
  });
  await assert.rejects(api("cases/case/previews", { method: "POST", body: "{}" }), error => error.status === 429);
  await assert.rejects(api("cases/case"), error => error.status === 400 && error.message === "invalid selection");
  assert.equal(calls, 2);
});

test("aborting during rate-limit backoff cancels the retry", async () => {
  const controller = new AbortController();
  let calls = 0;
  const api = createReviewApiClient({
    fetchImpl: async () => { calls++; return throttled(); },
  });
  await assert.rejects(api("cases/case", { signal: controller.signal }, {
    onRetry: () => controller.abort(),
  }), isAbortError);
  assert.equal(calls, 1);
});

test("UI requests only the selected case and keeps failed detail panels out of repair verification", () => {
  const source = readFileSync(new URL("../review-ui/main.tsx", import.meta.url), "utf8");
  assert.match(source, /if \(!selected\).*setDetails\(undefined\)/);
  assert.match(source, /api\(`cases\/\$\{encodeURIComponent\(selected.id\)\}\`,\{signal:controller.signal\}/);
  assert.match(source, /role="status"/);
  assert.match(source, /Retry case details/);
  assert.match(source, /disabled=\{busy\|\|!details\}/);
  assert.match(source, /!details\?<div className="notice detail-load"/);
});

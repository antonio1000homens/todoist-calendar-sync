import { isCleanReconciliationPass } from "./reconciliation-acceptance-logic.mjs";

function sanitizedCounts(result = {}) {
  return Object.fromEntries(Object.entries(result)
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
    .sort(([left], [right]) => left.localeCompare(right)));
}

export async function runReconciliationAcceptance({
  state,
  requestProfileReconciliation,
  profiles = ["antonio", "home", "work"],
  timeoutMs,
  pollIntervalMs = 15_000,
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onPass = () => {},
}) {
  const passesByProfile = Object.fromEntries(profiles.map(profile => [profile, []]));
  const deadline = now() + timeoutMs;
  const wait = async readiness => {
    while (now() < deadline) {
      const value = await readiness();
      if (value) return value;
      await sleep(pollIntervalMs);
    }
    throw new Error("reconciliation_acceptance_timeout");
  };

  for (const profile of profiles) {
    for (let passNumber = 1; passNumber <= 2; passNumber += 1) {
      await wait(async () => !(await state.getReconciliationState(profile))?.pending);
      let request;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        request = await requestProfileReconciliation(profile);
        if (request.queued) break;
        if (!request.coalesced && request.enqueueError) throw new Error("reconciliation_enqueue_failed");
        await wait(async () => !(await state.getReconciliationState(profile))?.pending);
      }
      if (!request?.queued) throw new Error("reconciliation_run_not_queued");
      const generation = request.generation;
      const current = await wait(async () => {
        const candidate = await state.getReconciliationState(profile);
        if (candidate?.generation !== generation) throw new Error("reconciliation_generation_changed");
        return candidate && !candidate.pending ? candidate : undefined;
      });
      const pass = {
        pass: passNumber,
        status: current.status || "unknown",
        unresolved: Number.isFinite(current.unresolved) ? current.unresolved : null,
        counts: sanitizedCounts(current.result),
      };
      passesByProfile[profile].push(pass);
      const clean = isCleanReconciliationPass(pass, passNumber);
      await onPass({ profile, pass, clean });
      if (!clean) return { mode: "production-reconciliation-acceptance", status: "failed", profiles: passesByProfile };
    }
  }
  return { mode: "production-reconciliation-acceptance", status: "passed", profiles: passesByProfile };
}

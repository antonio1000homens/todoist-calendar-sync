// Review API invocations share a small Lambda concurrency reservation.
// Serialize this tab's calls and retry only safe reads when Lambda returns 429.
const abortError = () => new DOMException("Review request cancelled", "AbortError");
export const isAbortError = error => error?.name === "AbortError";
export function reconciliationPollDelayMs(attempt = 0) {
  const normalized = Math.max(0, Math.floor(attempt));
  return Math.min(60_000, 5_000 * 2 ** normalized);
}

export function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryDelay(response, attempt, baseDelayMs, maxDelayMs, random) {
  const header = response.headers?.get("retry-after");
  if (header) {
    const seconds = Number(header);
    const until = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(until)) return Math.min(maxDelayMs, Math.max(0, until));
  }
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.min(maxDelayMs, Math.ceil(exponential * (0.75 + random() * 0.5)));
}

export function createReviewApiClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  wait = delay,
  random = Math.random,
  concurrency = 1,
  maxAttempts = 4,
  baseDelayMs = 400,
  maxDelayMs = 6000,
} = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Invalid review API concurrency");
  const queue = [];
  let active = 0;

  function drain() {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      if (job.signal?.aborted) {
        job.reject(abortError());
        continue;
      }
      active++;
      Promise.resolve().then(job.work).then(job.resolve, job.reject).finally(() => {
        active--;
        drain();
      });
    }
  }

  function schedule(work, signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = queue.indexOf(job);
        if (index !== -1) {
          queue.splice(index, 1);
          job.reject(abortError());
        }
      };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const job = {
        signal, work,
        resolve: value => { cleanup(); resolve(value); },
        reject: error => { cleanup(); reject(error); },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(job);
      drain();
    });
  }

  return (path, init = {}, { onRetry } = {}) => schedule(async () => {
    const method = (init.method || "GET").toUpperCase();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (init.signal?.aborted) throw abortError();
      const response = await fetchImpl("/review/api/" + path, {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers || {}) },
      });
      // Lambda's own 429 response need not contain JSON.
      const data = await response.json().catch(() => ({}));
      if (init.signal?.aborted) throw abortError();
      if (response.ok) return data;

      if (response.status === 429 && method === "GET" && attempt + 1 < maxAttempts) {
        const waitMs = retryDelay(response, attempt, baseDelayMs, maxDelayMs, random);
        onRetry?.({ attempt: attempt + 1, waitMs });
        await wait(waitMs, init.signal);
        continue;
      }

      const message = response.status === 429
        ? "Review API is busy (HTTP 429). Automatic retries have been exhausted; retry this request."
        : data.message || data.error || `Request failed (${response.status})`;
      const error = new Error(message);
      error.status = response.status;
      error.data = data;
      throw error;
    }
  }, init.signal);
}

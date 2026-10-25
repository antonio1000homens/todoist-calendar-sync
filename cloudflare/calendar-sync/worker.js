const ALLOWED_HOST = "calendar-sync.alf-broadcast.co.uk";
const CALENDAR_PATH = "/calendar";
const TODOIST_ROUTE = /^\/todoist(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
const REVIEW_API_PREFIX = "/review/api/";
const PROXY_AUTH_HEADER = "x-gcp-proxy-auth";

const STATIC_CHANNEL_PROFILES = new Map([
  ["antonio1000homens-nrwindsor", "antonio"],
  ["home1000homens-nrwindsor", "home"],
  ["work1000homens-nrwindsor", "work"],
]);

const V3_CHANNEL = /^(antonio1000homens|home1000homens|work1000homens)-calendar-sync-v3-[^\s/]+$/;
const V3_PROFILES = { antonio1000homens: "antonio", home1000homens: "home", work1000homens: "work" };

export function profileForChannel(channelId) {
  if (!channelId) return undefined;
  const staticProfile = STATIC_CHANNEL_PROFILES.get(channelId);
  if (staticProfile) return staticProfile;
  const match = channelId.match(V3_CHANNEL);
  return match ? V3_PROFILES[match[1]] : undefined;
}

function errorResponse(error, status) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function forwardedHeaders(request, url, secret) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete(PROXY_AUTH_HEADER);
  headers.delete("x-worker-verified");
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", "https");
  headers.set(PROXY_AUTH_HEADER, secret);
  return headers;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.host !== ALLOWED_HOST) return errorResponse("not_found", 404);

    if (url.pathname.startsWith(REVIEW_API_PREFIX)) {
      if (!["GET", "POST"].includes(request.method)) return errorResponse("method_not_allowed", 405);
      if (!env.TODOIST_CALENDAR_SYNC_REVIEW_API_URL) return errorResponse("review_api_not_configured", 503);
      const target = new URL(env.TODOIST_CALENDAR_SYNC_REVIEW_API_URL);
      target.pathname = url.pathname;
      target.search = url.search;
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.set("x-forwarded-host", url.host);
      headers.set("x-forwarded-proto", "https");
      try {
        return await fetch(target, { method:request.method, headers, ...(request.method === "GET" ? {} : { body:await request.arrayBuffer() }), redirect:"manual" });
      } catch {
        return errorResponse("review_api_unreachable", 502);
      }
    }

    if (url.pathname === "/review") return Response.redirect(url.origin + "/review/", 308);
    if (url.pathname.startsWith("/review/")) {
      if (!["GET", "HEAD"].includes(request.method)) return errorResponse("method_not_allowed", 405);
      return env.ASSETS.fetch(request);
    }

    const isCalendar = url.pathname === CALENDAR_PATH;
    const isTodoist = TODOIST_ROUTE.test(url.pathname);
    if (!isCalendar && !isTodoist) return errorResponse("not_found", 404);
    if (request.method !== "POST") return errorResponse("method_not_allowed", 405);

    if (isCalendar) {
      const channelId = request.headers.get("x-goog-channel-id") || "";
      if (!profileForChannel(channelId)) return errorResponse("unsupported_calendar_channel", 404);
    }
    if (!env.TODOIST_CALENDAR_SYNC_AWS_INGRESS_URL || !env.TODOIST_CALENDAR_SYNC_PROXY_SHARED_SECRET) {
      return errorResponse("calendar_sync_proxy_not_configured", 503);
    }

    const target = new URL(env.TODOIST_CALENDAR_SYNC_AWS_INGRESS_URL);
    target.pathname = url.pathname;
    target.search = url.search;
    const body = await request.arrayBuffer();
    try {
      return await fetch(target, {
        method: "POST",
        headers: forwardedHeaders(request, url, env.TODOIST_CALENDAR_SYNC_PROXY_SHARED_SECRET),
        body,
        redirect: "manual",
      });
    } catch {
      return errorResponse("calendar_sync_downstream_unreachable", 502);
    }
  },
};

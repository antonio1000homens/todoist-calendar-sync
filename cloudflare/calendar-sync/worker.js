const ALLOWED_HOST = "calendar-sync.alf-broadcast.co.uk";
const CALENDAR_PATH = "/calendar";
const PROXY_AUTH_HEADER = "x-gcp-proxy-auth";

const STATIC_CHANNEL_PROFILES = new Map([
  ["antonio1000homens-nrwindsor", "antonio"],
  ["home1000homens-nrwindsor", "home"],
  ["work1000homens-nrwindsor", "work"],
  ["antonio1000homens-calendar-sync-v2", "antonio"],
  ["home1000homens-calendar-sync-v2", "home"],
  ["work1000homens-calendar-sync-v2", "work"],
]);

const V3_CHANNEL = /^(antonio1000homens|home1000homens|work1000homens)-calendar-sync-v3-[^\s/]+$/;
const V3_PROFILES = { antonio1000homens: "antonio", home1000homens: "home", work1000homens: "work" };
const LEGACY_ALIASES = {
  "antonio1000homens-calendar-sync-v2": "antonio1000homens-nrwindsor",
  "home1000homens-calendar-sync-v2": "home1000homens-nrwindsor",
  "work1000homens-calendar-sync-v2": "work1000homens-nrwindsor",
};

export function profileForChannel(channelId) {
  if (!channelId) return undefined;
  const staticProfile = STATIC_CHANNEL_PROFILES.get(channelId);
  if (staticProfile) return staticProfile;
  const match = channelId.match(V3_CHANNEL);
  return match ? V3_PROFILES[match[1]] : undefined;
}

export function canonicalChannelId(channelId) {
  return LEGACY_ALIASES[channelId] || channelId;
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
  const channelId = headers.get("x-goog-channel-id");
  if (channelId) headers.set("x-goog-channel-id", canonicalChannelId(channelId));
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", "https");
  headers.set(PROXY_AUTH_HEADER, secret);
  return headers;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.host !== ALLOWED_HOST || url.pathname !== CALENDAR_PATH) return errorResponse("not_found", 404);
    if (request.method !== "POST") return errorResponse("method_not_allowed", 405);

    const channelId = request.headers.get("x-goog-channel-id") || "";
    if (!profileForChannel(channelId)) return errorResponse("unsupported_calendar_channel", 404);
    if (!env.TODOIST_CALENDAR_SYNC_AWS_INGRESS_URL || !env.TODOIST_CALENDAR_SYNC_PROXY_SHARED_SECRET) {
      return errorResponse("calendar_sync_proxy_not_configured", 503);
    }

    const target = new URL(env.TODOIST_CALENDAR_SYNC_AWS_INGRESS_URL);
    target.pathname = CALENDAR_PATH;
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

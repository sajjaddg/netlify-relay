const rawTargetBase = (Netlify.env.get("TARGET_DOMAIN") || "").trim();
const TARGET_BASE = rawTargetBase.replace(/\/$/, "");
const TIMEOUT_MS = Number(Netlify.env.get("RELAY_TIMEOUT_MS") || 25000);
const LOG_LEVEL = (Netlify.env.get("RELAY_LOG_LEVEL") || "info").toLowerCase();

const STRIP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

function shouldLog(level) {
  const order = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
  return (order[LOG_LEVEL] ?? 3) >= (order[level] ?? 3);
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ message: "unserializable_log" });
  }
}

export default async function handler(request) {
  if (!TARGET_BASE) {
    return new Response("Misconfigured: TARGET_DOMAIN is not set", { status: 500 });
  }

  try {
    const start = Date.now();
    const url = new URL(request.url);
    const targetUrl = TARGET_BASE + url.pathname + url.search;

    const headers = new Headers();
    let clientIp = null;
    let forwardedFor = null;

    for (const [key, value] of request.headers) {
      const k = key.toLowerCase();
      if (STRIP_HEADERS.has(k)) continue;
      if (k.startsWith("x-nf-")) continue;
      if (k.startsWith("x-netlify-")) continue;
      if (k === "x-real-ip") {
        clientIp = value;
        continue;
      }
      if (k === "x-forwarded-for") {
        forwardedFor = value;
        if (!clientIp) clientIp = value;
        continue;
      }
      headers.set(k, value);
    }

    if (clientIp) {
      const combined = forwardedFor ? `${forwardedFor}, ${clientIp}` : clientIp;
      headers.set("x-forwarded-for", combined);
    }

    const method = request.method;
    const hasBody = method !== "GET" && method !== "HEAD";

    const controller = new AbortController();
    const timeout = Number.isFinite(TIMEOUT_MS) && TIMEOUT_MS > 0 ? TIMEOUT_MS : 25000;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const fetchOptions = {
      method,
      headers,
      redirect: "manual",
      signal: controller.signal,
    };

    if (hasBody) {
      fetchOptions.body = request.body;
    }

    const requestId = crypto.randomUUID();
    if (shouldLog("info")) {
      console.log(
        safeJson({
          event: "relay_start",
          requestId,
          method,
          path: url.pathname,
          query: url.search,
          targetUrl,
        }),
      );
    }

    const upstream = await fetch(targetUrl, fetchOptions);
    clearTimeout(timeoutId);

    const responseHeaders = new Headers();
    for (const [key, value] of upstream.headers) {
      if (key.toLowerCase() === "transfer-encoding") continue;
      responseHeaders.set(key, value);
    }

    if (shouldLog("info")) {
      console.log(
        safeJson({
          event: "relay_end",
          requestId,
          status: upstream.status,
          durationMs: Date.now() - start,
        }),
      );
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    if (shouldLog("error")) {
      console.error(
        safeJson({
          event: "relay_error",
          message: error?.message || String(error),
          stack: error?.stack,
          name: error?.name,
        }),
      );
    }
    return new Response("Bad Gateway: Relay Failed", { status: 502 });
  }
}

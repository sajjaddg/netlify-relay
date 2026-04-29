const TARGET_BASE = (Netlify.env.get("TARGET_DOMAIN") || "").replace(/\/$/, "");

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

function log(level, msg, extra = {}) {
  console[level](
    JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra }),
  );
}

export default async function handler(request) {
  const reqId = crypto.randomUUID().slice(0, 8);
  const { method, url: rawUrl } = request;

  if (!TARGET_BASE) {
    log("error", "Missing TARGET_DOMAIN env var");
    return new Response("Misconfigured: TARGET_DOMAIN is not set", {
      status: 500,
    });
  }

  const url = new URL(rawUrl);
  const targetUrl = TARGET_BASE + url.pathname + url.search; // ← fix: no markdown link

  log("info", "Incoming request", {
    reqId,
    method,
    path: url.pathname + url.search,
    target: targetUrl,
  });

  try {
    // Build forwarded headers
    const headers = new Headers();
    let clientIp = null;

    for (const [key, value] of request.headers) {
      const k = key.toLowerCase();
      if (STRIP_HEADERS.has(k)) continue;
      if (k.startsWith("x-nf-") || k.startsWith("x-netlify-")) continue;

      if (k === "x-real-ip") {
        clientIp ??= value;
        continue;
      }
      if (k === "x-forwarded-for") {
        clientIp ??= value;
        continue;
      }

      headers.set(k, value);
    }

    if (clientIp) {
      headers.set("x-forwarded-for", clientIp);
      log("debug", "Client IP forwarded", { reqId, clientIp });
    }

    const hasBody = method !== "GET" && method !== "HEAD";

    // Timeout via AbortController (Netlify functions time out at 10s/26s)
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      log("warn", "Upstream timeout — aborting", { reqId, targetUrl });
      controller.abort();
    }, 9000);

    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        method,
        headers,
        redirect: "manual",
        signal: controller.signal,
        ...(hasBody && { body: request.body, duplex: "half" }), // duplex needed for streaming body
      });
    } finally {
      clearTimeout(timeout);
    }

    log("info", "Upstream responded", {
      reqId,
      status: upstream.status,
      contentType: upstream.headers.get("content-type"),
      contentLength: upstream.headers.get("content-length"),
    });

    // Handle redirects — pass through Location header as-is
    const responseHeaders = new Headers();
    for (const [key, value] of upstream.headers) {
      const k = key.toLowerCase();
      if (k === "transfer-encoding") continue; // never forward chunked encoding
      responseHeaders.set(key, value);
    }

    // Add CORS if needed (optional — uncomment if your frontend needs it)
    // responseHeaders.set("access-control-allow-origin", "*");

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    const isTimeout = error.name === "AbortError";
    const status = isTimeout ? 504 : 502;
    const msg = isTimeout
      ? "Gateway Timeout: Upstream took too long"
      : "Bad Gateway: Relay Failed";

    log("error", msg, {
      reqId,
      targetUrl,
      error: error.message,
      stack: error.stack?.split("\n").slice(0, 3),
    });

    return new Response(msg, { status });
  }
}

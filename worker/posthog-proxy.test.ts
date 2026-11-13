import { expect, test } from "bun:test";

import { isPostHogProxyRequest, proxyPostHog } from "./posthog-proxy";

interface CapturedFetch {
  url: string;
  init?: RequestInit;
}

function fakeFetcher(capture: CapturedFetch) {
  // SAFETY: the fake implements the (url, init) => Promise<Response> call shape
  // proxyPostHog uses; no other fetch members are touched.
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture.url = String(url);
    capture.init = init;
    return new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

test("only the proxy subdomain matches", () => {
  expect(isPostHogProxyRequest(new URL("https://e.dotflowy.com/e/"))).toBe(
    true,
  );
  expect(isPostHogProxyRequest(new URL("https://app.dotflowy.com/e/"))).toBe(
    false,
  );
  expect(isPostHogProxyRequest(new URL("https://faith.tools/e/"))).toBe(false);
});

test("event POSTs route to the ingestion host with body intact", async () => {
  const capture: CapturedFetch = { url: "" };
  const body = JSON.stringify({ event: "$pageview", token: "phc_test" });
  const res = await proxyPostHog(
    new Request("https://e.dotflowy.com/e/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session=secret",
        "cf-connecting-ip": "1.2.3.4",
      },
      body,
    }),
    fakeFetcher(capture),
  );
  expect(res.status).toBe(200);
  expect(capture.url).toBe("https://us.i.posthog.com/e/");
  expect(capture.init?.method).toBe("POST");
  // Cookies never leave for PostHog; the client IP is preserved for
  // geolocation and cookieless counting.
  expect(new Headers(capture.init?.headers).get("cookie")).toBeNull();
  expect(new Headers(capture.init?.headers).get("x-forwarded-for")).toBe(
    "1.2.3.4",
  );
  expect(new Headers(capture.init?.headers).get("content-type")).toBe(
    "application/json",
  );
});

test("static assets and remote config route to the asset host", async () => {
  const capture: CapturedFetch = { url: "" };
  await proxyPostHog(
    new Request("https://e.dotflowy.com/static/array.js"),
    fakeFetcher(capture),
  );
  expect(capture.url).toBe("https://us-assets.i.posthog.com/static/array.js");
  capture.url = "";
  await proxyPostHog(
    new Request("https://e.dotflowy.com/array/phc_test/config.js"),
    fakeFetcher(capture),
  );
  expect(capture.url).toBe(
    "https://us-assets.i.posthog.com/array/phc_test/config.js",
  );
});

test("only PostHog project-key Authorization survives", async () => {
  const capture: CapturedFetch = { url: "" };
  await proxyPostHog(
    new Request("https://e.dotflowy.com/e/", {
      method: "POST",
      headers: {
        authorization: "Bearer phc_projecttoken",
        "posthog-sdk-info": "x",
      },
      body: "{}",
    }),
    fakeFetcher(capture),
  );
  expect(new Headers(capture.init?.headers).get("authorization")).toBe(
    "Bearer phc_projecttoken",
  );
  await proxyPostHog(
    new Request("https://e.dotflowy.com/e/", {
      method: "POST",
      headers: { authorization: "Bearer sessiontoken" },
      body: "{}",
    }),
    fakeFetcher(capture),
  );
  expect(new Headers(capture.init?.headers).get("authorization")).toBeNull();
});

test("OPTIONS preflight answers without calling upstream", async () => {
  let called = false;
  // SAFETY: same as fakeFetcher above; only the call shape is used.
  const fetcher = (async () => {
    called = true;
    return new Response("x");
  }) as typeof fetch;
  const res = await proxyPostHog(
    new Request("https://e.dotflowy.com/e/", {
      method: "OPTIONS",
      headers: { origin: "https://faith.tools" },
    }),
    fetcher,
  );
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe(
    "https://faith.tools",
  );
  expect(called).toBe(false);
});

test("upstream failures become 502s", async () => {
  // SAFETY: same as fakeFetcher above; only the call shape is used.
  const fetcher = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  const res = await proxyPostHog(
    new Request("https://e.dotflowy.com/e/"),
    fetcher,
  );
  expect(res.status).toBe(502);
});

test("non-GET/POST methods are rejected", async () => {
  const res = await proxyPostHog(
    new Request("https://e.dotflowy.com/e/", { method: "DELETE" }),
    fakeFetcher({ url: "" }),
  );
  expect(res.status).toBe(405);
});

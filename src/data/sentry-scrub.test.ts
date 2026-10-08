import { expect, test } from "bun:test";

import { scrubSentryEvent } from "./sentry-scrub";

test("scrubs note text, credentials, and query strings from a request event and its breadcrumbs", () => {
  const event = {
    request: {
      url: "https://app.dotflowy.com/abc?q=my%20secret%20note",
      data: { text: "node text" },
      cookies: "session=abc",
      query_string: "q=secret",
      headers: {
        authorization: "Bearer x",
        Authorization: "Bearer y",
        cookie: "session=abc",
        Cookie: "session=def",
        referer: "https://app.dotflowy.com/n?q=secret",
        Referer: "https://app.dotflowy.com/m?q=secret",
        "user-agent": "test",
      },
    },
    breadcrumbs: [
      {
        data: {
          from: "/a?q=old%20note",
          to: "/b?q=new%20note",
          url: "https://x/api/unfurl?url=https://private.example",
        },
      },
      undefined,
      { data: { method: "GET" } },
    ],
  };
  expect(scrubSentryEvent(event)).toBe(event);
  // SAFETY: widened only so toEqual can compare against a plain literal.
  expect(event.request as unknown).toEqual({
    url: "https://app.dotflowy.com/abc",
    headers: { "user-agent": "test" },
  });
  expect(event.breadcrumbs).toEqual([
    { data: { from: "/a", to: "/b", url: "https://x/api/unfurl" } },
    undefined,
    { data: { method: "GET" } },
  ]);
});

test("scrubs independently optional request and breadcrumb fields", () => {
  const breadcrumbOnly = {
    breadcrumbs: [{ data: { to: "/outline?q=private%20note" } }],
  };
  scrubSentryEvent(breadcrumbOnly);
  expect(breadcrumbOnly.breadcrumbs).toEqual([{ data: { to: "/outline" } }]);

  const requestWithoutUrl = {
    request: {
      data: { text: "private note" },
      cookies: "session=abc",
      query_string: "q=private",
      headers: {
        authorization: "Bearer x",
        referer: "https://app.dotflowy.com/?q=private",
        "user-agent": "test",
      },
    },
  };
  scrubSentryEvent(requestWithoutUrl);
  // SAFETY: widened only so toEqual can compare against a plain literal.
  expect(requestWithoutUrl.request as unknown).toEqual({
    headers: { "user-agent": "test" },
  });
});

test("leaves a query-free url alone and no-ops on an event with nothing to scrub", () => {
  const clean = { request: { url: "https://app.dotflowy.com/abc" } };
  scrubSentryEvent(clean);
  expect(clean.request.url).toBe("https://app.dotflowy.com/abc");

  const empty = { request: undefined, breadcrumbs: undefined };
  expect(scrubSentryEvent(empty)).toEqual({
    request: undefined,
    breadcrumbs: undefined,
  });
});

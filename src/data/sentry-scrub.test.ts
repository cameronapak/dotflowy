import { describe, expect, it } from "bun:test";

import { scrubSentryEvent } from "./sentry-scrub";

describe("scrubSentryEvent", () => {
  it("strips the query string from request.url but keeps origin + path", () => {
    const event = {
      request: { url: "https://app.dotflowy.com/abc?q=my%20secret%20note" },
    };
    scrubSentryEvent(event);
    expect(event.request.url).toBe("https://app.dotflowy.com/abc");
  });

  it("leaves a url with no query string untouched", () => {
    const event = { request: { url: "https://app.dotflowy.com/abc" } };
    scrubSentryEvent(event);
    expect(event.request.url).toBe("https://app.dotflowy.com/abc");
  });

  it("drops the request body, cookies, and query_string fields", () => {
    const event = {
      request: {
        data: { text: "node text" },
        cookies: "session=abc",
        query_string: "q=secret",
      },
    };
    scrubSentryEvent(event);
    expect(event.request.data).toBeUndefined();
    expect(event.request.cookies).toBeUndefined();
    expect(event.request.query_string).toBeUndefined();
  });

  it("deletes auth, cookie, and referer headers (both casings), keeps others", () => {
    const event = {
      request: {
        headers: {
          authorization: "Bearer x",
          Cookie: "session=abc",
          Referer: "https://app.dotflowy.com/n?q=secret",
          "user-agent": "test",
        },
      },
    };
    scrubSentryEvent(event);
    expect(event.request.headers.authorization).toBeUndefined();
    expect(event.request.headers.Cookie).toBeUndefined();
    expect(event.request.headers.Referer).toBeUndefined();
    expect(event.request.headers["user-agent"]).toBe("test");
  });

  it("strips query strings from navigation breadcrumb url fields", () => {
    const event = {
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
    scrubSentryEvent(event);
    expect(event.breadcrumbs[0]!.data.from).toBe("/a");
    expect(event.breadcrumbs[0]!.data.to).toBe("/b");
    expect(event.breadcrumbs[0]!.data.url).toBe("https://x/api/unfurl");
    // Non-url breadcrumb data and holes are left alone.
    expect(event.breadcrumbs[2]!.data.method).toBe("GET");
  });

  it("no-ops on an event with no request or breadcrumbs, returning the same ref", () => {
    const event = { request: undefined, breadcrumbs: undefined };
    expect(scrubSentryEvent(event)).toBe(event);
  });
});

import { expect, test } from "bun:test";

import { withFramePolicy } from "./frame-policy";

test("only the app and the landing page may frame the app's pages", () => {
  const res = withFramePolicy(
    new Response("<html></html>", {
      status: 200,
      headers: { "Content-Type": "text/html", ETag: '"abc"' },
    }),
  );
  expect(res.headers.get("Content-Security-Policy")).toBe(
    "frame-ancestors 'self' https://dotflowy.com",
  );
  // The asset response is otherwise untouched.
  expect(res.status).toBe(200);
  expect(res.headers.get("ETag")).toBe('"abc"');
  expect(res.headers.get("Content-Type")).toBe("text/html");
});

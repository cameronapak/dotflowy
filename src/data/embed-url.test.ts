import { describe, expect, test } from "bun:test";

import { embedUrl } from "./embed-url";

describe("embedUrl", () => {
  test("accepts one HTTPS URL and a sole markdown link", () => {
    expect(embedUrl(" https://example.com/watch?v=1 ")).toBe(
      "https://example.com/watch?v=1",
    );
    expect(embedUrl("[A title](https://example.com/post/1)")).toBe(
      "https://example.com/post/1",
    );
  });

  test("rejects credentials, non-HTTPS, prose, and multiple links", () => {
    expect(embedUrl("https://user:pass@example.com/")).toBeNull();
    expect(embedUrl("http://example.com/")).toBeNull();
    expect(embedUrl("see https://example.com/")).toBeNull();
    expect(embedUrl("https://a.example/ https://b.example/")).toBeNull();
  });
});

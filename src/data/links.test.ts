import { describe, expect, test } from "bun:test";

import {
  bareHttpUrl,
  encodeUrlForMarkdown,
  hasLink,
  isHttpUrl,
  linkUrlAtOffset,
  replaceLinkToken,
  sanitizeLinkLabel,
  stripLinks,
  swapLinkLabel,
} from "./links";

describe("hasLink", () => {
  test("detects a complete link token", () => {
    expect(hasLink("[label](url)")).toBe(true);
    expect(hasLink("before [x](y) after")).toBe(true);
  });

  test("is false for plain text and incomplete tokens", () => {
    expect(hasLink("plain text")).toBe(false);
    expect(hasLink("[label]")).toBe(false);
    expect(hasLink("(url)")).toBe(false);
  });
});

describe("stripLinks", () => {
  test("flattens links to their label", () => {
    expect(stripLinks("[label](http://x)")).toBe("label");
    expect(stripLinks("a [x](y) b [z](w) c")).toBe("a x b z c");
  });

  test("an empty label collapses to nothing", () => {
    expect(stripLinks("a[](http://x)c")).toBe("ac");
  });

  test("leaves link-free text untouched", () => {
    expect(stripLinks("no links here")).toBe("no links here");
  });
});

describe("linkUrlAtOffset", () => {
  const text = "see [Example](https://example.com) now";

  test("returns the url when the caret is in the link label", () => {
    expect(linkUrlAtOffset(text, text.indexOf("Example"))).toBe(
      "https://example.com",
    );
    expect(linkUrlAtOffset(text, text.indexOf("]"))).toBe(
      "https://example.com",
    );
  });

  test("returns the url when the caret is in the url segment", () => {
    expect(linkUrlAtOffset(text, text.indexOf("example.com"))).toBe(
      "https://example.com",
    );
  });

  test("returns the url when the caret is behind the closing paren", () => {
    expect(linkUrlAtOffset(text, text.indexOf(")") + 1)).toBe(
      "https://example.com",
    );
  });

  test("returns null outside a complete link token", () => {
    expect(linkUrlAtOffset(text, 0)).toBeNull();
    expect(linkUrlAtOffset("[partial]", 3)).toBeNull();
  });
});

describe("isHttpUrl", () => {
  test("accepts http(s), case-insensitive, trimmed", () => {
    expect(isHttpUrl("http://x.com")).toBe(true);
    expect(isHttpUrl("https://x.com")).toBe(true);
    expect(isHttpUrl("HTTPS://X.COM")).toBe(true);
    expect(isHttpUrl("  https://x.com  ")).toBe(true);
  });

  test("rejects other schemes and non-urls", () => {
    expect(isHttpUrl("ftp://x.com")).toBe(false);
    expect(isHttpUrl("mailto:a@b.com")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
  });
});

describe("bareHttpUrl", () => {
  test("returns the trimmed url when the string is exactly one url", () => {
    expect(bareHttpUrl("https://x.com")).toBe("https://x.com");
    expect(bareHttpUrl("  https://x.com  ")).toBe("https://x.com");
  });

  test("returns null when there is surrounding text or whitespace", () => {
    expect(bareHttpUrl("see https://x.com")).toBeNull();
    expect(bareHttpUrl("https://x.com extra")).toBeNull();
    expect(bareHttpUrl("not-a-url")).toBeNull();
    expect(bareHttpUrl("")).toBeNull();
  });
});

describe("encodeUrlForMarkdown", () => {
  test("encodes only the chars that break the (url) parser", () => {
    expect(encodeUrlForMarkdown("http://x.com/a b?q=(1)")).toBe(
      "http://x.com/a%20b?q=%281%29",
    );
  });

  test("leaves other characters alone", () => {
    expect(encodeUrlForMarkdown("http://x.com/path?a=1&b=2")).toBe(
      "http://x.com/path?a=1&b=2",
    );
  });
});

describe("sanitizeLinkLabel", () => {
  test("strips `]` (fatal to the label grammar)", () => {
    expect(sanitizeLinkLabel("Foo ] bar")).toBe(
      "Foo  bar".replace(/\s+/g, " "),
    );
    expect(sanitizeLinkLabel("a]b]c")).toBe("abc");
  });

  test("collapses whitespace and trims", () => {
    expect(sanitizeLinkLabel("  Hello   \n  World  ")).toBe("Hello World");
  });

  test("keeps `[` and `(` `)` (only `]` breaks a label)", () => {
    expect(sanitizeLinkLabel("Foo [bar] (baz)")).toBe("Foo [bar (baz)");
  });

  test("an all-junk title collapses to empty (caller keeps the placeholder)", () => {
    expect(sanitizeLinkLabel("   \n\t ")).toBe("");
    expect(sanitizeLinkLabel("]]]")).toBe("");
  });
});

describe("replaceLinkToken", () => {
  test("replaces the verbatim token, first occurrence only", () => {
    const text = "a [x](http://x) b [x](http://x) c";
    expect(replaceLinkToken(text, "[x](http://x)", "[y](http://y)")).toBe(
      "a [y](http://y) b [x](http://x) c",
    );
  });

  test("returns null when the token is gone (the line was edited)", () => {
    expect(
      replaceLinkToken("now different", "[x](http://x)", "[y](http://y)"),
    ).toBeNull();
  });

  test("can change label and url together (the Edit Link popover write)", () => {
    expect(
      replaceLinkToken(
        "see [old label](https://old.example) now",
        "[old label](https://old.example)",
        "[New](https://new.example/path)",
      ),
    ).toBe("see [New](https://new.example/path) now");
  });
});

describe("swapLinkLabel", () => {
  const url = "https://anthropic.com";

  test("swaps the label of the verbatim placeholder, first occurrence", () => {
    const text = `see [${url}](${url}) now`;
    expect(swapLinkLabel(text, url, url, "Anthropic")).toBe(
      "see [Anthropic](https://anthropic.com) now",
    );
  });

  test("returns null when the placeholder is gone (label was edited)", () => {
    // The user already renamed the label, so the exact `[url](url)` is absent.
    const edited = `[My link](${url}) `;
    expect(swapLinkLabel(edited, url, url, "Anthropic")).toBeNull();
  });

  test("only the first placeholder is touched when the url repeats", () => {
    const text = `[${url}](${url}) and [${url}](${url})`;
    expect(swapLinkLabel(text, url, url, "A")).toBe(
      `[A](${url}) and [${url}](${url})`,
    );
  });

  test("matches against the ENCODED url half (parens case)", () => {
    const raw = "https://en.wikipedia.org/wiki/Foo_(bar)";
    const enc = encodeUrlForMarkdown(raw);
    const text = `[${raw}](${enc}) tail`;
    expect(swapLinkLabel(text, enc, raw, "Foo (bar)")).toBe(
      `[Foo (bar)](${enc}) tail`,
    );
  });
});

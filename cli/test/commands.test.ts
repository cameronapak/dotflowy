import { expect, test } from "bun:test";
import { Effect } from "effect";

import manifest from "../package.json" with { type: "json" };
import { callbackCode, trustedEndpoint } from "../src/auth.js";
import { commands, mergeInput, parse } from "../src/commands.js";
import { serverUrl, terminalText, VERSION } from "../src/core.js";

const parsed = async (args: string[]) => {
  const value = await Effect.runPromise(parse(args));
  if (!value) throw new Error("Expected a command");
  return value;
};

test("version matches the distributable package", () =>
  expect(VERSION).toBe(manifest.version));

test("covers all twelve current MCP tools", () => {
  expect(
    Object.values(commands)
      .map((c) => c.tool)
      .sort(),
  ).toEqual(
    [
      "get_outline",
      "search_nodes",
      "add_node",
      "add_subtree",
      "update_node",
      "delete_node",
      "move_nodes",
      "add_to_today",
      "mirror_node",
      "mirror_to_today",
      "import_opml",
      "export_opml",
    ].sort(),
  );
});

test("flags preserve false, empty text, numbers, and global options", async () => {
  const update = await parsed([
    "--json",
    "update",
    "node",
    "--no-completed",
    "--text",
    "",
    "--collapsed",
    "--server",
    "https://example.com",
  ]);
  expect(update.fields).toEqual({
    nodeId: "node",
    completed: false,
    text: "",
    collapsed: true,
  });
  expect(update.json).toBe(true);
  expect(update.server).toBe("https://example.com");
  expect((await parsed(["outline", "--max-depth", "0"])).fields).toEqual({
    maxDepth: 0,
  });
  expect((await parsed(["add", "--", "--literal"])).fields).toEqual({
    text: "--literal",
  });
});

test("moves keep input order and all tool arguments can arrive as JSON", async () => {
  const move = await parsed([
    "move",
    "b",
    "a",
    "--parent",
    "p",
    "--position",
    "first",
  ]);
  expect(move.fields).toEqual({
    nodeIds: ["b", "a"],
    newParentId: "p",
    position: "first",
  });
  const raw = await parsed(["call", "future_tool", "--input", "-"]);
  const args = {
    arbitrary: [null, false, { nested: "value" }],
    timeZone: null,
  };
  expect(mergeInput(raw, args, "America/Chicago")).toEqual(args);
});

test("friendly today uses local time; raw call preserves UTC defaults", async () => {
  const today = await parsed(["today", "hello"]);
  expect(mergeInput(today, {}, "America/Chicago")).toEqual({
    text: "hello",
    timeZone: "America/Chicago",
  });
  expect(mergeInput(today, { date: "2026-09-27" }, "America/Chicago")).toEqual({
    text: "hello",
    date: "2026-09-27",
  });
  expect(
    mergeInput(today, { timeZone: "Asia/Tokyo" }, "America/Chicago").timeZone,
  ).toBe("Asia/Tokyo");
  expect(
    mergeInput(
      await parsed(["call", "add_to_today"]),
      { text: "hello" },
      "America/Chicago",
    ),
  ).toEqual({ text: "hello" });
});

test("deletion requires --yes for both entry points", async () => {
  for (const argv of [
    ["delete", "id"],
    ["call", "delete_node"],
  ]) {
    const command = await parsed(argv);
    expect(() => mergeInput(command, {}, "UTC")).toThrow("--yes");
    expect(() =>
      mergeInput({ ...command, yes: true }, {}, "UTC"),
    ).not.toThrow();
  }
});

test("rejects duplicate input sources and ambiguous field merging", async () => {
  const command = await parsed(["add", "text"]);
  expect(() => mergeInput(command, { text: "other" }, "UTC")).toThrow(
    "only once",
  );
  expect(() =>
    mergeInput({ ...command, input: "a", args: "{}" }, {}, "UTC"),
  ).toThrow("not both");
});

test("rejects unknown options, extra arguments, malformed flags", async () => {
  for (const argv of [
    ["nonsense"],
    ["add", "x", "--typo", "x"],
    ["add", "x", "y"],
    ["outline", "--max-depth", "1.5"],
    ["call"],
  ]) {
    await expect(Effect.runPromise(parse(argv))).rejects.toThrow();
  }
});

test("server URLs cannot smuggle credentials, paths, or insecure remote origins", () => {
  for (const value of [
    "http://example.com",
    "https://u:p@example.com",
    "https://example.com/mcp",
    "https://example.com?token=x",
    "file:///tmp/a",
  ]) {
    expect(() => serverUrl(value)).toThrow();
  }
  expect(serverUrl("http://127.0.0.1:1234/")).toBe("http://127.0.0.1:1234");
  expect(serverUrl("https://app.dotflowy.com/")).toBe(
    "https://app.dotflowy.com",
  );
  expect(() =>
    trustedEndpoint("https://evil.test/token", "https://app.dotflowy.com"),
  ).toThrow();
});

test("OAuth callback validates path, state, unique code, and denial", () => {
  expect(callbackCode("/callback?state=expected&code=code", "expected")).toBe(
    "code",
  );
  for (const path of [
    "/other?state=expected&code=code",
    "/callback?state=wrong&code=code",
    "/callback?state=expected&state=expected&code=a",
    "/callback?state=expected&code=a&code=b",
  ]) {
    expect(callbackCode(path, "expected")).toBeNull();
  }
  expect(() =>
    callbackCode("/callback?state=expected&error=denied", "expected"),
  ).toThrow("denied");
});

test("human output strips terminal control characters", () => {
  expect(terminalText("hello\x1b]52;c;payload\x07\rworld\nnext")).toBe(
    "hello]52;c;payloadworld\nnext",
  );
});

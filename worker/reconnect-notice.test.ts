import { expect, test } from "bun:test";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmailEnv } from "./email";

import {
  maskRecipient,
  parseRecipientCsv,
  reconnectArgs,
} from "../scripts/reconnect-notice";
import {
  ReconnectNoticeBody,
  reconnectBearerAuthorized,
  reconnectNoticeEmail,
  runReconnectNotice,
} from "./reconnect-notice";

test("reconnect notices preview without sending, then send sequentially with the approved copy and report failures", async () => {
  // Digests of the approved draft, including its signature and whitespace.
  for (const [key, digest] of [
    [
      "subject",
      "1d377f4fd6fe7fedcdadff507d3812fc205e391b6bf4062e5dd2b8d910f7dad1",
    ],
    [
      "text",
      "8821f2321bb079539cd0320216d9c9be9b7a9a22a46dfd47121bbe6be6de0c5a",
    ],
    [
      "html",
      "412cada677f0bfcb3dcffd889fe1e8e878e4cbca859941543a1ad8543612251a",
    ],
  ] as const)
    expect(
      createHash("sha256").update(reconnectNoticeEmail[key]).digest("hex"),
    ).toBe(digest);
  const calls: unknown[] = [];
  let inFlight = 0;
  const env: EmailEnv = {
    EMAIL: {
      async send(message) {
        expect(inFlight++).toBe(0);
        calls.push(message);
        await Promise.resolve();
        inFlight--;
        if (calls.length === 2) throw new Error("private provider failure");
        return { messageId: "mock-message" };
      },
    },
  };
  const recipients = [
    " First@example.test ",
    "first@example.test",
    "second@example.test",
    "third@example.test",
  ];
  for (const body of [{ recipients }, { recipients, dryRun: true }]) {
    const preview = await runReconnectNotice(env, body);
    expect(preview.dryRun).toBe(true);
    expect(preview.message).toEqual(reconnectNoticeEmail);
    expect(preview.results).toEqual([
      { email: "first@example.test", status: "simulated" },
      { email: "second@example.test", status: "simulated" },
      { email: "third@example.test", status: "simulated" },
    ]);
    expect(calls).toHaveLength(0);
  }
  const sent = await runReconnectNotice(env, { recipients, dryRun: false });
  expect(sent.results.map((r) => r.status)).toEqual([
    "accepted",
    "failed",
    "accepted",
  ]);
  expect(sent.message).toBeUndefined();
  expect(calls).toEqual(
    ["first@example.test", "second@example.test", "third@example.test"].map(
      (to) => ({
        from: "Dotflowy Support <support@dotflowy.com>",
        replyTo: "support@dotflowy.com",
        to,
        ...reconnectNoticeEmail,
      }),
    ),
  );
  expect(
    (
      await runReconnectNotice(
        {},
        { recipients: ["first@example.test"], dryRun: false },
      )
    ).results,
  ).toEqual([{ email: "first@example.test", status: "simulated" }]);
});

test("CSV and command parsing fail closed before any network access", () => {
  const token = "disposable-reconnect-token-for-local-tests";
  expect(reconnectBearerAuthorized(`Bearer ${token}`, token)).toBe(true);
  for (const authorization of [
    null,
    "",
    token,
    `Basic ${token}`,
    `Bearer ${token} extra`,
    "Bearer short",
    `Bearer ${token}x`,
  ]) {
    expect(reconnectBearerAuthorized(authorization, token)).toBe(false);
  }
  expect(reconnectBearerAuthorized(`Bearer ${token}`)).toBe(false);
  expect(reconnectBearerAuthorized("Bearer short", "short")).toBe(false);
  expect(
    parseRecipientCsv(
      '\uFEFFuser_id,email,client_names\r\n1,"First@Example.test","Claude, Cursor"\r\n2,first@example.test,CLI\r\n3,second@example.test,"A ""quoted"" client"\r\n',
    ),
  ).toEqual(["first@example.test", "second@example.test"]);
  expect(reconnectArgs(["cohort.csv"]).dryRun).toBe(true);
  expect(reconnectArgs(["cohort.csv", "--dry-run"]).dryRun).toBe(true);
  expect(reconnectArgs(["cohort.csv", "--send"]).dryRun).toBe(false);
  expect(maskRecipient("first@example.test")).toBe("f***@e***");
  for (const csv of [
    "",
    "email\n",
    "name\nx",
    "email,email\na@b.test,a@b.test",
    'email\n"unclosed',
    "email\ninvalid",
    "email\na@b.test,extra",
    'email\n"a@b.test"junk',
  ])
    expect(() => parseRecipientCsv(csv)).toThrow();
  for (const args of [
    [],
    ["cohort.csv", "--send", "--dry-run"],
    ["cohort.csv", "--unknown"],
    ["cohort.csv", "--api"],
    ["cohort.csv", "--api", "http://example.test"],
    ["cohort.csv", "--api", "https://example.test/path"],
  ])
    expect(() => reconnectArgs(args)).toThrow();
  for (const body of [
    { recipients: [] },
    { recipients: ["bad"] },
    { recipients: Array(51).fill("a@b.test") },
    { recipients: ["a@b.test"], dryRun: "false" },
  ])
    expect(() => Schema.decodeUnknownSync(ReconnectNoticeBody)(body)).toThrow();
});

test("operator script defaults to preview and masks batch outcomes against a loopback-only stub", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reconnect-script-"));
  const csv = join(directory, "cohort.csv");
  await Bun.write(csv, "email\nfirst@example.test\nsecond@example.test\n");
  const requests: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/api/admin/reconnect-notice");
      expect(request.headers.get("cookie")).toBe(
        request.headers.has("authorization") ? null : "mock-session=local",
      );
      if (request.headers.has("authorization"))
        expect(request.headers.get("authorization")).toBe(
          "Bearer disposable-reconnect-token-for-local-tests",
        );
      const body = Schema.decodeUnknownSync(ReconnectNoticeBody)(
        await request.json(),
      );
      requests.push(body);
      return Response.json({
        dryRun: body.dryRun,
        results: body.recipients.map((email, index) => ({
          email,
          status: body.dryRun
            ? "simulated"
            : index === 0
              ? "accepted"
              : "failed",
        })),
        message: body.dryRun ? reconnectNoticeEmail : undefined,
      });
    },
  });
  try {
    for (const mode of ["cookie", "token-preview", "token-send"]) {
      const send = mode === "token-send";
      const child = Bun.spawn(
        [
          process.execPath,
          "scripts/reconnect-notice.ts",
          csv,
          "--api",
          server.url.origin,
          ...(send ? ["--send"] : []),
        ],
        {
          env: {
            ...process.env,
            DOTFLOWY_SESSION_COOKIE:
              mode === "cookie" ? "mock-session=local" : undefined,
            DOTFLOWY_ADMIN_EMAIL: undefined,
            DOTFLOWY_ADMIN_PASSWORD: undefined,
            DOTFLOWY_RECONNECT_TOKEN:
              mode === "cookie"
                ? undefined
                : "disposable-reconnect-token-for-local-tests",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(send ? 1 : 0);
      expect(errors).toBe("");
      expect(output).not.toContain("first@example.test");
      expect(output).not.toContain("second@example.test");
      expect(output).not.toContain(
        "disposable-reconnect-token-for-local-tests",
      );
      expect(output).toContain(
        send ? "f***@e***: accepted" : "DRY RUN: no emails sent.",
      );
      expect(output).toContain(
        send ? "s***@e***: failed" : "s***@e***: simulated",
      );
    }
    expect(requests).toEqual(
      [true, true, false].map((dryRun) => ({
        recipients: ["first@example.test", "second@example.test"],
        dryRun,
      })),
    );
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

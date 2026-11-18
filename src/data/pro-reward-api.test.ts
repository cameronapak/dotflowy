import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { saveReward } from "./pro-reward-api";

afterEach(() => mock.restore());

test("reward requests keep the reviewed account and code in the POST body", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ reward: null }),
  );
  const result = await Effect.runPromise(
    saveReward("/api/membership/redeem", {
      code: `DF-${"a".repeat(64)}`,
      accountId: "reviewed-account",
      consent: true,
    }),
  );
  expect(result).toEqual({ reward: null });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [path, request] = fetch.mock.calls[0] ?? [];
  expect(path).toBe("/api/membership/redeem");
  expect(request?.method).toBe("POST");
  expect(request?.referrerPolicy).toBe("no-referrer");
  expect(JSON.parse(String(request?.body))).toEqual({
    code: `DF-${"a".repeat(64)}`,
    accountId: "reviewed-account",
    consent: true,
  });
});

test.each([
  { body: "not JSON", status: 200, reason: "json" },
  { body: "{}", status: 200, reason: "schema" },
  { body: '{"reward":{"state":"applied"}}', status: 200, reason: "schema" },
  { body: '{"error":42}', status: 400, reason: "schema" },
  { body: "<html>Gateway error</html>", status: 502, reason: "json" },
])(
  "invalid reward response ($status / $reason) stays an uncertain typed failure",
  async ({ body, status, reason }) => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { status }),
    );
    const error = await Effect.runPromise(
      saveReward("/api/membership/redeem", {
        code: `DF-${"a".repeat(64)}`,
        accountId: "reviewed-account",
        consent: true,
      }).pipe(Effect.flip),
    );
    expect(error._tag).toBe("RewardRequestError");
    expect(error.reason).toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test("a decoded server rejection is distinct from a transport failure and neither retries", async () => {
  const fetch = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json(
        { error: "Account changed. Review the signed-in account." },
        { status: 409 },
      ),
    )
    .mockRejectedValueOnce(new TypeError("Failed to fetch"));
  const request = saveReward("/api/membership/redeem", {
    code: `DF-${"a".repeat(64)}`,
    accountId: "reviewed-account",
    consent: true,
  });
  const rejected = await Effect.runPromise(Effect.flip(request));
  expect(rejected.reason).toBe("server");
  expect(rejected.message).toBe(
    "Account changed. Review the signed-in account.",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  const interrupted = await Effect.runPromise(Effect.flip(request));
  expect(interrupted.reason).toBe("transport");
  expect(fetch).toHaveBeenCalledTimes(2);
});

test.each(["headers", "body"])(
  "the 90-second budget aborts stalled %s without retrying the claim",
  async (stage) => {
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetch = spyOn(globalThis, "fetch").mockReturnValue(
      stage === "headers"
        ? new Promise<Response>(() => {})
        : Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  body = controller;
                },
              }),
            ),
          ),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* saveReward("/api/membership/redeem", {
          code: `DF-${"a".repeat(64)}`,
          accountId: "reviewed-account",
          consent: true,
        }).pipe(Effect.flip, Effect.forkScoped);
        yield* TestClock.adjust("89 seconds");
        const signal = fetch.mock.calls[0]?.[1]?.signal;
        expect(signal?.aborted).toBe(false);
        signal?.addEventListener("abort", () => body?.error(signal.reason), {
          once: true,
        });
        yield* TestClock.adjust("1 second");
        expect((yield* Fiber.join(fiber)).reason).toBe("timeout");
        expect(signal?.aborted).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(1);
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    );
  },
);

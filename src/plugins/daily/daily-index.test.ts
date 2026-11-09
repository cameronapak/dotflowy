import { expect, test } from "bun:test";

import { claimMapping, dailyIndexCollection } from "./daily-index";

test("Daily adopts only confirmed claim winners without an ordinary mapping write", async () => {
  const realFetch = globalThis.fetch;
  let response = Response.json({
    value: { key: "2026-07-08", nodeId: "first" },
  });
  const indexStarted = Promise.withResolvers<void>();
  const indexRead = Promise.withResolvers<Response>();
  let claims = 0;
  const ordinaryWrites: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://fixture");
      if (init?.method === "GET") {
        indexStarted.resolve();
        return indexRead.promise;
      }
      if (url.searchParams.get("op") === "claim") {
        claims++;
        return response.clone();
      }
      ordinaryWrites.push(String(init?.body));
      return Response.json({ ok: true });
    },
    { preconnect: () => {} },
  );
  try {
    const claiming = claimMapping("2026-07-08", "second");
    await indexStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(claims).toBe(0);
    indexRead.resolve(Response.json([]));
    expect(await claiming).toEqual({
      winner: "first",
      won: false,
    });
    expect(dailyIndexCollection.get("2026-07-08")?.nodeId).toBe("first");
    expect(await claimMapping("2026-07-08", "first")).toEqual({
      winner: "first",
      won: true,
    });
    for (response of [
      new Response("unavailable", { status: 503 }),
      Response.json({ value: null }),
      Response.json({ value: { key: "2026-07-09", nodeId: "wrong-key" } }),
      Response.json({ value: { key: "2026-07-08", nodeId: "" } }),
    ]) {
      await expect(claimMapping("2026-07-08", "second")).rejects.toThrow();
      expect(dailyIndexCollection.get("2026-07-08")?.nodeId).toBe("first");
    }
    expect(ordinaryWrites).toEqual([]);
  } finally {
    indexRead.resolve(Response.json([]));
    await dailyIndexCollection.cleanup();
    globalThis.fetch = realFetch;
  }
});

import { describe, expect, test } from "bun:test";

import {
  DIRECT_TRANSACTION_METADATA_KEY,
  SHAPE_CHECKPOINT_FALLBACK_MS,
  shapeFirstCheckpoints,
  withDirectOptimisticMetadata,
  type CheckpointRegistry,
} from "./lunora-checkpoints";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeShapeGate(): CheckpointRegistry & {
  pending: Map<number, ReturnType<typeof deferred>>;
} {
  const pending = new Map<number, ReturnType<typeof deferred>>();
  return {
    pending,
    awaitCheckpoint: async () => undefined,
    resolve: (watermark) => {
      const id = watermark.mutationId;
      if (id == null) return;
      const d = pending.get(id);
      if (d) {
        pending.delete(id);
        d.resolve();
      }
    },
    awaitMutationId: (id) => {
      let d = pending.get(id);
      if (!d) {
        d = deferred();
        pending.set(id, d);
      }
      return d.promise;
    },
  };
}

describe("withDirectOptimisticMetadata", () => {
  test("stamps __tanstack_db_direct without dropping serverRef", () => {
    const raw = {
      setText: (_args: never) => ({
        metadata: { serverRef: "mutators:setText" } as Record<string, unknown>,
      }),
    };
    const bound = withDirectOptimisticMetadata(raw);
    const tx = bound.setText({} as never);
    expect(tx.metadata.serverRef).toBe("mutators:setText");
    expect(tx.metadata[DIRECT_TRANSACTION_METADATA_KEY]).toBe(true);
  });
});

describe("shapeFirstCheckpoints", () => {
  test("resolves when the shape poke arrives (no fallback)", async () => {
    const shape = makeShapeGate();
    const client = { confirmedMutationWatermark: () => 0 };
    const gate = shapeFirstCheckpoints(client, "u1", shape, {
      fallbackMs: 5_000,
    });

    const wait = gate.awaitMutationId(1);
    let done = false;
    void wait.then(() => {
      done = true;
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);

    shape.resolve({ mutationId: 1 });
    await wait;
    expect(done).toBe(true);
  });

  test("falls back after RPC watermark when shape never pokes", async () => {
    const shape = makeShapeGate();
    let watermark = 0;
    const client = {
      confirmedMutationWatermark: () => watermark,
    };
    const gate = shapeFirstCheckpoints(client, "u1", shape, {
      fallbackMs: 40,
    });

    const wait = gate.awaitMutationId(7);
    // Watermark still behind — fallback must not arm yet.
    await new Promise((r) => setTimeout(r, 80));
    let settled = false;
    void wait.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);

    watermark = 7;
    await wait;
    expect(settled).toBe(true);
  });

  test("default fallback window is 3s", () => {
    expect(SHAPE_CHECKPOINT_FALLBACK_MS).toBe(3000);
  });
});

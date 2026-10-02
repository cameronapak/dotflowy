import { describe, expect, it } from "bun:test";
import { Schema } from "effect";

import {
  LunoraRetirementArchiveSchema,
  validateLunoraRetirementArchive,
} from "./lunora-retirement";

function archive(text: string | null = "kept") {
  const rawNode = {
    _id: "n1",
    _creationTime: 1,
    userId: "u1",
    parentId: "missing-parent",
    prevSiblingId: null,
    text,
    isTask: false,
    completed: false,
    collapsed: false,
    bookmarkedAt: null,
    mirrorOf: null,
    createdAt: 1,
    updatedAt: 2,
    origin: null,
    kind: null,
    futureField: { preserved: true },
  };
  return {
    version: 1 as const,
    userId: "u1",
    exportedAt: 10,
    snapshot: {
      version: 1,
      userId: "u1",
      exportedAt: 10,
      nodes: [
        {
          ...rawNode,
          text: text ?? "",
          id: "n1",
        },
      ],
      dailyIndex: [
        {
          key: "2026-10-02",
          nodeId: "daily-node",
          touchedAt: 11,
          userId: "u1",
        },
      ],
      tagColors: [{ tag: "work", color: "blue", userId: "u1" }],
      savedQueries: [
        {
          id: "q1",
          name: "Open",
          query: "is:open",
          createdAt: 12,
          userId: "u1",
        },
      ],
      migrateState: [{ nodesAt: 13, kvAt: 14, userId: "u1" }],
    },
    raw: {
      nodes: [rawNode],
      dailyIndex: [
        {
          _id: "d1",
          _creationTime: 3,
          key: "2026-10-02",
          nodeId: "daily-node",
          touchedAt: 11,
          userId: "u1",
        },
      ],
      tagColors: [
        {
          _id: "t1",
          _creationTime: 4,
          tag: "work",
          color: "blue",
          userId: "u1",
        },
      ],
      savedQueries: [
        {
          _id: "q1",
          _creationTime: 5,
          name: "Open",
          query: "is:open",
          createdAt: 12,
          userId: "u1",
        },
      ],
      migrateState: [
        { _id: "m1", _creationTime: 6, nodesAt: 13, kvAt: 14, userId: "u1" },
      ],
    },
  };
}

describe("raw Lunora retirement archive", () => {
  it("preserves unknown fields and malformed graph references", () => {
    const decoded = Schema.decodeUnknownSync(LunoraRetirementArchiveSchema)(
      archive(),
    );
    expect(decoded.raw.nodes[0]?.futureField).toEqual({ preserved: true });
    expect(validateLunoraRetirementArchive(decoded, "u1")).toEqual({
      ok: true,
    });
  });

  it("rejects foreign owners, duplicate raw ids, and coercible malformed rows", () => {
    const foreign = archive();
    foreign.raw.nodes[0]!.userId = "u2";
    expect(validateLunoraRetirementArchive(foreign, "u1").ok).toBe(false);

    const duplicate = archive();
    duplicate.raw.nodes.push({ ...duplicate.raw.nodes[0]! });
    duplicate.snapshot.nodes.push({ ...duplicate.snapshot.nodes[0]! });
    expect(validateLunoraRetirementArchive(duplicate, "u1").ok).toBe(false);

    const malformed = archive(null);
    // The old projection would coerce this to an empty string.
    expect(validateLunoraRetirementArchive(malformed, "u1")).toEqual({
      ok: false,
      reason: "raw nodes row cannot be projected",
    });
  });

  it("rejects every projected field mismatch, including side collections and migrate state", () => {
    const mutations: Array<(value: ReturnType<typeof archive>) => void> = [
      (value) => {
        value.snapshot.nodes[0]!.updatedAt = 99;
      },
      (value) => {
        value.snapshot.dailyIndex[0]!.nodeId = "other";
      },
      (value) => {
        value.snapshot.tagColors[0]!.color = "red";
      },
      (value) => {
        value.snapshot.savedQueries[0]!.query = "is:done";
      },
      (value) => {
        value.snapshot.migrateState[0]!.kvAt = 99;
      },
    ];
    for (const mutate of mutations) {
      const value = archive();
      mutate(value);
      expect(validateLunoraRetirementArchive(value, "u1")).toEqual({
        ok: false,
        reason: "raw and projected values differ",
      });
    }
  });

  it("rejects asymmetric rows, reordered correspondence, and snapshot version drift", () => {
    const missing = archive();
    missing.snapshot.dailyIndex = [];
    expect(validateLunoraRetirementArchive(missing, "u1").ok).toBe(false);

    const extra = archive();
    extra.raw.tagColors.push({
      ...extra.raw.tagColors[0]!,
      _id: "t2",
      tag: "home",
    });
    expect(validateLunoraRetirementArchive(extra, "u1").ok).toBe(false);

    const version = archive();
    version.snapshot.version = 2;
    expect(validateLunoraRetirementArchive(version, "u1")).toEqual({
      ok: false,
      reason: "Lunora archive versions differ",
    });
  });
});

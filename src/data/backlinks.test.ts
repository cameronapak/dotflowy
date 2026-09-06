import { describe, expect, test } from "bun:test";

import { collectBacklinkReferrerIds } from "./backlinks";
import { parseDateLinkKeys } from "./date-links";
import { buildTreeIndex, createNode } from "./tree";

const DAY = "11111111-2222-3333-4444-555555555555";
const MIRROR = "22222222-3333-4444-5555-666666666666";
const VIA_LINK = "33333333-4444-5555-6666-777777777777";
const VIA_DATE = "44444444-5555-6666-7777-888888888888";
const BOTH = "55555555-6666-7777-8888-999999999999";
const TARGET = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const REF = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const OTHER = "cccccccc-dddd-eeee-ffff-000000000000";

describe("parseDateLinkKeys", () => {
  test("extracts unique calendar keys in order", () => {
    expect(
      parseDateLinkKeys(
        "meet [[2026-04-22]] and [[2026-04-22 09:00]] then [[2026-05-01]]",
      ),
    ).toEqual(["2026-04-22", "2026-05-01"]);
  });

  test("bails on bracket-free text; rejects non-calendar shape", () => {
    expect(parseDateLinkKeys("plain")).toEqual([]);
    expect(parseDateLinkKeys("see [[2026-13-45]]")).toEqual([]);
  });
});

describe("collectBacklinkReferrerIds", () => {
  test("unions node-links and date mentions; dedupes; excludes self + mirrors", () => {
    const index = buildTreeIndex([
      // Day node mentions its own date — must not count as a backlink.
      createNode({
        id: DAY,
        text: "Wednesday, April 22, 2026 [[2026-04-22]]",
      }),
      createNode({
        id: MIRROR,
        text: "Wednesday, April 22, 2026",
        mirrorOf: DAY,
      }),
      createNode({ id: VIA_LINK, text: `kickoff for [[${DAY}]]` }),
      createNode({ id: VIA_DATE, text: "party [[2026-04-22]]" }),
      createNode({ id: BOTH, text: `see [[${DAY}]] on [[2026-04-22]]` }),
    ]);

    const ids = collectBacklinkReferrerIds(index, DAY, "2026-04-22");
    expect(ids.sort()).toEqual([BOTH, VIA_DATE, VIA_LINK].sort());
    expect(ids).not.toContain(DAY);
    expect(ids).not.toContain(MIRROR);
  });

  test("without dayKey, only node-link referrers count", () => {
    const index = buildTreeIndex([
      createNode({ id: TARGET, text: "Target" }),
      createNode({ id: REF, text: `see [[${TARGET}]]` }),
      createNode({ id: OTHER, text: "party [[2026-04-22]]" }),
    ]);
    expect(collectBacklinkReferrerIds(index, TARGET, null)).toEqual([REF]);
  });
});

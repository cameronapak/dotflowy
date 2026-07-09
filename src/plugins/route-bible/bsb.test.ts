import { describe, expect, test } from "bun:test";
import { joinVerseRange, type BsbVerse } from "./bsb";

const verses: BsbVerse[] = [
  { n: 22, t: "One day Jesus said to His disciples." },
  { n: 23, t: "As they sailed, He fell asleep." },
  { n: 24, t: "The disciples went and woke Him." },
  { n: 25, t: "Where is your faith?" },
  { n: 26, t: "Then they sailed to the region of the Gerasenes." },
];

describe("joinVerseRange", () => {
  test("joins an inclusive range in order", () => {
    expect(joinVerseRange(verses, 22, 25)).toBe(
      "One day Jesus said to His disciples. As they sailed, He fell asleep. The disciples went and woke Him. Where is your faith?",
    );
  });

  test("accepts reversed bounds", () => {
    expect(joinVerseRange(verses, 25, 23)).toBe(
      "As they sailed, He fell asleep. The disciples went and woke Him. Where is your faith?",
    );
  });

  test("returns a single verse", () => {
    expect(joinVerseRange(verses, 24, 24)).toBe(
      "The disciples went and woke Him.",
    );
  });

  test("returns empty when outside the chapter", () => {
    expect(joinVerseRange(verses, 1, 3)).toBe("");
  });
});

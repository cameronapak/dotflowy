import type { Node } from "../data/schema";

import {
  addDays,
  dayKeyToScaffoldChain,
  dayKeyToUtc,
  localDateKey,
  scaffoldLabel,
} from "../data/date-links";
import { createNode } from "../data/tree";
import { hasMatchMedia } from "../env";

/** One bullet in the demo outline. `ref` names a bullet so others can link to
 *  it (`link(ref)`) or mirror it (`mirrorOf`); `dailyKey` maps it in the daily
 *  index, as the daily plugin's own get-or-create would. */
interface DemoBullet {
  text: string;
  ref?: string;
  task?: boolean;
  done?: boolean;
  collapsed?: boolean;
  kind?: Node["kind"];
  origin?: string;
  mirrorOf?: string;
  dailyKey?: string;
  children?: DemoBullet[];
}

/** A plugin side-collection row, as `/api/kv` stores it. */
export interface DemoKvRow {
  key: string;
  value: unknown;
}

export interface DemoSeed {
  nodes: Node[];
  kv: Record<string, DemoKvRow[]>;
}

/** Node-link tokens only match id-shaped interiors, so every demo id takes
 *  tree.ts's fallback id shape (`n_<a>_<b>`). */
const idOf = (name: string) => `n_demo_${name}`;
const link = (ref: string) => `[[${idOf(ref)}]]`;
const date = (key: string) => `[[${key}]]`;

/** The full date a day node carries, as the daily plugin writes it. */
function dayText(key: string): string {
  const d = dayKeyToUtc(key);
  return d
    ? d.toLocaleDateString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      })
    : key;
}

/** The next Thursday on or after `today`: the launch is always this week. */
function nextThursday(today: string): string {
  const weekday = dayKeyToUtc(today)?.getUTCDay() ?? 4;
  return addDays(today, (4 - weekday + 7) % 7);
}

/** Daily > Year > Month > Week > Day for `today` (ADR 0052), holding `day`'s
 *  children. Monday weeks, matching the demo account's week start. */
function dailyNotes(today: string, children: DemoBullet[]): DemoBullet {
  const chain = dayKeyToScaffoldChain(today, "monday");
  const day: DemoBullet = { text: dayText(today), dailyKey: today, children };
  if (!chain) return { text: "Daily", dailyKey: "container", children: [day] };
  const level = (key: string, inner: DemoBullet): DemoBullet => ({
    text: scaffoldLabel(key),
    dailyKey: key,
    children: [inner],
  });
  return {
    text: "Daily",
    dailyKey: "container",
    collapsed: true,
    children: [
      level(chain.yearKey, level(chain.monthKey, level(chain.weekKey, day))),
    ],
  };
}

/** The "Try it" hints, in the visitor's own input: keys on a desktop, taps
 *  on a phone, which has no ⌘K but has the same buttons in the header. */
const KEYBOARD_HINTS = [
  "Click any dot to zoom into that bullet. ⌘, zooms back out.",
  "Press ⌘K, type pancakes, and press Enter.",
  "Click #launch to see only what's tagged with it.",
  "The calendar button up top opens today's page.",
  "Enter adds a bullet. Tab nests it. Shift+Tab pulls it out.",
];
const TOUCH_HINTS = [
  "Tap any dot to zoom into that bullet. The home button brings you back.",
  "Tap ⌘ up top, type pancakes, and pick it.",
  "Tap #launch to see only what's tagged with it.",
  "The calendar button up top opens today's page.",
  "Tap + to add a bullet.",
];

/**
 * The outline a landing-page visitor gets to play with. It reads like a real
 * person's outline and carries one example of each feature worth finding:
 * daily notes, date chips, colored tags, links between bullets, a mirror,
 * a spoiler, highlights and code, a paragraph, embeds, and bullets an AI
 * agent wrote. The top level opens collapsed so it fits the landing page's
 * frame, and zooming in is how you find what's inside.
 */
function demoOutline(today: string, touch: boolean): DemoBullet[] {
  const launchDay = nextThursday(today);
  return [
    {
      text: "**Try it.** This is the real app. Nothing you type is saved.",
      children: (touch ? TOUCH_HINTS : KEYBOARD_HINTS).map((text) => ({
        text,
      })),
    },
    dailyNotes(today, [
      {
        text: `Ship the relaunch ${date(launchDay)} #launch`,
        task: true,
        mirrorOf: "shipit",
      },
      { text: `Prep for my 1:1 with ${link("maya")}`, task: true },
      { text: "==Dentist moved to Friday==, 9:30" },
      { text: "Office gate code: ||4417||" },
      { text: "Call the plumber about the kitchen sink #home", task: true },
    ]),
    {
      text: "Work",
      collapsed: true,
      children: [
        {
          text: "Website relaunch #launch",
          ref: "relaunch",
          children: [
            {
              text: `Ship the relaunch ${date(launchDay)} #launch`,
              ref: "shipit",
              task: true,
            },
            {
              text: "Hero: show, don't tell",
              children: [
                {
                  text: "Put the live outline in the hero",
                  task: true,
                  done: true,
                },
                { text: "Record a 60-second tour", task: true },
                {
                  text: "Headline ideas",
                  children: [
                    { text: "Zoom in. Zoom out. Jump anywhere." },
                    { text: "Everything you know, one keystroke away." },
                    { text: "Go from A to G without losing your place." },
                  ],
                },
              ],
            },
            { text: "Deploy with `bun run deploy`, then purge the CDN cache" },
            {
              text: "Launch-day checklist",
              origin: "Claude",
              children: [
                {
                  text: "Write the changelog entry",
                  task: true,
                  origin: "Claude",
                },
                {
                  text: "Post the announcement at 9am",
                  task: true,
                  origin: "Claude",
                },
                {
                  text: "Watch signups for the first hour",
                  task: true,
                  origin: "Claude",
                },
              ],
            },
          ],
        },
        {
          text: "1:1 notes",
          children: [
            {
              text: "Maya",
              ref: "maya",
              children: [
                { text: "Wants to own onboarding next quarter" },
                { text: `Asked to help test ${link("relaunch")}` },
                { text: "Send her the hiring plan", task: true },
              ],
            },
            {
              text: "Jordan",
              children: [{ text: "Blocked on design review; unblock Friday" }],
            },
          ],
        },
      ],
    },
    {
      text: "Home #home",
      collapsed: true,
      children: [
        {
          text: "Recipes",
          children: [
            {
              text: "Sunday pancakes",
              children: [
                { text: "2 cups flour, 2 eggs, 1½ cups milk" },
                { text: "Rest the batter for ==10 minutes==" },
                { text: "Brown butter in the pan, not oil" },
              ],
            },
            {
              text: "Weeknight dal",
              collapsed: true,
              children: [
                { text: "1 cup red lentils, rinsed" },
                { text: "Temper cumin and garlic in ghee at the end" },
              ],
            },
          ],
        },
        {
          text: "Garden",
          children: [
            { text: "Plant garlic before the first frost", task: true },
            { text: "Move the rosemary somewhere sunnier", task: true },
          ],
        },
      ],
    },
    {
      text: "Watch and read",
      collapsed: true,
      children: [
        {
          text: "https://www.youtube.com/watch?v=PUv66718DII",
          kind: "embed",
        },
        { text: "https://x.com/jack/status/20", kind: "embed" },
        {
          text: "https://open.spotify.com/album/3z8tPA07xcY6BlFepPQ8zq",
          kind: "embed",
        },
        { text: "The Pragmatic Programmer", task: true, done: true },
        { text: "How Buildings Learn", task: true },
      ],
    },
    {
      text: "Ideas #idea",
      collapsed: true,
      children: [
        {
          text: "An outline is a tree you can walk around in. Zoom into any branch and it becomes the whole page; zoom back out and you can see how it connects to everything else.",
          kind: "paragraph",
        },
        { text: "Every bullet can be a page of its own" },
      ],
    },
  ];
}

/** Colors for the demo's tags (tag-colors kv rows). */
const TAG_COLORS = { launch: "orange", home: "green", idea: "purple" };

/** Flatten the demo outline into the flat `Node` rows the collection stores,
 *  threading `parentId` and the `prevSiblingId` chain, plus the side-collection
 *  rows it relies on. Unnamed ids are positional, so every load starts from
 *  the same outline; only the dates follow the visitor's clock. */
export function demoSeed(
  today = localDateKey(),
  touch = hasMatchMedia() && matchMedia("(pointer: coarse)").matches,
): DemoSeed {
  const nodes: Node[] = [];
  const daily: DemoKvRow[] = [];
  const walk = (
    bullets: DemoBullet[],
    parentId: string | null,
    path: string,
  ) => {
    let prev: string | null = null;
    bullets.forEach((b, i) => {
      const id = idOf(b.ref ?? `${path}${i}`);
      nodes.push(
        createNode({
          id,
          parentId,
          prevSiblingId: prev,
          text: b.text,
          isTask: b.task ?? false,
          completed: b.done ?? false,
          collapsed: b.collapsed ?? false,
          kind: b.kind ?? null,
          origin: b.origin ?? null,
          mirrorOf: b.mirrorOf ? idOf(b.mirrorOf) : null,
        }),
      );
      if (b.dailyKey)
        daily.push({ key: b.dailyKey, value: { key: b.dailyKey, nodeId: id } });
      if (b.children) walk(b.children, id, `${path}${i}x`);
      prev = id;
    });
  };
  walk(demoOutline(today, touch), null, "");
  return {
    nodes,
    kv: {
      "daily-index": daily,
      "tag-colors": Object.entries(TAG_COLORS).map(([tag, color]) => ({
        key: tag,
        value: { tag, color },
      })),
      "account-prefs": [
        // Embeds load provider content only with the account's consent.
        {
          key: "external-embeds",
          value: { key: "external-embeds", enabled: true },
        },
        {
          key: "daily:week-start",
          value: { key: "daily:week-start", weekStart: "monday" },
        },
      ],
    },
  };
}

/**
 * Idempotent first-run demo seed — only when the outline is ready and empty.
 * Uses the existing `insertSibling` mutator (deterministic timestamps in args).
 */

export const DEMO_SEED_TEXTS = [
  "Welcome to the Lunora outline spike",
  "Open a second tab — edits sync live",
  "Try indent / outdent / delete",
  "Hard reload restores from wholeOutline",
] as const;

export type InsertSiblingArgs = {
  id: string;
  userId: string;
  parentId: string | null;
  afterId: string | null;
  text: string;
  createdAt: number;
  updatedAt: number;
};

export type InsertSiblingFn = (args: InsertSiblingArgs) => Promise<unknown>;

/** Gate: ready + zero nodes. Callers still guard in-flight / StrictMode. */
export function shouldSeedOutline(opts: {
  isReady: boolean;
  nodeCount: number;
}): boolean {
  return opts.isReady && opts.nodeCount === 0;
}

/**
 * Insert demo bullets as a top-level chain via `insertSibling`.
 * Returns inserted ids (empty if texts list is empty).
 */
export async function seedEmptyOutline(opts: {
  userId: string;
  insertSibling: InsertSiblingFn;
  texts?: readonly string[];
  newId?: () => string;
  now?: () => number;
}): Promise<string[]> {
  const texts = opts.texts ?? DEMO_SEED_TEXTS;
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const now = opts.now ?? (() => Date.now());

  let afterId: string | null = null;
  let t = now();
  const ids: string[] = [];

  for (const text of texts) {
    const id = newId();
    await opts.insertSibling({
      id,
      userId: opts.userId,
      parentId: null,
      afterId,
      text,
      createdAt: t,
      updatedAt: t,
    });
    ids.push(id);
    afterId = id;
    t += 1;
  }

  return ids;
}

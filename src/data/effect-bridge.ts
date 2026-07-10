import { Effect } from "effect";

/**
 * Run an Effect program and convert its typed error into a thrown `Error`, so a
 * caller that still speaks the throw-based contract — TanStack DB mutation
 * handlers, which signal failure by *throwing* to trigger optimistic rollback —
 * can adopt an Effect pipeline without a wider rewrite. Used by both transport
 * cores (`nodes-client-effect.ts`, `kv-client-effect.ts`) and the daily
 * loser-path; one definition so the error-coercion can't drift between them.
 * See docs/adr/0021-effect-first-one-schema-language.md (the throw-at-the-seam
 * bridge) and docs/adr/0012-effect-replaces-errore.md.
 */
export function runPromise<T, E>(effect: Effect.Effect<T, E>): Promise<T> {
  return Effect.runPromise(
    effect.pipe(
      Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e)))),
    ),
  );
}

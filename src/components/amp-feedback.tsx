import { Effect, Fiber, Schema } from "effect";
import { useEffect } from "react";

import { AmpFeedbackConfig } from "../data/amp-feedback";
import { hardReset } from "../lib/auth-client";
import { captureNodeZoomShortcut } from "./node-zoom-shortcut";

/** Owner-only, server-authorized exception to ADR 0031. Removing a script tag
 * cannot unload its code: tear down the document when this gate unmounts. */
export function AmpFeedback({ userId }: Readonly<{ userId: string }>) {
  useEffect(() => {
    let active = true;
    let loaded = false;
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise((signal) =>
          fetch("/api/feedback-widget", {
            credentials: "same-origin",
            cache: "no-store",
            signal,
          }),
        );
        if (!response.ok) return;
        const body = yield* Effect.tryPromise(() => response.json());
        const config =
          yield* Schema.decodeUnknownEffect(AmpFeedbackConfig)(body);
        // Also reject a response belonging to a previous account/document.
        if (!active || config.userId !== userId) return;
        const script = document.createElement("script");
        script.src = `https://ampcode.com/w/${config.clientId}.js`;
        script.async = true;
        // Install first: Amp captures Mod+. on window before node keymaps.
        window.addEventListener("keydown", captureNodeZoomShortcut, true);
        loaded = true;
        document.head.appendChild(script);
      }).pipe(
        Effect.timeout("5 seconds"),
        // Optional review tooling must never block or break the editor.
        Effect.catch(() => Effect.void),
      ),
    );
    return () => {
      active = false;
      Effect.runFork(Fiber.interrupt(fiber));
      window.removeEventListener("keydown", captureNodeZoomShortcut, true);
      if (loaded) hardReset(window.location.href);
    };
  }, [userId]);

  return null;
}

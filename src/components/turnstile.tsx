import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

/**
 * A tiny hand-rolled wrapper over Cloudflare Turnstile (#293). We load the
 * official script directly rather than add a dependency — the widget's whole
 * surface is render / reset / remove, which fits in one effect. Renders only
 * when the AuthScreen has a site key (from GET /api/auth-config); no key = the
 * caller renders nothing, which mirrors the server registering no captcha
 * plugin (dev/no-key parity).
 *
 * The solved token flows back through `onToken`; the parent sends it in the
 * `x-captcha-response` header the Better Auth captcha plugin reads. Tokens are
 * single-use, so after a failed submit the parent calls `reset()` (the exposed
 * handle) to get a fresh one.
 */

interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  "error-callback"?: () => void;
  "expired-callback"?: () => void;
  theme?: "light" | "dark" | "auto";
  size?: "normal" | "flexible" | "compact";
}

interface TurnstileApi {
  render: (el: HTMLElement, options: TurnstileRenderOptions) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** Load the Turnstile script once, shared across every widget instance. */
let scriptPromise: Promise<void> | null = null;
function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined")
    return Promise.reject(new Error("Turnstile requires a browser"));
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null; // let a later mount retry a failed load
      reject(new Error("Failed to load Turnstile"));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export interface TurnstileHandle {
  /** Discard the current token and re-challenge (tokens are single-use). */
  reset: () => void;
}

export const Turnstile = forwardRef<
  TurnstileHandle,
  { siteKey: string; onToken: (token: string | null) => void }
>(function Turnstile({ siteKey, onToken }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  // Keep the latest callback without re-rendering the widget on every parent
  // render (the effect must not depend on an unstable onToken identity).
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useImperativeHandle(ref, () => ({
    reset() {
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.reset(widgetIdRef.current);
        onTokenRef.current(null);
      }
    },
  }));

  useEffect(() => {
    let cancelled = false;
    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          callback: (token) => onTokenRef.current(token),
          "error-callback": () => onTokenRef.current(null),
          "expired-callback": () => onTokenRef.current(null),
          size: "flexible",
        });
      })
      .catch(() => {
        if (!cancelled) onTokenRef.current(null);
      });
    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [siteKey]);

  return <div ref={containerRef} className="flex justify-center" />;
});

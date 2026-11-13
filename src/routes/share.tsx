import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { LoaderIcon } from "@/lib/icons";

import { Button } from "../components/ui/button";
import { localDateKey } from "../data/date-links";
import {
  clearSharedPayload,
  readSharedPayload,
  shareToCapture,
  stashSharedFragment,
} from "../data/share-capture";
import { hasWindow } from "../env";
import { hardReset } from "../lib/auth-client";

/**
 * The share target's landing page (ADR 0085). The installed app's share_target
 * posts to `/share`; the Worker hands the shared fields over in this URL's
 * fragment. Nothing saves until you tap Add to Today: any site can link here
 * or post a form to `/share`, so loading this page must never write.
 */
export const Route = createFileRoute("/share")({
  // Runs before the auth gate renders, so a signed-out visitor's shared text
  // moves to sessionStorage before any sign-in redirect can carry the URL.
  beforeLoad: () => {
    if (hasWindow()) stashSharedFragment();
  },
  component: SharePage,
});

type Status =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved"; dailyNoteId: string }
  | { state: "failed"; message: string };

function SharePage() {
  const navigate = useNavigate();
  const [payload] = useState(readSharedPayload);
  const [status, setStatus] = useState<Status>({ state: "idle" });
  // The phone's date when you first tap, kept for every retry of this share
  // so a retry replays the same capture (ADR 0065: device-local Today).
  const dateRef = useRef<string | null>(null);
  const capture =
    payload && !("error" in payload) ? shareToCapture(payload) : null;

  const leave = () => {
    clearSharedPayload();
    void navigate({ to: "/", replace: true });
  };

  async function add() {
    if (!payload || "error" in payload || !capture) return;
    dateRef.current ??= localDateKey();
    setStatus({ state: "saving" });
    try {
      const response = await fetch("/api/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: payload.attemptId,
          date: dateRef.current,
          ...capture,
        }),
      });
      if (response.status === 401) {
        // The session ended; the share is still stashed for after sign-in.
        hardReset("/share");
        return;
      }
      // SAFETY: /api/share returns a receipt or { message } (worker/capture.ts).
      const body = (await response.json().catch(() => ({}))) as {
        dailyNoteId?: string;
        message?: string;
      };
      if (!response.ok || !body.dailyNoteId) {
        setStatus({
          state: "failed",
          message: body.message ?? "Couldn't add this. Try again.",
        });
        return;
      }
      clearSharedPayload();
      setStatus({ state: "saved", dailyNoteId: body.dailyNoteId });
    } catch {
      setStatus({
        state: "failed",
        message:
          "Couldn't confirm it was added. Check your connection and try again. It won't be added twice.",
      });
    }
  }

  let body;
  if (status.state === "saved") {
    body = (
      <>
        <p className="text-sm text-muted-foreground" role="status">
          Added to Today.
        </p>
        <div className="flex gap-2">
          <Button
            className="flex-1"
            onClick={() =>
              navigate({
                to: "/$nodeId",
                params: { nodeId: status.dailyNoteId },
                replace: true,
              })
            }
          >
            Open Today
          </Button>
          <Button className="flex-1" variant="outline" onClick={leave}>
            Done
          </Button>
        </div>
      </>
    );
  } else if (!payload || !capture) {
    const message =
      payload && "error" in payload
        ? payload.error === "rejected"
          ? "This share didn't come from your device's share sheet, so Dotflowy ignored it."
          : "Dotflowy couldn't read that share. It accepts text and links."
        : "Nothing was shared. Share text or a link to Dotflowy from another app.";
    body = (
      <>
        <p className="text-sm text-muted-foreground">{message}</p>
        <Button className="w-full" variant="outline" onClick={leave}>
          Back to Dotflowy
        </Button>
      </>
    );
  } else {
    const saving = status.state === "saving";
    body = (
      <>
        <figure
          aria-label="Shared content"
          className="max-h-[50dvh] overflow-y-auto rounded-lg border bg-muted/40 p-3 text-sm break-words whitespace-pre-wrap"
        >
          {capture.title && (
            <figcaption className="mb-1 font-medium">
              {capture.title}
            </figcaption>
          )}
          {capture.text}
        </figure>
        {status.state === "failed" && (
          <p className="text-sm text-destructive" role="alert">
            {status.message}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            className="flex-1"
            variant="outline"
            disabled={saving}
            onClick={leave}
          >
            Cancel
          </Button>
          <Button className="flex-1" disabled={saving} onClick={add}>
            {saving && <LoaderIcon className="animate-spin" />}
            Add to Today
          </Button>
        </div>
      </>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold">Add to Dotflowy</h1>
        {body}
      </div>
    </main>
  );
}

import { Collapsible } from "@base-ui/react/collapsible";
import { Link } from "@tanstack/react-router";
import { Effect } from "effect";
import { useEffect, useRef, useState } from "react";

import type {
  FeedbackContext,
  FeedbackKind,
  FeedbackSubmission,
} from "../data/feedback";

import { APP_VERSION } from "../data/app-version";
import {
  PUBLIC_IDEA_URL,
  feedbackRouteCategory,
  setFeedbackOpener,
  submitFeedback,
} from "../data/feedback";
import { useMembership } from "../data/membership";
import { PLAN_LABELS } from "../data/plans";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "./ui/field";
import { Textarea } from "./ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

/** Mount once inside AuthGate. The opener never reads the outline or full URL. */
export function FeedbackDialog() {
  const membership = useMembership();
  const paid =
    membership.state === "ready" &&
    (membership.plan === "unlimited" || membership.plan === "founding");
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [message, setMessage] = useState("");
  const [browser, setBrowser] = useState("");
  const [route, setRoute] = useState<FeedbackContext["routeCategory"]>("other");
  const [includeBrowser, setIncludeBrowser] = useState(false);
  const [includeRoute, setIncludeRoute] = useState(false);
  const [stage, setStage] = useState<"edit" | "review" | "success">("edit");
  const [attempt, setAttempt] = useState<FeedbackSubmission | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Synchronous guard: double clicks cannot start two requests before a render.
  const sending = useRef(false);

  useEffect(() => {
    setFeedbackOpener((requestedKind) => {
      // An errored/closed report keeps its body, context and id for safe retries.
      if (stage === "success") {
        setMessage("");
        setAttempt(null);
        setError(null);
        setStage("edit");
        setKind(requestedKind);
        setIncludeBrowser(false);
        setIncludeRoute(false);
      } else if (!message && !attempt) {
        setKind(requestedKind);
      }
      if (stage === "success" || !attempt) {
        setBrowser(navigator.userAgent.slice(0, 512));
        setRoute(feedbackRouteCategory(window.location.pathname));
      }
      setOpen(true);
    });
    return () => setFeedbackOpener(null);
  }, [stage, message, attempt]);

  const allowed = kind === "bug" || paid;

  function review(event: React.FormEvent) {
    event.preventDefault();
    if (!allowed || !message.trim() || message.length > 5000) return;
    let context: FeedbackContext = { appVersion: APP_VERSION };
    if (includeBrowser) context = { ...context, browser };
    if (includeRoute && route) context = { ...context, routeCategory: route };
    const draft = {
      kind,
      message,
      context,
    };
    // Re-reviewing an unchanged draft after an uncertain response keeps its id.
    if (
      !attempt ||
      JSON.stringify({ ...attempt, id: undefined }) !== JSON.stringify(draft)
    ) {
      setAttempt({ ...draft, id: crypto.randomUUID() });
    }
    setError(null);
    setStage("review");
  }

  async function send() {
    if (sending.current || !attempt || !allowed) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await Effect.runPromise(
        submitFeedback(attempt).pipe(
          Effect.match({
            onFailure: (failure) => setError(failure.message),
            onSuccess: () => setStage("success"),
          }),
        ),
      );
    } catch {
      // Defects also leave the draft intact; don't log potentially private input.
      setError("Couldn't confirm delivery. Retry this draft safely.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!sending.current) setOpen(next);
      }}
    >
      <DialogContent
        className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>
            {stage === "review" ? "Review feedback" : "Send feedback"}
          </DialogTitle>
          <DialogDescription>
            {paid
              ? "Send a bug, idea, or question straight to Cam. Ideas help shape Dotflowy, but aren't a promise of delivery."
              : "Report a problem straight to Cam. Bug reports are free on every plan."}
          </DialogDescription>
        </DialogHeader>

        {stage === "success" ? (
          <>
            <p role="status">
              Thanks, your feedback is saved in our private inbox.
            </p>
            <p className="text-sm break-all text-muted-foreground">
              Reference: {attempt?.id}
            </p>
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            {membership.state === "loading" && (
              <p role="status">
                Checking membership… You can still report a bug.
              </p>
            )}
            {membership.state === "error" && (
              <p role="status">
                Couldn't check membership. Bug reports still work.{" "}
                <Button variant="link" onClick={membership.reload}>
                  Retry membership
                </Button>
              </p>
            )}

            {stage === "edit" ? (
              <form onSubmit={review} className="flex flex-col gap-5">
                <FieldGroup>
                  <FieldSet>
                    <FieldLegend variant="label">Feedback type</FieldLegend>
                    <ToggleGroup
                      value={[kind]}
                      onValueChange={(values) => {
                        const next = values[0];
                        if (
                          next === "bug" ||
                          next === "idea" ||
                          next === "question"
                        )
                          setKind(next);
                      }}
                      aria-label="Feedback type"
                      variant="outline"
                      className="[&_[aria-pressed=true]]:border-foreground [&_[aria-pressed=true]]:bg-foreground [&_[aria-pressed=true]]:text-background"
                    >
                      <ToggleGroupItem value="bug">Bug</ToggleGroupItem>
                      <ToggleGroupItem value="idea">Idea</ToggleGroupItem>
                      {paid && (
                        <ToggleGroupItem value="question">
                          Question
                        </ToggleGroupItem>
                      )}
                    </ToggleGroup>
                  </FieldSet>
                  {!allowed ? (
                    <FieldDescription>
                      Private ideas and questions require Pro or Founding.
                      {membership.state === "ready" && !paid && (
                        <>
                          {" "}
                          You can instead{" "}
                          <a
                            href={PUBLIC_IDEA_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            draft a public idea on GitHub
                          </a>
                          . Nothing from this form is sent there.
                        </>
                      )}{" "}
                      Choose Bug to report a problem here without GitHub.
                    </FieldDescription>
                  ) : (
                    <>
                      <Field>
                        <FieldLabel htmlFor="feedback-message">
                          {kind === "bug"
                            ? "What happened, and what did you expect?"
                            : "Your feedback"}
                        </FieldLabel>
                        <Textarea
                          id="feedback-message"
                          value={message}
                          maxLength={5000}
                          required
                          rows={5}
                          onChange={(event) => setMessage(event.target.value)}
                        />
                        <FieldDescription>
                          {message.length}/5000 characters. Only include text
                          you want to share; no outline content is collected
                          automatically.
                        </FieldDescription>
                      </Field>
                      <Collapsible.Root>
                        <Collapsible.Trigger
                          type="button"
                          className="group flex cursor-pointer items-center gap-2 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        >
                          <span
                            aria-hidden="true"
                            className="group-data-panel-open:hidden"
                          >
                            ▸
                          </span>
                          <span
                            aria-hidden="true"
                            className="hidden group-data-panel-open:inline"
                          >
                            ▾
                          </span>
                          Technical details (optional)
                        </Collapsible.Trigger>
                        <Collapsible.Panel
                          className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none"
                          render={(props, state) => (
                            <div
                              {...props}
                              inert={!state.open}
                              aria-hidden={!state.open}
                            />
                          )}
                        >
                          <div className="pt-3">
                            <FieldSet>
                              <FieldLegend variant="label" className="sr-only">
                                Optional diagnostic context
                              </FieldLegend>
                              <FieldGroup>
                                <Field orientation="horizontal">
                                  <Checkbox
                                    id="feedback-browser"
                                    checked={includeBrowser}
                                    onCheckedChange={setIncludeBrowser}
                                  />
                                  <FieldLabel htmlFor="feedback-browser">
                                    Include browser information
                                  </FieldLabel>
                                </Field>
                                {includeBrowser && (
                                  <FieldDescription className="break-words">
                                    {browser}
                                  </FieldDescription>
                                )}
                                <Field orientation="horizontal">
                                  <Checkbox
                                    id="feedback-route"
                                    checked={includeRoute}
                                    onCheckedChange={setIncludeRoute}
                                  />
                                  <FieldLabel htmlFor="feedback-route">
                                    Include route category: {route}
                                  </FieldLabel>
                                </Field>
                              </FieldGroup>
                            </FieldSet>
                          </div>
                        </Collapsible.Panel>
                      </Collapsible.Root>
                    </>
                  )}
                </FieldGroup>
                {membership.state === "ready" && membership.plan === "free" && (
                  <p className="text-sm text-muted-foreground">
                    <Link
                      to="/settings"
                      hash="billing"
                      onClick={() => setOpen(false)}
                      className="font-medium text-foreground underline underline-offset-4"
                    >
                      Subscribe to Dotflowy
                    </Link>{" "}
                    to share ideas directly with Cam. Subscriber ideas get extra
                    weight; urgent bugs come first on every plan.
                  </p>
                )}
                <p className="text-sm text-muted-foreground">
                  {paid && "Thank you for supporting Dotflowy. "}
                  Your account, plan
                  {membership.state === "ready" && membership.plan
                    ? ` (${PLAN_LABELS[membership.plan]})`
                    : ""}
                  , and app version are attached privately. No notes or
                  screenshots are collected automatically.
                </p>
                <p className="text-sm text-muted-foreground">
                  We'll send a receipt to your account email, without your
                  feedback text.
                </p>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setOpen(false)}
                  >
                    Close
                  </Button>
                  <Button type="submit" disabled={!allowed || !message.trim()}>
                    Review feedback
                  </Button>
                </DialogFooter>
              </form>
            ) : (
              attempt && (
                <>
                  <p className="text-sm capitalize">{attempt.kind}</p>
                  <p
                    className="max-h-[35dvh] overflow-auto rounded-md bg-muted p-3 break-words whitespace-pre-wrap"
                    data-testid="feedback-review"
                  >
                    {attempt.message}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    App {attempt.context.appVersion} · Account and plan attached
                    privately
                  </p>
                  {attempt.context.routeCategory && (
                    <p className="text-sm text-muted-foreground">
                      Page: {attempt.context.routeCategory}
                    </p>
                  )}
                  {attempt.context.browser && (
                    <p className="text-xs break-words text-muted-foreground">
                      Browser: {attempt.context.browser}
                    </p>
                  )}
                  {error && <FieldError>{error}</FieldError>}
                  {!allowed && (
                    <FieldError>
                      Your membership no longer allows this feedback type. Go
                      back and choose Bug.
                    </FieldError>
                  )}
                  <DialogFooter>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setStage("edit")}
                    >
                      Back
                    </Button>
                    <Button disabled={busy || !allowed} onClick={send}>
                      {busy
                        ? "Sending…"
                        : error
                          ? "Retry feedback"
                          : "Send feedback"}
                    </Button>
                  </DialogFooter>
                </>
              )
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

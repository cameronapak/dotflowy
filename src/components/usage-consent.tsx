import { Link, useLocation } from "@tanstack/react-router";
import { Effect, Fiber, Schema } from "effect";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { downloadTextFile } from "../data/download";
import {
  USAGE_POLICY_VERSION,
  UsageConsentState,
  UsageDataExport,
  type UsageChoice,
} from "../data/usage-consent-schema";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./ui/card";

class UsageRequestError extends Schema.TaggedError<UsageRequestError>()(
  "UsageRequestError",
  {},
) {}

const requestUsage = Effect.fn("UsageConsent.request")(function* <A>(
  path: string,
  schema: Schema.Decoder<A>,
  choice?: UsageChoice,
) {
  const options: RequestInit = { method: "GET", cache: "no-store" };
  if (choice) {
    options.method = "POST";
    options.headers = { "content-type": "application/json" };
    options.body = JSON.stringify({
      policyVersion: USAGE_POLICY_VERSION,
      choice,
    });
  }
  const response = yield* Effect.tryPromise({
    try: (signal) => fetch(path, { ...options, signal }),
    catch: () => new UsageRequestError(),
  });
  if (!response.ok) return yield* Effect.fail(new UsageRequestError());
  const raw = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: () => new UsageRequestError(),
  });
  return yield* Schema.decodeUnknownEffect(schema)(raw);
}, Effect.timeout("8 seconds"));

type ConsentContext = {
  data: UsageConsentState | null;
  loading: boolean;
  busy: boolean;
  error: boolean;
  reload: () => void;
  choose: (choice: UsageChoice) => void;
  exportData: () => void;
};
const Context = createContext<ConsentContext | null>(null);

/** One account-scoped read shared by advance notice and Settings. No activity
 * requests, local consent cache, or instrumentation live in this provider. */
export function UsageConsentProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<UsageConsentState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const fiber = Effect.runFork(
      requestUsage("/api/usage/consent", UsageConsentState).pipe(
        Effect.match({
          onSuccess: (value) => {
            setData(value);
            setError(false);
            setLoading(false);
          },
          onFailure: () => {
            setData(null);
            setError(true);
            setLoading(false);
          },
        }),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [attempt]);

  function choose(choice: UsageChoice) {
    setBusy(true);
    setError(false);
    void Effect.runPromise(
      requestUsage("/api/usage/consent", UsageConsentState, choice),
    ).then(
      (value) => {
        setData(value);
        setBusy(false);
      },
      () => {
        setError(true);
        setBusy(false);
      },
    );
  }
  function exportData() {
    setBusy(true);
    setError(false);
    void Effect.runPromise(
      requestUsage("/api/usage/export", UsageDataExport),
    ).then(
      (value) => {
        downloadTextFile(
          "dotflowy-usage-data.json",
          "application/json",
          JSON.stringify(value, null, 2),
        );
        setBusy(false);
      },
      () => {
        setError(true);
        setBusy(false);
      },
    );
  }
  return (
    <Context.Provider
      value={{
        data,
        loading,
        busy,
        error,
        choose,
        exportData,
        reload: () => {
          setLoading(true);
          setError(false);
          setAttempt((value) => value + 1);
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}

function UsageConsentPanel({ notice = false }: { notice?: boolean }) {
  const context = useContext(Context);
  if (!context) throw new Error("UsageConsentProvider is required");
  const { data, loading, busy, error, choose, exportData, reload } = context;
  if (notice && (loading || !data?.noticeAvailable || data.choice !== "unset"))
    return null;
  return (
    <Card aria-label={notice ? "Optional usage reporting" : "Usage reporting"}>
      <CardHeader>
        <CardTitle>
          <h2>{notice ? "Optional usage reporting" : "Usage reporting"}</h2>
        </CardTitle>
        <CardDescription>
          Activity reporting is not enabled. Your choice does not change access
          to Dotflowy.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p>
          If you accept, admins can see daily summaries linked to your account:
          whether you opened or edited an outline, which sync backend you used,
          and whether edits came from your browser or an authorized AI agent.
        </p>
        <p>
          Summaries stay for at most 90 days. They do not include note text,
          node identifiers, URLs, IP addresses, device details, time spent, or
          individual events. You can withdraw and delete summaries in Settings.
        </p>
        <Link to="/privacy" className="underline underline-offset-4">
          Read the revised privacy policy
        </Link>
        {loading && <p role="status">Loading your choice…</p>}
        {error && (
          <p role="alert">
            Could not confirm your usage settings. No acceptance or deletion is
            confirmed. Try again.
          </p>
        )}
        {!loading && !error && data?.choice === "accepted" && (
          <p role="status">
            Accepted for policy {data.policyVersion}. Collection has not
            started.
          </p>
        )}
        {!loading && !error && data?.choice === "declined" && (
          <p role="status">
            Declined. Your activity summaries have been removed.
          </p>
        )}
        {!loading && data && !data.noticeAvailable && (
          <p>
            The advance notice is not published yet. Acceptance is unavailable.
          </p>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        {error && (
          <Button variant="outline" disabled={busy || loading} onClick={reload}>
            Try again
          </Button>
        )}
        {data?.choice !== "accepted" && data?.noticeAvailable && (
          <Button
            variant="outline"
            disabled={busy || loading}
            onClick={() => choose("accepted")}
          >
            Accept reporting
          </Button>
        )}
        {data && (
          <Button
            variant="outline"
            disabled={busy || loading}
            onClick={() => choose("declined")}
          >
            {data.choice === "accepted"
              ? "Withdraw and delete summaries"
              : "Decline reporting"}
          </Button>
        )}
        {!notice && (
          <Button
            variant="outline"
            disabled={!data || busy || loading}
            onClick={exportData}
          >
            Export usage data
          </Button>
        )}
        {busy && <span role="status">Saving…</span>}
      </CardFooter>
    </Card>
  );
}

/** Non-modal advance notice: nobody must choose before using their outline. */
export function UsageConsentNotice() {
  const { pathname } = useLocation();
  if (pathname === "/settings") return null;
  return (
    <div className="mx-auto max-w-2xl px-4 has-data-[slot=card]:py-4 sm:px-6">
      <UsageConsentPanel notice />
    </div>
  );
}

export function UsageConsentSettings() {
  return <UsageConsentPanel />;
}

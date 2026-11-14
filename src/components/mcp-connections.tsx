import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "./ui/button";

interface Connection {
  clientId: string;
  name: string;
}

export function McpConnections() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void fetch("/api/mcp-connections", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            "Could not load authorized apps. Reload to try again.",
          );
        // SAFETY: Browser-session endpoint returns the current user's client names and ids only.
        const body = (await response.json()) as { connections: Connection[] };
        if (current) setConnections(body.connections);
      })
      .catch((cause: unknown) => {
        if (current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load authorized apps.",
          );
      });
    return () => {
      current = false;
    };
  }, []);

  async function revoke(clientId: string) {
    setBusy(clientId);
    setError("");
    try {
      const response = await fetch("/api/mcp-connections", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId }),
      });
      if (!response.ok) throw new Error("Could not revoke access. Try again.");
      setConnections(
        (clients) =>
          clients?.filter((client) => client.clientId !== clientId) ?? [],
      );
      toast.success(
        "App access revoked. Reconnect from the app to allow access again.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not revoke access.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div id="authorized-apps" className="flex scroll-mt-20 flex-col gap-3 p-4">
      <h4 className="text-sm font-medium">Authorized apps</h4>
      <p className="text-sm text-muted-foreground">
        OAuth apps can read and change your entire outline. Revoking access
        invalidates all their access and refresh tokens for your account. It
        does not delete data already sent to the app.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {connections === null ? (
        !error && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading authorized apps…
          </p>
        )
      ) : connections.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          No authorized apps with active credentials.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {connections.map((client) => (
            <li
              key={client.clientId}
              className="flex items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium break-words">{client.name}</p>
                <p className="text-xs break-all text-muted-foreground">
                  {client.clientId}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                aria-label={`Revoke ${client.name}`}
                onClick={() => {
                  if (
                    window.confirm(
                      `Revoke access for ${client.name}? You'll need to reconnect from the app to allow access again.`,
                    )
                  )
                    void revoke(client.clientId);
                }}
              >
                {busy === client.clientId ? "Revoking…" : "Revoke"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

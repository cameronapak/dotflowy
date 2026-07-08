import { useCallback, useEffect, useState } from "react";
import { CheckIcon, CopyIcon, KeyRoundIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { apiKey } from "../lib/auth-client";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

/**
 * Personal API keys for headless quick-capture (`POST /api/quick-add` with
 * `x-api-key`). Keys never unlock the rest of the session-gated API (issue #96).
 *
 * Opened from the header More menu — same self-contained modal pattern as
 * `McpConnectDialog`.
 */

type ListedKey = {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  createdAt: Date | string;
};

async function copy(text: string, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(label);
  } catch {
    toast.error("Couldn't copy to clipboard");
  }
}

export function ApiKeysDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [keys, setKeys] = useState<ListedKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  /** Shown once at create time — never stored again. */
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await apiKey.list();
      if (error) {
        toast.error(error.message ?? "Couldn't load API keys");
        return;
      }
      // Plugin list payload is `{ apiKeys, total, … }`, not a bare array.
      const list = (data as { apiKeys?: ListedKey[] } | null)?.apiKeys ?? [];
      setKeys(list);
    } catch {
      toast.error("Couldn't load API keys");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setFreshSecret(null);
    setName("");
    void refresh();
  }, [open, refresh]);

  async function onCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give the key a name");
      return;
    }
    setCreating(true);
    try {
      const { data, error } = await apiKey.create({ name: trimmed });
      if (error || !data) {
        toast.error(error?.message ?? "Couldn't create API key");
        return;
      }
      // Plugin returns the raw key once on create (`key` field).
      const secret =
        typeof (data as { key?: string }).key === "string"
          ? (data as { key: string }).key
          : null;
      if (secret) setFreshSecret(secret);
      setName("");
      await refresh();
      toast.success("API key created — copy it now");
    } catch {
      toast.error("Couldn't create API key");
    } finally {
      setCreating(false);
    }
  }

  async function onDelete(id: string) {
    try {
      const { error } = await apiKey.delete({ keyId: id });
      if (error) {
        toast.error(error.message ?? "Couldn't revoke key");
        return;
      }
      if (freshSecret) setFreshSecret(null);
      await refresh();
      toast.success("Key revoked");
    } catch {
      toast.error("Couldn't revoke key");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRoundIcon className="size-4" />
            API keys
          </DialogTitle>
          <DialogDescription>
            For headless capture only — Shortcuts, Raycast, curl. A key can
            call{" "}
            <code className="text-xs">POST /api/quick-add</code> and nothing
            else. MCP agents still use OAuth.
          </DialogDescription>
        </DialogHeader>

        {freshSecret ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
            <p className="text-sm font-medium">Copy this key now</p>
            <p className="text-xs text-muted-foreground">
              It won&apos;t be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all text-xs font-mono bg-background/60 rounded px-2 py-1.5">
                {freshSecret}
              </code>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Copy API key"
                onClick={() => {
                  void copy(freshSecret, "Key copied");
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Key name (e.g. Raycast)"
            maxLength={64}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void onCreate();
              }
            }}
          />
          <Button onClick={() => void onCreate()} disabled={creating}>
            {creating ? "…" : "Create"}
          </Button>
        </div>

        <div className="space-y-2 max-h-48 overflow-y-auto">
          {loading && keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No keys yet.</p>
          ) : (
            keys.map((k) => {
              const label = k.name?.trim() || "Unnamed";
              const preview = [k.prefix, k.start].filter(Boolean).join("") || "••••";
              return (
                <div
                  key={k.id}
                  className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{label}</p>
                    <p className="text-xs text-muted-foreground font-mono truncate">
                      {preview}…
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Revoke ${label}`}
                    onClick={() => void onDelete(k.id)}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              );
            })
          )}
        </div>

        <p className="text-xs text-muted-foreground font-mono break-all">
          curl -X POST {typeof window !== "undefined" ? window.location.origin : ""}
          /api/quick-add \<br />
          &nbsp;&nbsp;-H &quot;content-type: application/json&quot; \<br />
          &nbsp;&nbsp;-H &quot;x-api-key: df_…&quot; \<br />
          &nbsp;&nbsp;-d &apos;&#123;&quot;text&quot;:&quot;Buy milk&quot;&#125;&apos;
        </p>
      </DialogContent>
    </Dialog>
  );
}

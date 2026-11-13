import {
  Tick02Icon,
  Copy01Icon,
  Key01Icon,
  SmartPhone01Icon,
  Loading03Icon,
  RefreshIcon,
  Delete02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { buttonVariants } from "./ui/button-variants";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Field, FieldGroup, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { Separator } from "./ui/separator";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

type Expiry = "30d" | "90d";
type Permission = "capture" | "read" | "write";

const PERMISSIONS = {
  capture: {
    label: "Capture only",
    description:
      "Append to daily notes. Cannot read, edit, or delete existing content.",
  },
  read: {
    label: "Read-only",
    description:
      "Read, search, and export through MCP or the CLI. Cannot change your outline.",
  },
  write: {
    label: "Read and write",
    description:
      "All MCP and CLI operations, plus capture. Can edit and delete your outline.",
  },
} satisfies Record<Permission, { label: string; description: string }>;

const APPLE_SHORTCUT_URL =
  "https://app.dotflowy.com/shortcuts/Dotflowy.shortcut";

interface CaptureKeyEntry {
  id: string;
  name: string;
  suffix: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
  permission: Permission;
}

interface ApiErrorBody {
  error?: string;
  message?: string;
}

async function responseError(response: Response, fallback: string) {
  try {
    // SAFETY: Error fields are optional and are checked before use; malformed
    // response bodies fall through to the supplied fallback.
    const body = (await response.json()) as ApiErrorBody;
    return body.message || body.error || fallback;
  } catch {
    return fallback;
  }
}

function formatDate(value: number | null) {
  if (value === null) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}

interface CaptureDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ApiKeysDialog(props: CaptureDialogProps) {
  return <CaptureDialog {...props} setup={false} />;
}

export function AppleShortcutSetupDialog(props: CaptureDialogProps) {
  return <CaptureDialog {...props} setup />;
}

// Both surfaces use the same API. Only management loads and
// revokes keys; setup stays focused on creating, copying, and installing.
function CaptureDialog({
  open,
  onOpenChange,
  setup,
}: CaptureDialogProps & { setup: boolean }) {
  const [keys, setKeys] = useState<CaptureKeyEntry[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [name, setName] = useState(setup ? "iPhone" : "");
  const [expiry, setExpiry] = useState<Expiry>("30d");
  const [permission, setPermission] = useState<Permission>("capture");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{
    id: string;
    value: string;
    permission: Permission;
    expiresAt: number;
    rotated: boolean;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [linkCopyError, setLinkCopyError] = useState(false);
  const [revoking, setRevoking] = useState<string | "all" | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | "all" | null>(
    null,
  );
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState<string | null>(null);
  const [rotateExpiry, setRotateExpiry] = useState<Expiry>("30d");
  const [rotating, setRotating] = useState<string | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const busy = creating || rotating !== null || revoking !== null;
  const loadSequence = useRef(0);

  const loadKeys = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setNow(Date.now());
    setLoading(true);
    setListError(null);
    try {
      const response = await fetch("/api/keys");
      if (!response.ok) {
        throw new Error(
          await responseError(response, "Couldn't load your API keys."),
        );
      }
      // SAFETY: This is the fixed GET /api/keys response contract.
      const body = (await response.json()) as { keys: CaptureKeyEntry[] };
      if (sequence === loadSequence.current) setKeys(body.keys);
    } catch (error) {
      if (sequence === loadSequence.current) {
        setListError(
          error instanceof Error
            ? error.message
            : "Couldn't load your API keys.",
        );
      }
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      if (setup) return;
      const timer = window.setTimeout(() => void loadKeys(), 0);
      return () => window.clearTimeout(timer);
    } else {
      loadSequence.current += 1;
      queueMicrotask(() => {
        setSecret(null);
        setCopied(false);
        setCopyError(false);
        setLinkCopyError(false);
        setName(setup ? "iPhone" : "");
        setExpiry("30d");
        setPermission("capture");
        setCreateError(null);
        setRevokeError(null);
        setConfirmRevoke(null);
        setConfirmRotate(null);
        setRotateExpiry("30d");
        setRotateError(null);
      });
    }
    return undefined;
  }, [loadKeys, open, setup]);

  useEffect(() => {
    if (!open || setup) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [open, setup]);

  async function createKey(event: React.FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || busy || secret) return;
    setCreating(true);
    setCreateError(null);
    setSecret(null);
    try {
      const response = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          expiry,
          permission: setup ? "capture" : permission,
        }),
      });
      if (!response.ok) {
        throw new Error(
          await responseError(
            response,
            "Couldn't create the key. You may need to sign in again.",
          ),
        );
      }
      // SAFETY: This is the fixed POST /api/keys response contract.
      const body = (await response.json()) as {
        key: string;
        entry: CaptureKeyEntry;
      };
      setKeys((current) => [body.entry, ...current]);
      setSecret({
        id: body.entry.id,
        value: body.key,
        permission: body.entry.permission,
        expiresAt: body.entry.expiresAt,
        rotated: false,
      });
    } catch (error) {
      setCreateError(
        error instanceof Error
          ? error.message
          : "Couldn't create the key. You may need to sign in again.",
      );
    } finally {
      setCreating(false);
    }
  }

  async function rotate(target: string) {
    if (busy || revoking || secret) return;
    setRotating(target);
    setRotateError(null);
    setCopied(false);
    setCopyError(false);
    let response: Response | undefined;
    try {
      response = await fetch("/api/keys", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: target, expiry: rotateExpiry }),
      });
      if (!response.ok)
        throw new Error(
          await responseError(
            response,
            "Couldn't rotate the API key. Sign in again if needed.",
          ),
        );
      // SAFETY: PATCH /api/keys returns the same one-time key contract as creation.
      const body = (await response.json()) as {
        key: string;
        entry: CaptureKeyEntry;
      };
      setKeys((current) =>
        current.map((key) => (key.id === target ? body.entry : key)),
      );
      setSecret({
        id: body.entry.id,
        value: body.key,
        permission: body.entry.permission,
        expiresAt: body.entry.expiresAt,
        rotated: true,
      });
      setConfirmRotate(null);
      toast.success("Key rotated");
    } catch (error) {
      setRotateError(
        !response || response.ok
          ? "Couldn't receive the replacement key. Rotation may have completed. Rotate again to get a new key, then update each connection that uses it."
          : error instanceof Error
            ? error.message
            : "Couldn't rotate the API key.",
      );
    } finally {
      setRotating(null);
    }
  }

  async function revoke(target: string | "all") {
    if (busy) return;
    setRevoking(target);
    setRevokeError(null);
    try {
      const response = await fetch("/api/keys", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(target === "all" ? {} : { id: target }),
      });
      if (!response.ok) {
        throw new Error(
          await responseError(response, "Couldn't revoke the API key."),
        );
      }
      setKeys((current) =>
        target === "all" ? [] : current.filter((key) => key.id !== target),
      );
      if (target === "all" || target === secret?.id) {
        setSecret(null);
        setCopied(false);
      }
      setConfirmRevoke(null);
      toast.success(target === "all" ? "All keys revoked" : "Key revoked");
    } catch (error) {
      setRevokeError(
        error instanceof Error ? error.message : "Couldn't revoke the API key.",
      );
    } finally {
      setRevoking(null);
    }
  }

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.value);
      setCopied(true);
      setCopyError(false);
      toast.success("API key copied");
    } catch {
      setCopyError(true);
    }
  }

  async function copyInstallLink() {
    try {
      await navigator.clipboard.writeText(APPLE_SHORTCUT_URL);
      setLinkCopyError(false);
      toast.success("Installation link copied");
    } catch {
      setLinkCopyError(true);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Do not abandon an in-flight creation or rotation: the server may
        // have issued a secret that can only be shown in this response.
        if (creating || rotating) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        className={cn(
          "max-h-[calc(100dvh-2rem)] grid-cols-1 overflow-y-auto",
          setup ? "sm:max-w-lg" : "sm:max-w-2xl",
        )}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HugeiconsIcon icon={setup ? SmartPhone01Icon : Key01Icon} />
            {setup ? "Add Apple Shortcut" : "API keys"}
          </DialogTitle>
          <DialogDescription>
            {setup
              ? "Add text and links to today's note from the share sheet or by running a shortcut. Available on every plan."
              : "Create personal API keys for shortcuts, MCP, and the CLI. Give each connection only the access it needs. Existing capture keys remain capture only."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={createKey} className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">
            {setup ? "1. Create a capture key" : "Create a key"}
          </h3>
          <FieldGroup className="gap-3">
            <Field data-disabled={busy || !!secret}>
              <FieldLabel htmlFor="capture-key-name">Name</FieldLabel>
              <Input
                id="capture-key-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Shortcut or script name"
                maxLength={80}
                disabled={busy || !!secret}
              />
            </Field>
            {!setup && (
              <Field data-disabled={busy || !!secret}>
                <FieldLabel id="api-key-permission-label">
                  Permission
                </FieldLabel>
                <ToggleGroup
                  aria-labelledby="api-key-permission-label"
                  variant="selection"
                  className="w-full flex-wrap"
                  value={[permission]}
                  onValueChange={(values) => {
                    const next = values[0];
                    if (
                      next === "capture" ||
                      next === "read" ||
                      next === "write"
                    )
                      setPermission(next);
                  }}
                  disabled={busy || !!secret}
                >
                  {Object.entries(PERMISSIONS).map(([value, option]) => (
                    <ToggleGroupItem key={value} value={value}>
                      <HugeiconsIcon
                        icon={Tick02Icon}
                        className={
                          permission !== value ? "invisible" : undefined
                        }
                      />
                      {option.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <p className="text-xs text-muted-foreground">
                  {PERMISSIONS[permission].description}
                </p>
              </Field>
            )}
            {setup && (
              <p className="text-sm text-muted-foreground">
                Capture only: append to daily notes, without reading or changing
                existing content.
              </p>
            )}
            <Field data-disabled={busy || !!secret}>
              <FieldLabel id="api-key-expiry-label">Expiration</FieldLabel>
              <ToggleGroup
                aria-labelledby="api-key-expiry-label"
                variant="selection"
                value={[expiry]}
                onValueChange={(values) => {
                  const next = values[0];
                  if (next === "30d" || next === "90d") setExpiry(next);
                }}
                disabled={busy || !!secret}
              >
                <ToggleGroupItem value="30d">
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    className={expiry !== "30d" ? "invisible" : undefined}
                  />
                  30 days
                </ToggleGroupItem>
                <ToggleGroupItem value="90d">
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    className={expiry !== "90d" ? "invisible" : undefined}
                  />
                  90 days
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>
            <Button type="submit" disabled={busy || !!secret || !name.trim()}>
              {creating && (
                <HugeiconsIcon
                  icon={Loading03Icon}
                  data-icon="inline-start"
                  className="animate-spin"
                />
              )}
              {creating ? "Creating…" : "Create key"}
            </Button>
          </FieldGroup>
          {createError && (
            <p role="alert" className="text-sm text-destructive">
              {createError}
            </p>
          )}
        </form>

        {secret && (
          <section
            aria-labelledby="new-capture-key"
            className="flex flex-col gap-2 rounded-lg bg-muted p-3"
          >
            <h3 id="new-capture-key" className="text-sm font-medium">
              {setup ? "2. Copy your key" : "Copy your new key now"}
            </h3>
            <p className="text-xs text-muted-foreground">
              This key won't be shown again after you close this dialog.
            </p>
            <p className="text-xs text-muted-foreground">
              {PERMISSIONS[secret.permission].label} · Expires{" "}
              {formatDate(secret.expiresAt)}
            </p>
            {secret.rotated && (
              <p className="text-sm">
                The old key no longer works. Copy this replacement and update
                your shortcut, app, or DOTFLOWY_TOKEN.
              </p>
            )}
            <div className="flex items-center gap-2">
              <Input
                aria-label="New API key"
                value={secret.value}
                readOnly
                autoComplete="off"
                spellCheck={false}
                onFocus={(event) => event.target.select()}
                onClick={(event) => event.currentTarget.select()}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void copySecret()}
              >
                {copied ? (
                  <HugeiconsIcon icon={Tick02Icon} data-icon="inline-start" />
                ) : (
                  <HugeiconsIcon icon={Copy01Icon} data-icon="inline-start" />
                )}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            {copyError && (
              <p role="alert" className="text-sm text-muted-foreground">
                Couldn't copy automatically. Select the key above and use your
                device's Copy command.
              </p>
            )}
          </section>
        )}

        {setup && !secret && (
          <p className="text-sm text-muted-foreground">
            2. Copy your key when it appears. It is shown only once.
          </p>
        )}

        {setup ? (
          <>
            <Separator />
            <section
              className="flex flex-col gap-3"
              aria-labelledby="install-shortcut"
            >
              <h3 id="install-shortcut" className="text-sm font-medium">
                3. Add the shortcut
              </h3>
              <p className="text-sm text-muted-foreground">
                Open the signed Dotflowy.shortcut file in Shortcuts and paste
                your key during setup. Your installed shortcut contains the key,
                so treat it as a credential.
              </p>
              <a
                href={APPLE_SHORTCUT_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants()}
                aria-disabled={creating}
                onClick={(event) => {
                  // Keep the one-time creation response on screen.
                  if (creating) event.preventDefault();
                }}
              >
                Add to Apple Shortcuts
              </a>
              <p className="text-xs text-muted-foreground">
                If the file downloads instead, open it from Files. If the Home
                Screen app doesn't open the file, copy the installation link and
                open it in Safari.
              </p>
              <Button variant="outline" onClick={() => void copyInstallLink()}>
                <HugeiconsIcon icon={Copy01Icon} data-icon="inline-start" />
                Copy installation link
              </Button>
              <p className="text-xs text-muted-foreground">
                For the Dotflowy logo on your Home Screen,{" "}
                <a
                  href="/apple-touch-icon.png"
                  download="Dotflowy.png"
                  className="underline underline-offset-4"
                >
                  download the Dotflowy icon
                </a>
                , then choose that file as the icon when using Add to Home
                Screen in Shortcuts. The shortcut collection uses Apple's
                built-in glyphs.
              </p>
              {linkCopyError && (
                <Field>
                  <FieldLabel htmlFor="shortcut-install-link">
                    Installation link
                  </FieldLabel>
                  <Input
                    id="shortcut-install-link"
                    readOnly
                    value={APPLE_SHORTCUT_URL}
                    onFocus={(event) => event.target.select()}
                    onClick={(event) => event.currentTarget.select()}
                  />
                  <p role="alert" className="text-xs text-muted-foreground">
                    Couldn't copy automatically. Select this link and use your
                    device's Copy command, then paste it into Safari.
                  </p>
                </Field>
              )}
            </section>
            <Link
              to="/settings"
              hash="capture-keys"
              className="text-sm text-muted-foreground underline underline-offset-4"
              aria-disabled={creating}
              onClick={(event) => {
                if (creating) event.preventDefault();
                else onOpenChange(false);
              }}
            >
              Manage API keys in Settings
            </Link>
          </>
        ) : (
          <>
            <Separator />

            <section
              className="flex flex-col gap-3"
              aria-labelledby="existing-keys"
            >
              <div className="flex items-center justify-between gap-3">
                <h3 id="existing-keys" className="text-sm font-medium">
                  Your keys
                </h3>
                {keys.length > 0 && confirmRevoke !== "all" && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setConfirmRotate(null);
                      setConfirmRevoke("all");
                    }}
                  >
                    Revoke all
                  </Button>
                )}
              </div>

              {loading ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <HugeiconsIcon
                    icon={Loading03Icon}
                    className="animate-spin"
                  />{" "}
                  Loading keys…
                </p>
              ) : listError ? (
                <div className="flex items-center justify-between gap-3">
                  <p role="alert" className="text-sm text-destructive">
                    {listError}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void loadKeys()}
                  >
                    <HugeiconsIcon
                      icon={RefreshIcon}
                      data-icon="inline-start"
                    />{" "}
                    Retry
                  </Button>
                </div>
              ) : keys.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No API keys yet.
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-border rounded-lg ring-1 ring-foreground/10">
                  {keys.map((key) => (
                    <li
                      key={key.id}
                      className="flex flex-col gap-2 p-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {key.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          ••••{key.suffix} · Created {formatDate(key.createdAt)}{" "}
                          · Last used {formatDate(key.lastUsedAt)} ·{" "}
                          {PERMISSIONS[key.permission].label} ·{" "}
                          {key.expiresAt <= now ? "Expired" : "Expires"}{" "}
                          {formatDate(key.expiresAt)}
                        </p>
                      </div>
                      {confirmRevoke === key.id ? (
                        <div className="flex shrink-0 items-center gap-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => setConfirmRevoke(null)}
                          >
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={busy}
                            onClick={() => void revoke(key.id)}
                          >
                            {revoking === key.id && (
                              <HugeiconsIcon
                                icon={Loading03Icon}
                                data-icon="inline-start"
                                className="animate-spin"
                              />
                            )}
                            Confirm revoke
                          </Button>
                        </div>
                      ) : (
                        <div className="flex shrink-0 items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-label={`Rotate ${key.name}`}
                            disabled={busy || !!secret}
                            onClick={() => {
                              setConfirmRevoke(null);
                              setRotateError(null);
                              setRotateExpiry("30d");
                              setConfirmRotate(key.id);
                            }}
                          >
                            Rotate
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Revoke ${key.name}`}
                            disabled={busy}
                            onClick={() => {
                              setConfirmRotate(null);
                              setConfirmRevoke(key.id);
                            }}
                          >
                            <HugeiconsIcon icon={Delete02Icon} />
                          </Button>
                        </div>
                      )}
                      {confirmRotate === key.id && (
                        <div className="flex w-full flex-col gap-3 rounded-lg bg-muted p-3">
                          <p className="text-sm">
                            Rotate {key.name}? The old key will stop working
                            immediately. Its permission stays{" "}
                            {PERMISSIONS[key.permission].label.toLowerCase()}.
                            Update each shortcut or script with the replacement.
                          </p>
                          <Field>
                            <FieldLabel id={`rotate-expiry-${key.id}`}>
                              Replacement expiration
                            </FieldLabel>
                            <ToggleGroup
                              aria-labelledby={`rotate-expiry-${key.id}`}
                              variant="selection"
                              value={[rotateExpiry]}
                              disabled={busy}
                              onValueChange={(values) => {
                                const value = values[0];
                                if (value === "30d" || value === "90d")
                                  setRotateExpiry(value);
                              }}
                            >
                              <ToggleGroupItem value="30d">
                                <HugeiconsIcon
                                  icon={Tick02Icon}
                                  className={
                                    rotateExpiry !== "30d"
                                      ? "invisible"
                                      : undefined
                                  }
                                />
                                30 days
                              </ToggleGroupItem>
                              <ToggleGroupItem value="90d">
                                <HugeiconsIcon
                                  icon={Tick02Icon}
                                  className={
                                    rotateExpiry !== "90d"
                                      ? "invisible"
                                      : undefined
                                  }
                                />
                                90 days
                              </ToggleGroupItem>
                            </ToggleGroup>
                          </Field>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => setConfirmRotate(null)}
                            >
                              Cancel
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              disabled={busy}
                              onClick={() => void rotate(key.id)}
                            >
                              {rotating === key.id
                                ? "Rotating…"
                                : "Confirm rotation"}
                            </Button>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {confirmRevoke === "all" && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted p-3">
                  <p className="text-sm">
                    Revoke every API key? Existing shortcuts, apps, and scripts
                    will stop working.
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirmRevoke(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() => void revoke("all")}
                    >
                      {revoking === "all" && (
                        <HugeiconsIcon
                          icon={Loading03Icon}
                          data-icon="inline-start"
                          className="animate-spin"
                        />
                      )}
                      Confirm revoke all
                    </Button>
                  </div>
                </div>
              )}
              {rotateError && (
                <p role="alert" className="text-sm text-destructive">
                  {rotateError}
                </p>
              )}
              {revokeError && (
                <p role="alert" className="text-sm text-destructive">
                  {revokeError}
                </p>
              )}
            </section>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

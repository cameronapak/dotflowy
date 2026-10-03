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
import { NativeSelect, NativeSelectOption } from "./ui/native-select";
import { Separator } from "./ui/separator";

type Expiry = "never" | "30d" | "90d" | "1y";

const APPLE_SHORTCUT_URL =
  "https://www.icloud.com/shortcuts/73918f14013646a1a36252939c26db46";

interface CaptureKeyEntry {
  id: string;
  name: string;
  suffix: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
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

export function CaptureKeysDialog(props: CaptureDialogProps) {
  return <CaptureDialog {...props} setup={false} />;
}

export function AppleShortcutSetupDialog(props: CaptureDialogProps) {
  return <CaptureDialog {...props} setup />;
}

// Both surfaces create the same scoped credential. Only management loads and
// revokes keys; setup stays focused on creating, copying, and installing.
function CaptureDialog({
  open,
  onOpenChange,
  setup,
}: CaptureDialogProps & { setup: boolean }) {
  const [keys, setKeys] = useState<CaptureKeyEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [name, setName] = useState(setup ? "iPhone" : "");
  const [expiry, setExpiry] = useState<Expiry>("never");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ id: string; value: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [linkCopyError, setLinkCopyError] = useState(false);
  const [revoking, setRevoking] = useState<string | "all" | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | "all" | null>(
    null,
  );
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const loadSequence = useRef(0);

  const loadKeys = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setListError(null);
    try {
      const response = await fetch("/api/capture-keys");
      if (!response.ok) {
        throw new Error(
          await responseError(response, "Couldn't load your capture keys."),
        );
      }
      // SAFETY: This is the fixed GET /api/capture-keys response contract.
      const body = (await response.json()) as { keys: CaptureKeyEntry[] };
      if (sequence === loadSequence.current) setKeys(body.keys);
    } catch (error) {
      if (sequence === loadSequence.current) {
        setListError(
          error instanceof Error
            ? error.message
            : "Couldn't load your capture keys.",
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
        setExpiry("never");
        setCreateError(null);
        setRevokeError(null);
        setConfirmRevoke(null);
      });
    }
    return undefined;
  }, [loadKeys, open, setup]);

  async function createKey(event: React.FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || creating || secret) return;
    setCreating(true);
    setCreateError(null);
    setSecret(null);
    try {
      const response = await fetch("/api/capture-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmedName, expiry }),
      });
      if (!response.ok) {
        throw new Error(
          await responseError(
            response,
            "Couldn't create the key. You may need to sign in again.",
          ),
        );
      }
      // SAFETY: This is the fixed POST /api/capture-keys response contract.
      const body = (await response.json()) as {
        key: string;
        entry: CaptureKeyEntry;
      };
      setKeys((current) => [body.entry, ...current]);
      setSecret({ id: body.entry.id, value: body.key });
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

  async function revoke(target: string | "all") {
    if (revoking) return;
    setRevoking(target);
    setRevokeError(null);
    try {
      const response = await fetch("/api/capture-keys", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(target === "all" ? {} : { id: target }),
      });
      if (!response.ok) {
        throw new Error(
          await responseError(response, "Couldn't revoke the capture key."),
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
        error instanceof Error
          ? error.message
          : "Couldn't revoke the capture key.",
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
      toast.success("Capture key copied");
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
        // Do not abandon an in-flight creation: the server may have created a
        // secret that can only be shown in this response.
        if (creating) return;
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
            {setup ? "Add Apple Shortcut" : "Capture keys"}
          </DialogTitle>
          <DialogDescription>
            {setup
              ? "Add text and links to today's note from the share sheet or by running a shortcut. Available on every plan."
              : "Keys let shortcuts and scripts add new items to your daily notes. They can't read, edit, or delete your outline."}
          </DialogDescription>
        </DialogHeader>

        {setup && (
          <p className="text-sm text-muted-foreground">
            Experimental. Installation and capture are not fully tested on
            iPhone yet. Check today's note if a save cannot be confirmed.
          </p>
        )}

        <form onSubmit={createKey} className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">
            {setup ? "1. Create a capture key" : "Create a key"}
          </h3>
          <FieldGroup
            className={cn(
              "gap-3",
              !setup && "sm:grid sm:grid-cols-[1fr_11rem_auto] sm:items-end",
            )}
          >
            <Field data-disabled={creating || !!secret}>
              <FieldLabel htmlFor="capture-key-name">Name</FieldLabel>
              <Input
                id="capture-key-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Shortcut or script name"
                maxLength={80}
                disabled={creating || !!secret}
              />
            </Field>
            <Field data-disabled={creating || !!secret}>
              <FieldLabel htmlFor="capture-key-expiry">Expiration</FieldLabel>
              <NativeSelect
                id="capture-key-expiry"
                value={expiry}
                onChange={(event) => {
                  // SAFETY: Every option value is one of the Expiry literals.
                  setExpiry(event.target.value as Expiry);
                }}
                disabled={creating || !!secret}
              >
                <NativeSelectOption value="never">
                  No expiration
                </NativeSelectOption>
                <NativeSelectOption value="30d">30 days</NativeSelectOption>
                <NativeSelectOption value="90d">90 days</NativeSelectOption>
                <NativeSelectOption value="1y">1 year</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Button
              type="submit"
              disabled={creating || !!secret || !name.trim()}
            >
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
            <div className="flex items-center gap-2">
              <Input
                aria-label="New capture key"
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
                During import, paste your key into the shortcut's setup prompt.
                Keep it private: sharing a configured shortcut also shares its
                key.
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
                If the Home Screen app doesn't open Shortcuts, copy the
                installation link and open it in Safari.
              </p>
              <Button variant="outline" onClick={() => void copyInstallLink()}>
                <HugeiconsIcon icon={Copy01Icon} data-icon="inline-start" />
                Copy installation link
              </Button>
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
              Manage capture keys in Settings
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
                    onClick={() => setConfirmRevoke("all")}
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
                  No capture keys yet.
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-border rounded-lg ring-1 ring-foreground/10">
                  {keys.map((key) => (
                    <li
                      key={key.id}
                      className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {key.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          ••••{key.suffix} · Created {formatDate(key.createdAt)}{" "}
                          · Last used {formatDate(key.lastUsedAt)} · Expires{" "}
                          {formatDate(key.expiresAt)}
                        </p>
                      </div>
                      {confirmRevoke === key.id ? (
                        <div className="flex shrink-0 items-center gap-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={revoking !== null}
                            onClick={() => setConfirmRevoke(null)}
                          >
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={revoking !== null}
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
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Revoke ${key.name}`}
                          disabled={revoking !== null}
                          onClick={() => setConfirmRevoke(key.id)}
                        >
                          <HugeiconsIcon icon={Delete02Icon} />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {confirmRevoke === "all" && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted p-3">
                  <p className="text-sm">
                    Revoke every capture key? Existing shortcuts and scripts
                    will stop working.
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={revoking !== null}
                      onClick={() => setConfirmRevoke(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={revoking !== null}
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

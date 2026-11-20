// Settings → Personal plugins (ADR 0095). Shown only to an eligible account.
// The account switch turns the beta on or off; each plugin has its own
// switch, a version picker over its Artifacts history, Remove (keeps history),
// and Delete history (permanent, confirmed).

import { useEffect, useState } from "react";
import { toast } from "sonner";

import type {
  PersonalPluginSummary,
  PersonalPluginVersion,
} from "../../data/personal-plugins";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  NativeSelect,
  NativeSelectOption,
  SettingsOptionRow,
  SettingsSwitchTarget,
  Switch,
} from "../kit";
import { refresh, setOptIn, useOptedIn } from "./store";

const PART_LABEL = new Map([
  ["chip", "Inline chip"],
  ["progress", "Progress bar"],
  ["board", "Board"],
  ["subheader", "Header band"],
  ["panel", "Side panel (Cmd+K)"],
]);

/** The bodies Settings sends to /api/personal-plugins. */
interface CallBody {
  id: string;
  enabled?: boolean;
  version?: string | null;
  confirm?: true;
}

async function call<T>(path: string, method: string, body?: CallBody) {
  const res = await fetch(`/api/personal-plugins/${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => null);
  if (!res?.ok) {
    // SAFETY: the Worker answers errors as { error }.
    const reason = (await res?.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(reason?.error ?? "Couldn't reach Dotflowy.");
  }
  // SAFETY: each route's caller names the body that route returns.
  return (await res.json()) as T;
}

export function PersonalPluginsSettings() {
  const optedIn = useOptedIn();
  const [rows, setRows] = useState<PersonalPluginSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = () =>
    call<PersonalPluginSummary[]>("list", "GET").then(setRows, () =>
      setRows([]),
    );
  useEffect(() => {
    if (optedIn) void reload();
    else setRows(null);
  }, [optedIn]);
  const run = (work: Promise<unknown>, failure: string) => {
    setBusy(true);
    void work
      .then(() => Promise.all([reload(), refresh()]))
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : failure),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        <div className="flex items-center justify-between gap-4 py-3 pr-4 pl-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">
              Personal plugins{" "}
              <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                Beta
              </span>
            </div>
            <div className="mt-0.5 text-sm text-muted-foreground">
              Your own agent adds views and commands over MCP. Only you see
              them. Turning this off hides them and keeps every plugin and
              version.
            </div>
          </div>
          <SettingsSwitchTarget>
            <Switch
              aria-label="Personal plugins"
              checked={optedIn}
              disabled={busy}
              onCheckedChange={(next) =>
                run(
                  setOptIn(next).then((ok) => {
                    if (!ok) throw new Error("Couldn't save that setting.");
                  }),
                  "Couldn't save that setting.",
                )
              }
            />
          </SettingsSwitchTarget>
        </div>
      </div>
      {optedIn && rows?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No plugins yet. Connect your agent in Connections, then ask it to make
          one. It starts with the get_personal_plugin_guide tool.
        </p>
      )}
      {optedIn && !!rows?.length && (
        <div className="divide-y divide-border overflow-hidden rounded-xl ring-1 ring-foreground/10">
          {rows.map((plugin) => (
            <PluginRow key={plugin.id} plugin={plugin} busy={busy} run={run} />
          ))}
        </div>
      )}
    </div>
  );
}

function PluginRow({
  plugin,
  busy,
  run,
}: {
  plugin: PersonalPluginSummary;
  busy: boolean;
  run: (work: Promise<unknown>, failure: string) => void;
}) {
  const [versions, setVersions] = useState<PersonalPluginVersion[] | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    void call<{ versions: PersonalPluginVersion[] }>(
      `versions?id=${encodeURIComponent(plugin.id)}`,
      "GET",
    ).then(
      (r) => setVersions(r.versions),
      () => setVersions([]),
    );
  }, [plugin.id, plugin.activeVersion]);
  const parts = plugin.parts
    .map((p) => {
      const what = PART_LABEL.get(p.what) ?? p.what;
      return p.syntax ? `${p.syntax} ${what}` : what;
    })
    .join(" · ");
  const latest = versions?.[0]?.version ?? null;
  return (
    <div data-personal-plugin={plugin.id} className="bg-card">
      <div className="flex items-center justify-between gap-4 py-3 pr-4 pl-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">
            {plugin.name}
          </div>
          {plugin.description && (
            <div className="mt-0.5 text-sm text-muted-foreground">
              {plugin.description}
            </div>
          )}
          <div className="mt-1 text-xs text-muted-foreground">
            {!plugin.installed
              ? "Removed. Its history is kept."
              : plugin.activeVersion
                ? parts || "Nothing visible yet"
                : "No live version"}
          </div>
        </div>
        {plugin.installed && (
          <SettingsSwitchTarget>
            <Switch
              aria-label={plugin.name}
              checked={plugin.enabled}
              disabled={busy}
              onCheckedChange={(enabled) =>
                run(
                  call("enabled", "PUT", { id: plugin.id, enabled }),
                  "Couldn't save that plugin setting.",
                )
              }
            />
          </SettingsSwitchTarget>
        )}
      </div>
      <div className="divide-y divide-border border-t bg-muted/30">
        <SettingsOptionRow
          title="Version"
          description="Each save by your agent is a version. Pick one to make it live."
        >
          <NativeSelect
            size="sm"
            aria-label={`${plugin.name} version`}
            disabled={busy || versions === null || !versions.length}
            value={plugin.activeVersion ?? ""}
            onChange={(e) =>
              run(
                call("activate", "POST", {
                  id: plugin.id,
                  version: e.target.value || null,
                }),
                "Couldn't switch versions.",
              )
            }
          >
            <NativeSelectOption value="">None live</NativeSelectOption>
            {versions?.map((v, i) => (
              <NativeSelectOption key={v.version} value={v.version}>
                {`v${versions.length - i} · ${v.note || "Untitled"}`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </SettingsOptionRow>
        <div className="flex flex-wrap justify-end gap-2 py-2 pr-4 pl-8">
          {plugin.installed ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                run(
                  call("uninstall", "POST", { id: plugin.id }),
                  "Couldn't remove that plugin.",
                )
              }
            >
              Remove
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !latest}
              onClick={() =>
                run(
                  call("activate", "POST", { id: plugin.id, version: latest }),
                  "Couldn't restore that plugin.",
                )
              }
            >
              Restore latest
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            Delete history
          </Button>
        </div>
      </div>
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {plugin.name} for good?</DialogTitle>
            <DialogDescription>
              This removes the plugin and every saved version. Notes that use
              its syntax keep their text. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmDelete(false);
                run(
                  call("delete-history", "POST", {
                    id: plugin.id,
                    confirm: true,
                  }),
                  "Couldn't delete that history.",
                );
              }}
            >
              Delete history
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

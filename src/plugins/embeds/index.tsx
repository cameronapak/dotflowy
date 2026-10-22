import { LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Duration, Effect, Schema } from "effect";
import { motion, useReducedMotion } from "motion/react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import type { Node } from "../../data/schema";
import type { PluginContext } from "../types";

import { readSource } from "../../components/inline-code";
import { openSettings } from "../../components/settings-nav";
import {
  getEditorFeatures,
  loadEditorFeatures,
  useEditorFeatures,
} from "../../data/editor-features";
import {
  EmbedResponse,
  embedResource,
  validEmbedSrc,
  type EmbedDescriptor,
} from "../../data/embed-providers";
import { embedUrl } from "../../data/embed-url";
import { bareHttpUrl, encodeUrlForMarkdown } from "../../data/links";
import { queryClient } from "../../data/query-client";
import { featureToggleAction } from "../feature-actions";
import {
  Button,
  Skeleton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "../kit";
import { cancelNodeUnfurl, unfurlNodeLinks } from "../links/unfurl";
import { definePlugin } from "../types";
import { requestPermission } from "./permission";

function EmbedIcon({ className }: { className?: string }) {
  return <HugeiconsIcon icon={LinkSquare02Icon} className={className} />;
}

interface XWidgets {
  widgets: {
    createTweet(
      id: string,
      element: HTMLElement,
      options: { align: "left"; dnt: true; theme: "dark" | "light" },
    ): Promise<HTMLElement | undefined>;
  };
}

declare global {
  interface Window {
    twttr?: XWidgets;
  }
}

let xWidgetsPromise: Promise<XWidgets> | null = null;
function loadXWidgets(): Promise<XWidgets> {
  if (window.twttr?.widgets) return Promise.resolve(window.twttr);
  if (xWidgetsPromise) return xWidgetsPromise;
  const loading = new Promise<XWidgets>((resolve, reject) => {
    const finish = () =>
      window.twttr?.widgets
        ? resolve(window.twttr)
        : reject(new Error("X widgets unavailable"));
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://platform.twitter.com/widgets.js"]',
    );
    if (existing) {
      existing.addEventListener("load", finish, { once: true });
      existing.addEventListener("error", reject, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://platform.twitter.com/widgets.js";
    script.async = true;
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", reject, { once: true });
    document.head.append(script);
  });
  xWidgetsPromise = loading.catch((error) => {
    xWidgetsPromise = null;
    throw error;
  });
  return loading;
}

type DisplayAs = "link" | "plain" | "embed";

function changeDisplay(
  nodeId: string,
  url: string,
  display: DisplayAs,
  ctx: PluginContext,
  el?: HTMLElement,
): boolean {
  const node = ctx.tree.byId.get(nodeId);
  if (
    !node ||
    (embedUrl(node.text) ?? bareHttpUrl(node.text)) !== url ||
    (el && (embedUrl(readSource(el)) ?? bareHttpUrl(readSource(el))) !== url)
  )
    return false;

  cancelNodeUnfurl(nodeId);
  if (display === "embed") {
    if (!getEditorFeatures().embeds || !embedResource(url)) return false;
    ctx.mutations.onSetKind(nodeId, "embed", url);
    return true;
  }

  const text =
    display === "link" ? `[${url}](${encodeUrlForMarkdown(url)})` : url;
  if (node.kind === "embed") ctx.mutations.onSetKind(nodeId, null, text);
  else ctx.mutations.onTextChange(nodeId, text);
  if (display === "link") unfurlNodeLinks(nodeId, "", text, ctx, el);
  return true;
}

function DisplayMenuContent({
  nodeId,
  url,
  current,
  getCtx,
  label,
  returnFocus,
  sourceEl,
  first,
  onDone,
}: {
  nodeId: string;
  url: string;
  current: DisplayAs;
  getCtx: () => PluginContext;
  label: string;
  returnFocus?: HTMLElement;
  sourceEl?: HTMLElement;
  first?: React.RefObject<HTMLDivElement | null>;
  onDone?: () => void;
}) {
  const ctx = getCtx();
  const mirrorCount = ctx.tree.mirrorsBySource.get(nodeId)?.length ?? 0;
  const choose = (display: DisplayAs) => {
    if (display === current) return;
    const ctx = getCtx();
    const changed = changeDisplay(nodeId, url, display, ctx, sourceEl);
    onDone?.();
    if (changed && display === "embed" && !getEditorFeatures().externalEmbeds) {
      queueMicrotask(() => requestPermission(ctx, returnFocus));
    }
  };
  return (
    <DropdownMenuContent
      anchor={returnFocus}
      className="w-52"
      aria-label={label}
      finalFocus={() => returnFocus ?? true}
    >
      <DropdownMenuGroup>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={current}
          onValueChange={(value) => {
            if (value === "link" || value === "plain" || value === "embed")
              choose(value);
          }}
        >
          <DropdownMenuRadioItem
            ref={first}
            value="link"
            disabled={current === "link"}
          >
            Link Title
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="plain" disabled={current === "plain"}>
            Plain URL
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            value="embed"
            disabled={current === "embed" || !embedResource(url)}
          >
            Embed
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {mirrorCount > 0 && (
          <DropdownMenuLabel>
            Changes all {mirrorCount + 1} instances
          </DropdownMenuLabel>
        )}
      </DropdownMenuGroup>
    </DropdownMenuContent>
  );
}

function PasteChoice({
  nodeId,
  url,
  el,
  ctx,
}: {
  nodeId: string;
  url: string;
  el: HTMLElement;
  ctx: PluginContext;
}) {
  const first = useRef<HTMLDivElement>(null);
  return (
    <DropdownMenu
      open
      modal={false}
      onOpenChangeComplete={(open) => {
        if (open) first.current?.focus();
      }}
      onOpenChange={(open) => {
        if (!open) ctx.openOverlay(null);
      }}
    >
      <DisplayMenuContent
        nodeId={nodeId}
        url={url}
        current="plain"
        getCtx={() => ctx}
        label="Paste as"
        returnFocus={el}
        sourceEl={el}
        first={first}
        onDone={() => ctx.openOverlay(null)}
      />
    </DropdownMenu>
  );
}

function fallbackToLink(
  nodeId: string,
  url: string,
  getCtx: () => PluginContext,
) {
  const ctx = getCtx();
  if (!changeDisplay(nodeId, url, "link", ctx)) return;
  toast("URL couldn’t be embedded, kept as a link instead.", {
    id: `embed:${nodeId}`,
  });
}

function ProviderFrame({
  nodeId,
  url,
  getCtx,
}: {
  nodeId: string;
  url: string;
  getCtx: () => PluginContext;
}) {
  const [result, setResult] = useState<EmbedDescriptor | null | undefined>(
    undefined,
  );
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const reported = useRef(false);
  useEffect(() => {
    let active = true;
    const resource = embedResource(url);
    void queryClient
      .fetchQuery({
        queryKey: ["embed", url],
        staleTime: 60 * 60 * 1000,
        retry: false,
        queryFn: ({ signal }) =>
          Effect.runPromise(
            Effect.tryPromise({
              try: async (abortSignal) => {
                const response = await fetch(
                  `/api/embeds?url=${encodeURIComponent(url)}`,
                  { signal: abortSignal },
                );
                return response.ok ? response.json() : { embed: null };
              },
              catch: (cause) => cause,
            }).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(EmbedResponse)),
              Effect.map(({ embed }) =>
                embed &&
                resource &&
                embed.provider === resource.provider &&
                validEmbedSrc(resource, embed.src)
                  ? embed
                  : null,
              ),
              Effect.timeoutOrElse({
                duration: Duration.seconds(8),
                orElse: () => Effect.succeed(null),
              }),
              Effect.orElseSucceed(() => null),
            ),
            { signal },
          ),
      })
      .then(
        (embed) => {
          if (active) setResult(embed);
        },
        () => {
          if (active) setResult(null);
        },
      );
    return () => {
      active = false;
    };
  }, [url]);
  useEffect(() => {
    if (!result || loaded) return;
    const timer = window.setTimeout(() => setFailed(true), 15000);
    return () => window.clearTimeout(timer);
  }, [result, loaded]);

  useEffect(() => {
    if (result !== null && !failed) return;
    if (reported.current) return;
    reported.current = true;
    fallbackToLink(nodeId, url, getCtx);
  }, [result, failed, nodeId, url, getCtx]);

  if (result === null || failed) return null;
  if (result === undefined)
    return (
      <Skeleton
        className="h-24 w-full motion-reduce:animate-none"
        aria-label="Loading preview"
      />
    );
  return (
    <div
      className="overflow-hidden"
      style={{ height: loaded ? undefined : 96 }}
    >
      <div
        className="embed-frame"
        style={
          result.provider === "spotify"
            ? { height: result.height }
            : { aspectRatio: `${result.width} / ${result.height}` }
        }
      >
        {!loaded && (
          <Skeleton
            className="absolute inset-0 size-full motion-reduce:animate-none"
            aria-label="Loading preview"
          />
        )}
        <iframe
          src={result.src}
          title={result.title || `${result.provider} embed`}
          className="absolute inset-0 size-full border-0 motion-safe:transition-opacity motion-safe:duration-150"
          style={{ opacity: loaded ? 1 : 0 }}
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      </div>
    </div>
  );
}

function XFrame({
  nodeId,
  id,
  url,
  getCtx,
}: {
  nodeId: string;
  id: string;
  url: string;
  getCtx: () => PluginContext;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const reported = useRef(false);
  useEffect(() => {
    let active = true;
    const element = container.current;
    if (element) element.replaceChildren();
    void loadXWidgets().then(
      async (x) => {
        if (!active || !element) return;
        const tweet = await x.widgets.createTweet(id, element, {
          align: "left",
          dnt: true,
          theme: document.documentElement.classList.contains("dark")
            ? "dark"
            : "light",
        });
        if (!active) return;
        if (tweet) setLoaded(true);
        else setFailed(true);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [id]);
  useEffect(() => {
    if (!failed) return;
    if (reported.current) return;
    reported.current = true;
    fallbackToLink(nodeId, url, getCtx);
  }, [failed, nodeId, url, getCtx]);
  if (failed) return null;
  return (
    <div className="relative min-h-24" data-x-embed>
      {!loaded && (
        <Skeleton
          className="h-24 w-full motion-reduce:animate-none"
          aria-label="Loading preview"
        />
      )}
      <div
        ref={container}
        className={loaded ? "flow-root" : "absolute inset-0 opacity-0"}
      />
    </div>
  );
}

function AnimatedEmbedBody({ children }: { children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(96);
  const reducedMotion = useReducedMotion();
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <motion.div
      data-embed-reveal
      className="overflow-hidden"
      initial={false}
      animate={{ height }}
      transition={{ duration: reducedMotion ? 0 : 0.2, ease: "easeOut" }}
    >
      <div ref={content}>{children}</div>
    </motion.div>
  );
}

function EmbedBody({
  node,
  getCtx,
}: {
  node: Node;
  getCtx: () => PluginContext;
}) {
  const prefs = useEditorFeatures();
  if (node.kind !== "embed") return null;
  const resource = embedResource(node.text);
  // Unsupported resources fall back to the existing inline source link.
  if (!resource || !prefs.ready) return null;
  return (
    <div className="space-y-1 empty:hidden" data-embed-body>
      {!prefs.externalEmbeds && (
        <Button
          size="sm"
          variant="ghost"
          onClick={(event) => requestPermission(getCtx(), event.currentTarget)}
        >
          Load embed…
        </Button>
      )}
      {prefs.externalEmbeds && (
        <AnimatedEmbedBody>
          {resource.provider === "x" ? (
            <XFrame
              nodeId={node.id}
              id={resource.id}
              url={resource.url}
              getCtx={getCtx}
            />
          ) : (
            <ProviderFrame
              key={resource.url}
              nodeId={node.id}
              url={resource.url}
              getCtx={getCtx}
            />
          )}
        </AnimatedEmbedBody>
      )}
    </div>
  );
}

export default definePlugin({
  id: "embeds",
  globalActions: () => [
    featureToggleAction("embeds", "Embeds"),
    {
      id: "permission",
      label: "Manage external embed permission",
      description: "Review provider requests and tracking in Settings",
      icon: EmbedIcon,
      keywords: [
        "settings",
        "allow",
        "external",
        "embeds",
        "consent",
        "privacy",
      ],
      run: openSettings,
    },
  ],
  commands: [
    {
      id: "embed",
      label: "Embed",
      description: "Show this link as an external embed",
      icon: EmbedIcon,
      keywords: ["embed", "video", "tweet", "oembed"],
      available: (node) => node.kind !== "embed" && !!embedResource(node.text),
      run: (id, ctx) => {
        const url = embedUrl(ctx.tree.byId.get(id)?.text ?? "");
        if (!url) return;
        cancelNodeUnfurl(id);
        ctx.mutations.onSetKind(id, "embed", url);
        if (!getEditorFeatures().externalEmbeds) requestPermission(ctx);
      },
    },
  ],
  slots: [
    {
      id: "embeds:row",
      position: "row:body",
      render: (node, getCtx) => <EmbedBody node={node} getCtx={getCtx} />,
    },
    {
      id: "embeds:title",
      position: "title:body",
      render: (node, getCtx) => <EmbedBody node={node} getCtx={getCtx} />,
    },
  ],
  input: {
    afterPaste: ({ before, text, nodeId, el }, ctx) => {
      const prefs = getEditorFeatures();
      if (
        (prefs.ready && !prefs.embeds) ||
        before.trim() ||
        !el?.closest(".outline-row, .zoomed-title")
      )
        return;
      const url = embedUrl(text) ?? bareHttpUrl(text);
      if (!url || !el) return;
      const choose = () => {
        const current = getEditorFeatures();
        if (
          !current.ready ||
          !el.isConnected ||
          readSource(el) !== text ||
          ctx.tree.byId.get(nodeId)?.text !== text
        )
          return;
        // Preferences may have resolved to disabled while the literal URL waited.
        if (!current.embeds) {
          changeDisplay(nodeId, url, "link", ctx, el);
          return;
        }
        ctx.openOverlay(
          <PasteChoice
            key={`${nodeId}:${url}`}
            nodeId={nodeId}
            url={url}
            el={el}
            ctx={ctx}
          />,
        );
      };
      if (prefs.ready) choose();
      else
        ctx.run(
          Effect.promise(loadEditorFeatures).pipe(
            Effect.andThen(Effect.sync(choose)),
          ),
        );
    },
  },
});

import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  BotIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  PuzzleIcon,
  SquareCodeIcon,
} from "lucide-react";
import {
  SiAnthropic,
  SiClaude,
  SiCursor,
} from "@icons-pack/react-simple-icons";
import { toast } from "sonner";
import { cn } from "../lib/utils";
import { useIsMobile } from "../hooks/use-mobile";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Separator } from "./ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "./ui/input-group";

/**
 * "Connect to your AI apps" dialog (opened from the header More menu).
 *
 * Dotflowy's MCP server is a REMOTE, OAuth-gated Streamable-HTTP endpoint
 * (`POST /mcp`, ADR 0026), so every client's setup reduces to "point at the
 * server URL and sign in" -- there is no API key to paste anywhere. That's the
 * spine of this dialog: one canonical URL up top, then a per-client rail with
 * the exact command / config / deeplink for that app.
 *
 * v1 is a self-contained modal (the fastest, matches "a header menu option").
 * A shareable `/connect` route + an "active connections" panel is the clean v2
 * promotion when it earns its weight.
 */

// Real users always view this on the prod origin, so `origin + /mcp` yields the
// correct copyable URL and self-heals if the domain ever moves; the fallback
// only matters during the `/` prerender (no `window`, SPA mode / ADR 0008).
const MCP_URL =
  typeof window !== "undefined"
    ? `${window.location.origin}/mcp`
    : "https://app.dotflowy.com/mcp";

function toBase64(s: string): string {
  return typeof btoa !== "undefined" ? btoa(s) : "";
}

// One-click install deeplinks for the clients that support them. Cursor wants a
// base64 server-config object; VS Code wants the url-encoded server entry.
const CURSOR_DEEPLINK = `cursor://anysphere.cursor-deeplink/mcp/install?name=dotflowy&config=${toBase64(
  JSON.stringify({ url: MCP_URL }),
)}`;
const VSCODE_DEEPLINK = `vscode:mcp/install?${encodeURIComponent(
  JSON.stringify({ name: "dotflowy", type: "http", url: MCP_URL }),
)}`;

async function copy(text: string, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(label);
  } catch {
    toast.error("Couldn't copy to clipboard");
  }
}

/** Small icon button that copies `text` and flips to a check for a beat. */
function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={className}
      onClick={() => {
        void copy(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      aria-label="Copy"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}

/** Read-only single-line value (the server URL) with a trailing copy button. */
function CopyField({ value }: { value: string }) {
  return (
    <InputGroup>
      <InputGroupInput readOnly value={value} className="font-mono text-xs" />
      <InputGroupAddon align="inline-end">
        <InputGroupButton onClick={() => void copy(value, "URL copied")}>
          <CopyIcon />
          Copy
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

/** Monospace code block (a command or config snippet) with a copy button. */
function CopyBlock({ code }: { code: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg bg-muted p-3 pr-11 font-mono text-xs leading-relaxed text-foreground">
        {code}
      </pre>
      <CopyButton text={code} className="absolute top-1.5 right-1.5" />
    </div>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className="flex list-decimal flex-col gap-1.5 pl-4 text-sm text-muted-foreground marker:text-muted-foreground/60">
      {children}
    </ol>
  );
}

/** Deeplink "Add to X" button (renders as an anchor so the OS handles it). */
function DeeplinkButton({ href, label }: { href: string; label: string }) {
  return (
    <Button variant="outline" size="sm" render={<a href={href} />}>
      <ExternalLinkIcon data-icon="inline-start" />
      {label}
    </Button>
  );
}

interface Client {
  id: string;
  name: string;
  // Lucide icons and simple-icons brand icons both render an <svg> that inherits
  // size (tab CSS) and currentColor -- so they stay monochrome with the rail.
  icon: ComponentType<{ className?: string }>;
  content: ReactNode;
}

const CLIENTS: Client[] = [
  {
    id: "claude",
    name: "Claude",
    icon: SiClaude,
    content: (
      <>
        <p className="text-sm text-muted-foreground">
          Claude.ai and Claude Desktop connect to remote MCP servers directly.
        </p>
        <Steps>
          <li>
            Open <span className="text-foreground">Settings → Connectors</span>.
          </li>
          <li>
            Click <span className="text-foreground">Add custom connector</span>.
          </li>
          <li>Paste the server URL and continue.</li>
          <li>Sign in when the Dotflowy window opens.</li>
        </Steps>
        <CopyField value={MCP_URL} />
      </>
    ),
  },
  {
    id: "claude-code",
    name: "Claude Code",
    icon: SiAnthropic,
    content: (
      <>
        <p className="text-sm text-muted-foreground">
          Add Dotflowy as an HTTP MCP server from your terminal.
        </p>
        <CopyBlock
          code={`claude mcp add --transport http dotflowy ${MCP_URL}`}
        />
        <p className="text-sm text-muted-foreground">
          Then run <span className="font-mono text-foreground">/mcp</span>{" "}
          inside Claude Code and pick Dotflowy to sign in.
        </p>
      </>
    ),
  },
  {
    id: "cursor",
    name: "Cursor",
    icon: SiCursor,
    content: (
      <>
        <p className="text-sm text-muted-foreground">
          One click, or add it to your MCP config by hand.
        </p>
        <DeeplinkButton href={CURSOR_DEEPLINK} label="Add to Cursor" />
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Or add to <span className="font-mono">.cursor/mcp.json</span>:
          </p>
          <CopyBlock
            code={`{\n  "mcpServers": {\n    "dotflowy": {\n      "url": "${MCP_URL}"\n    }\n  }\n}`}
          />
        </div>
      </>
    ),
  },
  {
    id: "vscode",
    name: "VS Code",
    icon: SquareCodeIcon,
    content: (
      <>
        <p className="text-sm text-muted-foreground">
          One click, or add it to your workspace MCP config.
        </p>
        <DeeplinkButton href={VSCODE_DEEPLINK} label="Install in VS Code" />
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Or add to <span className="font-mono">.vscode/mcp.json</span>:
          </p>
          <CopyBlock
            code={`{\n  "servers": {\n    "dotflowy": {\n      "type": "http",\n      "url": "${MCP_URL}"\n    }\n  }\n}`}
          />
        </div>
      </>
    ),
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    icon: BotIcon,
    content: (
      <>
        <p className="text-sm text-muted-foreground">
          Requires connectors / developer mode (availability varies by plan).
        </p>
        <Steps>
          <li>
            Open <span className="text-foreground">Settings → Connectors</span>.
          </li>
          <li>Add a connector and paste the server URL.</li>
          <li>Authenticate with your Dotflowy account.</li>
        </Steps>
        <CopyField value={MCP_URL} />
      </>
    ),
  },
  {
    id: "other",
    name: "Other apps",
    icon: PuzzleIcon,
    content: (
      <>
        <p className="text-sm text-muted-foreground">
          Cline, Windsurf, Zed, Codex and most MCP clients take the URL
          directly. The universal installer writes the config for you:
        </p>
        <CopyBlock code={`npx install-mcp ${MCP_URL} --client <your-client>`} />
        <p className="text-sm text-muted-foreground">
          Dotflowy is a Streamable-HTTP server with OAuth, so any spec-compliant
          client works.
        </p>
      </>
    ),
  },
];

/**
 * Animates its own height as `children` reflow -- here, when the active tab
 * panel swaps and the natural height jumps. A CSS `height` transition (not a
 * keyframe) so a rapid tab-switch interrupts and retargets cleanly mid-flight;
 * height is measured off the padded inner via ResizeObserver so wrap/reflow
 * stays in sync, and `motion-reduce` opts reduced-motion users straight to the
 * snap.
 */
function AnimateHeight({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const inner = useRef<HTMLDivElement>(null);
  // undefined on first paint = natural `auto` height, so the initial open never
  // animates from 0; the first measure sets it to its own value (no motion).
  const [height, setHeight] = useState<number>();

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const measure = () => setHeight(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      style={{ height }}
      className="overflow-hidden transition-[height] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"
    >
      <div ref={inner} className={className}>
        {children}
      </div>
    </div>
  );
}

export function McpConnectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle>Connect to your AI apps</DialogTitle>
          <DialogDescription>
            Dotflowy speaks MCP. Connect any AI app to read and edit your
            outline — no API key, you just sign in.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5 px-5 pb-4">
          <span className="text-xs font-medium text-muted-foreground">
            Server URL
          </span>
          <CopyField value={MCP_URL} />
        </div>

        <Separator />

        <Tabs
          orientation={isMobile ? "horizontal" : "vertical"}
          defaultValue="claude"
          className="min-h-0 flex-1 gap-0"
        >
          {/* Desktop: a vertical rail (line indicator). Mobile: a horizontal,
              scrollable segmented strip -- a w-40 rail would eat half a phone's
              width. `orientation` also flips the arrow-key nav axis, so it's
              driven off the media query, not pure CSS. */}
          <TabsList
            variant={isMobile ? "default" : "line"}
            className={cn(
              isMobile
                ? "w-full justify-start overflow-x-auto"
                : "h-auto w-40 shrink-0 flex-col items-stretch gap-0.5 border-r p-2",
            )}
          >
            {CLIENTS.map((c) => (
              <TabsTrigger
                key={c.id}
                value={c.id}
                className={cn("justify-start", isMobile && "flex-none")}
              >
                <c.icon />
                {c.name}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="min-w-0 flex-1 overflow-y-auto">
            <AnimateHeight className="p-5">
              {CLIENTS.map((c) => (
                <TabsContent
                  key={c.id}
                  value={c.id}
                  className="flex flex-col gap-4"
                >
                  {c.content}
                </TabsContent>
              ))}
            </AnimateHeight>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

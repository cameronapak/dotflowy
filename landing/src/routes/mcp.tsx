import { createFileRoute } from "@tanstack/react-router";

import { APP_URL, Footer, GITHUB_URL, Nav } from "@/components/SiteChrome";

const TITLE = "MCP documentation - Dotflowy";
const DESCRIPTION =
  "Connect your AI apps to your Dotflowy outline with MCP. Setup instructions, available tools, permissions, and security guidance for users and IT admins.";
const URL = "https://dotflowy.com/mcp";
const CLAUDE_GUIDE =
  "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp";

export const Route = createFileRoute("/mcp")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:url", content: URL },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: DESCRIPTION },
    ],
    links: [{ rel: "canonical", href: URL }],
  }),
  component: McpPage,
});

const READ_TOOLS = [
  [
    "get_outline",
    "Read your outline, or one node and its subtree, with node IDs.",
  ],
  [
    "search_nodes",
    "Find nodes by text, tags, and filters such as incomplete tasks.",
  ],
  ["export_opml", "Export your outline or a subtree as an OPML document."],
];

const WRITE_TOOLS = [
  ["add_node", "Create a node under a parent or at the top level."],
  ["add_subtree", "Create a nested outline in one atomic operation."],
  [
    "update_node",
    "Change text, task status, completion, or collapse state. Editing a mirror changes its shared content everywhere.",
  ],
  [
    "delete_node",
    "Delete a node and its entire subtree. The agent cannot undo this operation.",
  ],
  [
    "move_nodes",
    "Move nodes with their subtrees, preserving their IDs and content.",
  ],
  [
    "add_to_today",
    "Add a node to a daily note, creating the daily note if needed.",
  ],
  [
    "mirror_node",
    "Place a mirror of an existing node under another parent or at the top level. A mirror shares content with its source, rather than making a copy.",
  ],
  ["mirror_to_today", "Place a mirror of an existing node in a daily note."],
  [
    "import_opml",
    "Import an OPML document as new nodes. Supports a dry run that previews the import without writing.",
  ],
];

function McpPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <Nav />
      <main className="flex-1">
        <article className="[&_a]:text-brand-blue mx-auto w-full max-w-2xl px-6 pt-14 pb-24 text-[15px] leading-relaxed sm:pt-20 [&_a]:underline [&_a]:underline-offset-4 [&_code]:font-sans [&_code]:font-medium [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h3]:text-lg [&_h3]:font-semibold [&_li]:pl-1 [&_section]:mt-12 [&_section]:scroll-mt-8">
          <header>
            <p className="mb-3 text-sm font-medium text-muted-foreground">
              Documentation
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              Connect your outline to your AI apps
            </h1>
            <p className="mt-5 text-lg text-pretty text-muted-foreground">
              Use the Dotflowy Model Context Protocol (MCP) server to search
              your notes, capture ideas, and organize your outline from an AI
              app.
            </p>
            <p className="mt-4">
              Connect from ChatGPT, Claude, Grok Bot, Cursor, and other AI apps
              that support remote MCP with OAuth. Availability varies by app,
              plan, and organization.
            </p>
            <p className="mt-5">
              Connecting gives the AI app read and write access across your
              Dotflowy outline, not just selected nodes. It can change text,
              move nodes, and delete entire subtrees. Connect only apps you
              trust, and review their tool approval requests before allowing
              changes.
            </p>
          </header>

          <nav aria-label="On this page" className="mt-8">
            <ul className="flex list-none flex-wrap gap-x-5 gap-y-2">
              <li>
                <a href="#setup">Connect Claude</a>
              </li>
              <li>
                <a href="#tools">Available tools</a>
              </li>
              <li>
                <a href="#security">Security and privacy</a>
              </li>
              <li>
                <a href="#troubleshooting">Troubleshooting</a>
              </li>
            </ul>
          </nav>

          <section id="setup" aria-labelledby="setup-heading">
            <h2 id="setup-heading">Connect Claude</h2>
            <p className="mt-4">
              You need a Dotflowy account with an <strong>Unlimited</strong> or{" "}
              <strong>Founding</strong> plan. The Free plan does not include MCP
              tool use. Your Claude account must support custom remote
              connectors, and your organization must permit the connection.
            </p>
            <p className="mt-4">Use this server URL:</p>
            <pre className="mt-3 overflow-x-auto rounded-lg border border-border bg-muted px-4 py-3 text-sm">
              <code>https://app.dotflowy.com/mcp</code>
            </pre>
            <ol className="mt-5 flex list-decimal flex-col gap-3 pl-5">
              <li>
                In Claude, open <strong>Customize → Connectors</strong>.
              </li>
              <li>
                Select <strong>Add</strong>, then{" "}
                <strong>Add custom connector</strong>. Enter{" "}
                <strong>Dotflowy</strong> as the name and paste the server URL.
              </li>
              <li>
                Continue with OAuth authentication. If Claude asks how to
                identify its OAuth client, choose{" "}
                <strong>Register automatically</strong>. You do not need an API
                key or a manually supplied client secret.
              </li>
              <li>
                Sign in to your Dotflowy account when prompted. If you chose to
                sign in later, select <strong>Connect</strong> on the connector
                first.
              </li>
              <li>
                Enable Dotflowy for your conversation from Claude&apos;s
                connector controls.
              </li>
              <li>
                Ask Claude:{" "}
                <q>
                  Search my Dotflowy outline for #project. Do not change
                  anything.
                </q>{" "}
                A search result, or a response that no nodes match, confirms
                that a read tool works.
              </li>
            </ol>
            <p className="mt-5">
              For Team and Enterprise workspaces, an authorized owner or admin
              must first add the custom connector in{" "}
              <strong>Organization settings → Connectors</strong>. Each member
              then connects with their own Dotflowy account. See{" "}
              <a href={CLAUDE_GUIDE}>Claude&apos;s custom connector guide</a>{" "}
              for current interface labels, plan availability, and organization
              roles.
            </p>
            <h3 className="mt-8">Other MCP clients</h3>
            <p className="mt-3">
              Dotflowy uses Streamable HTTP with OAuth 2.1, PKCE, and dynamic
              client registration. Use the same URL in a client that supports
              these features. For client-specific instructions, open{" "}
              <a href={`${APP_URL}/settings`}>Dotflowy Settings</a>, then select{" "}
              <strong>Connections → Connect apps (MCP)</strong>.
            </p>
          </section>

          <section id="tools" aria-labelledby="tools-heading">
            <h2 id="tools-heading">Available tools</h2>
            <p className="mt-4">
              A node is one item in your outline. A subtree includes that node
              and all its descendants. Connected apps discover the current tool
              inputs through MCP. Changes appear in your connected Dotflowy
              editor.
            </p>
            <h3 className="mt-6">Read tools</h3>
            <dl className="mt-3 flex flex-col gap-4">
              {READ_TOOLS.map(([name, description]) => (
                <div key={name}>
                  <dt>
                    <code>{name}</code>
                  </dt>
                  <dd className="mt-1 text-muted-foreground">{description}</dd>
                </div>
              ))}
            </dl>
            <h3 className="mt-8">Write tools</h3>
            <dl className="mt-3 flex flex-col gap-4">
              {WRITE_TOOLS.map(([name, description]) => (
                <div key={name}>
                  <dt>
                    <code>{name}</code>
                  </dt>
                  <dd className="mt-1 text-muted-foreground">{description}</dd>
                </div>
              ))}
            </dl>
            <h3 className="mt-8">Usage limits</h3>
            <ul className="mt-3 flex list-disc flex-col gap-3 pl-5">
              <li>
                <code>get_outline</code> returns up to 500 nodes per call and
                reports truncation. Ask for a specific subtree to read more.
              </li>
              <li>
                <code>search_nodes</code> returns 25 matches by default, up to
                100 per page. The app must follow continuation cursors for more
                matches.
              </li>
              <li>
                <code>add_subtree</code> accepts up to 500 nodes per call.
              </li>
              <li>
                OPML import and export each accept up to 5,000 nodes. Requests
                over this limit fail rather than silently truncate.
              </li>
              <li>
                For daily tools, provide a date or your IANA time zone, such as{" "}
                <code>America/Chicago</code>. Without either, <q>today</q> uses
                UTC and may differ from your local date.
              </li>
            </ul>
          </section>

          <section id="security" aria-labelledby="security-heading">
            <h2 id="security-heading">Security and privacy</h2>
            <h3 className="mt-6">Account access and authentication</h3>
            <p className="mt-3">
              Dotflowy authenticates MCP requests with OAuth bearer tokens and
              routes them to the signed-in user&apos;s outline. The connector
              does not grant access to other users&apos; outlines. You sign in
              with Dotflowy, rather than giving the AI app your Dotflowy
              password.
            </p>
            <p className="mt-4">
              There is no Dotflowy read-only connection mode or per-subtree
              authorization. Scoping a tool call to a node limits that request,
              not the connection&apos;s permissions. Collapsing nodes, hiding
              completed nodes, or turning off an editor feature does not
              restrict MCP access. Use your AI app&apos;s tool controls to limit
              what it invokes, but do not treat them as a Dotflowy permission
              boundary.
            </p>
            <h3 className="mt-6">Locked content</h3>
            <p className="mt-3">
              Locks set in the editor protect content in a node and its
              descendants from changes, including changes through mirrors. MCP
              clients cannot lock or unlock nodes. They can still read locked
              content and move a locked subtree intact. Locks are mutation
              protection, not secrecy.
            </p>
            <h3 className="mt-6">Spoiler redaction</h3>
            <p className="mt-3">
              Spoiler text marked with <code>||hidden text||</code> becomes{" "}
              <code>[spoiler]</code> in MCP results, including exports and
              breadcrumbs. MCP search does not match text inside spoilers. This
              reduces accidental disclosure to an AI app, but it is not access
              control and does not make an untrusted connection safe.
            </p>
            <p className="mt-4">
              If an app replaces a node&apos;s text using a redacted result, the
              hidden text is lost. Ask the app not to rewrite nodes containing{" "}
              <code>[spoiler]</code> unless you provide the intended full text.
            </p>
            <h3 className="mt-6">Data handling</h3>
            <p className="mt-3">
              Tool results send outline content to the AI app you connect.
              Review that provider&apos;s data handling and retention policies
              before connecting sensitive notes. Dotflowy runs on Cloudflare and
              stores each user&apos;s outline in a separate database. Notes are
              not end-to-end encrypted. Read the{" "}
              <a href={`${APP_URL}/privacy`}>Dotflowy privacy policy</a> and{" "}
              <a href={`${APP_URL}/terms`}>terms of service</a> for service-wide
              details.
            </p>
            <h3 className="mt-6">Disconnecting and revocation</h3>
            <p className="mt-3">
              You can disable or remove Dotflowy in your AI app&apos;s connector
              settings. Dotflowy does not currently provide a page to list and
              revoke individual MCP client connections. Do not assume removal in
              an AI app invalidates credentials already issued by Dotflowy. If
              you suspect unwanted access, contact{" "}
              <a href="mailto:support@dotflowy.com">support@dotflowy.com</a>.
            </p>
          </section>

          <section
            id="troubleshooting"
            aria-labelledby="troubleshooting-heading"
          >
            <h2 id="troubleshooting-heading">Troubleshooting</h2>
            <dl className="mt-5 flex flex-col gap-5">
              <div>
                <dt className="font-medium">
                  The connector is unavailable in Claude
                </dt>
                <dd className="mt-1">
                  Check your Claude account&apos;s connector availability and
                  organization policy. Team and Enterprise members may need an
                  owner or admin to add it first.
                </dd>
              </div>
              <div>
                <dt className="font-medium">
                  Sign-in fails or requests are unauthorized
                </dt>
                <dd className="mt-1">
                  Check that the URL is exactly{" "}
                  <code className="break-all">
                    https://app.dotflowy.com/mcp
                  </code>
                  , use automatic OAuth registration, and reconnect with the
                  intended Dotflowy account. Opening the server URL directly in
                  a browser is not a connection test.
                </dd>
              </div>
              <div>
                <dt className="font-medium">
                  Tools appear, but calls require an upgrade
                </dt>
                <dd className="mt-1">
                  Tool discovery can succeed on a Free account. Tool execution
                  requires Unlimited or Founding on the Dotflowy account you
                  used to connect.
                </dd>
              </div>
              <div>
                <dt className="font-medium">A write is rejected</dt>
                <dd className="mt-1">
                  Read the tool&apos;s error. Locked content and protected
                  daily-note structure can block changes. If appropriate, unlock
                  the content yourself in Dotflowy before retrying.
                </dd>
              </div>
              <div>
                <dt className="font-medium">Search results are incomplete</dt>
                <dd className="mt-1">
                  Ask the app to follow continuation cursors. If the outline
                  changes during pagination, restart the search. Text inside
                  spoilers does not match.
                </dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="support-heading">
            <h2 id="support-heading">Get help</h2>
            <p className="mt-4">
              Email{" "}
              <a href="mailto:support@dotflowy.com">support@dotflowy.com</a> for
              connection, privacy, or security questions. For reproducible bugs,
              you can also{" "}
              <a href={`${GITHUB_URL}/issues`}>open a GitHub issue</a>. Include
              your client name, the tool name, and a redacted error message.
              Never post tokens, passwords, or private outline content.
            </p>
          </section>
        </article>
      </main>
      <Footer />
    </div>
  );
}

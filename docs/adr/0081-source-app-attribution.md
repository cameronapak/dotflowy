# Source app attribution: a required `sourceApp` on node-creating MCP tools

Status: accepted.

Every MCP tool that creates nodes (`add_node`, `add_subtree`, `add_to_today`,
`mirror_node`, `mirror_to_today`, `import_opml`) requires a `sourceApp`
argument: the app the agent is running in, not the model. The tool publishes it
as "one of a fixed list, or any trimmed name up to 64 characters". The Worker
stamps it into the write-once `Node.origin`. A listed app is stored in its
canonical spelling whatever the casing; an unlisted app is stored as given. The
fixed list lives in `src/data/source-apps.ts`, shared by the Worker and the
editor.

The provenance plugin shows the source app's logo in the slot the generic
sparkle used, at the same 16px size, so rows never shift. Unlisted apps, and
nodes stamped before this change with an unmatched name, show a bot icon.
The floated tooltip trigger uses flex layout so an inline baseline cannot add
extra height and indent a second text line. Continuation lines still wrap
underneath the checkbox and source mark.

## Why the app, not the model

The app is what the user connected and recognizes, and it does not change from
call to call. Inside Cursor, VS Code, or Poke an agent may not know which model
it runs on, so a model answer would be unstable.

## Why a required argument, not the OAuth client name

Origin used to be the OAuth client's self-registered name, read with one D1
lookup per MCP request. Those names are unverified free text, so mapping them to
logos meant guessing at strings we had not seen. An explicit enum gives agents
the exact spellings the logo table keys on. The field is required, not optional:
agents are trusted to name their app, and an optional field would leave most
writes unattributed. The bearer-token lookup is removed.

Breaking change: a client with a cached tool list, or an older published CLI,
gets `INVALID_PARAMS` ("Missing key at sourceApp") on node-creating calls until
it refreshes. Reads and edits are unaffected. The CLI's friendly write commands
send `sourceApp: "Dotflowy CLI"` unless `--source-app` is given; raw `call`
passes arguments unchanged, as ADR 0061 requires.

## Logos and brand rules

Most logos come from Simple Icons, already a dependency. Simple Icons has no
OpenAI mark (removed in v16 for lack of permission), so ChatGPT and Codex use
OpenAI's published Blossom, and Amp, Grok, Devin, Poke, and Muse use their own
published files (`src/plugins/provenance/brand-marks.ts`, with sources).

Marks are muted. OpenAI and xAI require their logos "exactly as provided", and
both ship only black or white, so ChatGPT, Codex, and Grok use the text color.
Amp's only mark is a wordmark, so Amp rows are about 7px wider. The sparkle is
not the fallback because at 14px it reads as Gemini's star.

The app's connect-to-AI dialog and the landing footer carry a one-line notice
that these names and logos belong to their owners and Dotflowy is not affiliated
with them, as OpenAI's terms ask. Per-node tooltips stay notice-free.

A listed app without a logo is a type error in the plugin's table, so the list
and the logos cannot drift.

## Rejected

- **Named chip after the text**: always readable, but it adds width in the
  trailing badge zone on every agent row.
- **One mark per agent run**: quieter, but child rows look user-written, and the
  row slot does not receive the parent node.
- **Brand colors**: many marks are black, white, or near-black, so the colored
  ones would dominate; muted keeps the mark quiet.
- **A model field**: see above.

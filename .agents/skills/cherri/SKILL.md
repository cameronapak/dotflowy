---
name: cherri
description: Use whenever writing, reading, reviewing, or debugging Cherri code (.cherri files) - the DSL that compiles to Apple Shortcuts. Trigger on any mention of Cherri, .cherri files, cherrilang.org, the `cherri` CLI, or writing/generating a Shortcut as code, even if the user doesn't name the language directly. This skill is for authoring Cherri programs, not for contributing to the Cherri compiler itself. Gives a quick syntax reference and known gotchas up front, looks up action signatures via `cherri --action=`, and checks the user's local cherrilang.org docs clone (or the live site) before answering anything else beyond the basics, such as standard library behavior or the package manager.
---

# Cherri

Cherri is a language that compiles directly to a runnable Apple Shortcut, so a Shortcut can be written and maintained as text instead of built by hand in the Shortcuts app's graphical editor. This skill is about *writing Cherri code*, not about hacking on the compiler itself.

- Project (compiler, CLI, standard library source): https://github.com/electrikmilk/cherri
- Documentation site: https://cherrilang.org (source: https://github.com/electrikmilk/cherrilang.org)
- Playground (compile in-browser, no install): https://playground.cherrilang.org

The quick reference and caveats below cover most everyday code. For anything they don't cover - standard library behavior, package manager usage, etc. - go find the docs locally per the workflow below rather than guessing. For an individual action's exact parameters, the CLI's action search (Step 1 below) is the go-to, not the docs.

Add `--no-ansi` to every `cherri` command you run. The CLI colors and styles a lot of its output (errors, action search, docs generation) with ANSI escape sequences, which are meant for a terminal, not for you - they add tokens and can garble how the output looks once you read it back. `--no-ansi` turns all of that off and is safe to always include.

The CLI does more than compiling and action search - signing options, decompiling, the package manager, docs generation, and more. Rather than this skill trying to enumerate every flag, run `cherri --no-ansi --help` to see the current list straight from the binary.

## Step 1: Look up action signatures with `--action=`

Whenever you need to know how to call a specific action - its argument names, types, order, or what it returns - use the `cherri` binary's action search instead of guessing or relying on the docs. This works standalone; it doesn't need a docs clone at all.

```console
cherri --no-ansi --action=downloadURL
```

This is a **search**, not an exact-match lookup, so it's forgiving of not knowing the precise name:

- An exact match prints just that action's signature.
- A partial or misspelled name (e.g. `cherri --action=download`) prints every action whose identifier *or* doc title contains that substring (case-insensitive), each with its full signature - use this to discover the right action when you're not sure of the exact name.
- `cherri --action=` with no value at all prints every action definition there is.
- Searching `text` or `dictionary` specifically prints a hint that those aren't actions - they're literal syntax (`@x = "..."` / `@x = {...}`) - instead of a signature.

### Reading a signature

A signature looks like this:

```
downloadURL(text url, dictionary! ?headers): variable
```

| Part | Meaning |
|---|---|
| `?` before the name | The argument is optional. |
| `!` after the type | The argument requires a literal value - you cannot pass a variable here. |
| `&` before the type | A content reference can be passed to this argument. |
| `...` before the name | The argument accepts multiple values. |
| `name = value` | The default value used when the argument is omitted. |
| `: type` after `()` | The type of value the action outputs, if any (omitted if it doesn't output anything). |

Passing a variable where a `!` argument expects a literal is a compile error, so check for `!` before wiring up a variable there.

## Step 2: Locate the local docs clone

Action signatures come from the CLI (Step 1). Everything else - types, control flow, the package manager, standard library behavior in prose - comes from the docs. Before relying on the docs for anything, find the user's local clone of `electrikmilk/cherrilang.org`:

1. Check whatever persistent memory or notes mechanism you have (e.g. Claude Code's memory files) for a path you saved in an earlier session. If you find one, verify it still exists and skip to step 2.
2. If you have no saved path, look in a few likely spots before asking - the same parent directory as the project you're currently working in, `~/cherrilang.org`, `~/Developer/cherrilang.org`, `~/code/cherrilang.org`, `~/projects/cherrilang.org`. Confirm a candidate is the right repo by checking it has a `language/` directory and that `git remote -v` mentions `electrikmilk/cherrilang.org`.
3. If you still don't have it, just ask the user where it's cloned. Don't guess or fabricate a path.
4. Once confirmed, save the absolute path in your persistent memory (if you have one) so future sessions don't have to repeat this search. If you have no persistent memory available, ask again next session - don't invent a path from a prior conversation that isn't this one.
5. If the user says they don't have it cloned at all, tell them where to get it (the docs repo URL above) and offer the live site (https://cherrilang.org) as a fallback in the meantime. Don't clone it yourself without asking first.

## Step 3: Make sure it's up to date

A stale local clone can describe behavior that's since changed. Each time you're about to lean on the docs clone for something non-trivial:

1. Run `git -C <docs-path> fetch`.
2. Compare local `HEAD` against `origin/main` (e.g. `git -C <docs-path> rev-list --count HEAD..origin/main`).
3. If it's behind, tell the user and ask whether to pull - don't pull automatically, since it changes files on their machine without confirmation.
4. If it's current, proceed straight to reading the relevant file.

## Step 4: Find the right doc

The docs repo's `language/` directory is organized by topic. Read the file that matches what you're doing rather than skimming everything:

| Topic | File |
|---|---|
| Comments | `language/comments.md` |
| `#define` / `#include` metadata | `language/definitions.md`, `language/includes.md` |
| Variables, constants, globals | `language/variables-constants-globals.md` |
| Types, coercion | `language/types.md` |
| Control flow (if/else, repeat, for) | `language/control-flow.md` |
| Operators | `language/operators.md` |
| Functions | `language/functions.md` |
| Enums | `language/enums.md` |
| Calling actions in general (prose explanation; for exact signatures use `--action=` from Step 1) | `language/actions.md` |
| Writing your own action definitions | `language/action-definitions.md` |
| Raw actions (manual identifier/params) | `language/raw-actions.md` |
| References (`&variable`-style) | `language/references.md` |
| Menus | `language/menus.md` |
| VCards | `language/vcards.md` |
| Copy/paste of actions | `language/copy-paste.md` |
| Import questions | `language/import-questions.md` |
| Importing existing Shortcuts as actions | `language/import-actions.md` |
| Package manager | `language/package-manager.md` |
| Performance/size tips | `language/best-practices.md` |
| Standard library, by category (network, device, media, text, math, calendar, contacts, location, images, documents, storage, settings, sharing, music, photos, pdf, crypto, a11y, translation, intelligence, macOS-only, builtin) | `language/standard/*.md` |
| General site pages | `getting-started.md`, `install.md`, `migration.md`, `faq.md` |

If a doc file doesn't answer the question, check the live site at https://cherrilang.org in case the local clone is missing something, and check with the user before assuming a feature doesn't exist.

## Step 5: Compile and verify

If the `cherri` binary is on the user's `PATH`, compile whatever you write rather than only eyeballing it:

- `cherri file.cherri --no-ansi` compiles a file; no output means success (Unix convention).
- `cherri file.cherri --no-ansi --debug` (or `-d`) prints stack traces and writes a `.plist` you can inspect if something looks wrong.

If it's not installed, point the user at `install.md`'s instructions (Homebrew tap, Nix, or a direct release download) rather than assuming a particular install method.

---

## Quick syntax reference

This covers the everyday shape of the language. Treat it as a cheat sheet, not the full spec - the docs above are authoritative and cover more (enums, references, raw actions, menus, etc. in full).

### Comments

```ruby
// single-line
/* multi-line */
comment('explicit comment action - shows up as an actual action in the Shortcut')
```

### File metadata

```ruby
#define name My Shortcut
#define color blue
#define glyph apple
#define inputs image, text
#define outputs file
#define noinput stopwith "No input provided"
#define from menubar, sharesheet
#define mac true
#define version 18.4
```

### Includes

```ruby
#include 'actions/device'        // standard library category
#include 'path/to/file.cherri'   // arbitrary local file
```

Only standard library categories you `#include` are available - an "undefined action" error usually means a missing include.

### Variables, constants, globals

```ruby
// Mutable variable - compiles to a "Set Variable" action
@name = "value"
@count = 0
@count += 1    // also -=, *=, /=

// Constant (magic variable) - references an action's output directly, smaller Shortcut
const result = someAction()

// Type declaration with no initial value (faster to compile than an empty literal)
@builder: text
@items: array

// Globals (case-sensitive)
@input = ShortcutInput
@now   = CurrentDate
@clip  = Clipboard
@dev   = Device

// Ask the user at runtime instead of a fixed value
wait(Ask)
wait(Ask: 'How many seconds?')
```

Mutable variables need the `@` prefix when referenced inside a string: `"{@name}"`. Prefer `const` over `@` whenever the value never changes - it's one fewer action in the compiled Shortcut.

### Types

| Syntax | Type | Notes |
|---|---|---|
| `"hello {@var}"` | text | interpolates `{@var}` and escape sequences |
| `'raw text'` | rawtext | no interpolation (other than escaped `'`); can't go in dicts/arrays; compiles faster |
| `42` | number | |
| `0.5` | float | |
| `true` / `false` | bool | compiles to `1`/`0` |
| `{"k": "v"}` | dictionary | valid JSON syntax |
| `["a", "b"]` | array | valid JSON syntax |
| `nil` | empty | skips optional arguments; faster than `""`, `[]`, `{}` |

Type declaration with no value: `@x: text`, `@x: number`, `@x: array`, `@x: dictionary`, `@x: bool`, `@x: float`, `@x: variable`.

Coercion: `@var.number`, `@var.text`, `"{@var.number}"`, or a coercion action (`number()`, `getDictionary()`).

Expressions: `@result = 5 + (2 * @n)` - two-operand arithmetic compiles to a Math action.

Enums:
```ruby
enum Color { 'Red', 'Green', 'Blue' }
```

### Control flow

```ruby
// If / else
if @x > 0 {
    // ...
} else {
    // ...
}

// Operators: == != > >= < <= contains !contains beginsWith endsWith <> (between)
// Logical: && (all) || (any)
// Has-value shorthand: if @x { } / if !@x { }
// Between: if @x <> 5 10 { }

// Repeat N times (i is the index variable)
repeat i for 6 {
    @items += "Item {@i}"
}

// For-each
@items = ["a", "b", "c"]
for item in @items {
    alert("@item")
}

// Control flow can produce a value
const result = if @x == "iPhone" {
    getCellularDetail("Carrier Name")
} else {
    getWifiDetail("Network Name")
}
```

### Functions

```ruby
function add(number op1, number op2): number {
    const s = @op1 + @op2
    output("{s}")
}

const sum = add(2, 3)

// Argument modifiers:
//   text? message          - optional
//   text! message          - literal value required, not a variable
//   text message = "default"  - default value
```

Functions run in an isolated scope (`runSelf` under the hood) - they can't read the caller's variables except through their declared arguments.

### Actions

```ruby
alert("Hello!")                 // common actions need no include
#include 'actions/network'
@data = getContentsOfURL("https://example.com")
```

If an action's output isn't used by anything, follow it with `nothing()` to discard it and keep the compiled Shortcut's runtime memory down.

---

## Common gotchas

These trip people up because they're runtime behaviors of Shortcuts itself, or compiler quirks, not obvious from the syntax alone. Check `language/best-practices.md` and `language/types.md` in the docs for the full detail behind these.

- **Comparisons need a typed value on the left.** `if 5 == 5` is a compile error - the left side of `==`/`!=`/other comparisons must be a variable or constant with a known type (`text`, `number`, `bool`, `action`, `date`), never a bare literal: `@n = 5; if @n == 5`.
- **A `const` from an action with no declared return type can't be compared directly.** If `const r = someAction()` and `someAction` has no `: type` on it, `r` has an empty type and `if r == "x"` fails. Either add `: type` to the action's definition, or force a type via interpolation: `@s = "{r}"; if @s == "x"`.
- **`: variable`-typed results often need `.text` before comparing.** Actions that read out of a dict/array (`getValue`, `getFirstItem`, `getLastItem`, `getListItem`, `getRandomItem`) or decode something (`base64Decode`) return a generic variable reference at runtime, not real text, even though it looks like text. Declare them `: variable` and cast with `.text` before comparing: `if result.text != "expected"`. True text-transform actions (`uppercase`, `replaceText`, `hash`, `base64Encode`, `formatDate`) don't need this. `downloadURL` is the surprising exception - despite being a network action it returns a generic variable reference too.
- **`contains`/`!contains` only work on text and arrays**, not dictionaries. To check for a key in a dictionary, use `getValue(dict, key)` and test `if !result`.
- **Every logical operator joining conditions in one `if` must match.** `if @a == 1 && @b == 2 || @c == 3` is a compile error: Shortcuts' If action has a single All/Any toggle for the whole condition group, not a per-condition one, so whichever of `&&`/`||` you use first in a statement, every other joiner in that same statement has to be the same. Split into nested `if`s for mixed logic. This restriction is per `if` statement - separate `if`s can each use a different operator.
- **Branches inside a value-producing `if` must call an action, not return a bare literal.** `const r = if @x > 3 { "yes" } else { "no" }` doesn't work - use `text("yes")` (the `gettext` action) to output a plain string from a branch. The result still has an empty type, so cast before comparing it, same as above.
- **Prefer `nil` or a type declaration over an empty literal.** `@x = ""` / `@x = []` / `@x = {}` compile slower than `@x: text` or `@x = nil` - only reach for the empty literal form if you specifically need typed-empty-value behavior.
- **Large pre-defined arrays are slower to build than dictionaries.** Shortcuts runs one action per element added to a pre-populated array literal (`@a = ["x", "y", "z"]`), where a dictionary literal is a single action. Prefer a dictionary, or build the array incrementally at runtime, if it's large.
- **Use raw text (`'...'`) instead of quoted text (`"..."`) when you don't need interpolation** - it skips the interpolation step and compiles faster. It can't be used inside a dictionary or array literal, though.

---

## Optional: the compiler's own source

The user may also have a local clone of the project repo itself (`electrikmilk/cherri`, not the docs). It's not required for writing Cherri code - the docs and `cherri --action=` cover everyday use - but if something genuinely isn't in the docs, `actions_std.go` and `actions/*.cherri` in that repo are the ground truth for what an action actually does, and `tests/*.cherri` has real usage examples. Treat it the same way as the docs clone: don't assume a path, ask or remember it, and don't modify anything in it - it's someone else's project, not part of the Shortcut you're writing.

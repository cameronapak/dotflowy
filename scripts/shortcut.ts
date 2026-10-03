#!/usr/bin/env bun
/**
 * Builds the credential-free Apple Shortcut template (ADR 0065).
 *
 * The source of truth is `shortcuts/add-to-dotflowy-today.cherri`, compiled with
 * Cherri (https://cherrilang.org). Cherri owns the action schemas, so the
 * template can only contain actions Shortcuts actually knows — hand-written
 * plist identifiers are how the first template shipped an unrecognized Match
 * Text action and a "Generate UUID" action that does not exist as a built-in.
 *
 * Compilation repairs Cherri v2.3.0's import questions and control-flow IDs:
 *
 *   - `ActionIndex` is rebound to the action holding the question's parameter.
 *     Cherri records a stale index, and a question bound to the wrong action
 *     never reaches its target, leaving the capture key empty.
 *   - The bound parameter is pre-filled with the question's default, so a
 *     skipped setup question still runs and reports the server's clear
 *     "invalid key" instead of failing on an empty parameter.
 *   - Each conditional block gets a distinct deterministic grouping ID;
 *     Cherri's derived UUID mode reuses one ID across every block.
 *
 * Usage:
 *   bun scripts/shortcut.ts --build     compile the source into the artifact
 *   bun scripts/shortcut.ts --validate  check the committed artifact
 *   bun scripts/shortcut.ts --sign      macOS only: Apple `shortcuts sign`
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type Plist =
  | boolean
  | number
  | string
  | Plist[]
  | { [key: string]: Plist };

/** A compiled workflow, keyed by its plist fields. */
export type Workflow = { [key: string]: Plist };

/**
 * The one place that narrows the closed `Plist` union by runtime shape. The
 * parser below is the boundary that builds those values, so every other function
 * works with the narrowed types instead of re-asserting them.
 */
export function asDict(value: Plist | undefined): Workflow | undefined {
  // This is the closed Plist union, not boundary parsing.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value;
}

export function asArray(value: Plist | undefined): Plist[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function asString(value: Plist | undefined): string | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: Plist | undefined): number | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  return typeof value === "number" ? value : undefined;
}

const ROOT = join(import.meta.dir, "..");
const SOURCE = join(ROOT, "shortcuts/add-to-dotflowy-today.cherri");
const OUTPUT = join(ROOT, "public/shortcuts/add-to-dotflowy-today.shortcut");
/** Must match `#define name` in the source: Cherri names its output after it. */
const SHORTCUT_NAME = "Add to Dotflowy Today";
const DEFAULT_SERVER = "https://app.dotflowy.com";

/**
 * Every action the template may contain. Cherri refuses to compile an action it
 * does not define, and this list keeps the compiled output honest: an identifier
 * outside it is one Shortcuts may not recognize.
 */
export const ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  "is.workflow.actions.ask",
  "is.workflow.actions.conditional",
  "is.workflow.actions.downloadurl",
  "is.workflow.actions.format.date",
  "is.workflow.actions.gettext",
  "is.workflow.actions.getvalueforkey",
  "is.workflow.actions.nothing",
  "is.workflow.actions.notification",
  "is.workflow.actions.number",
  "is.workflow.actions.number.random",
  "is.workflow.actions.setvariable",
  "is.workflow.actions.showresult",
  "is.workflow.actions.text.match",
]);

const REQUIRED_ACTIONS = [
  "is.workflow.actions.ask",
  "is.workflow.actions.downloadurl",
  "is.workflow.actions.format.date",
  "is.workflow.actions.getvalueforkey",
  "is.workflow.actions.notification",
  "is.workflow.actions.number.random",
  "is.workflow.actions.showresult",
  "is.workflow.actions.text.match",
];

const FORBIDDEN_MARKERS = [
  "sk-",
  "Bearer ey",
  "Bearer dotflowy_",
  "api_key=",
  "dfc_",
];

/* --- Cherri ---------------------------------------------------------------- */

function cherriBinary(): string {
  return process.env.CHERRI_BIN ?? "cherri";
}

/**
 * Compiles the Cherri source and returns the workflow, normalized.
 *
 * Cherri writes its artifact next to the source file (its `--output` flag is
 * ignored in v2.3.0), so the source is copied into a scratch directory first.
 */
export function compile(): Workflow {
  const bin = cherriBinary();
  const dir = mkdtempSync(join(tmpdir(), "dotflowy-shortcut-"));
  try {
    const source = join(dir, SOURCE.split("/").at(-1)!);
    writeFileSync(source, readFileSync(SOURCE));
    let result: Bun.SyncSubprocess<"ignore", "pipe">;
    try {
      result = Bun.spawnSync(
        [bin, source, "--skip-sign", "--derive-uuids", "--no-ansi"],
        { stderr: "pipe" },
      );
    } catch {
      throw new Error(
        `\`${bin}\` was not found. Install the Cherri compiler (https://cherrilang.org) or point CHERRI_BIN at it.`,
      );
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim();
      throw new Error(
        stderr || `\`${bin}\` failed with exit code ${result.exitCode}`,
      );
    }
    const artifact = join(dir, `${SHORTCUT_NAME}_unsigned.shortcut`);
    if (!existsSync(artifact)) {
      throw new Error(`\`${bin}\` wrote no artifact at ${artifact}`);
    }
    const workflow = asDict(parsePlist(readFileSync(artifact, "utf8")));
    if (!workflow) throw new Error("compiled output is not a plist dict");
    normalizeConditionalGroups(workflow);
    normalizeImportQuestions(workflow);
    sortDictionaryItems(workflow);
    return workflow;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* --- Determinism ----------------------------------------------------------- */

/** Cherri's derived UUID mode reuses one ID for every conditional block. */
function normalizeConditionalGroups(workflow: Workflow): void {
  const actions = asArray(workflow.WFWorkflowActions) ?? [];
  const stack: string[] = [];
  actions.forEach((action, index) => {
    const entry = asDict(action);
    if (
      entry?.WFWorkflowActionIdentifier !== "is.workflow.actions.conditional"
    ) {
      return;
    }
    const parameters = asDict(entry.WFWorkflowActionParameters);
    if (!parameters) throw new Error("conditional has no parameters");
    const mode = parameters.WFControlFlowMode;
    if (mode === 0) {
      stack.push(
        `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      );
    }
    const group = stack.at(-1);
    if (!group) throw new Error("conditional boundary has no opening block");
    parameters.GroupingIdentifier = group;
    if (mode === 2) {
      parameters.UUID = group;
      stack.pop();
    }
  });
  if (stack.length)
    throw new Error("conditional block has no closing boundary");
}

/**
 * Cherri emits dictionary field items in Go map order, so the same source can
 * compile to different bytes. Item order is not semantic for HTTP headers or
 * JSON bodies, so sort them by key and keep the artifact reproducible.
 */
export function sortDictionaryItems(value: Plist): Plist {
  const array = asArray(value);
  if (array) return array.map(sortDictionaryItems);
  const dict = asDict(value);
  if (!dict) return value;
  for (const [key, item] of Object.entries(dict)) {
    dict[key] = sortDictionaryItems(item);
  }
  if (dict.WFSerializationType === "WFDictionaryFieldValue") {
    const items = asArray(asDict(dict.Value)?.WFDictionaryFieldValueItems);
    if (items) {
      items.sort((a, b) => dictionaryKey(a).localeCompare(dictionaryKey(b)));
    }
  }
  return dict;
}

function dictionaryKey(item: Plist): string {
  const key = asDict(asDict(item)?.WFKey);
  const string = asString(asDict(key?.Value)?.string);
  return string ?? JSON.stringify(item);
}

/* --- Import questions ------------------------------------------------------ */

/**
 * Binds each import question to the action that holds its parameter and
 * pre-fills that parameter with the question's default. Questions are emitted in
 * Cherri's map order, so sort them by their (now known) action index to keep the
 * artifact deterministic and the setup dialog in flow order.
 */
export function normalizeImportQuestions(workflow: Workflow): void {
  const actions = asArray(workflow.WFWorkflowActions);
  const questions = asArray(workflow.WFWorkflowImportQuestions);
  if (!actions || !questions) {
    throw new Error("workflow is missing its actions or import questions");
  }
  const bound = new Set<number>();
  for (const question of questions) {
    const entry = asDict(question);
    const key = asString(entry?.ParameterKey);
    if (!entry || !key) {
      throw new Error("import question has no parameter key");
    }
    const index = actions.findIndex((action, at) => {
      if (bound.has(at)) return false;
      const parameters = asDict(asDict(action)?.WFWorkflowActionParameters);
      return parameters?.[key] === "";
    });
    if (index < 0) {
      throw new Error(`import question ${key} has no empty target parameter`);
    }
    bound.add(index);
    entry.ActionIndex = index;
    const parameters = asDict(
      asDict(actions[index])?.WFWorkflowActionParameters,
    );
    if (!parameters) {
      throw new Error(
        `import question ${key} targets an action with no parameters`,
      );
    }
    parameters[key] = entry.DefaultValue ?? "";
  }
  questions.sort(
    (a, b) =>
      (asNumber(asDict(a)?.ActionIndex) ?? 0) -
      (asNumber(asDict(b)?.ActionIndex) ?? 0),
  );
}

/* --- Validation ------------------------------------------------------------ */

export function validateWorkflow(workflow: Workflow): void {
  const actions = asArray(workflow.WFWorkflowActions);
  if (!actions || actions.length === 0) {
    throw new Error("WFWorkflowActions must be a nonempty array");
  }
  const identifiers = actions.map(
    (action) => asString(asDict(action)?.WFWorkflowActionIdentifier) ?? "",
  );
  for (const identifier of identifiers) {
    if (!ALLOWED_ACTIONS.has(identifier)) {
      throw new Error(`unknown action identifier: ${identifier}`);
    }
  }
  for (const required of REQUIRED_ACTIONS) {
    if (!identifiers.includes(required)) {
      throw new Error(`missing action: ${required}`);
    }
  }

  const questions = asArray(workflow.WFWorkflowImportQuestions);
  if (!questions || questions.length !== 2) {
    throw new Error("expected exactly two import questions");
  }
  const boundKeys: string[] = [];
  for (const question of questions) {
    const entry = asDict(question);
    const index = asNumber(entry?.ActionIndex);
    if (index === undefined || !Number.isInteger(index) || index < 0) {
      throw new Error("import question has no ActionIndex");
    }
    const key = asString(entry?.ParameterKey);
    if (!key) throw new Error("import question has no parameter key");
    boundKeys.push(key);
    const parameters = asDict(
      asDict(actions[index])?.WFWorkflowActionParameters,
    );
    const value = asString(parameters?.[key]);
    if (!value) {
      throw new Error(
        `import question ${key} does not target a filled parameter`,
      );
    }
  }
  if (!boundKeys.includes("WFTextActionText") || !boundKeys.includes("WFURL")) {
    throw new Error(
      "import questions must target the capture key and endpoint",
    );
  }

  const serialized = JSON.stringify(workflow);
  for (const marker of FORBIDDEN_MARKERS) {
    if (serialized.toLowerCase().includes(marker.toLowerCase())) {
      throw new Error(`possible embedded credential: ${marker}`);
    }
  }
  if (!serialized.includes("PASTE_CAPTURE_KEY_DURING_IMPORT")) {
    throw new Error("capture-key import placeholder missing");
  }
  if (!serialized.includes("yyyy-MM-dd")) {
    throw new Error("local date format missing");
  }
  if (!serialized.includes("(?s)^.+")) {
    throw new Error("success receipt validation missing");
  }
  for (const key of [
    "attemptId",
    "date",
    "text",
    "saved",
    "nodeId",
    "dailyNoteId",
  ]) {
    if (!serialized.includes(`"${key}"`)) {
      throw new Error(`request or receipt field missing: ${key}`);
    }
  }
  const inputs = asArray(workflow.WFWorkflowInputContentItemClasses);
  if (
    !inputs ||
    !inputs.includes("WFStringContentItem") ||
    !inputs.includes("WFURLContentItem")
  ) {
    throw new Error("shortcut must accept shared text and URLs");
  }
  const types = asArray(workflow.WFWorkflowTypes);
  if (!types || !types.includes("ActionExtension")) {
    throw new Error("shortcut must appear in the share sheet");
  }
}

/* --- Plist ----------------------------------------------------------------- */

/** Reads the XML property list subset Cherri emits. */
export function parsePlist(xml: string): Plist {
  let at = xml.indexOf("<plist");
  if (at < 0) throw new Error("shortcut plist: no <plist> root");
  at = xml.indexOf(">", at) + 1;

  const fail = (message: string): never => {
    throw new Error(`shortcut plist: ${message}`);
  };
  const skipSpace = () => {
    while (at < xml.length && /\s/.test(xml[at]!)) at += 1;
  };
  const take = (text: string) => {
    skipSpace();
    if (!xml.startsWith(text, at)) {
      fail(`expected ${text} at ${at}, found ${xml.slice(at, at + 24)}`);
    }
    at += text.length;
  };
  const readUntil = (end: string) => {
    const stop = xml.indexOf(end, at);
    if (stop < 0) fail(`unterminated ${end}`);
    const value = xml.slice(at, stop);
    at = stop + end.length;
    return value;
  };
  const decode = (text: string) =>
    text
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll(/&#x([0-9a-f]+);/gi, (_, code: string) =>
        String.fromCodePoint(Number.parseInt(code, 16)),
      )
      .replaceAll(/&#(\d+);/g, (_, code: string) =>
        String.fromCodePoint(Number(code)),
      )
      .replaceAll("&amp;", "&");

  const parseValue = (): Plist => {
    skipSpace();
    if (xml.startsWith("<dict/>", at)) {
      at += "<dict/>".length;
      return {};
    }
    if (xml.startsWith("<dict>", at)) {
      at += "<dict>".length;
      const dict: Workflow = {};
      for (;;) {
        skipSpace();
        if (xml.startsWith("</dict>", at)) {
          at += "</dict>".length;
          return dict;
        }
        take("<key>");
        const key = decode(readUntil("</key>"));
        dict[key] = parseValue();
      }
    }
    if (xml.startsWith("<array/>", at)) {
      at += "<array/>".length;
      return [];
    }
    if (xml.startsWith("<array>", at)) {
      at += "<array>".length;
      const array: Plist[] = [];
      for (;;) {
        skipSpace();
        if (xml.startsWith("</array>", at)) {
          at += "</array>".length;
          return array;
        }
        array.push(parseValue());
      }
    }
    if (xml.startsWith("<string/>", at)) {
      at += "<string/>".length;
      return "";
    }
    if (xml.startsWith("<string>", at)) {
      at += "<string>".length;
      return decode(readUntil("</string>"));
    }
    if (xml.startsWith("<integer>", at)) {
      at += "<integer>".length;
      return Number(readUntil("</integer>"));
    }
    if (xml.startsWith("<real>", at)) {
      at += "<real>".length;
      return Number(readUntil("</real>"));
    }
    if (xml.startsWith("<true/>", at)) {
      at += "<true/>".length;
      return true;
    }
    if (xml.startsWith("<false/>", at)) {
      at += "<false/>".length;
      return false;
    }
    return fail(`unsupported value at ${at}: ${xml.slice(at, at + 24)}`);
  };

  const value = parseValue();
  skipSpace();
  take("</plist>");
  return value;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function serialize(value: Plist, indent = "  "): string {
  // This is the serializer for the closed Plist union above, not boundary parsing.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof value === "string") return `<string>${escapeXml(value)}</string>`;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? `<integer>${value}</integer>`
      : `<real>${value}</real>`;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (Array.isArray(value)) {
    if (value.length === 0) return "<array/>";
    return `<array>\n${value.map((item) => `${indent}${serialize(item, `${indent}  `)}`).join("\n")}\n${indent.slice(2)}</array>`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return "<dict/>";
  return `<dict>\n${entries
    .map(
      ([key, item]) =>
        `${indent}<key>${escapeXml(key)}</key>\n${indent}${serialize(item, `${indent}  `)}`,
    )
    .join("\n")}\n${indent.slice(2)}</dict>`;
}

export function unsignedArtifact(workflow: Workflow): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${serialize(workflow)}\n</plist>\n`;
}

/* --- Entry points ---------------------------------------------------------- */

function build(): void {
  const workflow = compile();
  validateWorkflow(workflow);
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, unsignedArtifact(workflow));
  console.log(`wrote shortcut template: ${OUTPUT}`);
}

function validateArtifact(): void {
  const bytes = readFileSync(OUTPUT);
  const text = bytes.toString("utf8");
  if (text.startsWith("<?xml")) {
    const workflow = asDict(parsePlist(text));
    if (!workflow) throw new Error("artifact is not a plist dict");
    validateWorkflow(workflow);
    const reserialized = unsignedArtifact(workflow);
    if (reserialized !== text) {
      throw new Error(`${OUTPUT} is stale; run --build`);
    }
    console.log(`valid unsigned template: ${OUTPUT}`);
    return;
  }
  if (bytes.subarray(0, 4).toString("ascii") !== "AEA1") {
    throw new Error(
      "artifact is neither the generated XML plist nor an Apple-signed AEA1 file",
    );
  }
  for (const marker of [
    "PASTE_CAPTURE_KEY_DURING_IMPORT",
    ...FORBIDDEN_MARKERS,
  ]) {
    if (marker === "PASTE_CAPTURE_KEY_DURING_IMPORT") continue;
    if (bytes.includes(Buffer.from(marker))) {
      throw new Error(`signed artifact exposes forbidden marker: ${marker}`);
    }
  }
  console.log(
    `valid Apple-signed envelope (payload was validated before signing): ${OUTPUT}`,
  );
}

function sign(): void {
  if (process.platform !== "darwin") {
    throw new Error("Apple's `shortcuts sign` is available only on macOS");
  }
  const input = readFileSync(OUTPUT, "utf8");
  const workflow = asDict(parsePlist(input));
  if (!workflow) throw new Error("signing input is not an unsigned plist dict");
  validateWorkflow(workflow);
  const unsigned = `${OUTPUT}.unsigned.shortcut`;
  const signed = `${OUTPUT}.signed.shortcut`;
  writeFileSync(unsigned, input);
  rmSync(signed, { force: true });
  const result = Bun.spawnSync([
    "shortcuts",
    "sign",
    "--mode",
    "anyone",
    "--input",
    unsigned,
    "--output",
    signed,
  ]);
  rmSync(unsigned, { force: true });
  if (result.exitCode !== 0) {
    rmSync(signed, { force: true });
    throw new Error(result.stderr.toString() || "shortcuts sign failed");
  }
  renameSync(signed, OUTPUT);
  validateArtifact();
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "--validate";
  if (mode === "--build") build();
  else if (mode === "--validate") validateArtifact();
  else if (mode === "--sign") sign();
  else
    throw new Error(
      "usage: bun scripts/shortcut.ts [--build|--validate|--sign]",
    );
}

/** Exported for the template test. */
export { DEFAULT_SERVER, OUTPUT, SOURCE };

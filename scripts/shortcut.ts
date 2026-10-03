import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

type Plist = boolean | number | string | Plist[] | { [key: string]: Plist };

const ROOT = join(import.meta.dir, "..");
const OUTPUT = join(ROOT, "public/shortcuts/add-to-dotflowy-today.shortcut");
const DEFAULT_SERVER = "https://app.dotflowy.com";
const BACKSLASH = String.fromCharCode(92);
const IDS = {
  inputIf: "4B1C8C85-CCB1-498E-BAE0-000000000001",
  inputSet: "4B1C8C85-CCB1-498E-BAE0-000000000002",
  ask: "4B1C8C85-CCB1-498E-BAE0-000000000003",
  askSet: "4B1C8C85-CCB1-498E-BAE0-000000000004",
  nonblank: "4B1C8C85-CCB1-498E-BAE0-000000000005",
  uuid: "4B1C8C85-CCB1-498E-BAE0-000000000006",
  date: "4B1C8C85-CCB1-498E-BAE0-000000000007",
  server: "4B1C8C85-CCB1-498E-BAE0-000000000008",
  key: "4B1C8C85-CCB1-498E-BAE0-000000000009",
  request: "4B1C8C85-CCB1-498E-BAE0-000000000010",
  saved: "4B1C8C85-CCB1-498E-BAE0-000000000011",
  node: "4B1C8C85-CCB1-498E-BAE0-000000000012",
  daily: "4B1C8C85-CCB1-498E-BAE0-000000000013",
  receiptDate: "4B1C8C85-CCB1-498E-BAE0-000000000014",
  receipt: "4B1C8C85-CCB1-498E-BAE0-000000000015",
  receiptMatch: "4B1C8C85-CCB1-498E-BAE0-000000000016",
  error: "4B1C8C85-CCB1-498E-BAE0-000000000017",
  message: "4B1C8C85-CCB1-498E-BAE0-000000000018",
} as const;

const action = (
  identifier: string,
  parameters: Record<string, Plist> = {},
) => ({
  WFWorkflowActionIdentifier: `is.workflow.actions.${identifier}`,
  WFWorkflowActionParameters: parameters,
});

const attachment = (uuid: string, outputName: string): Plist => ({
  Value: { OutputName: outputName, OutputUUID: uuid, Type: "ActionOutput" },
  WFSerializationType: "WFTextTokenAttachment",
});

const variable = (name: string): Plist => ({
  Value: { OutputName: name, Type: "Variable", VariableName: name },
  WFSerializationType: "WFTextTokenAttachment",
});

const extensionInput: Plist = {
  Value: { OutputName: "Shortcut Input", Type: "ExtensionInput" },
  WFSerializationType: "WFTextTokenAttachment",
};

function tokenString(
  text: string,
  refs: Array<{ at: number; value: Record<string, Plist> }>,
): Plist {
  return {
    Value: {
      attachmentsByRange: Object.fromEntries(
        refs.map(({ at, value }) => [`{${at}, 1}`, value]),
      ),
      string: text,
    },
    WFSerializationType: "WFTextTokenString",
  };
}

const tokenRef = (uuid: string, outputName: string) => ({
  OutputName: outputName,
  OutputUUID: uuid,
  Type: "ActionOutput",
});

function dictionaryItems(entries: Array<[string, Plist, number?]>): Plist {
  return {
    Value: {
      WFDictionaryFieldValueItems: entries.map(([key, value, type = 0]) => ({
        WFItemType: type,
        WFKey: tokenString(key, []),
        WFValue: value,
      })),
    },
    WFSerializationType: "WFDictionaryFieldValue",
  };
}

export function createWorkflow() {
  const inputGroup = "A963ED4A-02E5-4EA7-BDBF-000000000001";
  const nonblankGroup = "A963ED4A-02E5-4EA7-BDBF-000000000002";
  const receiptGroup = "A963ED4A-02E5-4EA7-BDBF-000000000003";
  const actions = [
    action("conditional", {
      GroupingIdentifier: inputGroup,
      UUID: IDS.inputIf,
      WFCondition: 100,
      WFControlFlowMode: 0,
      WFInput: extensionInput,
    }),
    action("setvariable", {
      UUID: IDS.inputSet,
      WFInput: extensionInput,
      WFVariableName: "Capture Text",
    }),
    action("conditional", {
      GroupingIdentifier: inputGroup,
      WFControlFlowMode: 1,
    }),
    action("ask", {
      UUID: IDS.ask,
      WFAskActionDefaultAnswer: "",
      WFAskActionPrompt:
        "What do you want to add to today? You can type or use keyboard dictation.",
      WFInputType: "Text",
    }),
    action("setvariable", {
      UUID: IDS.askSet,
      WFInput: attachment(IDS.ask, "Provided Input"),
      WFVariableName: "Capture Text",
    }),
    action("conditional", {
      GroupingIdentifier: inputGroup,
      WFControlFlowMode: 2,
    }),
    action("matchtext", {
      UUID: IDS.nonblank,
      WFInput: variable("Capture Text"),
      WFMatchTextPattern: `${BACKSLASH}S`,
    }),
    action("conditional", {
      GroupingIdentifier: nonblankGroup,
      WFCondition: 100,
      WFControlFlowMode: 0,
      WFInput: attachment(IDS.nonblank, "Matches"),
    }),
    action("generateuuid", { UUID: IDS.uuid }),
    action("format.date", {
      UUID: IDS.date,
      WFDate: {
        Value: { Type: "CurrentDate" },
        WFSerializationType: "WFTextTokenAttachment",
      },
      WFDateFormat: "Custom",
      WFDateFormatStyle: "Custom",
      WFDateFormatString: "yyyy-MM-dd",
      WFISO8601IncludeTime: false,
      WFTimeFormatStyle: "None",
    }),
    action("url", {
      UUID: IDS.server,
      WFURLActionURL: `${DEFAULT_SERVER}/api/capture`,
    }),
    action("gettext", {
      UUID: IDS.key,
      WFTextActionText: "PASTE_CAPTURE_KEY_DURING_IMPORT",
    }),
    action("downloadurl", {
      UUID: IDS.request,
      WFInput: attachment(IDS.server, "URL"),
      ShowHeaders: true,
      WFHTTPBodyType: "JSON",
      WFHTTPHeaders: dictionaryItems([
        [
          "Authorization",
          tokenString("Bearer ￼", [
            { at: 7, value: tokenRef(IDS.key, "Text") },
          ]),
        ],
        ["Content-Type", tokenString("application/json", [])],
      ]),
      WFHTTPMethod: "POST",
      WFJSONValues: dictionaryItems([
        ["attemptId", attachment(IDS.uuid, "UUID")],
        ["date", attachment(IDS.date, "Formatted Date")],
        ["text", variable("Capture Text")],
      ]),
    }),
    action("getvalueforkey", {
      UUID: IDS.saved,
      WFDictionaryKey: "saved",
      WFGetDictionaryValueType: "Value",
      WFInput: attachment(IDS.request, "Contents of URL"),
    }),
    action("getvalueforkey", {
      UUID: IDS.node,
      WFDictionaryKey: "nodeId",
      WFGetDictionaryValueType: "Value",
      WFInput: attachment(IDS.request, "Contents of URL"),
    }),
    action("getvalueforkey", {
      UUID: IDS.daily,
      WFDictionaryKey: "dailyNoteId",
      WFGetDictionaryValueType: "Value",
      WFInput: attachment(IDS.request, "Contents of URL"),
    }),
    action("getvalueforkey", {
      UUID: IDS.receiptDate,
      WFDictionaryKey: "date",
      WFGetDictionaryValueType: "Value",
      WFInput: attachment(IDS.request, "Contents of URL"),
    }),
    action("gettext", {
      UUID: IDS.receipt,
      WFTextActionText: tokenString("￼\n￼\n￼\n￼", [
        { at: 0, value: tokenRef(IDS.saved, "Dictionary Value") },
        { at: 2, value: tokenRef(IDS.node, "Dictionary Value") },
        { at: 4, value: tokenRef(IDS.daily, "Dictionary Value") },
        { at: 6, value: tokenRef(IDS.receiptDate, "Dictionary Value") },
      ]),
    }),
    action("matchtext", {
      UUID: IDS.receiptMatch,
      WFInput: attachment(IDS.receipt, "Text"),
      WFMatchTextPattern: `(?s)^true${BACKSLASH}n.+${BACKSLASH}n.+${BACKSLASH}n${BACKSLASH}d{4}-${BACKSLASH}d{2}-${BACKSLASH}d{2}$`,
    }),
    action("conditional", {
      GroupingIdentifier: receiptGroup,
      UUID: "4B1C8C85-CCB1-498E-BAE0-000000000019",
      WFCondition: 100,
      WFControlFlowMode: 0,
      WFInput: attachment(IDS.receiptMatch, "Matches"),
    }),
    action("notification", {
      WFNotificationActionBody: "Added one bullet to today's note.",
      WFNotificationActionTitle: "Saved to Dotflowy",
    }),
    action("conditional", {
      GroupingIdentifier: receiptGroup,
      WFControlFlowMode: 1,
    }),
    action("getvalueforkey", {
      UUID: IDS.error,
      WFDictionaryKey: "error",
      WFGetDictionaryValueType: "Value",
      WFInput: attachment(IDS.request, "Contents of URL"),
    }),
    action("getvalueforkey", {
      UUID: IDS.message,
      WFDictionaryKey: "message",
      WFGetDictionaryValueType: "Value",
      WFInput: attachment(IDS.request, "Contents of URL"),
    }),
    action("showresult", {
      Text: tokenString("Capture failed (￼): ￼", [
        { at: 16, value: tokenRef(IDS.error, "Dictionary Value") },
        { at: 20, value: tokenRef(IDS.message, "Dictionary Value") },
      ]),
    }),
    action("conditional", {
      GroupingIdentifier: receiptGroup,
      WFControlFlowMode: 2,
    }),
    action("conditional", {
      GroupingIdentifier: nonblankGroup,
      WFControlFlowMode: 2,
    }),
  ];

  return {
    WFQuickActionSurfaces: [],
    WFWorkflowActions: actions,
    WFWorkflowClientVersion: "2700.0.4",
    WFWorkflowHasOutputFallback: false,
    WFWorkflowHasShortcutInputVariables: true,
    WFWorkflowIcon: {
      WFWorkflowIconGlyphNumber: 59412,
      WFWorkflowIconStartColor: 4282601983,
    },
    WFWorkflowImportQuestions: [
      {
        ActionIndex: 11,
        Category: "Parameter",
        ParameterKey: "WFTextActionText",
        Text: "Paste your Dotflowy capture key. It is stored only in your copy of this shortcut.",
      },
      {
        ActionIndex: 10,
        Category: "Parameter",
        DefaultValue: `${DEFAULT_SERVER}/api/capture`,
        ParameterKey: "WFURLActionURL",
        Text: "Capture endpoint (change only when self-hosting Dotflowy).",
      },
    ],
    WFWorkflowInputContentItemClasses: [
      "WFStringContentItem",
      "WFURLContentItem",
    ],
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: "900",
    WFWorkflowName: "Add to Dotflowy Today",
    WFWorkflowOutputContentItemClasses: [],
    WFWorkflowTypes: ["ActionExtension"],
  };
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
  if (typeof value === "number") return `<integer>${value}</integer>`;
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

export function unsignedArtifact(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${serialize(createWorkflow())}\n</plist>\n`;
}

export function validateWorkflow(workflow = createWorkflow()): void {
  const actions = workflow.WFWorkflowActions;
  if (!Array.isArray(actions))
    throw new Error("WFWorkflowActions must be an array");
  const identifiers = actions.map((entry) => entry.WFWorkflowActionIdentifier);
  for (const required of [
    "is.workflow.actions.ask",
    "is.workflow.actions.generateuuid",
    "is.workflow.actions.format.date",
    "is.workflow.actions.downloadurl",
    "is.workflow.actions.matchtext",
  ]) {
    if (!identifiers.includes(required))
      throw new Error(`missing action: ${required}`);
  }
  const serialized = unsignedArtifact();
  for (const forbidden of [
    "sk-",
    "Bearer ey",
    "Bearer dotflowy_",
    "api_key=",
  ]) {
    if (serialized.toLowerCase().includes(forbidden.toLowerCase()))
      throw new Error(`possible embedded credential: ${forbidden}`);
  }
  if (!serialized.includes("PASTE_CAPTURE_KEY_DURING_IMPORT"))
    throw new Error("capture-key import placeholder missing");
  if (!serialized.includes("yyyy-MM-dd"))
    throw new Error("local date format missing");
  if (!serialized.includes("(?s)^true"))
    throw new Error("success receipt validation missing");
}

function validateArtifact(): void {
  const bytes = readFileSync(OUTPUT);
  const text = bytes.toString("utf8");
  if (text.startsWith("<?xml")) {
    if (text !== unsignedArtifact())
      throw new Error(`${OUTPUT} is stale; run --build`);
    validateWorkflow();
    console.log(`valid unsigned template: ${OUTPUT}`);
    return;
  }
  if (bytes.subarray(0, 4).toString("ascii") !== "AEA1")
    throw new Error(
      "artifact is neither the generated XML plist nor an Apple-signed AEA1 file",
    );
  for (const marker of [
    "PASTE_CAPTURE_KEY_DURING_IMPORT",
    "Bearer dotflowy_",
    "api_key=",
  ]) {
    if (bytes.includes(Buffer.from(marker)))
      throw new Error(`signed artifact exposes forbidden marker: ${marker}`);
  }
  console.log(
    `valid Apple-signed envelope (payload was validated before signing): ${OUTPUT}`,
  );
}

function build(): void {
  validateWorkflow();
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, unsignedArtifact());
  console.log(`wrote unsigned template: ${OUTPUT}`);
}

function sign(): void {
  if (process.platform !== "darwin")
    throw new Error("Apple's `shortcuts sign` is available only on macOS");
  validateWorkflow();
  mkdirSync(dirname(OUTPUT), { recursive: true });
  const unsigned = `${OUTPUT}.unsigned`;
  const signed = `${OUTPUT}.signed`;
  writeFileSync(unsigned, unsignedArtifact());
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

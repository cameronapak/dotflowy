import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  ALLOWED_ACTIONS,
  asArray,
  asDict,
  asNumber,
  asString,
  normalizeImportQuestions,
  OUTPUT,
  type Plist,
  parsePlist,
  sortDictionaryItems,
  unsignedArtifact,
  validateWorkflow,
} from "./shortcut";

const artifact = readFileSync(OUTPUT, "utf8");
const workflow = required(asDict(parsePlist(artifact)), "workflow dict");
const actions = required(asArray(workflow.WFWorkflowActions), "actions");
const identifierOf = (action: Plist) =>
  asString(asDict(action)?.WFWorkflowActionIdentifier) ?? "";
const parametersOf = (index: number) =>
  required(
    asDict(
      required(actions[index], `action ${index}`).WFWorkflowActionParameters,
    ),
    `action ${index} parameters`,
  );

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`test fixture is missing ${what}`);
  return value;
}

test("the committed artifact is deterministic, valid, and credential-free", () => {
  validateWorkflow(workflow);
  // Re-serializing the parsed artifact must reproduce it byte for byte; that is
  // what `--validate` reports as a stale artifact.
  expect(unsignedArtifact(workflow)).toBe(artifact);
  expect(artifact).not.toContain("Bearer dotflowy_");
  expect(artifact).not.toContain("dfc_");
  expect(artifact).toContain("PASTE_CAPTURE_KEY_DURING_IMPORT");
});

test("every action is one Shortcuts recognizes", () => {
  const identifiers = actions.map(identifierOf);
  for (const identifier of identifiers) {
    expect(ALLOWED_ACTIONS.has(identifier)).toBe(true);
  }
  // The first template shipped these two, and macOS rendered "Unknown Action"
  // where Match Text should have been.
  expect(identifiers).not.toContain("is.workflow.actions.matchtext");
  expect(identifiers).not.toContain("is.workflow.actions.generateuuid");
  expect(identifiers).toContain("is.workflow.actions.text.match");
  expect(identifiers).toContain("is.workflow.actions.number.random");
});

test("the attempt ID uses two six-digit numbers within Shortcuts' integer range", () => {
  const randomActions = actions.filter(
    (action) => identifierOf(action) === "is.workflow.actions.number.random",
  );
  expect(
    randomActions.map((action) => {
      const parameters = parametersOf(actions.indexOf(action));
      return [
        parameters.WFRandomNumberMinimum,
        parameters.WFRandomNumberMaximum,
      ];
    }),
  ).toEqual([
    [100_000, 999_999],
    [100_000, 999_999],
  ]);
  const idAction = actions.findIndex(
    (action) =>
      asDict(asDict(action)?.WFWorkflowActionParameters)?.CustomOutputName ===
      "attemptId",
  );
  const text = required(
    asDict(asDict(parametersOf(idAction).WFTextActionText)?.Value),
    "attempt ID text",
  );
  expect(text.string).toBe("00000000-0000-4000-8000-\uFFFC\uFFFC");
});

test("conditional blocks have distinct IDs and balanced nested boundaries", () => {
  const groups = new Set<string>();
  const stack: string[] = [];
  for (const action of actions) {
    if (identifierOf(action) !== "is.workflow.actions.conditional") continue;
    const parameters = parametersOf(actions.indexOf(action));
    const group = required(asString(parameters.GroupingIdentifier), "group ID");
    if (parameters.WFControlFlowMode === 0) {
      expect(groups.has(group)).toBe(false);
      groups.add(group);
      stack.push(group);
    } else {
      expect(group).toBe(stack.at(-1));
      if (parameters.WFControlFlowMode === 2) stack.pop();
    }
  }
  expect(stack).toEqual([]);
});

test("import questions target the key and endpoint parameters", () => {
  const questions = required(
    asArray(workflow.WFWorkflowImportQuestions),
    "import questions",
  );
  const bound = questions.map((question) => {
    const entry = required(asDict(question), "question dict");
    const index = required(asNumber(entry.ActionIndex), "question ActionIndex");
    const key = required(asString(entry.ParameterKey), "question key");
    return {
      key,
      target: parametersOf(index).CustomOutputName,
      value: parametersOf(index)[key],
      defaultValue: entry.DefaultValue,
    };
  });
  expect(bound).toEqual([
    {
      key: "WFTextActionText",
      target: "captureKey",
      value: "PASTE_CAPTURE_KEY_DURING_IMPORT",
      defaultValue: "PASTE_CAPTURE_KEY_DURING_IMPORT",
    },
    {
      key: "WFURL",
      target: "response",
      value: "https://app.dotflowy.com/api/capture",
      defaultValue: "https://app.dotflowy.com/api/capture",
    },
  ]);
});

test("setup questions stay bound when Cherri emits them in reverse order", () => {
  const fixture = structuredClone(workflow);
  const questions = required(
    asArray(fixture.WFWorkflowImportQuestions),
    "questions",
  );
  const fixtureActions = required(
    asArray(fixture.WFWorkflowActions),
    "actions",
  );
  for (const question of questions) {
    const entry = required(asDict(question), "question");
    const index = required(asNumber(entry.ActionIndex), "action index");
    const parameters = required(
      asDict(asDict(fixtureActions[index])?.WFWorkflowActionParameters),
      "parameters",
    );
    const key = required(asString(entry.ParameterKey), "parameter key");
    parameters[key] = "";
  }
  questions.reverse();
  normalizeImportQuestions(fixture);
  const defaults = questions.map((question) => asDict(question)?.DefaultValue);
  expect(defaults).toEqual([
    "PASTE_CAPTURE_KEY_DURING_IMPORT",
    "https://app.dotflowy.com/api/capture",
  ]);
  validateWorkflow(fixture);
});

test("the flow is one nonblank gate, a JSON POST, and a receipt check", () => {
  const matches = actions.filter(
    (action) => identifierOf(action) === "is.workflow.actions.text.match",
  );
  expect(matches.length).toBe(2);
  const patterns = matches.map((action) =>
    asString(parametersOf(actions.indexOf(action)).WFMatchTextPattern),
  );
  expect(patterns).toContain(String.raw`\S`);
  expect(patterns).toContain(String.raw`(?s)^.+\n.+\n\d{4}-\d{2}-\d{2}$`);

  const requestAt = actions.findIndex(
    (action) => identifierOf(action) === "is.workflow.actions.downloadurl",
  );
  const request = parametersOf(requestAt);
  expect(request.WFHTTPMethod).toBe("POST");
  expect(request.WFHTTPBodyType).toBe("JSON");

  const source = JSON.stringify(workflow);
  for (const key of [
    "attemptId",
    "date",
    "text",
    "Authorization",
    "Bearer ",
    "saved",
    "nodeId",
    "dailyNoteId",
    "yyyy-MM-dd",
  ]) {
    expect(source).toContain(key);
  }
  const dateAt = actions.findIndex(
    (action) => identifierOf(action) === "is.workflow.actions.format.date",
  );
  expect(parametersOf(dateAt).WFDateFormat).toBe("yyyy-MM-dd");
});

test("receipt fields keep their newlines and saved uses a numeric comparison", () => {
  const receiptAt = actions.findIndex(
    (action) =>
      asDict(asDict(action)?.WFWorkflowActionParameters)?.CustomOutputName ===
      "receipt",
  );
  const receipt = required(
    asDict(asDict(parametersOf(receiptAt).WFTextActionText)?.Value),
    "receipt text",
  );
  expect(receipt.string).toBe("\uFFFC\n\uFFFC\n\uFFFC");
  const numericGate = actions.findIndex(
    (action) =>
      identifierOf(action) === "is.workflow.actions.conditional" &&
      parametersOf(actions.indexOf(action)).WFNumberValue === 1,
  );
  const parameters = parametersOf(numericGate);
  expect(parameters.WFCondition).toBe(4);
  expect(parameters.WFConditionalActionString).toBeUndefined();
  expect(JSON.stringify(parameters.WFInput)).toContain("ReceiptSaved");
});

test("dictionary field items are sorted, not left in map order", () => {
  const dictionary: Plist = {
    WFSerializationType: "WFDictionaryFieldValue",
    Value: {
      WFDictionaryFieldValueItems: [
        { WFKey: { Value: { string: "z" } } },
        { WFKey: { Value: { string: "a" } } },
      ],
    },
  };
  const sorted = required(
    asDict(sortDictionaryItems(dictionary)),
    "sorted dict",
  );
  const items = required(
    asArray(
      required(asDict(sorted.Value), "dictionary value")
        .WFDictionaryFieldValueItems,
    ),
    "dictionary items",
  );
  const keys = items.map((item) =>
    asString(asDict(required(asDict(item).WFKey, "item key").Value)?.string),
  );
  expect(keys).toEqual(["a", "z"]);
});

test("parsePlist decodes numeric entities without decoding escaped entities twice", () => {
  expect(
    parsePlist(
      '<plist version="1.0"><string>a&#xA;b&#10;c &amp;#xA; &amp;#10;</string></plist>',
    ),
  ).toBe("a\nb\nc &#xA; &#10;");
});

test("parsePlist reads the XML subset Cherri emits", () => {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict><key>empty</key><string/><key>list</key><array/>' +
    "<key>dict</key><dict/><key>count</key><integer>3</integer>" +
    "<key>flag</key><true/><key>off</key><false/>" +
    "<key>text</key><string>a &amp; b &lt;c&gt;</string></dict></plist>";
  expect(parsePlist(xml)).toEqual({
    empty: "",
    list: [],
    dict: {},
    count: 3,
    flag: true,
    off: false,
    text: "a & b <c>",
  });
});

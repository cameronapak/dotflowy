import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  ALLOWED_ACTIONS,
  asArray,
  asDict,
  asNumber,
  asString,
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
      value: parametersOf(index)[key],
      defaultValue: entry.DefaultValue,
    };
  });
  expect(bound).toEqual([
    {
      key: "WFTextActionText",
      value: "PASTE_CAPTURE_KEY_DURING_IMPORT",
      defaultValue: "PASTE_CAPTURE_KEY_DURING_IMPORT",
    },
    {
      key: "WFURL",
      value: "https://app.dotflowy.com/api/capture",
      defaultValue: "https://app.dotflowy.com/api/capture",
    },
  ]);
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
  expect(patterns).toContain(String.raw`(?s)^true\n.+\n.+\n\d{4}-\d{2}-\d{2}$`);

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

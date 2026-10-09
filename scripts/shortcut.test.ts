import { expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  ALLOWED_ACTIONS,
  asArray,
  asDict,
  asNumber,
  asString,
  normalizeImportQuestions,
  OUTPUT,
  SIGNED_OUTPUT,
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

test("the public download has the intended name and is signed, not XML", () => {
  expect(basename(SIGNED_OUTPUT)).toBe("Dotflowy.shortcut");
  expect(readFileSync(SIGNED_OUTPUT).subarray(0, 4).toString()).toBe("AEA1");
});

test("share sheet and Spotlight accept text and URLs with the intended icon", () => {
  expect(workflow.WFWorkflowTypes).toEqual([
    "ActionExtension",
    "WFWorkflowTypeShowInSearch",
    "WFWorkflowTypeReceivesInputFromSearch",
  ]);
  expect(workflow.WFWorkflowInputContentItemClasses).toEqual([
    "WFStringContentItem",
    "WFURLContentItem",
  ]);
  expect(workflow.WFWorkflowIcon).toEqual({
    WFWorkflowIconGlyphNumber: 59445,
    WFWorkflowIconStartColor: 1440408063,
  });
});

test("build preserves the signed download and validation rejects a public XML file", () => {
  const dir = mkdtempSync(join(tmpdir(), "dotflowy-build-test-"));
  try {
    for (const path of ["scripts", "shortcuts", "public/shortcuts", "bin"]) {
      mkdirSync(join(dir, path), { recursive: true });
    }
    const script = join(dir, "scripts/shortcut.ts");
    copyFileSync(join(import.meta.dir, "shortcut.ts"), script);
    writeFileSync(join(dir, "shortcuts/add-to-dotflowy-today.cherri"), "");
    const fixture = join(dir, "fixture.shortcut");
    const raw = structuredClone(workflow);
    const rawActions = required(asArray(raw.WFWorkflowActions), "raw actions");
    const keyAction = rawActions.find(
      (action) =>
        asDict(asDict(action)?.WFWorkflowActionParameters)?.CustomOutputName ===
        "captureKey",
    );
    required(
      asDict(asDict(keyAction)?.WFWorkflowActionParameters),
      "raw key parameters",
    ).WFTextActionText = "";
    writeFileSync(fixture, unsignedArtifact(raw));
    const compiler = join(dir, "bin/cherri");
    writeFileSync(
      compiler,
      `#!${process.execPath}\nimport {copyFileSync} from 'node:fs'; import {dirname, join} from 'node:path'; copyFileSync(${JSON.stringify(fixture)}, join(dirname(process.argv[2]), 'Dotflowy_unsigned.shortcut'));\n`,
      { mode: 0o755 },
    );
    const download = join(dir, "public/shortcuts/Dotflowy.shortcut");
    const signed = readFileSync(SIGNED_OUTPUT);
    writeFileSync(download, signed);
    const built = Bun.spawnSync([process.execPath, script, "--build"], {
      env: { ...process.env, CHERRI_BIN: compiler },
    });
    expect(built.stderr.toString()).toBe("");
    expect(built.exitCode).toBe(0);
    expect(readFileSync(download)).toEqual(signed);
    expect(
      readFileSync(join(dir, "shortcuts/Dotflowy.unsigned.shortcut"), "utf8"),
    ).toBe(artifact);
    writeFileSync(download, artifact);
    const invalid = Bun.spawnSync([process.execPath, script, "--validate"]);
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr.toString()).toContain(
      "public shortcut must be an Apple-signed AEA1 file",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")(
  "signing rejects embedded credentials before invoking Apple's CLI",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "dotflowy-signing-test-"));
    try {
      for (const path of ["scripts", "shortcuts", "public/shortcuts", "bin"]) {
        mkdirSync(join(dir, path), { recursive: true });
      }
      const script = join(dir, "scripts/shortcut.ts");
      copyFileSync(join(import.meta.dir, "shortcut.ts"), script);
      writeFileSync(
        join(dir, "shortcuts/Dotflowy.unsigned.shortcut"),
        artifact.replaceAll(
          "PASTE_CAPTURE_KEY_DURING_IMPORT",
          "dfc_fake_signing_test_key",
        ),
      );
      writeFileSync(
        join(dir, "bin/shortcuts"),
        `#!${process.execPath}\nconsole.error("signing was invoked"); process.exit(77);\n`,
        { mode: 0o755 },
      );
      const result = Bun.spawnSync([process.execPath, script, "--sign"], {
        env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}` },
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).not.toContain("signing was invoked");

      writeFileSync(
        join(dir, "shortcuts/Dotflowy.unsigned.shortcut"),
        artifact,
      );
      const clean = Bun.spawnSync([process.execPath, script, "--sign"], {
        env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}` },
      });
      expect(clean.stderr.toString()).toContain("signing was invoked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

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
      if (parameters.WFControlFlowMode === 2) {
        expect(parameters.UUID).toBe(group);
        stack.pop();
      }
    }
  }
  expect(stack).toEqual([]);
});

test("immutable conditional outputs resolve after grouping normalization", () => {
  expect(actions.length).toBeLessThan(40);
  expect(actions.map(identifierOf)).not.toContain(
    "is.workflow.actions.setvariable",
  );
  const ids = new Set(
    actions.map(
      (action) => asDict(asDict(action)?.WFWorkflowActionParameters)?.UUID,
    ),
  );
  const refs: { name: string; uuid: string }[] = [];
  function inspect(value: Plist): void {
    const array = asArray(value);
    if (array) return array.forEach(inspect);
    const dict = asDict(value);
    if (!dict) return;
    if (dict.Type === "ActionOutput") {
      const uuid = required(asString(dict.OutputUUID), "output reference");
      expect(ids.has(uuid)).toBe(true);
      refs.push({ name: asString(dict.OutputName) ?? "", uuid });
    }
    Object.values(dict).forEach(inspect);
  }
  inspect(workflow);
  for (const [name, input] of [
    ["captureText", "ShortcutInput"],
    ["receiptSaved", "receiptMatch"],
  ]) {
    const opening = actions.findIndex(
      (action, index) =>
        identifierOf(action) === "is.workflow.actions.conditional" &&
        (JSON.stringify(parametersOf(index).WFInput) ?? "").includes(input),
    );
    const expected = parametersOf(opening).GroupingIdentifier;
    const consumers = refs.filter((ref) => ref.name === name);
    expect(consumers.length).toBeGreaterThan(0);
    expect(consumers.every((ref) => ref.uuid === expected)).toBe(true);
  }
});

test("the only import question targets the capture-key Text action", () => {
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
  ]);
});

test("the capture-key question is rebound when Cherri emits a stale action index", () => {
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
    entry.ActionIndex = 0;
  }
  normalizeImportQuestions(fixture);
  const defaults = questions.map((question) => asDict(question)?.DefaultValue);
  expect(defaults).toEqual(["PASTE_CAPTURE_KEY_DURING_IMPORT"]);
  validateWorkflow(fixture);
});

test("validation rejects a key question bound to another filled Text action", () => {
  const fixture = structuredClone(workflow);
  const question = required(
    asDict(
      required(asArray(fixture.WFWorkflowImportQuestions), "questions")[0],
    ),
    "question",
  );
  question.ActionIndex = actions.findIndex(
    (action) =>
      asDict(asDict(action)?.WFWorkflowActionParameters)?.CustomOutputName ===
      "attemptId",
  );
  const fixtureActions = required(
    asArray(fixture.WFWorkflowActions),
    "actions",
  );
  const wrongParameters = required(
    asDict(
      asDict(fixtureActions[question.ActionIndex])?.WFWorkflowActionParameters,
    ),
    "wrong target parameters",
  );
  wrongParameters.WFTextActionText = "another filled Text field";
  expect(() => validateWorkflow(fixture)).toThrow(
    "import question must target the capture-key Text action",
  );
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
  expect(request.WFURL).toBe("https://app.dotflowy.com/api/capture");
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
  const input = required(
    asDict(asDict(asDict(parameters.WFInput)?.Variable)?.Value),
    "numeric gate input",
  );
  expect(input.OutputName).toBe("receiptSaved");
  expect(input.Aggrandizements).toEqual([
    {
      CoercionItemClass: "WFNumberContentItem",
      Type: "WFCoercionVariableAggrandizement",
    },
  ]);
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

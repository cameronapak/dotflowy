import { expect, test } from "bun:test";

import { createWorkflow, unsignedArtifact, validateWorkflow } from "./shortcut";

test("the shortcut is deterministic, structurally valid, and credential-free", () => {
  validateWorkflow();
  const first = unsignedArtifact();
  expect(unsignedArtifact()).toBe(first);
  expect(first).toStartWith("<?xml version=");
  expect(first).not.toContain("Bearer dotflowy_");
  expect(first).toContain("PASTE_CAPTURE_KEY_DURING_IMPORT");
});

test("import questions target the key and server URL action parameters", () => {
  const workflow = createWorkflow();
  expect(workflow.WFWorkflowImportQuestions).toEqual([
    {
      ActionIndex: 11,
      Category: "Parameter",
      ParameterKey: "WFTextActionText",
      Text: "Paste your Dotflowy capture key. It is stored only in your copy of this shortcut.",
    },
    {
      ActionIndex: 10,
      Category: "Parameter",
      DefaultValue: "https://app.dotflowy.com/api/capture",
      ParameterKey: "WFURLActionURL",
      Text: "Capture endpoint (change only when self-hosting Dotflowy).",
    },
  ]);
});

test("request is POST JSON with receipt validation after one nonblank gate", () => {
  const workflow = createWorkflow();
  const endpoint = workflow.WFWorkflowActions.find(
    (action) => action.WFWorkflowActionIdentifier === "is.workflow.actions.url",
  )!;
  const request = workflow.WFWorkflowActions.find(
    (action) =>
      action.WFWorkflowActionIdentifier === "is.workflow.actions.downloadurl",
  )!;
  expect(request.WFWorkflowActionParameters.WFInput).toEqual({
    Value: {
      OutputName: "URL",
      OutputUUID: endpoint.WFWorkflowActionParameters.UUID,
      Type: "ActionOutput",
    },
    WFSerializationType: "WFTextTokenAttachment",
  });
  const source = JSON.stringify(workflow);
  expect(source).toContain('"WFHTTPMethod":"POST"');
  expect(source).toContain('"WFHTTPBodyType":"JSON"');
  expect(source).toContain(JSON.stringify(String.fromCharCode(92) + "S"));
  expect(source).toContain('"WFMatchTextPattern":"(?s)^true');
  for (const key of [
    "attemptId",
    "date",
    "text",
    "saved",
    "nodeId",
    "dailyNoteId",
  ])
    expect(source).toContain(`"${key}"`);
});

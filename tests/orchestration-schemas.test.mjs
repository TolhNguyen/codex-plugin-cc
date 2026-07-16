import test from "node:test";
import assert from "node:assert/strict";

import {
  loadOrchestrationSchema,
  toStrictOutputSchema,
  validateAgainstSchema
} from "../plugins/codex/scripts/lib/schema-validator.mjs";

const SCHEMA_NAMES = [
  "project-profile",
  "agent",
  "skill",
  "task",
  "task-result",
  "review-decision",
  "memory-proposal",
  "campaign"
];

const VALID_DOCS = {
  "project-profile": {
    version: 1,
    generatedAt: "2026-07-13T00:00:00.000Z",
    languages: ["javascript"],
    commands: { test: "npm test", build: null, lint: null },
    structure: { dirs: ["src"], entryPoints: ["src/index.mjs"] },
    capabilities: { technical: ["cli"], domains: [], crossCutting: [] }
  },
  agent: {
    id: "worker-1",
    name: "Worker One",
    type: "persistent",
    status: "active",
    ownership: { primary: ["src/"], secondary: [], excluded: [] },
    responsibilities: ["implement tasks"],
    skills: ["core/testing@1.0.0"],
    memory: { namespaces: ["worker-1"] },
    permissions: { read: ["src/**"], write: ["src/**"] },
    runtime: { provider: "codex", model: "gpt-5" },
    limits: { maxAttemptsPerTask: 3, maxExecutionMinutes: 30, maxToolCalls: 100 }
  },
  skill: {
    id: "core/testing",
    version: "1.0.0",
    status: "active",
    purpose: "Write and run tests",
    useWhen: ["implementing a feature"],
    dontUseWhen: ["reviewing docs"],
    requiredInputs: ["task"],
    procedure: ["write tests", "run tests"],
    verificationSteps: ["npm test"],
    doneWhen: ["tests pass"],
    escalateWhen: ["tests cannot pass"],
    outputContract: "task-result",
    sources: [],
    owner: "worker-1"
  },
  task: {
    taskId: "task-1",
    campaignId: "campaign-1",
    title: "Add feature",
    goal: "Ship the feature",
    affectedPaths: ["src/index.mjs"],
    requiredSkills: ["core/testing@1.0.0"],
    owner: "worker-1",
    verificationCommands: ["npm test"],
    acceptanceCriteria: ["tests pass"],
    maxAttempts: 3,
    status: "pending"
  },
  "task-result": {
    taskId: "task-1",
    agentId: "worker-1",
    summary: "Implemented the feature",
    status: "completed",
    changedFiles: ["src/index.mjs"],
    commandsExecuted: ["npm test"],
    verification: { passed: true, details: "all green" },
    risks: [],
    memoryProposals: [],
    skillProposals: []
  },
  "review-decision": {
    taskId: "task-1",
    decision: "approve",
    feedback: [],
    nextAttempt: 1,
    maxAttempts: 3
  },
  "memory-proposal": {
    proposalId: "proposal-1",
    agentId: "worker-1",
    scope: "project",
    content: "Always run npm test before committing",
    type: "convention",
    evidence: ["task-1 failed CI without it"],
    confidence: 0.8,
    status: "pending"
  },
  campaign: {
    campaignId: "campaign-1",
    brief: "Ship the feature",
    acceptanceCriteria: ["feature is live"],
    status: "running",
    budget: {
      maxExecutiveCalls: 10,
      maxManagerCalls: 20,
      maxWorkerCalls: 50,
      maxAttemptsPerTask: 3,
      maxCampaignDurationMinutes: 120
    },
    usage: {
      executiveCalls: 0,
      managerCalls: 0,
      workerCalls: 0,
      reworks: 0,
      estimatedCostByProvider: {}
    },
    startedAt: "2026-07-13T00:00:00.000Z"
  }
};

const INVALID_DOC_BUILDERS = {
  "project-profile": (doc) => ({ ...doc, version: "not-a-number" }),
  agent: (doc) => ({ ...doc, status: "bogus-status" }),
  skill: (doc) => ({ ...doc, id: "not-a-valid-id" }),
  task: (doc) => {
    const { status, ...rest } = doc;
    return rest;
  },
  "task-result": (doc) => ({ ...doc, status: "bogus-status" }),
  "review-decision": (doc) => ({ ...doc, decision: "bogus-decision" }),
  "memory-proposal": (doc) => ({ ...doc, confidence: 2 }),
  campaign: (doc) => {
    const { status, ...rest } = doc;
    return rest;
  }
};

for (const name of SCHEMA_NAMES) {
  test(`${name} schema: minimal valid document passes`, () => {
    const schema = loadOrchestrationSchema(name);
    const result = validateAgainstSchema(VALID_DOCS[name], schema);

    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
  });

  test(`${name} schema: invalid document fails with a path-bearing error`, () => {
    const schema = loadOrchestrationSchema(name);
    const invalidDoc = INVALID_DOC_BUILDERS[name](VALID_DOCS[name]);
    const result = validateAgainstSchema(invalidDoc, schema);

    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some((e) => e.startsWith("/")));
  });

  test(`${name} schema: file parses and contains no $ref`, () => {
    const schema = loadOrchestrationSchema(name);

    assert.equal(typeof schema, "object");
    assert.equal(JSON.stringify(schema).includes("$ref"), false);
  });
}

// --- strict output-schema compliance ---------------------------------------
// These schemas are handed to a model as `outputSchema`. The OpenAI API
// rejects any strict output schema whose object nodes do not list EVERY
// property key in `required` (observed as a 400 `invalid_json_schema`
// during `orchestration-cli bootstrap`). `toStrictOutputSchema` must turn
// each of them into a compliant schema.

const MODEL_FACING_SCHEMA_NAMES = [
  "topology-proposal",
  "memory-decision",
  "review-decision",
  "task-result"
];

function collectStrictViolations(node, ctx, issues) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return;
  }
  if (node.type === "object" && node.properties) {
    const keys = Object.keys(node.properties);
    const required = new Set(node.required ?? []);
    const missing = keys.filter((key) => !required.has(key));
    if (missing.length > 0) {
      issues.push(`${ctx}: missing from required: ${missing.join(", ")}`);
    }
    if (node.additionalProperties !== false) {
      issues.push(`${ctx}: additionalProperties is not false`);
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      collectStrictViolations(value, `${ctx}.${key}`, issues);
    }
  }
}

for (const name of MODEL_FACING_SCHEMA_NAMES) {
  test(`${name} schema: toStrictOutputSchema output satisfies strict structured-output rules`, () => {
    const strict = toStrictOutputSchema(loadOrchestrationSchema(name));
    const issues = [];
    collectStrictViolations(strict, "$", issues);

    assert.deepEqual(issues, []);
  });
}

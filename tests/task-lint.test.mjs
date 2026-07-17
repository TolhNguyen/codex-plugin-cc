import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TASK_LINT_LIMITS,
  estimateMinToolCalls,
  lintTask
} from "../plugins/codex/scripts/orchestration/task-lint.mjs";

function makeTask(overrides = {}) {
  return {
    taskId: "task-1",
    campaignId: "camp-1",
    title: "Add a test",
    goal: "Extend coverage.",
    affectedPaths: ["tests/example.test.mjs"],
    requiredSkills: [],
    owner: "worker-a",
    verificationCommands: ["npm test"],
    acceptanceCriteria: ["it works"],
    maxAttempts: 3,
    status: "routed",
    contextFiles: ["plugins/codex/scripts/lib/args.mjs"],
    ...overrides
  };
}

test("lintTask: a small, contexted, verifiable task passes with no findings", () => {
  const result = lintTask(makeTask());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test("lintTask: too many affected paths is an error recommending a split", () => {
  const paths = Array.from({ length: DEFAULT_TASK_LINT_LIMITS.maxAffectedPaths + 1 }, (_, i) => `src/f${i}.js`);
  const result = lintTask(makeTask({ affectedPaths: paths }));
  assert.equal(result.ok, false);
  const codes = result.errors.map((f) => f.code);
  assert.ok(codes.includes("TOO_MANY_PATHS"));
});

test("lintTask: missing verification commands is an error", () => {
  const result = lintTask(makeTask({ verificationCommands: [] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((f) => f.code === "NO_VERIFICATION"));
});

test("lintTask: docker-flavoured verification is a warning, not an error", () => {
  const result = lintTask(makeTask({ verificationCommands: ["docker compose up -d && dotnet test"] }));
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((f) => f.code === "HEAVY_VERIFICATION"));
});

test("lintTask: no contextFiles warns that the worker must explore", () => {
  const result = lintTask(makeTask({ contextFiles: [] }));
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((f) => f.code === "NO_CONTEXT_FILES"));
});

test("lintTask: agent maxToolCalls below the estimated minimum is an error", () => {
  const task = makeTask({ contextFiles: [] });
  const estimate = estimateMinToolCalls(task);
  const agent = { id: "worker-a", limits: { maxToolCalls: estimate - 1 } };
  const result = lintTask(task, { agent });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((f) => f.code === "TOOL_BUDGET_TOO_LOW"));
});

test("lintTask: agent with enough maxToolCalls passes the budget check", () => {
  const task = makeTask();
  const agent = { id: "worker-a", limits: { maxToolCalls: estimateMinToolCalls(task) } };
  const result = lintTask(task, { agent });
  assert.equal(result.ok, true);
});

test("estimateMinToolCalls: contextFiles shrink the exploration allowance", () => {
  const withContext = estimateMinToolCalls(makeTask());
  const withoutContext = estimateMinToolCalls(makeTask({ contextFiles: [] }));
  assert.ok(withoutContext > withContext);
  assert.equal(
    withoutContext - withContext,
    DEFAULT_TASK_LINT_LIMITS.explorationAllowance - DEFAULT_TASK_LINT_LIMITS.contextedExplorationAllowance
  );
});

test("lintTask: custom limits override the defaults", () => {
  const result = lintTask(makeTask({ affectedPaths: ["a.js", "b.js", "c.js"] }), {
    limits: { maxAffectedPaths: 2 }
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((f) => f.code === "TOO_MANY_PATHS"));
});

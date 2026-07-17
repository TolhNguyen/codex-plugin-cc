import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  buildEscalationReport,
  createCodexEscalationTriage,
  runEscalationTriage
} from "../plugins/codex/scripts/orchestration/escalation-triage.mjs";
import { readAuditEvents } from "../plugins/codex/scripts/orchestration/audit-log.mjs";
import { makeTempDir } from "./helpers.mjs";

function withTempDir(fn) {
  const rootDir = makeTempDir("escalation-triage-test-");
  return Promise.resolve(fn(rootDir)).finally(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
}

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
    status: "escalated",
    ...overrides
  };
}

function makeLoop(overrides = {}) {
  return {
    outcome: "escalated",
    attempts: 3,
    lastResult: {
      status: "failed",
      error: "submit_result failed schema validation twice",
      output: "",
      toolCalls: [
        { tool: "read_file", args: {}, result: "ok", ok: true },
        { tool: "submit_result", args: {}, result: "ERROR: missing required property \"risks\"", ok: false },
        { tool: "submit_result", args: {}, result: "ERROR: missing required property \"risks\"", ok: false }
      ]
    },
    decision: {
      decision: "escalate",
      feedback: [{ code: "max-attempts", description: "Reached max attempts (3) without approval." }]
    },
    ...overrides
  };
}

function makeDecision(overrides = {}) {
  return {
    taskId: "task-1",
    action: "retry_with_fixes",
    rationale: "The failure is a mechanical result-format error.",
    fixes: [{ code: "result-shape", description: "Include the risks array in submit_result." }],
    suggestedTasks: [],
    ...overrides
  };
}

// --- buildEscalationReport -------------------------------------------------

test("buildEscalationReport: summarizes attempts, last error, feedback, and tool stats compactly", () => {
  const report = buildEscalationReport(makeTask(), makeLoop());

  assert.equal(report.taskId, "task-1");
  assert.equal(report.outcome, "escalated");
  assert.equal(report.attempts, 3);
  assert.equal(report.lastWorkerStatus, "failed");
  assert.equal(report.lastWorkerError, "submit_result failed schema validation twice");
  assert.equal(report.lastDecisionFeedback.length, 1);
  assert.equal(report.toolCallStats.total, 3);
  assert.equal(report.toolCallStats.failed, 2);
  assert.deepEqual(report.toolCallStats.byTool, { read_file: 1, submit_result: 2 });
  assert.equal(report.toolCallStats.recentFailures.length, 2);
});

test("buildEscalationReport: tolerates a loop with no lastResult (e.g. halted before any attempt)", () => {
  const report = buildEscalationReport(makeTask(), { outcome: "escalated", attempts: 0 });
  assert.equal(report.lastWorkerStatus, null);
  assert.equal(report.toolCallStats.total, 0);
});

test("buildEscalationReport: extracts summary/verification when worker output is a task-result JSON", () => {
  const loop = makeLoop({
    lastResult: {
      status: "completed",
      error: null,
      output: JSON.stringify({ summary: "partial work", verification: { passed: false, details: "build broke" } }),
      toolCalls: []
    }
  });
  const report = buildEscalationReport(makeTask(), loop);
  assert.equal(report.lastWorkerSummary, "partial work");
  assert.deepEqual(report.lastVerification, { passed: false, details: "build broke" });
});

// --- createCodexEscalationTriage ------------------------------------------

test("createCodexEscalationTriage: returns the validated decision on the first try", async () => {
  const prompts = [];
  const runtime = {
    execute: async (_agent, _task, { prompt }) => {
      prompts.push(prompt);
      return { status: "completed", output: JSON.stringify(makeDecision()) };
    }
  };
  const triageFn = createCodexEscalationTriage({ rootDir: ".", runtime, managerAgent: { id: "manager-codex" } });

  const decision = await triageFn(makeTask(), buildEscalationReport(makeTask(), makeLoop()));
  assert.equal(decision.action, "retry_with_fixes");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /escalation_report/);
  assert.match(prompts[0], /submit_result failed schema validation twice/);
});

test("createCodexEscalationTriage: one schema-repair retry, then throws", async () => {
  let calls = 0;
  const runtime = {
    execute: async () => {
      calls += 1;
      return { status: "completed", output: JSON.stringify({ nonsense: true }) };
    }
  };
  const triageFn = createCodexEscalationTriage({ rootDir: ".", runtime, managerAgent: { id: "manager-codex" } });

  await assert.rejects(
    () => triageFn(makeTask(), buildEscalationReport(makeTask(), makeLoop())),
    /Manager triage decision invalid after one retry/
  );
  assert.equal(calls, 2);
});

test("createCodexEscalationTriage: invalid first output then valid second output succeeds", async () => {
  let calls = 0;
  const runtime = {
    execute: async () => {
      calls += 1;
      if (calls === 1) {
        return { status: "completed", output: "not json" };
      }
      return { status: "completed", output: JSON.stringify(makeDecision({ action: "shrink" })) };
    }
  };
  const triageFn = createCodexEscalationTriage({ rootDir: ".", runtime, managerAgent: { id: "manager-codex" } });

  const decision = await triageFn(makeTask(), buildEscalationReport(makeTask(), makeLoop()));
  assert.equal(decision.action, "shrink");
  assert.equal(calls, 2);
});

// --- runEscalationTriage ---------------------------------------------------

test("runEscalationTriage: persists report + decision and audits the action", async () => {
  await withTempDir(async (rootDir) => {
    const triageFn = async () => makeDecision();
    const doc = await runEscalationTriage(rootDir, {
      campaignId: "camp-1",
      task: makeTask(),
      loop: makeLoop(),
      triageFn
    });

    assert.equal(doc.decision.action, "retry_with_fixes");
    assert.equal(doc.triageError, null);

    const filePath = path.join(rootDir, ".ai-company", "campaigns", "camp-1", "escalations", "task-1.json");
    assert.ok(fs.existsSync(filePath));
    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(persisted.report.taskId, "task-1");
    assert.equal(persisted.decision.action, "retry_with_fixes");

    const events = readAuditEvents(rootDir, "camp-1");
    const triaged = events.find((event) => event.event === "escalation_triaged");
    assert.equal(triaged.action, "retry_with_fixes");
  });
});

test("runEscalationTriage: a failing triageFn still persists the report with decision null — never throws", async () => {
  await withTempDir(async (rootDir) => {
    const triageFn = async () => {
      throw new Error("codex unavailable");
    };
    const doc = await runEscalationTriage(rootDir, {
      campaignId: "camp-1",
      task: makeTask(),
      loop: makeLoop(),
      triageFn
    });

    assert.equal(doc.decision, null);
    assert.equal(doc.triageError, "codex unavailable");

    const filePath = path.join(rootDir, ".ai-company", "campaigns", "camp-1", "escalations", "task-1.json");
    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(persisted.decision, null);
    assert.equal(persisted.report.attempts, 3);
  });
});

test("runEscalationTriage: a denying budget guard is absorbed as triageError, report still persisted", async () => {
  await withTempDir(async (rootDir) => {
    let triageCalled = false;
    const doc = await runEscalationTriage(rootDir, {
      campaignId: "camp-1",
      task: makeTask(),
      loop: makeLoop(),
      triageFn: async () => {
        triageCalled = true;
        return makeDecision();
      },
      guards: {
        beforeManagerCall: async () => {
          throw new Error("Budget exhausted: manager calls (30/30)");
        }
      }
    });

    assert.equal(triageCalled, false);
    assert.equal(doc.decision, null);
    assert.match(doc.triageError, /Budget exhausted/);
  });
});

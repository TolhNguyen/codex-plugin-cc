import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createCodexReviewer, runReviewLoop } from "../plugins/codex/scripts/orchestration/review-loop.mjs";
import { readAuditEvents } from "../plugins/codex/scripts/orchestration/audit-log.mjs";
import { loadOrchestrationSchema } from "../plugins/codex/scripts/lib/schema-validator.mjs";
import { createRuntimeResult } from "../plugins/codex/scripts/runtimes/runtime-base.mjs";
import { makeTempDir } from "./helpers.mjs";

async function withTempDir(fn) {
  const rootDir = makeTempDir("review-loop-test-");
  try {
    await fn(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function makeTask(overrides = {}) {
  return {
    taskId: "task-1",
    campaignId: "camp-1",
    title: "Do the thing",
    goal: "Get it done",
    affectedPaths: ["src/alpha/file.js"],
    requiredSkills: ["technical/shared-skill@1.0.0"],
    owner: "worker-a",
    verificationCommands: [],
    acceptanceCriteria: ["it works"],
    maxAttempts: 3,
    status: "routed",
    ...overrides
  };
}

function makeAgent(overrides = {}) {
  return {
    id: "worker-a",
    name: "Worker A",
    type: "persistent",
    status: "active",
    ownership: { primary: ["src/alpha/**"], secondary: [], excluded: [] },
    responsibilities: ["do work"],
    skills: ["technical/shared-skill@1.0.0"],
    memory: { namespaces: ["agent/worker-a"] },
    permissions: { read: ["**"], write: ["src/alpha/**"] },
    runtime: { provider: "openai-compatible", model: "deepseek-chat" },
    limits: { maxAttemptsPerTask: 3, maxExecutionMinutes: 20, maxToolCalls: 40 },
    ...overrides
  };
}

let workerResultCounter = 0;
function makeWorkerResult(status, overrides = {}) {
  workerResultCounter += 1;
  return createRuntimeResult({
    executionId: overrides.executionId ?? `exec-worker-${workerResultCounter}`,
    agentId: overrides.agentId ?? "worker-a",
    role: "worker",
    status,
    output: overrides.output ?? "",
    startedAt: overrides.startedAt ?? "2026-07-14T00:00:00.000Z",
    endedAt: overrides.endedAt ?? "2026-07-14T00:00:01.000Z",
    error: overrides.error ?? null
  });
}

function makeManagerResult(overrides = {}) {
  return createRuntimeResult({
    executionId: overrides.executionId ?? "exec-mgr-1",
    agentId: overrides.agentId ?? "manager-codex",
    role: "manager",
    status: overrides.status ?? "completed",
    output: overrides.output ?? "",
    startedAt: overrides.startedAt ?? "2026-07-14T00:00:00.000Z",
    endedAt: overrides.endedAt ?? "2026-07-14T00:00:01.000Z",
    error: overrides.error ?? null
  });
}

function makeScriptedWorkerRuntime(results) {
  let call = 0;
  const contexts = [];
  return {
    contexts,
    execute: async (agent, task, context) => {
      contexts.push(context);
      const result = results[call];
      call += 1;
      return result;
    }
  };
}

function makeScriptedReviewFn(decisions) {
  let call = 0;
  const calls = [];
  const fn = async (task, attempt, workerResult) => {
    calls.push({ task, attempt, workerResult });
    const decision = decisions[call];
    call += 1;
    return decision;
  };
  fn.calls = calls;
  return fn;
}

function taskFilePath(rootDir, campaignId, taskId) {
  return path.join(rootDir, ".ai-company", "campaigns", campaignId, "tasks", `${taskId}.json`);
}

// 1. Approve on attempt 1.
test("runReviewLoop: approve on attempt 1 returns approved and audits in order", async () => {
  await withTempDir(async (rootDir) => {
    const task = makeTask();
    const agent = makeAgent();
    const workerResult = makeWorkerResult("completed", { output: JSON.stringify({ ok: true }) });
    const decision = { taskId: task.taskId, decision: "approve", feedback: [], nextAttempt: 2, maxAttempts: 3 };

    const workerRuntime = makeScriptedWorkerRuntime([workerResult]);
    const reviewFn = makeScriptedReviewFn([decision]);
    const buildWorkerContext = () => ({});

    const result = await runReviewLoop(rootDir, {
      campaignId: "camp-1",
      task,
      agent,
      workerRuntime,
      reviewFn,
      buildWorkerContext
    });

    assert.equal(result.outcome, "approved");
    assert.equal(result.attempts, 1);
    assert.deepEqual(result.decision, decision);

    const persisted = JSON.parse(fs.readFileSync(taskFilePath(rootDir, "camp-1", task.taskId), "utf8"));
    assert.equal(persisted.status, "approved");
    assert.equal(persisted.attempts.length, 1);
    assert.equal(persisted.attempts[0].workerStatus, "completed");

    const events = readAuditEvents(rootDir, "camp-1");
    assert.deepEqual(
      events.map((event) => event.event),
      ["task_attempt_started", "worker_result", "review_decision", "loop_finished"]
    );
    assert.equal(events.at(-1).outcome, "approved");
    assert.equal(events.at(-1).attempts, 1);
  });
});

// 2. Rework then approve threads feedback into next attempt's context.
test("runReviewLoop: rework then approve threads feedback into the next attempt's context", async () => {
  await withTempDir(async (rootDir) => {
    const task = makeTask();
    const agent = makeAgent();
    const workerResult1 = makeWorkerResult("completed");
    const workerResult2 = makeWorkerResult("completed");
    const reworkFeedback = [{ code: "MISSING_TESTS", description: "add a test" }];
    const decision1 = { taskId: task.taskId, decision: "rework", feedback: reworkFeedback, nextAttempt: 2, maxAttempts: 3 };
    const decision2 = { taskId: task.taskId, decision: "approve", feedback: [], nextAttempt: 3, maxAttempts: 3 };

    const workerRuntime = makeScriptedWorkerRuntime([workerResult1, workerResult2]);
    const reviewFn = makeScriptedReviewFn([decision1, decision2]);
    const seenFeedback = [];
    const buildWorkerContext = (t, a, feedback) => {
      seenFeedback.push(feedback);
      return {};
    };

    const result = await runReviewLoop(rootDir, {
      campaignId: "camp-1",
      task,
      agent,
      workerRuntime,
      reviewFn,
      buildWorkerContext
    });

    assert.equal(result.outcome, "approved");
    assert.equal(result.attempts, 2);
    assert.deepEqual(seenFeedback[0], []);
    assert.deepEqual(seenFeedback[1], reworkFeedback);

    const persisted = JSON.parse(fs.readFileSync(taskFilePath(rootDir, "camp-1", task.taskId), "utf8"));
    assert.equal(persisted.attempts.length, 2);
  });
});

// 3. Rework on every attempt escalates once maxAttempts is exhausted.
test("runReviewLoop: rework on every attempt escalates once maxAttempts is exhausted", async () => {
  await withTempDir(async (rootDir) => {
    const task = makeTask({ maxAttempts: 2 });
    const agent = makeAgent();
    const wr1 = makeWorkerResult("completed");
    const wr2 = makeWorkerResult("completed");
    const decision1 = { taskId: task.taskId, decision: "rework", feedback: [{ code: "X", description: "keep going" }], nextAttempt: 2, maxAttempts: 2 };
    const decision2 = { taskId: task.taskId, decision: "rework", feedback: [{ code: "X", description: "keep going" }], nextAttempt: 3, maxAttempts: 2 };

    const workerRuntime = makeScriptedWorkerRuntime([wr1, wr2]);
    const reviewFn = makeScriptedReviewFn([decision1, decision2]);
    const buildWorkerContext = () => ({});

    const result = await runReviewLoop(rootDir, {
      campaignId: "camp-1",
      task,
      agent,
      workerRuntime,
      reviewFn,
      buildWorkerContext
    });

    assert.equal(result.outcome, "escalated");
    assert.equal(result.attempts, 2);
    assert.equal(result.decision.decision, "escalate");
    assert.equal(result.decision.feedback[0].code, "MAX_ATTEMPTS_EXHAUSTED");

    const persisted = JSON.parse(fs.readFileSync(taskFilePath(rootDir, "camp-1", task.taskId), "utf8"));
    assert.equal(persisted.status, "escalated");

    const events = readAuditEvents(rootDir, "camp-1");
    assert.ok(events.some((event) => event.event === "escalated"));
    assert.equal(events.at(-1).event, "loop_finished");
    assert.equal(events.at(-1).outcome, "escalated");
  });
});

// 4. Worker transport failure synthesizes a decision without calling reviewFn.
test("runReviewLoop: a worker transport failure synthesizes rework without calling reviewFn; the final failure escalates", async () => {
  await withTempDir(async (rootDir) => {
    const task = makeTask({ maxAttempts: 2 });
    const agent = makeAgent();
    const failed1 = makeWorkerResult("failed", { error: "network down" });
    const failed2 = makeWorkerResult("failed", { error: "network down again" });

    const workerRuntime = makeScriptedWorkerRuntime([failed1, failed2]);
    const reviewFn = makeScriptedReviewFn([]);
    const buildWorkerContext = () => ({});

    const result = await runReviewLoop(rootDir, {
      campaignId: "camp-1",
      task,
      agent,
      workerRuntime,
      reviewFn,
      buildWorkerContext
    });

    assert.equal(reviewFn.calls.length, 0);
    assert.equal(result.outcome, "escalate");
    assert.equal(result.attempts, 2);
    assert.equal(result.decision.feedback[0].code, "WORKER_FAILED");

    const events = readAuditEvents(rootDir, "camp-1");
    const decisionEvents = events.filter((event) => event.event === "review_decision");
    assert.equal(decisionEvents.length, 2);
    assert.ok(decisionEvents.every((event) => event.synthesized === true));
    assert.equal(decisionEvents[0].decision, "rework");
    assert.equal(decisionEvents[1].decision, "escalate");
  });
});

// 5. A real escalate decision from reviewFn ends the loop immediately.
test("runReviewLoop: a real escalate decision from reviewFn ends the loop immediately", async () => {
  await withTempDir(async (rootDir) => {
    const task = makeTask({ maxAttempts: 3 });
    const agent = makeAgent();
    const wr1 = makeWorkerResult("completed");
    const decision = {
      taskId: task.taskId,
      decision: "escalate",
      feedback: [{ code: "OUT_OF_SCOPE", description: "not our repo area" }],
      nextAttempt: 2,
      maxAttempts: 3
    };

    const workerRuntime = makeScriptedWorkerRuntime([wr1]);
    const reviewFn = makeScriptedReviewFn([decision]);
    const buildWorkerContext = () => ({});

    const result = await runReviewLoop(rootDir, {
      campaignId: "camp-1",
      task,
      agent,
      workerRuntime,
      reviewFn,
      buildWorkerContext
    });

    assert.equal(result.outcome, "escalate");
    assert.equal(result.attempts, 1);
    assert.equal(reviewFn.calls.length, 1);

    const persisted = JSON.parse(fs.readFileSync(taskFilePath(rootDir, "camp-1", task.taskId), "utf8"));
    assert.equal(persisted.status, "escalated");
  });
});

// 6. guards.beforeWorkerCall throwing halts the loop.
test("runReviewLoop: guards.beforeWorkerCall throwing halts the loop without another worker or review call", async () => {
  await withTempDir(async (rootDir) => {
    const task = makeTask({ maxAttempts: 3 });
    const agent = makeAgent();
    const wr1 = makeWorkerResult("completed");
    const decision1 = { taskId: task.taskId, decision: "rework", feedback: [{ code: "X", description: "y" }], nextAttempt: 2, maxAttempts: 3 };

    const workerRuntime = makeScriptedWorkerRuntime([wr1]);
    const reviewFn = makeScriptedReviewFn([decision1]);
    const buildWorkerContext = () => ({});
    const guards = {
      beforeWorkerCall: (attempt) => {
        if (attempt === 2) {
          throw new Error("budget exhausted");
        }
      }
    };

    const result = await runReviewLoop(rootDir, {
      campaignId: "camp-1",
      task,
      agent,
      workerRuntime,
      reviewFn,
      buildWorkerContext,
      guards
    });

    assert.equal(result.outcome, "halted");
    assert.equal(reviewFn.calls.length, 1);
    assert.equal(workerRuntime.contexts.length, 1);

    const events = readAuditEvents(rootDir, "camp-1");
    assert.ok(events.some((event) => event.event === "loop_halted"));
    assert.equal(events.at(-1).event, "loop_finished");
    assert.equal(events.at(-1).outcome, "halted");
  });
});

test("runReviewLoop: guards.beforeManagerCall throwing halts the loop after the worker ran", async () => {
  await withTempDir(async (rootDir) => {
    const task = makeTask({ maxAttempts: 3 });
    const agent = makeAgent();
    const wr1 = makeWorkerResult("completed");

    const workerRuntime = makeScriptedWorkerRuntime([wr1]);
    const reviewFn = makeScriptedReviewFn([]);
    const buildWorkerContext = () => ({});
    const guards = {
      beforeManagerCall: () => {
        throw new Error("manager budget exhausted");
      }
    };

    const result = await runReviewLoop(rootDir, {
      campaignId: "camp-1",
      task,
      agent,
      workerRuntime,
      reviewFn,
      buildWorkerContext,
      guards
    });

    assert.equal(result.outcome, "halted");
    assert.equal(reviewFn.calls.length, 0);

    const events = readAuditEvents(rootDir, "camp-1");
    assert.ok(events.some((event) => event.event === "loop_halted"));
    assert.equal(events.at(-1).event, "loop_finished");
  });
});

// 7. reviewFn returning a schema-invalid decision halts the loop (defensive
// re-check) instead of throwing, so the failure is audited like every other
// return path.
test("runReviewLoop: a schema-invalid decision from reviewFn halts the loop and audits review_failed", async () => {
  await withTempDir(async (rootDir) => {
    const task = makeTask();
    const agent = makeAgent();
    const wr1 = makeWorkerResult("completed");
    const badDecision = { taskId: task.taskId, decision: "approve" };

    const workerRuntime = makeScriptedWorkerRuntime([wr1]);
    const reviewFn = makeScriptedReviewFn([badDecision]);
    const buildWorkerContext = () => ({});

    const result = await runReviewLoop(rootDir, {
      campaignId: "camp-1",
      task,
      agent,
      workerRuntime,
      reviewFn,
      buildWorkerContext
    });

    assert.equal(result.outcome, "halted");
    assert.match(result.reason, /feedback/);

    const events = readAuditEvents(rootDir, "camp-1");
    const failedEvent = events.find((event) => event.event === "review_failed");
    assert.ok(failedEvent, "expected a review_failed audit event");
    assert.equal(failedEvent.taskId, task.taskId);
    assert.equal(failedEvent.attempt, 1);
    assert.match(failedEvent.error, /feedback/);
    assert.ok(events.some((event) => event.event === "loop_halted"));
    assert.equal(events.at(-1).event, "loop_finished");
    assert.equal(events.at(-1).outcome, "halted");
  });
});

// 7b. An uncaught reviewFn throw (e.g. manager runtime failure surfaced by
// createCodexReviewer) must still leave a full audit trail and resolve
// (never reject) with outcome "halted".
test("runReviewLoop: reviewFn throwing (manager runtime failure) halts the loop and audits review_failed", async () => {
  await withTempDir(async (rootDir) => {
    const task = makeTask();
    const agent = makeAgent();
    const wr1 = makeWorkerResult("completed");

    const workerRuntime = makeScriptedWorkerRuntime([wr1]);
    const reviewFn = async () => {
      throw new Error("Manager review failed: codex crashed");
    };
    const buildWorkerContext = () => ({});

    const result = await runReviewLoop(rootDir, {
      campaignId: "camp-1",
      task,
      agent,
      workerRuntime,
      reviewFn,
      buildWorkerContext
    });

    assert.equal(result.outcome, "halted");
    assert.match(result.reason, /Manager review failed: codex crashed/);

    const events = readAuditEvents(rootDir, "camp-1");
    const failedEvent = events.find((event) => event.event === "review_failed");
    assert.ok(failedEvent, "expected a review_failed audit event");
    assert.equal(failedEvent.taskId, task.taskId);
    assert.equal(failedEvent.attempt, 1);
    assert.match(failedEvent.error, /Manager review failed: codex crashed/);
    assert.ok(events.some((event) => event.event === "loop_halted"));
    assert.equal(events.at(-1).event, "loop_finished");
    assert.equal(events.at(-1).outcome, "halted");
  });
});

// 7c. decision.taskId must match task.taskId; a mismatch is a
// manager-integrity failure routed through the same halt handling.
test("runReviewLoop: a decision with a mismatched taskId halts as a manager-integrity failure", async () => {
  await withTempDir(async (rootDir) => {
    const task = makeTask();
    const agent = makeAgent();
    const wr1 = makeWorkerResult("completed");
    const mismatched = {
      taskId: "some-other-task",
      decision: "approve",
      feedback: [],
      nextAttempt: 2,
      maxAttempts: 3
    };

    const workerRuntime = makeScriptedWorkerRuntime([wr1]);
    const reviewFn = makeScriptedReviewFn([mismatched]);
    const buildWorkerContext = () => ({});

    const result = await runReviewLoop(rootDir, {
      campaignId: "camp-1",
      task,
      agent,
      workerRuntime,
      reviewFn,
      buildWorkerContext
    });

    assert.equal(result.outcome, "halted");
    assert.match(result.reason, /decision taskId mismatch: expected task-1, got some-other-task/);

    const events = readAuditEvents(rootDir, "camp-1");
    const failedEvent = events.find((event) => event.event === "review_failed");
    assert.ok(failedEvent, "expected a review_failed audit event");
    assert.match(failedEvent.error, /decision taskId mismatch: expected task-1, got some-other-task/);
    assert.ok(events.some((event) => event.event === "loop_halted"));
    assert.equal(events.at(-1).event, "loop_finished");
    assert.equal(events.at(-1).outcome, "halted");
  });
});

// 7d. The loop must pass its effective (agent-capped) maxAttempts into
// reviewFn so the manager sees the real budget, not the raw task field.
test("runReviewLoop: passes the capped maxAttempts to reviewFn as the 4th argument", async () => {
  await withTempDir(async (rootDir) => {
    const task = makeTask({ maxAttempts: 5 });
    const agent = makeAgent({ limits: { maxAttemptsPerTask: 2, maxExecutionMinutes: 20, maxToolCalls: 40 } });
    const wr1 = makeWorkerResult("completed");
    const decision = { taskId: task.taskId, decision: "approve", feedback: [], nextAttempt: 2, maxAttempts: 2 };

    const workerRuntime = makeScriptedWorkerRuntime([wr1]);
    const seenOptions = [];
    const reviewFn = async (t, attempt, workerResult, options) => {
      seenOptions.push(options);
      return decision;
    };
    const buildWorkerContext = () => ({});

    await runReviewLoop(rootDir, {
      campaignId: "camp-1",
      task,
      agent,
      workerRuntime,
      reviewFn,
      buildWorkerContext
    });

    assert.equal(seenOptions.length, 1);
    assert.equal(seenOptions[0].maxAttempts, 2);
  });
});

// 8. maxAttempts is capped at the smaller of task.maxAttempts and the agent's limit.
test("runReviewLoop: caps maxAttempts at the smaller of task.maxAttempts and the agent's limit", async () => {
  await withTempDir(async (rootDir) => {
    const task = makeTask({ maxAttempts: 5 });
    const agent = makeAgent({ limits: { maxAttemptsPerTask: 2, maxExecutionMinutes: 20, maxToolCalls: 40 } });
    const wr1 = makeWorkerResult("completed");
    const wr2 = makeWorkerResult("completed");
    const rework = (n) => ({ taskId: task.taskId, decision: "rework", feedback: [{ code: "X", description: "y" }], nextAttempt: n + 1, maxAttempts: 2 });

    const workerRuntime = makeScriptedWorkerRuntime([wr1, wr2]);
    const reviewFn = makeScriptedReviewFn([rework(1), rework(2)]);
    const buildWorkerContext = () => ({});

    const result = await runReviewLoop(rootDir, {
      campaignId: "camp-1",
      task,
      agent,
      workerRuntime,
      reviewFn,
      buildWorkerContext
    });

    assert.equal(result.attempts, 2);
    assert.equal(result.outcome, "escalated");
    assert.equal(workerRuntime.contexts.length, 2);
  });
});

// --- createCodexReviewer -------------------------------------------------

test("createCodexReviewer: returns the manager's decision when it validates on the first try", async () => {
  await withTempDir(async (rootDir) => {
    const task = makeTask();
    const workerResult = makeWorkerResult("completed", { output: JSON.stringify({ done: true }) });
    const decision = { taskId: task.taskId, decision: "approve", feedback: [], nextAttempt: 2, maxAttempts: 3 };

    const calls = [];
    const runtime = {
      execute: async (agent, t, context) => {
        calls.push({ agent, task: t, context });
        return makeManagerResult({ output: JSON.stringify(decision) });
      }
    };

    const reviewFn = createCodexReviewer({ rootDir, runtime, managerAgent: { id: "manager-codex" } });
    const result = await reviewFn(task, 1, workerResult);

    assert.deepEqual(result, decision);
    assert.equal(calls.length, 1);
    assert.match(calls[0].context.prompt, /"taskId": "task-1"/);
    assert.deepEqual(calls[0].context.outputSchema, loadOrchestrationSchema("review-decision"));
  });
});

test("createCodexReviewer: retries once with validation errors appended, then succeeds", async () => {
  await withTempDir(async (rootDir) => {
    const task = makeTask();
    const workerResult = makeWorkerResult("completed", { output: "not json" });
    const badDecision = { taskId: task.taskId, decision: "approve" };
    const goodDecision = { taskId: task.taskId, decision: "approve", feedback: [], nextAttempt: 2, maxAttempts: 3 };

    let call = 0;
    const prompts = [];
    const runtime = {
      execute: async (agent, t, context) => {
        prompts.push(context.prompt);
        call += 1;
        return makeManagerResult({ output: JSON.stringify(call === 1 ? badDecision : goodDecision) });
      }
    };

    const reviewFn = createCodexReviewer({ rootDir, runtime, managerAgent: { id: "manager-codex" } });
    const result = await reviewFn(task, 1, workerResult);

    assert.deepEqual(result, goodDecision);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /missing required property "feedback"/);
  });
});

test("createCodexReviewer: throws with validation errors when both attempts are invalid", async () => {
  await withTempDir(async (rootDir) => {
    const task = makeTask();
    const workerResult = makeWorkerResult("completed", { output: "{}" });
    const badDecision = { taskId: task.taskId, decision: "approve" };

    const runtime = {
      execute: async () => makeManagerResult({ output: JSON.stringify(badDecision) })
    };

    const reviewFn = createCodexReviewer({ rootDir, runtime, managerAgent: { id: "manager-codex" } });

    await assert.rejects(() => reviewFn(task, 1, workerResult), /missing required property "feedback"/);
  });
});

test("createCodexReviewer: throws 'Manager review failed' when the runtime does not complete", async () => {
  await withTempDir(async (rootDir) => {
    const task = makeTask();
    const workerResult = makeWorkerResult("completed", { output: "{}" });

    const runtime = {
      execute: async () => makeManagerResult({ status: "failed", output: "", error: "codex crashed" })
    };

    const reviewFn = createCodexReviewer({ rootDir, runtime, managerAgent: { id: "manager-codex" } });

    await assert.rejects(() => reviewFn(task, 1, workerResult), /Manager review failed: codex crashed/);
  });
});

test("createCodexReviewer: uses the capped maxAttempts passed via the 4th argument for the prompt, not task.maxAttempts", async () => {
  await withTempDir(async (rootDir) => {
    const task = makeTask({ maxAttempts: 5 });
    const workerResult = makeWorkerResult("completed", { output: JSON.stringify({ ok: true }) });
    const decision = { taskId: task.taskId, decision: "approve", feedback: [], nextAttempt: 3, maxAttempts: 2 };

    const calls = [];
    const runtime = {
      execute: async (agent, t, context) => {
        calls.push({ agent, task: t, context });
        return makeManagerResult({ output: JSON.stringify(decision) });
      }
    };

    const reviewFn = createCodexReviewer({ rootDir, runtime, managerAgent: { id: "manager-codex" } });
    const result = await reviewFn(task, 2, workerResult, { maxAttempts: 2 });

    assert.deepEqual(result, decision);
    assert.match(calls[0].context.prompt, /is attempt 2 of 2/);
  });
});

test("createCodexReviewer: falls back to task.maxAttempts when no options are passed (backward compatible)", async () => {
  await withTempDir(async (rootDir) => {
    const task = makeTask({ maxAttempts: 5 });
    const workerResult = makeWorkerResult("completed", { output: JSON.stringify({ ok: true }) });
    const decision = { taskId: task.taskId, decision: "approve", feedback: [], nextAttempt: 2, maxAttempts: 5 };

    const calls = [];
    const runtime = {
      execute: async (agent, t, context) => {
        calls.push({ agent, task: t, context });
        return makeManagerResult({ output: JSON.stringify(decision) });
      }
    };

    const reviewFn = createCodexReviewer({ rootDir, runtime, managerAgent: { id: "manager-codex" } });
    await reviewFn(task, 1, workerResult);

    assert.match(calls[0].context.prompt, /is attempt 1 of 5/);
  });
});

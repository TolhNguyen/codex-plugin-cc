import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadOrchestrationSchema, validateAgainstSchema } from "../lib/schema-validator.mjs";
import { loadPromptTemplate, interpolateTemplate } from "../lib/prompts.mjs";
import { writeJsonFile } from "../lib/fs.mjs";
import { appendAuditEvent } from "./audit-log.mjs";

/**
 * The managed worker -> review -> rework loop. This is the only loop in the
 * orchestration core; every path through it is bounded by `maxAttempts` and
 * every step is audited (append-only JSONL via `audit-log.mjs`). Budget
 * guards are consulted before every worker call and every manager call;
 * transport failures (a worker RuntimeResult that isn't "completed") never
 * spend manager-review budget — they synthesize a decision locally instead.
 */

const PLUGIN_ROOT_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// --- prompt assembly for the Codex-backed reviewer -----------------------

function extractWorkerResultJson(workerResult) {
  const raw = workerResult?.output ?? "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function buildReviewPrompt(pluginRoot, task, attemptNumber, workerResult) {
  const template = loadPromptTemplate(pluginRoot, "orchestration/review-decision");
  return interpolateTemplate(template, {
    TASK_JSON: JSON.stringify(task, null, 2),
    ATTEMPT_NUMBER: String(attemptNumber),
    MAX_ATTEMPTS: String(task.maxAttempts),
    WORKER_RESULT_JSON: extractWorkerResultJson(workerResult),
    ACCEPTANCE_CRITERIA: (task.acceptanceCriteria ?? []).map((item) => `- ${item}`).join("\n")
  });
}

function buildCorrectionPrompt(prompt, errors) {
  const errorList = errors.map((error) => `- ${error}`).join("\n");
  return `${prompt}\n\n## Correction required\nThe previous response failed validation with these errors:\n${errorList}\n\nReturn ONLY corrected JSON matching the schema.`;
}

function tryParseAndValidate(output, schema) {
  let parsed;
  try {
    parsed = JSON.parse(output ?? "");
  } catch (error) {
    return { ok: false, errors: [`Manager output was not parseable JSON: ${error.message}`] };
  }

  const { valid, errors } = validateAgainstSchema(parsed, schema);
  if (!valid) {
    return { ok: false, errors };
  }
  return { ok: true, value: parsed };
}

/**
 * Builds a `reviewFn(task, attemptNumber, workerResult)` backed by a manager
 * runtime (normally the Codex manager runtime). One schema-repair retry is
 * attempted before giving up, mirroring `topology-planner.mjs`.
 *
 * @param {{ rootDir: string, runtime: { execute: Function }, managerAgent: object, pluginRoot?: string }} options
 */
export function createCodexReviewer({ rootDir, runtime, managerAgent, pluginRoot = PLUGIN_ROOT_DIR } = {}) {
  return async function reviewFn(task, attemptNumber, workerResult) {
    const schema = loadOrchestrationSchema("review-decision");
    const prompt = buildReviewPrompt(pluginRoot, task, attemptNumber, workerResult);

    const firstRun = await runtime.execute(managerAgent, task, { prompt, outputSchema: schema });
    if (firstRun.status !== "completed") {
      throw new Error(`Manager review failed: ${firstRun.error ?? firstRun.status}`);
    }

    const firstTry = tryParseAndValidate(firstRun.output, schema);
    if (firstTry.ok) {
      return firstTry.value;
    }

    const retryPrompt = buildCorrectionPrompt(prompt, firstTry.errors);
    const secondRun = await runtime.execute(managerAgent, task, { prompt: retryPrompt, outputSchema: schema });
    if (secondRun.status !== "completed") {
      throw new Error(`Manager review failed: ${secondRun.error ?? secondRun.status}`);
    }

    const secondTry = tryParseAndValidate(secondRun.output, schema);
    if (secondTry.ok) {
      return secondTry.value;
    }

    throw new Error(`Manager review decision invalid after one retry:\n${secondTry.errors.join("\n")}`);
  };
}

// --- bounded review loop --------------------------------------------------

function taskFilePath(rootDir, campaignId, taskId) {
  return path.join(rootDir, ".ai-company", "campaigns", campaignId, "tasks", `${taskId}.json`);
}

function persistTask(rootDir, campaignId, task, status, attempts) {
  const filePath = taskFilePath(rootDir, campaignId, task.taskId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeJsonFile(filePath, { ...task, status, attempts });
  return filePath;
}

function mapDecisionToTaskStatus(decision) {
  switch (decision) {
    case "approve":
      return "approved";
    case "escalate":
      return "escalated";
    case "split":
    case "reassign":
      return "pending";
    case "rework":
    default:
      return "in_progress";
  }
}

function computeMaxAttempts(task, agent) {
  const fromTask = task.maxAttempts;
  const fromAgent = agent?.limits?.maxAttemptsPerTask;
  if (fromTask != null && fromAgent != null) {
    return Math.min(fromTask, fromAgent);
  }
  return fromTask ?? fromAgent ?? 3;
}

function synthesizeTransportDecision(task, attempt, maxAttempts, workerResult) {
  const decision = attempt < maxAttempts ? "rework" : "escalate";
  return {
    taskId: task.taskId,
    decision,
    feedback: [
      {
        code: `WORKER_${workerResult.status.toUpperCase()}`,
        description: workerResult.error ?? workerResult.status
      }
    ],
    nextAttempt: attempt + 1,
    maxAttempts
  };
}

function synthesizeExhaustedDecision(task, maxAttempts) {
  return {
    taskId: task.taskId,
    decision: "escalate",
    feedback: [
      {
        code: "MAX_ATTEMPTS_EXHAUSTED",
        description: `Reached max attempts (${maxAttempts}) without approval.`
      }
    ],
    nextAttempt: maxAttempts + 1,
    maxAttempts
  };
}

/**
 * Runs the bounded worker -> review -> rework loop for a single task. The
 * ONLY loop here is the bounded `for` below (attempts 1..maxAttempts); the
 * reviewFn schema-repair retry (bounded to 1) lives inside `createCodexReviewer`.
 *
 * @param {string} rootDir
 * @param {{
 *   campaignId: string,
 *   task: object,
 *   agent: object,
 *   workerRuntime: { execute: Function },
 *   reviewFn: (task: object, attempt: number, workerResult: object) => Promise<object>,
 *   buildWorkerContext: (task: object, agent: object, feedback: object[]) => object,
 *   guards?: { beforeWorkerCall?: Function, beforeManagerCall?: Function },
 *   audit?: typeof appendAuditEvent
 * }} options
 */
export async function runReviewLoop(
  rootDir,
  { campaignId, task, agent, workerRuntime, reviewFn, buildWorkerContext, guards = {}, audit = appendAuditEvent }
) {
  const maxAttempts = computeMaxAttempts(task, agent);
  const reviewDecisionSchema = loadOrchestrationSchema("review-decision");

  let feedback = [];
  let attemptsLog = Array.isArray(task.attempts) ? [...task.attempts] : [];
  let lastWorkerResult = null;

  function finish(outcome, attempts, extra = {}) {
    audit(rootDir, campaignId, { event: "loop_finished", taskId: task.taskId, outcome, attempts });
    return { outcome, attempts, ...extra };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Budget guard BEFORE every worker call. A throw here never spends a
    // worker or manager call for this attempt.
    try {
      await guards.beforeWorkerCall?.(attempt);
    } catch (error) {
      audit(rootDir, campaignId, { event: "loop_halted", taskId: task.taskId, attempt, reason: error.message });
      return finish("halted", attempt - 1, { reason: error.message });
    }

    audit(rootDir, campaignId, { event: "task_attempt_started", taskId: task.taskId, attempt, agentId: agent.id });

    const context = buildWorkerContext(task, agent, feedback);
    const workerResult = await workerRuntime.execute(agent, task, context);
    lastWorkerResult = workerResult;

    audit(rootDir, campaignId, {
      event: "worker_result",
      taskId: task.taskId,
      attempt,
      executionId: workerResult.executionId,
      status: workerResult.status
    });

    let decision;
    if (workerResult.status !== "completed") {
      // Transport/environment failure: synthesize a decision locally so the
      // manager (and its budget) is never consulted for something the
      // worker's runtime already failed to deliver.
      decision = synthesizeTransportDecision(task, attempt, maxAttempts, workerResult);
      audit(rootDir, campaignId, {
        event: "review_decision",
        synthesized: true,
        taskId: task.taskId,
        attempt,
        decision: decision.decision
      });
    } else {
      // Budget guard BEFORE every manager call.
      try {
        await guards.beforeManagerCall?.(attempt);
      } catch (error) {
        audit(rootDir, campaignId, { event: "loop_halted", taskId: task.taskId, attempt, reason: error.message });
        return finish("halted", attempt, { reason: error.message });
      }

      decision = await reviewFn(task, attempt, workerResult);
      const { valid, errors } = validateAgainstSchema(decision, reviewDecisionSchema);
      if (!valid) {
        throw new Error(`Invalid review decision:\n${errors.join("\n")}`);
      }

      audit(rootDir, campaignId, {
        event: "review_decision",
        taskId: task.taskId,
        attempt,
        decision: decision.decision
      });
    }

    attemptsLog = [
      ...attemptsLog,
      { attempt, executionId: workerResult.executionId, workerStatus: workerResult.status, decision }
    ];

    persistTask(rootDir, campaignId, task, mapDecisionToTaskStatus(decision.decision), attemptsLog);

    if (decision.decision === "approve") {
      return finish("approved", attempt, { lastResult: workerResult, decision });
    }

    if (decision.decision === "rework") {
      feedback = decision.feedback;
      continue;
    }

    // "split" | "reassign" | "escalate"
    return finish(decision.decision, attempt, { lastResult: workerResult, decision });
  }

  // Attempts exhausted and the final decision was still "rework" — escalate.
  const exhaustedDecision = synthesizeExhaustedDecision(task, maxAttempts);
  persistTask(rootDir, campaignId, task, "escalated", attemptsLog);
  audit(rootDir, campaignId, {
    event: "escalated",
    taskId: task.taskId,
    attempts: maxAttempts,
    reason: "MAX_ATTEMPTS_EXHAUSTED"
  });

  return finish("escalated", maxAttempts, { lastResult: lastWorkerResult, decision: exhaustedDecision });
}

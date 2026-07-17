import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadOrchestrationSchema, validateAgainstSchema } from "../lib/schema-validator.mjs";
import { loadPromptTemplate, interpolateTemplate } from "../lib/prompts.mjs";
import { writeJsonFile } from "../lib/fs.mjs";
import { appendAuditEvent } from "./audit-log.mjs";

/**
 * Escalation triage: when the review loop escalates a task, the MANAGER tier
 * (Codex, subscription-priced) absorbs the diagnosis instead of dumping raw
 * logs on the Executive (the most expensive tier). Two pieces:
 *
 *  - `buildEscalationReport` — deterministic, compact summary of what
 *    happened (attempts, last worker status/error, reviewer feedback, tool
 *    call stats). This alone replaces "Executive reads execution records".
 *  - `createCodexEscalationTriage` — a manager turn over that report that
 *    returns a schema-validated decision (retry_with_fixes / shrink / split /
 *    reassign / handle_directly), with one schema-repair retry, mirroring
 *    `createCodexReviewer`.
 *
 * `runEscalationTriage` never throws: if the manager call fails (budget
 * exhausted, transport error, invalid output twice), the report is still
 * persisted with `decision: null` so the Executive gets the compact report
 * either way.
 */

const PLUGIN_ROOT_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function tryParseJson(raw) {
  try {
    return JSON.parse(raw ?? "");
  } catch {
    return null;
  }
}

/**
 * @param {object} task the task document handed to the loop
 * @param {{ outcome: string, attempts: number, lastResult?: object, decision?: object, reason?: string }} loop
 *   the review-loop result
 * @returns {object} a compact, deterministic escalation report
 */
export function buildEscalationReport(task, loop) {
  const lastResult = loop.lastResult ?? null;
  const workerDoc = tryParseJson(lastResult?.output);
  const toolCalls = Array.isArray(lastResult?.toolCalls) ? lastResult.toolCalls : [];
  const failedCalls = toolCalls.filter((call) => call && call.ok === false);

  const byTool = {};
  for (const call of toolCalls) {
    const name = call?.tool ?? "unknown";
    byTool[name] = (byTool[name] ?? 0) + 1;
  }

  return {
    taskId: task.taskId,
    title: task.title,
    outcome: loop.outcome,
    attempts: loop.attempts,
    reason: loop.reason ?? null,
    lastWorkerStatus: lastResult?.status ?? null,
    lastWorkerError: lastResult?.error ?? null,
    lastWorkerSummary: workerDoc?.summary ?? null,
    lastVerification: workerDoc?.verification ?? null,
    lastDecisionFeedback: loop.decision?.feedback ?? [],
    toolCallStats: {
      total: toolCalls.length,
      failed: failedCalls.length,
      byTool,
      recentFailures: failedCalls.slice(-5).map((call) => ({ tool: call.tool, result: call.result }))
    }
  };
}

function buildTriagePrompt(pluginRoot, task, report) {
  const template = loadPromptTemplate(pluginRoot, "orchestration/escalation-triage");
  return interpolateTemplate(template, {
    TASK_JSON: JSON.stringify(task, null, 2),
    ESCALATION_REPORT_JSON: JSON.stringify(report, null, 2)
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
 * Builds a `triageFn(task, report)` backed by a manager runtime, with one
 * schema-repair retry (mirrors `createCodexReviewer`).
 *
 * @param {{ rootDir: string, runtime: { execute: Function }, managerAgent: object, pluginRoot?: string }} options
 */
export function createCodexEscalationTriage({ rootDir, runtime, managerAgent, pluginRoot = PLUGIN_ROOT_DIR } = {}) {
  return async function triageFn(task, report) {
    const schema = loadOrchestrationSchema("escalation-triage");
    const prompt = buildTriagePrompt(pluginRoot, task, report);

    const firstRun = await runtime.execute(managerAgent, task, { prompt, outputSchema: schema });
    if (firstRun.status !== "completed") {
      throw new Error(`Manager triage failed: ${firstRun.error ?? firstRun.status}`);
    }

    const firstTry = tryParseAndValidate(firstRun.output, schema);
    if (firstTry.ok) {
      return firstTry.value;
    }

    const retryPrompt = buildCorrectionPrompt(prompt, firstTry.errors);
    const secondRun = await runtime.execute(managerAgent, task, { prompt: retryPrompt, outputSchema: schema });
    if (secondRun.status !== "completed") {
      throw new Error(`Manager triage failed: ${secondRun.error ?? secondRun.status}`);
    }

    const secondTry = tryParseAndValidate(secondRun.output, schema);
    if (secondTry.ok) {
      return secondTry.value;
    }

    throw new Error(`Manager triage decision invalid after one retry:\n${secondTry.errors.join("\n")}`);
  };
}

function escalationFilePath(rootDir, campaignId, taskId) {
  return path.join(rootDir, ".ai-company", "campaigns", campaignId, "escalations", `${taskId}.json`);
}

/**
 * Builds the report, runs the (budget-guarded) manager triage, persists both
 * under `.ai-company/campaigns/<id>/escalations/<taskId>.json`, and audits.
 * NEVER throws — a failed manager call still persists the report with
 * `decision: null` and the failure in `triageError`.
 *
 * @param {string} rootDir
 * @param {{
 *   campaignId: string,
 *   task: object,
 *   loop: object,
 *   triageFn: (task: object, report: object) => Promise<object>,
 *   guards?: { beforeManagerCall?: Function },
 *   audit?: Function,
 *   now?: () => string
 * }} options
 * @returns {Promise<{ taskId: string, campaignId: string, createdAt: string, report: object, decision: object|null, triageError: string|null }>}
 */
export async function runEscalationTriage(
  rootDir,
  { campaignId, task, loop, triageFn, guards = {}, audit = appendAuditEvent, now = () => new Date().toISOString() }
) {
  const report = buildEscalationReport(task, loop);

  let decision = null;
  let triageError = null;
  try {
    await guards.beforeManagerCall?.();
    decision = await triageFn(task, report);
  } catch (error) {
    triageError = error instanceof Error ? error.message : String(error);
  }

  const doc = { taskId: task.taskId, campaignId, createdAt: now(), report, decision, triageError };

  const filePath = escalationFilePath(rootDir, campaignId, task.taskId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeJsonFile(filePath, doc);

  audit(rootDir, campaignId, {
    event: "escalation_triaged",
    taskId: task.taskId,
    action: decision?.action ?? null,
    triageError
  });

  return doc;
}

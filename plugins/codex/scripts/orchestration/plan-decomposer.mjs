import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadOrchestrationSchema, validateAgainstSchema } from "../lib/schema-validator.mjs";
import { loadPromptTemplate, interpolateTemplate } from "../lib/prompts.mjs";
import { writeJsonFile } from "../lib/fs.mjs";
import { lintTask } from "./task-lint.mjs";
import { appendAuditEvent } from "./audit-log.mjs";

/**
 * Plan decomposition: turn a written implementation plan into tier-classified
 * task drafts. The MANAGER tier (Codex) reads the plan and decides, per unit of
 * work, which tier should do it and — for worker-tier units — writes a
 * spec-complete task. This is the step that keeps the campaign economics from
 * inverting: only genuinely worker-shaped, lint-passing slices with routable
 * skills become run-ready; everything else is surfaced but never handed to a
 * cheap worker (see docs/CAMPAIGN_RUNBOOK.md §4).
 *
 *  - `buildPlanDecompositionPrompt` — deterministic prompt assembly.
 *  - `createCodexPlanDecomposer` — a manager turn returning a schema-validated
 *    `{ tasks }`, with one schema-repair retry (mirrors
 *    `createCodexEscalationTriage`).
 *  - `runPlanDecomposition` — classifies each returned task (run-ready /
 *    needs-attention / expensive-tier), persists worker-tier drafts + a
 *    manifest under `.ai-company/campaigns/<id>/drafts/`, and audits. It only
 *    touches disk AFTER a successful decomposition, so a denied budget guard or
 *    a failed manager call leaves nothing behind.
 */

const PLUGIN_ROOT_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function buildPlanDecompositionPrompt(
  pluginRoot,
  { planText, projectProfile = null, campaign = {}, skillCatalog = [] } = {}
) {
  const template = loadPromptTemplate(pluginRoot, "orchestration/plan-decomposition");
  return interpolateTemplate(template, {
    PLAN_TEXT: planText ?? "",
    PROJECT_PROFILE_JSON: JSON.stringify(projectProfile ?? {}, null, 2),
    CAMPAIGN_JSON: JSON.stringify(campaign ?? {}, null, 2),
    SKILL_CATALOG_JSON: JSON.stringify(skillCatalog ?? [], null, 2)
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
 * Builds a `decomposeFn(planText, ctx)` backed by a manager runtime, with one
 * schema-repair retry (mirrors `createCodexEscalationTriage`).
 *
 * @param {{ rootDir: string, runtime: { execute: Function }, managerAgent: object, pluginRoot?: string }} options
 */
export function createCodexPlanDecomposer({ rootDir, runtime, managerAgent, pluginRoot = PLUGIN_ROOT_DIR } = {}) {
  return async function decomposeFn(planText, ctx = {}) {
    const schema = loadOrchestrationSchema("plan-decomposition");
    const prompt = buildPlanDecompositionPrompt(pluginRoot, {
      planText,
      projectProfile: ctx.projectProfile ?? null,
      campaign: ctx.campaign ?? {},
      skillCatalog: ctx.skillCatalog ?? []
    });
    const descriptor = { taskId: "plan-decomposition", campaignId: ctx.campaign?.campaignId ?? null };

    const firstRun = await runtime.execute(managerAgent, descriptor, { prompt, outputSchema: schema });
    if (firstRun.status !== "completed") {
      throw new Error(`Plan decomposition failed: ${firstRun.error ?? firstRun.status}`);
    }

    const firstTry = tryParseAndValidate(firstRun.output, schema);
    if (firstTry.ok) {
      return firstTry.value;
    }

    const retryPrompt = buildCorrectionPrompt(prompt, firstTry.errors);
    const secondRun = await runtime.execute(managerAgent, descriptor, { prompt: retryPrompt, outputSchema: schema });
    if (secondRun.status !== "completed") {
      throw new Error(`Plan decomposition failed: ${secondRun.error ?? secondRun.status}`);
    }

    const secondTry = tryParseAndValidate(secondRun.output, schema);
    if (secondTry.ok) {
      return secondTry.value;
    }

    throw new Error(`Plan decomposition invalid after one retry:\n${secondTry.errors.join("\n")}`);
  };
}

function slugify(title) {
  const slug = String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "task";
}

function uniqueTaskId(base, used) {
  let candidate = `task-${base}`;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `task-${base}-${n}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

function toTaskDoc(raw, { taskId, campaignId, maxAttempts }) {
  return {
    taskId,
    campaignId,
    title: raw.title,
    goal: raw.goal,
    affectedPaths: raw.affectedPaths ?? [],
    requiredSkills: raw.requiredSkills ?? [],
    owner: "",
    verificationCommands: raw.verificationCommands ?? [],
    acceptanceCriteria: raw.acceptanceCriteria ?? [],
    maxAttempts,
    status: "pending",
    contextFiles: raw.contextFiles ?? []
  };
}

/**
 * Classifies and persists a decomposition.
 *
 * @param {string} cwd
 * @param {{
 *   campaign: object,
 *   planText: string,
 *   projectProfile?: object|null,
 *   skillCatalog?: { ref: string, purpose?: string }[],
 *   decomposeFn: (planText: string, ctx: object) => Promise<{ tasks: object[] }>,
 *   guards?: { beforeManagerCall?: Function },
 *   audit?: Function,
 *   now?: () => string,
 *   outDir?: string|null
 * }} options
 */
export async function runPlanDecomposition(
  cwd,
  {
    campaign,
    planText,
    projectProfile = null,
    skillCatalog = [],
    decomposeFn,
    guards = {},
    audit = appendAuditEvent,
    now = () => new Date().toISOString(),
    outDir = null
  }
) {
  // Nothing below touches disk until decomposition succeeds, so a denied guard
  // or a failed manager call leaves no partial artifacts behind.
  await guards.beforeManagerCall?.();
  const decomposition = await decomposeFn(planText, { projectProfile, campaign, skillCatalog });

  const routable = new Set((skillCatalog ?? []).map((skill) => skill.ref));
  const maxAttempts = campaign.budget?.maxAttemptsPerTask ?? 3;
  const draftsDir = outDir ?? path.join(cwd, ".ai-company", "campaigns", campaign.campaignId, "drafts");
  const usedIds = new Set();

  const tasks = [];
  const runReady = [];
  const filesToWrite = [];

  for (const raw of decomposition.tasks) {
    const taskId = uniqueTaskId(slugify(raw.title), usedIds);
    const taskDoc = toTaskDoc(raw, { taskId, campaignId: campaign.campaignId, maxAttempts });

    const lint = lintTask(taskDoc);
    const skillGap = (raw.requiredSkills ?? []).filter((ref) => !routable.has(ref));
    const tier = raw.tier;

    const isWorker = tier === "worker";
    const bucket = isWorker ? (lint.ok && skillGap.length === 0 ? "run-ready" : "needs-attention") : "expensive-tier";

    const actualFile = path.join(draftsDir, `${taskId}.json`);
    tasks.push({
      taskId,
      title: raw.title,
      tier,
      tierRationale: raw.tierRationale,
      bucket,
      file: isWorker ? path.relative(cwd, actualFile) : null,
      lint: {
        ok: lint.ok,
        errorCodes: lint.errors.map((error) => error.code),
        warningCodes: lint.warnings.map((warning) => warning.code)
      },
      skillGap,
      requiredSkills: raw.requiredSkills ?? []
    });

    if (isWorker) {
      filesToWrite.push({ actualFile, taskDoc });
    }
    if (bucket === "run-ready") {
      runReady.push(taskDoc);
    }
  }

  fs.mkdirSync(draftsDir, { recursive: true });
  for (const { actualFile, taskDoc } of filesToWrite) {
    writeJsonFile(actualFile, taskDoc);
  }

  const summary = {
    total: tasks.length,
    runReady: tasks.filter((task) => task.bucket === "run-ready").length,
    needsAttention: tasks.filter((task) => task.bucket === "needs-attention").length,
    expensiveTier: tasks.filter((task) => task.bucket === "expensive-tier").length
  };
  const manifest = {
    campaignId: campaign.campaignId,
    decomposedAt: now(),
    outDir: draftsDir,
    summary,
    tasks
  };
  const manifestPath = path.join(draftsDir, "manifest.json");
  writeJsonFile(manifestPath, manifest);

  audit(cwd, campaign.campaignId, {
    event: "plan_decomposed",
    total: summary.total,
    runReady: summary.runReady,
    needsAttention: summary.needsAttention,
    expensiveTier: summary.expensiveTier
  });

  return { campaignId: campaign.campaignId, outDir: draftsDir, manifestPath, manifest, tasks, runReady };
}

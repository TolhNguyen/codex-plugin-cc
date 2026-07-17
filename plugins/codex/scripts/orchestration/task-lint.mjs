/**
 * Deterministic task-size lint. Pure code, no LLM, no IO — it runs BEFORE any
 * budget is spent so an over-sized or under-specified task is rejected at
 * routing time instead of being discovered on worker attempt 3.
 *
 * Rationale (docs/CAMPAIGN_RUNBOOK.md): the dominant cost-failure mode of the
 * three-tier runtime is a cheap worker burning attempts on a task it can
 * never finish, then escalating to the most expensive tier. Every finding
 * here encodes one observed way that happens:
 *  - TOO_MANY_PATHS      task spans too many files for one worker slice
 *  - NO_VERIFICATION     worker cannot self-verify, review is blind
 *  - HEAVY_VERIFICATION  verification needs docker/containers — slow or
 *                        impossible in the worker sandbox
 *  - NO_CONTEXT_FILES    worker must burn tool calls exploring the repo
 *  - TOOL_BUDGET_TOO_LOW the agent's maxToolCalls cannot cover even the
 *                        optimistic minimum for this task
 *
 * Enforcement is the caller's choice: `runCampaignTask` rejects on errors by
 * default but accepts `lint: { enforce: false }` (CLI: `--no-lint`) for
 * deliberate "unleashed" experiment runs.
 */

export const DEFAULT_TASK_LINT_LIMITS = {
  // More writable paths than this in one task is a "split" signal.
  maxAffectedPaths: 6,
  // Tool calls assumed burned on discovery when the task ships no context.
  explorationAllowance: 12,
  // Discovery allowance when contextFiles are pre-stuffed into the prompt.
  contextedExplorationAllowance: 4,
  // Each verification command is expected to run this many times
  // (initial run + one fix-and-rerun cycle).
  verificationRunsPerCommand: 2,
  // submit_result plus one schema-repair resubmit.
  submitAllowance: 2,
  // Case-insensitive substrings marking verification that is slow or needs
  // infrastructure a worker sandbox usually lacks.
  heavyCommandPatterns: ["docker", "testcontainers", "kubectl"]
};

/**
 * Optimistic lower bound on the tool calls a worker needs for `task`:
 * read + write per affected path, verification runs, submit allowance, and
 * an exploration allowance that shrinks when contextFiles are provided.
 *
 * @param {object} task a task document
 * @param {object} [limits] overrides merged over DEFAULT_TASK_LINT_LIMITS
 * @returns {number}
 */
export function estimateMinToolCalls(task, limits = {}) {
  const cfg = { ...DEFAULT_TASK_LINT_LIMITS, ...limits };
  const pathCount = Array.isArray(task.affectedPaths) ? task.affectedPaths.length : 0;
  const commandCount = Array.isArray(task.verificationCommands) ? task.verificationCommands.length : 0;
  const hasContext = Array.isArray(task.contextFiles) && task.contextFiles.length > 0;

  const exploration = hasContext ? cfg.contextedExplorationAllowance : cfg.explorationAllowance;
  return (
    pathCount * 2 +
    Math.max(1, commandCount) * cfg.verificationRunsPerCommand +
    cfg.submitAllowance +
    exploration
  );
}

function finding(severity, code, message, recommendation) {
  return { severity, code, message, recommendation };
}

/**
 * @param {object} task a task document (already schema-validated upstream)
 * @param {{ agent?: object|null, limits?: object }} [options] `agent` is the
 *   routed owner; when provided, its `limits.maxToolCalls` is checked against
 *   the estimated minimum.
 * @returns {{ ok: boolean, errors: object[], warnings: object[], estimatedMinToolCalls: number }}
 */
export function lintTask(task, { agent = null, limits = {} } = {}) {
  const cfg = { ...DEFAULT_TASK_LINT_LIMITS, ...limits };
  const errors = [];
  const warnings = [];

  const affectedPaths = Array.isArray(task.affectedPaths) ? task.affectedPaths : [];
  const verificationCommands = Array.isArray(task.verificationCommands) ? task.verificationCommands : [];
  const contextFiles = Array.isArray(task.contextFiles) ? task.contextFiles : [];

  if (affectedPaths.length > cfg.maxAffectedPaths) {
    errors.push(
      finding(
        "error",
        "TOO_MANY_PATHS",
        `Task touches ${affectedPaths.length} paths (limit ${cfg.maxAffectedPaths}).`,
        "Split into slices of at most " + cfg.maxAffectedPaths + " writable paths each."
      )
    );
  }

  if (verificationCommands.length === 0) {
    errors.push(
      finding(
        "error",
        "NO_VERIFICATION",
        "Task has no verificationCommands; the worker cannot self-verify and review is blind.",
        "Add at least one cheap, deterministic verification command (a scoped build or test run)."
      )
    );
  }

  for (const command of verificationCommands) {
    const lowered = String(command).toLowerCase();
    const heavy = cfg.heavyCommandPatterns.find((pattern) => lowered.includes(pattern));
    if (heavy) {
      warnings.push(
        finding(
          "warning",
          "HEAVY_VERIFICATION",
          `Verification command needs "${heavy}": ${command}`,
          "Verify with a scoped build/unit-test command instead; run infrastructure-heavy checks outside the worker."
        )
      );
    }
  }

  if (contextFiles.length === 0 && affectedPaths.length > 0) {
    warnings.push(
      finding(
        "warning",
        "NO_CONTEXT_FILES",
        "Task ships no contextFiles; the worker must burn tool calls exploring the repo.",
        "Pre-stuff the reference files the worker needs into contextFiles (they are injected free of tool calls)."
      )
    );
  }

  const estimatedMinToolCalls = estimateMinToolCalls(task, limits);
  const maxToolCalls = agent?.limits?.maxToolCalls;
  if (typeof maxToolCalls === "number" && estimatedMinToolCalls > maxToolCalls) {
    errors.push(
      finding(
        "error",
        "TOOL_BUDGET_TOO_LOW",
        `Estimated minimum tool calls (${estimatedMinToolCalls}) exceeds agent ${agent?.id ?? "?"}'s maxToolCalls (${maxToolCalls}).`,
        "Shrink the task (fewer paths, pre-stuffed context) or raise the agent's limits.maxToolCalls."
      )
    );
  }

  return { ok: errors.length === 0, errors, warnings, estimatedMinToolCalls };
}

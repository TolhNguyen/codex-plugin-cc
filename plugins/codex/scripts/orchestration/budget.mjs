/**
 * Pure budget guard over a campaign's `budget` (caps) and `usage` (counters).
 * No file IO here — the orchestrator (`campaign-orchestrator.mjs`) is
 * responsible for persisting the campaign document after usage changes.
 *
 * `createBudget(campaign)` returns guards that must be awaited before every
 * manager/worker/executive call. A guard throws instead of returning false so
 * that callers (the review loop, the memory-review batch) can lean on a
 * single try/catch pattern to turn "budget exhausted" into a halted/paused
 * outcome instead of a crash.
 */

// Per-1k-token price table. These are ESTIMATES for budget-tracking
// purposes only, not authoritative billing figures — actual provider
// pricing can change or differ by region/tier. Update deliberately.
export const PROVIDER_PRICING = {
  deepseek: { input: 0.00027, output: 0.0011 },
  codex: { input: 0, output: 0 }
};

function formatMinutes(ms) {
  return Math.floor(ms / 60000);
}

/**
 * @param {{ budget: object, usage: object, startedAt: string }} campaign
 */
export function createBudget(campaign) {
  const budget = campaign.budget;
  const usage = campaign.usage;
  const startedAtMs = new Date(campaign.startedAt).getTime();

  function checkDeadline() {
    const maxMs = budget.maxCampaignDurationMinutes * 60000;
    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs > maxMs) {
      throw new Error(
        `Budget exhausted: campaign duration (${formatMinutes(elapsedMs)}m/${budget.maxCampaignDurationMinutes}m)`
      );
    }
  }

  function makeGuard(kind, usageKey, maxKey) {
    return async function guard() {
      checkDeadline();
      const max = budget[maxKey];
      const used = usage[usageKey];
      if (used + 1 > max) {
        throw new Error(`Budget exhausted: ${kind} calls (${used}/${max})`);
      }
      usage[usageKey] = used + 1;
    };
  }

  const guards = {
    beforeManagerCall: makeGuard("manager", "managerCalls", "maxManagerCalls"),
    beforeWorkerCall: makeGuard("worker", "workerCalls", "maxWorkerCalls"),
    beforeExecutiveCall: makeGuard("executive", "executiveCalls", "maxExecutiveCalls")
  };

  function recordRework() {
    usage.reworks += 1;
  }

  /**
   * @param {string} provider
   * @param {{ inputTokens?: number|null, outputTokens?: number|null }} [tokenUsage]
   * @returns {number} the updated running total for that provider (an ESTIMATE)
   */
  function estimateCost(provider, tokenUsage = {}) {
    const pricing = PROVIDER_PRICING[provider] ?? { input: 0, output: 0 };
    const inputTokens = tokenUsage?.inputTokens ?? 0;
    const outputTokens = tokenUsage?.outputTokens ?? 0;
    const cost = (inputTokens / 1000) * pricing.input + (outputTokens / 1000) * pricing.output;
    const previous = usage.estimatedCostByProvider[provider] ?? 0;
    usage.estimatedCostByProvider[provider] = previous + cost;
    return usage.estimatedCostByProvider[provider];
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(usage));
  }

  return { guards, checkDeadline, recordRework, estimateCost, snapshot };
}

/**
 * Delta between two usage snapshots (see `snapshot()` above), used to
 * attribute per-task spend: `runCampaignTask` snapshots usage before and
 * after a task's loop and stores the diff in `usage.taskStats[taskId]` so a
 * campaign can answer "what did each APPROVED task actually cost, per tier"
 * — the number that tells you whether delegating to a cheap worker is
 * saving money or burning it twice.
 *
 * @param {object} before a usage snapshot
 * @param {object} after a later usage snapshot
 * @returns {{ workerCalls: number, managerCalls: number, executiveCalls: number, reworks: number, estimatedCostByProvider: object }}
 */
export function diffUsage(before, after) {
  const estimatedCostByProvider = {};
  const providers = new Set([
    ...Object.keys(before?.estimatedCostByProvider ?? {}),
    ...Object.keys(after?.estimatedCostByProvider ?? {})
  ]);
  for (const provider of providers) {
    const delta = (after?.estimatedCostByProvider?.[provider] ?? 0) - (before?.estimatedCostByProvider?.[provider] ?? 0);
    if (delta !== 0) {
      estimatedCostByProvider[provider] = delta;
    }
  }

  return {
    workerCalls: (after?.workerCalls ?? 0) - (before?.workerCalls ?? 0),
    managerCalls: (after?.managerCalls ?? 0) - (before?.managerCalls ?? 0),
    executiveCalls: (after?.executiveCalls ?? 0) - (before?.executiveCalls ?? 0),
    reworks: (after?.reworks ?? 0) - (before?.reworks ?? 0),
    estimatedCostByProvider
  };
}

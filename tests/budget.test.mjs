import test from "node:test";
import assert from "node:assert/strict";

import { createBudget, PROVIDER_PRICING } from "../plugins/codex/scripts/orchestration/budget.mjs";

function makeCampaign(overrides = {}) {
  return {
    campaignId: "camp-1",
    budget: {
      maxExecutiveCalls: 2,
      maxManagerCalls: 2,
      maxWorkerCalls: 2,
      maxAttemptsPerTask: 3,
      maxCampaignDurationMinutes: 180,
      ...overrides.budget
    },
    usage: {
      executiveCalls: 0,
      managerCalls: 0,
      workerCalls: 0,
      reworks: 0,
      estimatedCostByProvider: {},
      ...overrides.usage
    },
    startedAt: overrides.startedAt ?? new Date().toISOString()
  };
}

// --- guards: increment then throw at the cap -----------------------------

test("beforeWorkerCall increments usage.workerCalls until the cap, then throws without over-incrementing", async () => {
  const campaign = makeCampaign({ budget: { maxWorkerCalls: 2 } });
  const budget = createBudget(campaign);

  await budget.guards.beforeWorkerCall();
  assert.equal(campaign.usage.workerCalls, 1);
  await budget.guards.beforeWorkerCall();
  assert.equal(campaign.usage.workerCalls, 2);

  await assert.rejects(() => budget.guards.beforeWorkerCall(), /Budget exhausted: worker calls \(2\/2\)/);
  assert.equal(campaign.usage.workerCalls, 2);
});

test("beforeManagerCall increments usage.managerCalls until the cap, then throws", async () => {
  const campaign = makeCampaign({ budget: { maxManagerCalls: 1 } });
  const budget = createBudget(campaign);

  await budget.guards.beforeManagerCall();
  assert.equal(campaign.usage.managerCalls, 1);
  await assert.rejects(() => budget.guards.beforeManagerCall(), /Budget exhausted: manager calls \(1\/1\)/);
  assert.equal(campaign.usage.managerCalls, 1);
});

test("beforeExecutiveCall increments usage.executiveCalls until the cap, then throws", async () => {
  const campaign = makeCampaign({ budget: { maxExecutiveCalls: 1 } });
  const budget = createBudget(campaign);

  await budget.guards.beforeExecutiveCall();
  assert.equal(campaign.usage.executiveCalls, 1);
  await assert.rejects(() => budget.guards.beforeExecutiveCall(), /Budget exhausted: executive calls \(1\/1\)/);
  assert.equal(campaign.usage.executiveCalls, 1);
});

test("a cap of 0 throws on the very first call without incrementing usage", async () => {
  const campaign = makeCampaign({ budget: { maxWorkerCalls: 0 } });
  const budget = createBudget(campaign);

  await assert.rejects(() => budget.guards.beforeWorkerCall(), /Budget exhausted: worker calls \(0\/0\)/);
  assert.equal(campaign.usage.workerCalls, 0);
});

// --- deadline --------------------------------------------------------------

test("checkDeadline throws once elapsed time exceeds maxCampaignDurationMinutes", () => {
  const campaign = makeCampaign({
    budget: { maxCampaignDurationMinutes: 10 },
    startedAt: new Date(Date.now() - 11 * 60000).toISOString()
  });
  const budget = createBudget(campaign);

  assert.throws(() => budget.checkDeadline(), /Budget exhausted: campaign duration \(\d+m\/10m\)/);
});

test("checkDeadline does not throw when within the deadline", () => {
  const campaign = makeCampaign({ budget: { maxCampaignDurationMinutes: 180 } });
  const budget = createBudget(campaign);

  assert.doesNotThrow(() => budget.checkDeadline());
});

test("every guard calls checkDeadline internally, throwing on an expired deadline even under the call cap", async () => {
  const campaign = makeCampaign({
    budget: { maxWorkerCalls: 10, maxManagerCalls: 10, maxExecutiveCalls: 10, maxCampaignDurationMinutes: 1 },
    startedAt: new Date(Date.now() - 5 * 60000).toISOString()
  });
  const budget = createBudget(campaign);

  await assert.rejects(() => budget.guards.beforeWorkerCall(), /Budget exhausted: campaign duration/);
  await assert.rejects(() => budget.guards.beforeManagerCall(), /Budget exhausted: campaign duration/);
  await assert.rejects(() => budget.guards.beforeExecutiveCall(), /Budget exhausted: campaign duration/);
  assert.equal(campaign.usage.workerCalls, 0);
  assert.equal(campaign.usage.managerCalls, 0);
  assert.equal(campaign.usage.executiveCalls, 0);
});

// --- recordRework ------------------------------------------------------

test("recordRework increments usage.reworks", () => {
  const campaign = makeCampaign();
  const budget = createBudget(campaign);

  budget.recordRework();
  budget.recordRework();

  assert.equal(campaign.usage.reworks, 2);
});

// --- estimateCost --------------------------------------------------------

test("estimateCost adds cost for a known provider based on input/output tokens", () => {
  const campaign = makeCampaign();
  const budget = createBudget(campaign);

  budget.estimateCost("deepseek", { inputTokens: 1000, outputTokens: 1000 });

  const expected = PROVIDER_PRICING.deepseek.input + PROVIDER_PRICING.deepseek.output;
  assert.equal(campaign.usage.estimatedCostByProvider.deepseek, expected);
});

test("estimateCost treats an unknown provider as zero cost but still records the key", () => {
  const campaign = makeCampaign();
  const budget = createBudget(campaign);

  budget.estimateCost("mystery-provider", { inputTokens: 1000, outputTokens: 1000 });

  assert.equal(campaign.usage.estimatedCostByProvider["mystery-provider"], 0);
});

test("estimateCost treats null tokens as contributing 0", () => {
  const campaign = makeCampaign();
  const budget = createBudget(campaign);

  budget.estimateCost("deepseek", { inputTokens: null, outputTokens: null });

  assert.equal(campaign.usage.estimatedCostByProvider.deepseek, 0);
});

test("estimateCost accumulates across multiple calls for the same provider", () => {
  const campaign = makeCampaign();
  const budget = createBudget(campaign);

  budget.estimateCost("deepseek", { inputTokens: 1000, outputTokens: 0 });
  budget.estimateCost("deepseek", { inputTokens: 1000, outputTokens: 0 });

  assert.equal(campaign.usage.estimatedCostByProvider.deepseek, PROVIDER_PRICING.deepseek.input * 2);
});

// --- snapshot --------------------------------------------------------------

test("snapshot returns a plain copy of usage, not a live reference", () => {
  const campaign = makeCampaign();
  const budget = createBudget(campaign);

  const snap = budget.snapshot();
  budget.recordRework();

  assert.equal(snap.reworks, 0);
  assert.equal(campaign.usage.reworks, 1);
  assert.notEqual(snap, campaign.usage);
});

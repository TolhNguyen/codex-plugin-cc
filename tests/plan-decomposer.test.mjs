import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  buildPlanDecompositionPrompt,
  createCodexPlanDecomposer,
  runPlanDecomposition
} from "../plugins/codex/scripts/orchestration/plan-decomposer.mjs";
import { readAuditEvents } from "../plugins/codex/scripts/orchestration/audit-log.mjs";
import { makeTempDir } from "./helpers.mjs";

function withTempDir(fn) {
  const rootDir = makeTempDir("plan-decomposer-test-");
  return Promise.resolve(fn(rootDir)).finally(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
}

function makeCampaign(overrides = {}) {
  return {
    campaignId: "camp-1",
    brief: "Do the thing.",
    status: "running",
    budget: { maxAttemptsPerTask: 3 },
    ...overrides
  };
}

function workerTask(overrides = {}) {
  return {
    title: "Unit tests for lib/foo.mjs",
    goal: "Create tests/foo.test.mjs covering bar and baz exported from lib/foo.mjs.",
    affectedPaths: ["tests/foo.test.mjs"],
    contextFiles: ["lib/foo.mjs"],
    verificationCommands: ["node --test tests/foo.test.mjs"],
    acceptanceCriteria: ["tests pass"],
    requiredSkills: [],
    tier: "worker",
    tierRationale: "single-file mechanical test authoring",
    ...overrides
  };
}

function makeDecomposeFn(tasks) {
  return async () => ({ tasks });
}

function draftPath(rootDir, campaignId, taskId) {
  return path.join(rootDir, ".ai-company", "campaigns", campaignId, "drafts", `${taskId}.json`);
}

// --- buildPlanDecompositionPrompt -----------------------------------------

test("buildPlanDecompositionPrompt: interpolates plan text, campaign, and skill catalog", () => {
  const pluginRoot = path.resolve("plugins/codex");
  const prompt = buildPlanDecompositionPrompt(pluginRoot, {
    planText: "## Task 1\nWrite tests for the widget.",
    projectProfile: { languages: ["js"] },
    campaign: makeCampaign(),
    skillCatalog: [{ ref: "technical/node-test-authoring@0.1.0", purpose: "write node:test tests" }]
  });

  assert.match(prompt, /Write tests for the widget/);
  assert.match(prompt, /technical\/node-test-authoring@0\.1\.0/);
  assert.match(prompt, /available_skills/);
});

// --- createCodexPlanDecomposer --------------------------------------------

test("createCodexPlanDecomposer: returns the validated decomposition on the first try", async () => {
  const prompts = [];
  const runtime = {
    execute: async (_agent, _task, { prompt }) => {
      prompts.push(prompt);
      return { status: "completed", output: JSON.stringify({ tasks: [workerTask()] }) };
    }
  };
  const decomposeFn = createCodexPlanDecomposer({
    rootDir: ".",
    runtime,
    managerAgent: { id: "manager-codex" },
    pluginRoot: path.resolve("plugins/codex")
  });

  const result = await decomposeFn("## Task 1\nWrite tests.", {
    projectProfile: null,
    campaign: makeCampaign(),
    skillCatalog: []
  });
  assert.equal(result.tasks.length, 1);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Write tests/);
});

test("createCodexPlanDecomposer: one schema-repair retry, then throws", async () => {
  let calls = 0;
  const runtime = {
    execute: async () => {
      calls += 1;
      return { status: "completed", output: JSON.stringify({ nonsense: true }) };
    }
  };
  const decomposeFn = createCodexPlanDecomposer({
    rootDir: ".",
    runtime,
    managerAgent: { id: "manager-codex" },
    pluginRoot: path.resolve("plugins/codex")
  });

  await assert.rejects(
    () => decomposeFn("plan", { campaign: makeCampaign(), skillCatalog: [] }),
    /invalid after one retry/
  );
  assert.equal(calls, 2);
});

test("createCodexPlanDecomposer: invalid first output then valid second output succeeds", async () => {
  let calls = 0;
  const runtime = {
    execute: async () => {
      calls += 1;
      if (calls === 1) {
        return { status: "completed", output: "not json" };
      }
      return { status: "completed", output: JSON.stringify({ tasks: [workerTask()] }) };
    }
  };
  const decomposeFn = createCodexPlanDecomposer({
    rootDir: ".",
    runtime,
    managerAgent: { id: "manager-codex" },
    pluginRoot: path.resolve("plugins/codex")
  });

  const result = await decomposeFn("plan", { campaign: makeCampaign(), skillCatalog: [] });
  assert.equal(result.tasks.length, 1);
  assert.equal(calls, 2);
});

// --- runPlanDecomposition: classification ---------------------------------

test("runPlanDecomposition: worker-tier, lint-passing, routable task becomes run-ready with a draft file", async () => {
  await withTempDir(async (rootDir) => {
    const result = await runPlanDecomposition(rootDir, {
      campaign: makeCampaign(),
      planText: "plan",
      decomposeFn: makeDecomposeFn([workerTask()])
    });

    assert.equal(result.runReady.length, 1);
    const entry = result.tasks[0];
    assert.equal(entry.bucket, "run-ready");
    assert.ok(entry.file);
    assert.ok(fs.existsSync(draftPath(rootDir, "camp-1", entry.taskId)));

    const persisted = JSON.parse(fs.readFileSync(draftPath(rootDir, "camp-1", entry.taskId), "utf8"));
    assert.equal(persisted.campaignId, "camp-1");
    assert.equal(persisted.status, "pending");
    assert.equal(persisted.owner, "");
    assert.equal(persisted.maxAttempts, 3);
  });
});

test("runPlanDecomposition: worker-tier task that fails lint is written but not run-ready", async () => {
  await withTempDir(async (rootDir) => {
    const tooManyPaths = workerTask({
      title: "Massive task",
      affectedPaths: ["a", "b", "c", "d", "e", "f", "g"]
    });
    const result = await runPlanDecomposition(rootDir, {
      campaign: makeCampaign(),
      planText: "plan",
      decomposeFn: makeDecomposeFn([tooManyPaths])
    });

    assert.equal(result.runReady.length, 0);
    const entry = result.tasks[0];
    assert.equal(entry.bucket, "needs-attention");
    assert.ok(fs.existsSync(draftPath(rootDir, "camp-1", entry.taskId)));
    assert.ok(entry.lint.errorCodes.includes("TOO_MANY_PATHS"));
  });
});

test("runPlanDecomposition: manager-tier task goes to the manifest only, no draft file", async () => {
  await withTempDir(async (rootDir) => {
    const managerJob = workerTask({ title: "Design the auth flow", tier: "manager", tierRationale: "cross-cutting" });
    const result = await runPlanDecomposition(rootDir, {
      campaign: makeCampaign(),
      planText: "plan",
      decomposeFn: makeDecomposeFn([managerJob])
    });

    assert.equal(result.runReady.length, 0);
    const entry = result.tasks[0];
    assert.equal(entry.bucket, "expensive-tier");
    assert.equal(entry.file, null);
    assert.equal(fs.existsSync(draftPath(rootDir, "camp-1", entry.taskId)), false);
  });
});

test("runPlanDecomposition: worker-tier task requiring a non-routable skill is demoted out of run-ready", async () => {
  await withTempDir(async (rootDir) => {
    const needsSkill = workerTask({ requiredSkills: ["technical/ghost-skill@1.0.0"] });
    const result = await runPlanDecomposition(rootDir, {
      campaign: makeCampaign(),
      planText: "plan",
      skillCatalog: [{ ref: "technical/node-test-authoring@0.1.0", purpose: "tests" }],
      decomposeFn: makeDecomposeFn([needsSkill])
    });

    assert.equal(result.runReady.length, 0);
    const entry = result.tasks[0];
    assert.equal(entry.bucket, "needs-attention");
    assert.deepEqual(entry.skillGap, ["technical/ghost-skill@1.0.0"]);
  });
});

test("runPlanDecomposition: worker-tier task requiring a routable skill stays run-ready", async () => {
  await withTempDir(async (rootDir) => {
    const needsSkill = workerTask({ requiredSkills: ["technical/node-test-authoring@0.1.0"] });
    const result = await runPlanDecomposition(rootDir, {
      campaign: makeCampaign(),
      planText: "plan",
      skillCatalog: [{ ref: "technical/node-test-authoring@0.1.0", purpose: "tests" }],
      decomposeFn: makeDecomposeFn([needsSkill])
    });

    assert.equal(result.runReady.length, 1);
    assert.equal(result.tasks[0].bucket, "run-ready");
  });
});

test("runPlanDecomposition: duplicate titles produce unique task ids", async () => {
  await withTempDir(async (rootDir) => {
    const result = await runPlanDecomposition(rootDir, {
      campaign: makeCampaign(),
      planText: "plan",
      decomposeFn: makeDecomposeFn([workerTask({ title: "Same title" }), workerTask({ title: "Same title" })])
    });

    const ids = result.tasks.map((t) => t.taskId);
    assert.equal(new Set(ids).size, 2);
  });
});

test("runPlanDecomposition: zero worker tasks writes a manifest and no draft files", async () => {
  await withTempDir(async (rootDir) => {
    const result = await runPlanDecomposition(rootDir, {
      campaign: makeCampaign(),
      planText: "plan",
      decomposeFn: makeDecomposeFn([
        workerTask({ title: "A", tier: "manager", tierRationale: "x" }),
        workerTask({ title: "B", tier: "executive", tierRationale: "y" })
      ])
    });

    assert.equal(result.runReady.length, 0);
    assert.equal(result.manifest.summary.total, 2);
    assert.equal(result.manifest.summary.runReady, 0);
    assert.ok(fs.existsSync(result.manifestPath));
    const draftsDir = path.join(rootDir, ".ai-company", "campaigns", "camp-1", "drafts");
    const files = fs.readdirSync(draftsDir).filter((n) => n !== "manifest.json");
    assert.equal(files.length, 0);
  });
});

test("runPlanDecomposition: writes a manifest with per-task tier/lint/path and audits the decomposition", async () => {
  await withTempDir(async (rootDir) => {
    const result = await runPlanDecomposition(rootDir, {
      campaign: makeCampaign(),
      planText: "plan",
      decomposeFn: makeDecomposeFn([workerTask(), workerTask({ title: "Second", tier: "manager", tierRationale: "z" })])
    });

    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
    assert.equal(manifest.campaignId, "camp-1");
    assert.equal(manifest.tasks.length, 2);
    assert.equal(manifest.summary.total, 2);
    assert.equal(manifest.summary.runReady, 1);
    assert.equal(manifest.summary.expensiveTier, 1);
    assert.ok(manifest.tasks.every((t) => typeof t.tier === "string" && "lint" in t));

    const events = readAuditEvents(rootDir, "camp-1");
    const decomposed = events.find((event) => event.event === "plan_decomposed");
    assert.ok(decomposed);
    assert.equal(decomposed.total, 2);
    assert.equal(decomposed.runReady, 1);
  });
});

// --- runPlanDecomposition: failure modes ----------------------------------

test("runPlanDecomposition: a denying budget guard throws and writes nothing", async () => {
  await withTempDir(async (rootDir) => {
    await assert.rejects(
      () =>
        runPlanDecomposition(rootDir, {
          campaign: makeCampaign(),
          planText: "plan",
          decomposeFn: makeDecomposeFn([workerTask()]),
          guards: {
            beforeManagerCall: async () => {
              throw new Error("Budget exhausted: manager calls (10/10)");
            }
          }
        }),
      /Budget exhausted/
    );

    const draftsDir = path.join(rootDir, ".ai-company", "campaigns", "camp-1", "drafts");
    assert.equal(fs.existsSync(draftsDir), false);
  });
});

test("runPlanDecomposition: a failing decomposeFn propagates and writes nothing", async () => {
  await withTempDir(async (rootDir) => {
    await assert.rejects(
      () =>
        runPlanDecomposition(rootDir, {
          campaign: makeCampaign(),
          planText: "plan",
          decomposeFn: async () => {
            throw new Error("codex unavailable");
          }
        }),
      /codex unavailable/
    );

    const draftsDir = path.join(rootDir, ".ai-company", "campaigns", "camp-1", "drafts");
    assert.equal(fs.existsSync(draftsDir), false);
  });
});

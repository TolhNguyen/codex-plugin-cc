import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  saveSkill,
  loadSkill,
  loadSkillByRef,
  listSkills,
  setSkillStatus,
  assertSkillsActive,
  recordEvaluation
} from "../plugins/codex/scripts/skills/skill-registry.mjs";
import { saveAgent } from "../plugins/codex/scripts/agents/agent-registry.mjs";
import { routeTask } from "../plugins/codex/scripts/orchestration/task-router.mjs";
import { run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "plugins", "codex", "scripts", "orchestration-cli.mjs");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
}

function withTempDir(fn) {
  const rootDir = makeTempDir();
  try {
    fn(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function makeSkill(overrides = {}) {
  return {
    id: "technical/node-test-authoring",
    version: "1.0.0",
    status: "draft",
    purpose: "Author node:test suites",
    useWhen: ["writing new tests"],
    dontUseWhen: ["writing production code"],
    requiredInputs: ["target module path"],
    procedure: ["write a fixture", "write a test", "run node --test"],
    verificationSteps: ["npm test passes"],
    doneWhen: ["tests are green"],
    escalateWhen: ["tests reveal a design gap"],
    outputContract: "a *.test.mjs file",
    sources: ["tests/state.test.mjs"],
    owner: "manager",
    ...overrides
  };
}

test("saveSkill + loadSkill round-trip by id", () => {
  withTempDir((rootDir) => {
    const skill = makeSkill();
    const filePath = saveSkill(rootDir, skill);

    assert.equal(
      filePath,
      path.join(rootDir, ".ai-company", "skills", "technical", "node-test-authoring.json")
    );
    assert.ok(fs.readFileSync(filePath, "utf8").endsWith("\n"));

    const loaded = loadSkill(rootDir, "technical/node-test-authoring");
    assert.deepEqual(loaded, skill);
  });
});

test("loadSkill returns null for a missing skill", () => {
  withTempDir((rootDir) => {
    assert.equal(loadSkill(rootDir, "technical/does-not-exist"), null);
  });
});

test("loadSkillByRef returns the skill only when id and version both match", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill());

    const matched = loadSkillByRef(rootDir, "technical/node-test-authoring@1.0.0");
    assert.equal(matched.id, "technical/node-test-authoring");

    assert.equal(loadSkillByRef(rootDir, "technical/node-test-authoring@2.0.0"), null);
    assert.equal(loadSkillByRef(rootDir, "technical/does-not-exist@1.0.0"), null);
  });
});

test("listSkills lists across tiers sorted by id, with optional status filter", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill({ id: "technical/zeta-skill", status: "active" }));
    saveSkill(rootDir, makeSkill({ id: "core/alpha-skill", status: "draft" }));
    saveSkill(rootDir, makeSkill({ id: "project/mid-skill", status: "active" }));

    const all = listSkills(rootDir);
    assert.deepEqual(all.map((s) => s.id), [
      "core/alpha-skill",
      "project/mid-skill",
      "technical/zeta-skill"
    ]);

    const active = listSkills(rootDir, { status: "active" });
    assert.deepEqual(active.map((s) => s.id), ["project/mid-skill", "technical/zeta-skill"]);
  });
});

test("listSkills returns [] when the skills dir is missing", () => {
  withTempDir((rootDir) => {
    assert.deepEqual(listSkills(rootDir), []);
  });
});

test("setSkillStatus walks the legal lifecycle single-step at a time", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill({ status: "draft" }));

    setSkillStatus(rootDir, "technical/node-test-authoring", "evaluating");
    assert.equal(loadSkill(rootDir, "technical/node-test-authoring").status, "evaluating");

    setSkillStatus(rootDir, "technical/node-test-authoring", "approved", { approvedBy: "manager-01" });
    let loaded = loadSkill(rootDir, "technical/node-test-authoring");
    assert.equal(loaded.status, "approved");
    assert.equal(loaded.approvedBy, "manager-01");

    setSkillStatus(rootDir, "technical/node-test-authoring", "active", { approvedBy: "manager-01" });
    loaded = loadSkill(rootDir, "technical/node-test-authoring");
    assert.equal(loaded.status, "active");

    setSkillStatus(rootDir, "technical/node-test-authoring", "deprecated");
    loaded = loadSkill(rootDir, "technical/node-test-authoring");
    assert.equal(loaded.status, "deprecated");
  });
});

test("setSkillStatus requires approvedBy for evaluating -> approved", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill({ status: "evaluating" }));

    assert.throws(
      () => setSkillStatus(rootDir, "technical/node-test-authoring", "approved"),
      /approvedBy/i
    );
  });
});

test("setSkillStatus requires approvedBy for approved -> active", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill({ status: "approved", approvedBy: "manager-01" }));

    assert.throws(
      () => setSkillStatus(rootDir, "technical/node-test-authoring", "active"),
      /approvedBy/i
    );
  });
});

test("setSkillStatus throws on illegal transition: skipping a step", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill({ status: "draft" }));

    assert.throws(
      () => setSkillStatus(rootDir, "technical/node-test-authoring", "approved", { approvedBy: "x" }),
      /Illegal skill status transition: draft -> approved/
    );
  });
});

test("setSkillStatus throws on illegal transition: backward move", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill({ status: "active" }));

    assert.throws(
      () => setSkillStatus(rootDir, "technical/node-test-authoring", "draft"),
      /Illegal skill status transition: active -> draft/
    );
  });
});

test("assertSkillsActive returns loaded skills when all refs are active", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill({ status: "active" }));
    saveSkill(rootDir, makeSkill({ id: "core/scope-control", status: "active" }));

    const result = assertSkillsActive(rootDir, [
      "technical/node-test-authoring@1.0.0",
      "core/scope-control@1.0.0"
    ]);

    assert.equal(result.length, 2);
    assert.deepEqual(result.map((s) => s.id).sort(), ["core/scope-control", "technical/node-test-authoring"]);
  });
});

test("assertSkillsActive throws naming every missing or non-active ref in a mix", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill({ status: "active" }));
    saveSkill(rootDir, makeSkill({ id: "core/scope-control", status: "draft" }));

    assert.throws(
      () =>
        assertSkillsActive(rootDir, [
          "technical/node-test-authoring@1.0.0",
          "core/scope-control@1.0.0",
          "project/does-not-exist@1.0.0"
        ]),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /core\/scope-control@1\.0\.0/);
        assert.match(err.message, /project\/does-not-exist@1\.0\.0/);
        assert.doesNotMatch(err.message, /technical\/node-test-authoring@1\.0\.0/);
        return true;
      }
    );
  });
});

// --- CLI: `skill activate` (Must-fix 2) ------------------------------------
//
// Before this fix, no CLI path could ever move a skill from "draft" to
// "active" — `setSkillStatus` was exported and unit-tested but never called
// from any command, so `approveTopology`'s draft skills (and thus every
// skill-requiring task) permanently dead-ended at `assertSkillsActive`.

function makeRoutableAgent(overrides = {}) {
  return {
    id: "worker-a",
    name: "Worker A",
    type: "persistent",
    status: "active",
    ownership: { primary: ["src/**"], secondary: [], excluded: [] },
    responsibilities: ["do work"],
    skills: ["technical/node-test-authoring@1.0.0"],
    memory: { namespaces: ["agent/worker-a"] },
    permissions: { read: ["**"], write: ["src/**"] },
    runtime: { provider: "deepseek", model: "deepseek-chat" },
    limits: { maxAttemptsPerTask: 3, maxExecutionMinutes: 20, maxToolCalls: 40 },
    ...overrides
  };
}

function makeRoutableTask(overrides = {}) {
  return {
    taskId: "task-1",
    campaignId: "camp-1",
    title: "Add a test",
    goal: "Extend coverage for the alpha module.",
    affectedPaths: ["src/file.js"],
    requiredSkills: ["technical/node-test-authoring@1.0.0"],
    owner: "worker-a",
    verificationCommands: ["npm test"],
    acceptanceCriteria: ["it works"],
    maxAttempts: 3,
    status: "routed",
    ...overrides
  };
}

test("orchestration-cli skill activate walks a draft skill to active, persists the approver, and unblocks routing — Must-fix 2", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill({ status: "draft" }));
    saveAgent(rootDir, makeRoutableAgent());

    const result = run(
      "node",
      [
        CLI,
        "skill",
        "activate",
        "technical/node-test-authoring",
        "--approved-by",
        "tech-lead",
        "--cwd",
        rootDir,
        "--json"
      ],
      { cwd: ROOT }
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "active");
    assert.equal(payload.approvedBy, "tech-lead");
    assert.equal(payload.alreadyActive, false);

    const activated = loadSkill(rootDir, "technical/node-test-authoring");
    assert.equal(activated.status, "active");
    assert.equal(activated.approvedBy, "tech-lead");

    // assertSkillsActive now passes...
    assertSkillsActive(rootDir, ["technical/node-test-authoring@1.0.0"]);

    // ...and routeTask, which hard-gates on assertSkillsActive, succeeds too.
    const routing = routeTask(rootDir, makeRoutableTask());
    assert.equal(routing.owner.id, "worker-a");
  });
});

test("orchestration-cli skill activate without --approved-by exits 1, mentions approved-by, and leaves the skill in draft — Must-fix 2", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill({ status: "draft" }));

    const result = run(
      "node",
      [CLI, "skill", "activate", "technical/node-test-authoring", "--cwd", rootDir],
      { cwd: ROOT }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /approved-by/i);
    assert.equal(loadSkill(rootDir, "technical/node-test-authoring").status, "draft");
  });
});

test("orchestration-cli skill activate is idempotent when the skill is already active", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill({ status: "active" }));

    const result = run(
      "node",
      [
        CLI,
        "skill",
        "activate",
        "technical/node-test-authoring",
        "--approved-by",
        "tech-lead",
        "--cwd",
        rootDir,
        "--json"
      ],
      { cwd: ROOT }
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.alreadyActive, true);
    assert.equal(payload.status, "active");
  });
});

test("orchestration-cli skill list reports status and version", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill({ status: "draft" }));

    const result = run("node", [CLI, "skill", "list", "--cwd", rootDir, "--json"], { cwd: ROOT });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.skills.length, 1);
    assert.equal(payload.skills[0].id, "technical/node-test-authoring");
    assert.equal(payload.skills[0].status, "draft");
  });
});

test("recordEvaluation appends to the skill's evaluations array", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkill());

    recordEvaluation(rootDir, "technical/node-test-authoring", {
      taskId: "task-1",
      outcome: "pass",
      at: "2026-07-13T00:00:00.000Z"
    });
    recordEvaluation(rootDir, "technical/node-test-authoring", {
      taskId: "task-2",
      outcome: "fail",
      at: "2026-07-13T01:00:00.000Z"
    });

    const loaded = loadSkill(rootDir, "technical/node-test-authoring");
    assert.equal(loaded.evaluations.length, 2);
    assert.equal(loaded.evaluations[0].taskId, "task-1");
    assert.equal(loaded.evaluations[1].outcome, "fail");
  });
});

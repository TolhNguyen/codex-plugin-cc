import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { routeTask } from "../plugins/codex/scripts/orchestration/task-router.mjs";
import { saveAgent } from "../plugins/codex/scripts/agents/agent-registry.mjs";
import { saveSkill, setSkillStatus } from "../plugins/codex/scripts/skills/skill-registry.mjs";
import { makeTempDir } from "./helpers.mjs";

function withTempDir(fn) {
  const rootDir = makeTempDir("task-router-test-");
  try {
    return fn(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function makeAgent(overrides = {}) {
  return {
    id: "worker-a",
    name: "Worker A",
    type: "persistent",
    status: "active",
    ownership: { primary: [], secondary: [], excluded: [] },
    responsibilities: ["do work"],
    skills: ["technical/shared-skill@1.0.0"],
    memory: { namespaces: ["agent/worker-a"] },
    permissions: { read: ["**"], write: [] },
    runtime: { provider: "openai-compatible", model: "deepseek-chat" },
    limits: { maxAttemptsPerTask: 3, maxExecutionMinutes: 20, maxToolCalls: 40 },
    ...overrides
  };
}

function makeTask(overrides = {}) {
  return {
    taskId: "task-1",
    campaignId: "camp-1",
    title: "Do the thing",
    goal: "Get it done",
    affectedPaths: ["src/alpha/file.js"],
    requiredSkills: ["technical/shared-skill@1.0.0"],
    owner: "",
    verificationCommands: [],
    acceptanceCriteria: ["it works"],
    maxAttempts: 3,
    status: "pending",
    ...overrides
  };
}

function makeSkillDoc(overrides = {}) {
  return {
    id: "technical/shared-skill",
    version: "1.0.0",
    status: "draft",
    purpose: "shared skill",
    useWhen: [],
    dontUseWhen: [],
    requiredInputs: [],
    procedure: ["step"],
    verificationSteps: [],
    doneWhen: [],
    escalateWhen: [],
    outputContract: "task-result",
    sources: [],
    owner: "manager",
    ...overrides
  };
}

function activateSkill(rootDir, id = "technical/shared-skill") {
  saveSkill(rootDir, makeSkillDoc({ id }));
  setSkillStatus(rootDir, id, "evaluating");
  setSkillStatus(rootDir, id, "approved", { approvedBy: "manager" });
  setSkillStatus(rootDir, id, "active", { approvedBy: "manager" });
}

// 1. Schema validation.
test("routeTask: throws with schema errors for an invalid task doc", () => {
  withTempDir((rootDir) => {
    activateSkill(rootDir);
    saveAgent(rootDir, makeAgent());
    const task = makeTask();
    delete task.goal;

    assert.throws(
      () => routeTask(rootDir, task),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /goal/);
        return true;
      }
    );
  });
});

// 2. Status filter: only active agents are candidates.
test("routeTask: ignores agents that are not status active", () => {
  withTempDir((rootDir) => {
    activateSkill(rootDir);
    saveAgent(
      rootDir,
      makeAgent({ id: "worker-proposed", status: "proposed", ownership: { primary: ["src/alpha/**"], secondary: [], excluded: [] } })
    );
    saveAgent(rootDir, makeAgent({ id: "worker-active", status: "active" }));

    const result = routeTask(rootDir, makeTask());

    assert.equal(result.owner.id, "worker-active");
  });
});

// 3. Skill filter excludes agents lacking a required skill.
test("routeTask: skill filter excludes an agent lacking the required skill even with better ownership", () => {
  withTempDir((rootDir) => {
    activateSkill(rootDir);
    saveAgent(
      rootDir,
      makeAgent({ id: "worker-no-skill", skills: [], ownership: { primary: ["src/alpha/**"], secondary: [], excluded: [] } })
    );
    saveAgent(
      rootDir,
      makeAgent({ id: "worker-has-skill", ownership: { primary: [], secondary: [], excluded: [] } })
    );

    const result = routeTask(rootDir, makeTask());

    assert.equal(result.owner.id, "worker-has-skill");
  });
});

test("routeTask: throws when no active agent has the required skills", () => {
  withTempDir((rootDir) => {
    activateSkill(rootDir);
    saveAgent(rootDir, makeAgent({ id: "worker-a", skills: [] }));

    assert.throws(
      () => routeTask(rootDir, makeTask()),
      /No active agent has the required skills: technical\/shared-skill@1\.0\.0/
    );
  });
});

// 4. Ownership scoring: primary beats secondary; tie -> id order.
test("routeTask: ownership scoring prefers a primary match over a secondary match", () => {
  withTempDir((rootDir) => {
    activateSkill(rootDir);
    saveAgent(rootDir, makeAgent({ id: "worker-primary", ownership: { primary: ["src/alpha/**"], secondary: [], excluded: [] } }));
    saveAgent(rootDir, makeAgent({ id: "worker-secondary", ownership: { primary: [], secondary: ["src/alpha/**"], excluded: [] } }));

    const result = routeTask(rootDir, makeTask({ affectedPaths: ["src/alpha/file.js"] }));

    assert.equal(result.owner.id, "worker-primary");
  });
});

test("routeTask: ties on ownership score break by lowest agent id", () => {
  withTempDir((rootDir) => {
    activateSkill(rootDir);
    saveAgent(rootDir, makeAgent({ id: "worker-zeta", ownership: { primary: ["src/shared/**"], secondary: [], excluded: [] } }));
    saveAgent(rootDir, makeAgent({ id: "worker-alpha", ownership: { primary: ["src/shared/**"], secondary: [], excluded: [] } }));

    const result = routeTask(rootDir, makeTask({ affectedPaths: ["src/shared/file.js"] }));

    assert.equal(result.owner.id, "worker-alpha");
  });
});

// 5. Preset owner honored / rejected.
test("routeTask: honors a preset owner regardless of ownership score", () => {
  withTempDir((rootDir) => {
    activateSkill(rootDir);
    saveAgent(rootDir, makeAgent({ id: "worker-best", ownership: { primary: ["src/alpha/**"], secondary: [], excluded: [] } }));
    saveAgent(rootDir, makeAgent({ id: "worker-preset" }));

    const result = routeTask(rootDir, makeTask({ affectedPaths: ["src/alpha/file.js"], owner: "worker-preset" }));

    assert.equal(result.owner.id, "worker-preset");
  });
});

test("routeTask: throws when the preset owner is not skill-eligible", () => {
  withTempDir((rootDir) => {
    activateSkill(rootDir);
    saveAgent(rootDir, makeAgent({ id: "worker-a" }));
    saveAgent(rootDir, makeAgent({ id: "worker-no-skill", skills: [] }));

    assert.throws(
      () => routeTask(rootDir, makeTask({ owner: "worker-no-skill" })),
      /Preset owner worker-no-skill is not eligible/
    );
  });
});

// 6. Support list.
test("routeTask: support lists remaining skill-eligible agents with ownership overlap, sorted by id", () => {
  withTempDir((rootDir) => {
    activateSkill(rootDir);
    saveAgent(rootDir, makeAgent({ id: "worker-owner", ownership: { primary: ["src/alpha/**"], secondary: [], excluded: [] } }));
    saveAgent(rootDir, makeAgent({ id: "worker-zeta-support", ownership: { primary: [], secondary: ["src/alpha/**"], excluded: [] } }));
    saveAgent(rootDir, makeAgent({ id: "worker-alpha-support", ownership: { primary: [], secondary: ["src/alpha/**"], excluded: [] } }));
    saveAgent(rootDir, makeAgent({ id: "worker-unrelated", ownership: { primary: ["src/other/**"], secondary: [], excluded: [] } }));

    const result = routeTask(rootDir, makeTask({ affectedPaths: ["src/alpha/file.js"] }));

    assert.equal(result.owner.id, "worker-owner");
    assert.deepEqual(result.support.map((a) => a.id), ["worker-alpha-support", "worker-zeta-support"]);
  });
});

// 7. writeGaps.
test("routeTask: reports writeGaps for affectedPaths outside the owner's write globs", () => {
  withTempDir((rootDir) => {
    activateSkill(rootDir);
    saveAgent(
      rootDir,
      makeAgent({
        id: "worker-a",
        ownership: { primary: ["src/**"], secondary: [], excluded: [] },
        permissions: { read: ["**"], write: ["src/alpha/**"] }
      })
    );

    const result = routeTask(rootDir, makeTask({ affectedPaths: ["src/alpha/file.js", "src/beta/file.js"] }));

    assert.equal(result.owner.id, "worker-a");
    assert.deepEqual(result.writeGaps, ["src/beta/file.js"]);
  });
});

test("routeTask: writeGaps is empty when the owner can write every affected path", () => {
  withTempDir((rootDir) => {
    activateSkill(rootDir);
    saveAgent(
      rootDir,
      makeAgent({
        id: "worker-a",
        ownership: { primary: ["src/**"], secondary: [], excluded: [] },
        permissions: { read: ["**"], write: ["src/**"] }
      })
    );

    const result = routeTask(rootDir, makeTask({ affectedPaths: ["src/alpha/file.js"] }));

    assert.deepEqual(result.writeGaps, []);
  });
});

// 8. Hard skill gate is the last check.
test("routeTask: throws from assertSkillsActive when a required skill exists but is not active", () => {
  withTempDir((rootDir) => {
    saveSkill(rootDir, makeSkillDoc({ id: "technical/draft-skill" }));
    saveAgent(rootDir, makeAgent({ id: "worker-a", skills: ["technical/draft-skill@1.0.0"] }));

    assert.throws(
      () => routeTask(rootDir, makeTask({ requiredSkills: ["technical/draft-skill@1.0.0"] })),
      /Skills not active: technical\/draft-skill@1\.0\.0 \(status: draft\)/
    );
  });
});

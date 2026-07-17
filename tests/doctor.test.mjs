import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runDoctor, renderDoctorReport } from "../plugins/codex/scripts/orchestration/doctor.mjs";
import { writeProjectProfile, analyzeRepository } from "../plugins/codex/scripts/orchestration/repository-analyzer.mjs";
import { writeTopologyProposal } from "../plugins/codex/scripts/orchestration/topology-planner.mjs";
import { saveAgent } from "../plugins/codex/scripts/agents/agent-registry.mjs";
import { saveSkill } from "../plugins/codex/scripts/skills/skill-registry.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import { installFakeCodex, buildEnv } from "./fake-codex-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "plugins", "codex", "scripts", "orchestration-cli.mjs");

const CODEX_OK = () => ({ available: true, detail: "codex-cli test; advanced runtime available" });
const CODEX_MISSING = () => ({ available: false, detail: "codex binary not found" });

async function withTempDir(fn) {
  const rootDir = makeTempDir("doctor-test-");
  try {
    await fn(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function makeProposal() {
  return {
    topologyType: "workflow-oriented",
    rationale: "One worker.",
    agents: [
      {
        id: "test-worker-01",
        name: "Test Worker",
        type: "persistent",
        responsibilities: ["tests"],
        ownership: { primary: ["tests/**"], secondary: [], excluded: [] },
        permissions: { read: ["**"], write: ["tests/**"] },
        skills: ["technical/node-test-authoring"],
        rationale: "Owns tests."
      }
    ],
    skillDrafts: [
      {
        id: "technical/node-test-authoring",
        purpose: "Author node:test suites.",
        sources: ["tests/state.test.mjs"]
      }
    ],
    overlaps: [],
    risks: []
  };
}

function makeActiveAgent(overrides = {}) {
  return {
    id: "test-worker-01",
    name: "Test Worker",
    type: "persistent",
    status: "active",
    ownership: { primary: ["tests/**"], secondary: [], excluded: [] },
    responsibilities: ["tests"],
    skills: ["technical/node-test-authoring@0.1.0"],
    memory: { namespaces: ["agent/test-worker-01"] },
    permissions: { read: ["**"], write: ["tests/**"] },
    runtime: { provider: "deepseek", model: "deepseek-chat" },
    limits: { maxAttemptsPerTask: 3, maxExecutionMinutes: 20, maxToolCalls: 40 },
    ...overrides
  };
}

function checkById(report, id) {
  const check = report.checks.find((entry) => entry.id === id);
  assert.ok(check, `expected check "${id}" in ${report.checks.map((c) => c.id).join(", ")}`);
  return check;
}

// 1. Empty repo: the ladder points at bootstrap first.
test("runDoctor: empty repo reports missing profile/topology and next step bootstrap", async () => {
  await withTempDir(async (rootDir) => {
    const report = runDoctor(rootDir, { env: {}, checkCodex: CODEX_OK });

    assert.equal(checkById(report, "codex-cli").status, "ok");
    assert.equal(checkById(report, "project-profile").status, "fail");
    assert.equal(checkById(report, "topology-proposal").status, "fail");
    assert.equal(checkById(report, "agents").status, "fail");
    assert.match(report.nextStep, /bootstrap/);
    // Every failing check must carry a concrete fix.
    for (const check of report.checks) {
      if (check.status !== "ok") {
        assert.ok(check.fix, `check "${check.id}" has no fix`);
      }
    }
  });
});

// 2. Codex missing beats everything: next step is installing Codex.
test("runDoctor: missing codex CLI is a fail whose fix names the install command", async () => {
  await withTempDir(async (rootDir) => {
    const report = runDoctor(rootDir, { env: {}, checkCodex: CODEX_MISSING });

    const codexCheck = checkById(report, "codex-cli");
    assert.equal(codexCheck.status, "fail");
    assert.match(codexCheck.fix, /npm install -g @openai\/codex/);
    assert.match(report.nextStep, /npm install -g @openai\/codex/);
  });
});

// 3. Profile present, no topology: next step is a full bootstrap.
test("runDoctor: profile without topology points at bootstrap (not profile-only)", async () => {
  await withTempDir(async (rootDir) => {
    writeProjectProfile(rootDir, analyzeRepository(rootDir));

    const report = runDoctor(rootDir, { env: {}, checkCodex: CODEX_OK });

    assert.equal(checkById(report, "project-profile").status, "ok");
    assert.equal(checkById(report, "topology-proposal").status, "fail");
    assert.match(report.nextStep, /bootstrap/);
    assert.doesNotMatch(report.nextStep, /--profile-only/);
  });
});

// 4. Topology present, nothing approved: next step is approve-topology.
test("runDoctor: topology without registered agents points at approve-topology", async () => {
  await withTempDir(async (rootDir) => {
    writeProjectProfile(rootDir, analyzeRepository(rootDir));
    writeTopologyProposal(rootDir, makeProposal());

    const report = runDoctor(rootDir, { env: {}, checkCodex: CODEX_OK });

    assert.equal(checkById(report, "topology-proposal").status, "ok");
    assert.equal(checkById(report, "agents").status, "fail");
    assert.match(report.nextStep, /approve-topology/);
  });
});

// 5. Active agent whose provider has no API key in env: warn naming the env var.
test("runDoctor: active agent with missing provider API key warns with the env var name", async () => {
  await withTempDir(async (rootDir) => {
    writeProjectProfile(rootDir, analyzeRepository(rootDir));
    writeTopologyProposal(rootDir, makeProposal());
    saveAgent(rootDir, makeActiveAgent());

    const report = runDoctor(rootDir, { env: {}, checkCodex: CODEX_OK });

    assert.equal(checkById(report, "agents").status, "ok");
    const providerCheck = checkById(report, "worker-providers");
    assert.equal(providerCheck.status, "warn");
    assert.match(providerCheck.detail, /DEEPSEEK_API_KEY/);
  });
});

// 6. Fully healthy state: no fail checks, next step reports healthy.
test("runDoctor: healthy state has no failing checks", async () => {
  await withTempDir(async (rootDir) => {
    writeProjectProfile(rootDir, analyzeRepository(rootDir));
    writeTopologyProposal(rootDir, makeProposal());
    saveAgent(rootDir, makeActiveAgent());
    saveSkill(rootDir, {
      id: "technical/node-test-authoring",
      version: "0.1.0",
      status: "active",
      purpose: "Author node:test suites.",
      useWhen: [],
      dontUseWhen: [],
      requiredInputs: [],
      procedure: ["write tests"],
      verificationSteps: [],
      doneWhen: [],
      escalateWhen: [],
      outputContract: "task-result",
      sources: [],
      owner: "manager-codex"
    });

    const report = runDoctor(rootDir, {
      env: { DEEPSEEK_API_KEY: "test-key" },
      checkCodex: CODEX_OK
    });

    assert.deepEqual(report.checks.filter((check) => check.status === "fail"), []);
    assert.equal(report.summary.fail, 0);
  });
});

// 7. Draft-only skills warn and name the activation command.
test("runDoctor: draft-only skills warn with the skill activate fix", async () => {
  await withTempDir(async (rootDir) => {
    writeProjectProfile(rootDir, analyzeRepository(rootDir));
    writeTopologyProposal(rootDir, makeProposal());
    saveAgent(rootDir, makeActiveAgent());
    saveSkill(rootDir, {
      id: "technical/node-test-authoring",
      version: "0.1.0",
      status: "draft",
      purpose: "Author node:test suites.",
      useWhen: [],
      dontUseWhen: [],
      requiredInputs: [],
      procedure: ["write tests"],
      verificationSteps: [],
      doneWhen: [],
      escalateWhen: [],
      outputContract: "task-result",
      sources: [],
      owner: "manager-codex"
    });

    const report = runDoctor(rootDir, {
      env: { DEEPSEEK_API_KEY: "test-key" },
      checkCodex: CODEX_OK
    });

    const skillsCheck = checkById(report, "skills");
    assert.equal(skillsCheck.status, "warn");
    assert.match(skillsCheck.fix, /skill activate/);
  });
});

// 8. Text renderer includes statuses, fixes, and the next step.
test("renderDoctorReport: renders one line per check plus fixes and next step", async () => {
  await withTempDir(async (rootDir) => {
    const report = runDoctor(rootDir, { env: {}, checkCodex: CODEX_OK });
    const text = renderDoctorReport(report);

    assert.match(text, /codex-cli/);
    assert.match(text, /project-profile/);
    assert.match(text, /Fix:/);
    assert.match(text, /Next step:/);
  });
});

// 9. CLI smoke test: doctor runs end-to-end and exits 0 even on an unhealthy repo
// (diagnosis is the success case; only broken invocations should exit non-zero).
test("orchestration-cli doctor --json exits 0 and returns the report", () => {
  const rootDir = makeTempDir("doctor-cli-");
  const binDir = makeTempDir("doctor-cli-bin-");
  installFakeCodex(binDir);
  try {
    const result = run("node", [CLI, "doctor", "--cwd", rootDir, "--json"], {
      cwd: ROOT,
      env: buildEnv(binDir)
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.ok(Array.isArray(payload.checks));
    assert.ok(payload.nextStep);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

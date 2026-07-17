import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { getCodexAvailability } from "../lib/codex.mjs";
import { listAgents } from "../agents/agent-registry.mjs";
import { listSkills } from "../skills/skill-registry.mjs";
import { listCampaigns } from "./campaign-orchestrator.mjs";
import { resolveProvider } from "../runtimes/provider-presets.mjs";

/**
 * Environment/state diagnosis for the orchestration system. Every check that
 * is not "ok" carries a concrete `fix` the caller (usually a model reading
 * CLI output) can act on directly — the goal is to make the first failing
 * rung of the setup ladder unambiguous instead of leaving it to guesswork.
 */

const MIN_NODE_MAJOR = 18;
const MIN_NODE_MINOR = 18;

const CLI_HINT = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-cli.mjs"';

function checkNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const ok = major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
  return {
    id: "node-version",
    status: ok ? "ok" : "fail",
    detail: `Node ${process.versions.node} (requires >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0)`,
    fix: ok ? null : `Install Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0 and rerun.`
  };
}

function checkCodexCli(rootDir, checkCodex) {
  const availability = checkCodex(rootDir);
  return {
    id: "codex-cli",
    status: availability.available ? "ok" : "fail",
    detail: availability.detail,
    fix: availability.available
      ? null
      : "Run `npm install -g @openai/codex`, then `/codex:setup` to verify authentication."
  };
}

function checkProjectProfile(rootDir) {
  const exists = fs.existsSync(path.join(rootDir, ".ai-company", "project-profile.json"));
  return {
    id: "project-profile",
    status: exists ? "ok" : "fail",
    detail: exists ? ".ai-company/project-profile.json present" : ".ai-company/project-profile.json missing",
    fix: exists ? null : `Run \`${CLI_HINT} bootstrap\` to scan the repository and propose a topology.`
  };
}

function checkTopologyProposal(rootDir) {
  const exists = fs.existsSync(path.join(rootDir, ".ai-company", "topology-proposal.json"));
  return {
    id: "topology-proposal",
    status: exists ? "ok" : "fail",
    detail: exists ? ".ai-company/topology-proposal.json present" : ".ai-company/topology-proposal.json missing",
    fix: exists ? null : `Run \`${CLI_HINT} bootstrap\` to propose a topology.`
  };
}

function checkAgents(rootDir) {
  const agents = listAgents(rootDir);
  const active = agents.filter((agent) => agent.status === "active");
  if (active.length > 0) {
    return {
      id: "agents",
      status: "ok",
      detail: `${active.length} active agent(s): ${active.map((agent) => agent.id).join(", ")}`,
      fix: null
    };
  }
  return {
    id: "agents",
    status: "fail",
    detail: agents.length > 0 ? `${agents.length} agent(s) registered, none active` : "no agents registered",
    fix: `Run \`${CLI_HINT} approve-topology --approved-by <role>\` to register the proposed agents (requires an existing topology proposal).`
  };
}

function checkSkills(rootDir) {
  const skills = listSkills(rootDir);
  if (skills.length === 0) {
    return {
      id: "skills",
      status: "warn",
      detail: "no skills registered",
      fix: "Skills are registered as drafts when a topology is approved; approve a topology first."
    };
  }

  const byStatus = new Map();
  for (const skill of skills) {
    byStatus.set(skill.status, (byStatus.get(skill.status) ?? 0) + 1);
  }
  const detail = [...byStatus.entries()].map(([status, count]) => `${count} ${status}`).join(", ");

  if ((byStatus.get("active") ?? 0) > 0) {
    return { id: "skills", status: "ok", detail, fix: null };
  }
  return {
    id: "skills",
    status: "warn",
    detail,
    fix: `No active skills yet — routing and workers require active skills. Activate one with \`${CLI_HINT} skill activate <skillId> --approved-by <role>\` once it has been evaluated.`
  };
}

function checkWorkerProviders(rootDir, env) {
  const active = listAgents(rootDir).filter((agent) => agent.status === "active");
  const providers = [...new Set(active.map((agent) => agent.runtime?.provider).filter(Boolean))];
  // Codex authentication is covered by the codex-cli check; only
  // chat-completions providers need env-key verification here.
  const external = providers.filter((provider) => provider !== "codex");

  if (external.length === 0) {
    return {
      id: "worker-providers",
      status: "ok",
      detail: active.length > 0 ? "no external chat-completions providers in use" : "no active agents to check",
      fix: null
    };
  }

  const problems = [];
  const okDetails = [];
  for (const providerId of external) {
    let resolved;
    try {
      resolved = resolveProvider(providerId, { env, rootDir });
    } catch (error) {
      problems.push(`${providerId}: ${error.message}`);
      continue;
    }
    if (!resolved.apiKey) {
      problems.push(`${providerId}: API key missing — set ${resolved.apiKeyEnv ?? "its API key env var"}`);
    } else if (!resolved.baseUrl) {
      problems.push(`${providerId}: base URL missing — set ${resolved.baseUrlEnv ?? "its base URL env var"}`);
    } else {
      okDetails.push(`${providerId} configured`);
    }
  }

  if (problems.length === 0) {
    return { id: "worker-providers", status: "ok", detail: okDetails.join(", "), fix: null };
  }
  return {
    id: "worker-providers",
    status: "warn",
    detail: problems.join("; "),
    fix: "Export the missing environment variable(s) in the shell that runs campaign tasks, or override the provider in .ai-company/runtimes.json."
  };
}

function checkCampaigns(rootDir) {
  const campaigns = listCampaigns(rootDir);
  if (campaigns.length === 0) {
    return { id: "campaigns", status: "ok", detail: "no campaigns yet", fix: null };
  }
  const byStatus = new Map();
  for (const campaign of campaigns) {
    byStatus.set(campaign.status, (byStatus.get(campaign.status) ?? 0) + 1);
  }
  const detail = [...byStatus.entries()].map(([status, count]) => `${count} ${status}`).join(", ");
  const paused = byStatus.get("paused") ?? 0;
  if (paused > 0) {
    return {
      id: "campaigns",
      status: "warn",
      detail,
      fix: "A paused campaign hit a budget cap. Inspect it with `campaign show <id>` and ask the user whether to recreate it with higher --max-* limits."
    };
  }
  return { id: "campaigns", status: "ok", detail, fix: null };
}

function pickNextStep(checks) {
  const firstFail = checks.find((check) => check.status === "fail");
  if (firstFail) {
    return firstFail.fix;
  }
  const firstWarn = checks.find((check) => check.status === "warn");
  if (firstWarn) {
    return firstWarn.fix;
  }
  return "All checks passed. The orchestration system is ready — create a campaign with `campaign create --brief <text>`.";
}

export function runDoctor(rootDir, { env = process.env, checkCodex = getCodexAvailability } = {}) {
  const checks = [
    checkNodeVersion(),
    checkCodexCli(rootDir, checkCodex),
    checkProjectProfile(rootDir),
    checkTopologyProposal(rootDir),
    checkAgents(rootDir),
    checkSkills(rootDir),
    checkWorkerProviders(rootDir, env),
    checkCampaigns(rootDir)
  ];

  const summary = {
    ok: checks.filter((check) => check.status === "ok").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length
  };

  return { checks, summary, nextStep: pickNextStep(checks) };
}

const STATUS_LABELS = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]" };

export function renderDoctorReport(report) {
  const lines = [];
  for (const check of report.checks) {
    lines.push(`${STATUS_LABELS[check.status]} ${check.id}: ${check.detail}`);
    if (check.fix && check.status !== "ok") {
      lines.push(`       Fix: ${check.fix}`);
    }
  }
  lines.push("");
  lines.push(`${report.summary.ok} ok, ${report.summary.warn} warning(s), ${report.summary.fail} failure(s).`);
  lines.push(`Next step: ${report.nextStep}`);
  return `${lines.join("\n")}\n`;
}

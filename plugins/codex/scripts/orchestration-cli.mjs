#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { analyzeRepository, writeProjectProfile } from "./orchestration/repository-analyzer.mjs";
import { proposeTopology, writeTopologyProposal, approveTopology } from "./orchestration/topology-planner.mjs";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/orchestration-cli.mjs bootstrap [--cwd <path>] [--profile-only] [--json]",
      "  node scripts/orchestration-cli.mjs approve-topology --approved-by <role> [--cwd <path>] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(argv, config);
}

function joinList(items) {
  return items && items.length > 0 ? items.join(", ") : "(none)";
}

function renderProfileOnlyReport(profile) {
  const lines = [
    "Repository profile written to .ai-company/project-profile.json.",
    "",
    `Languages: ${joinList(profile.languages)}`,
    `Frameworks: ${joinList(profile.frameworks)}`,
    `Test command: ${profile.commands?.test ?? "(none)"}`,
    `Top-level dirs: ${joinList(profile.structure?.dirs)}`,
    "",
    "Profile-only run: no topology was proposed. Rerun without --profile-only to propose one."
  ];
  return `${lines.join("\n")}\n`;
}

function renderBootstrapReport(proposal) {
  const lines = [
    `Topology type: ${proposal.topologyType}`,
    proposal.rationale,
    "",
    "Agents:"
  ];

  for (const agent of proposal.agents) {
    lines.push(`- ${agent.id} (${agent.type})`);
    lines.push(`    ownership.primary: ${joinList(agent.ownership?.primary)}`);
    lines.push(`    write: ${joinList(agent.permissions?.write)}`);
    lines.push(`    skills: ${joinList(agent.skills)}`);
  }

  lines.push("", "Skill drafts:");
  for (const draft of proposal.skillDrafts ?? []) {
    lines.push(`- ${draft.id}: ${draft.purpose}`);
  }

  lines.push("", "Overlaps:");
  for (const overlap of proposal.overlaps ?? []) {
    lines.push(`- ${overlap}`);
  }

  lines.push("", "Risks:");
  for (const risk of proposal.risks ?? []) {
    lines.push(`- ${risk}`);
  }

  lines.push(
    "",
    "Nothing has been activated. To register these agents and skills, approve the proposal with:",
    "  /codex:bootstrap-agents --approve --approved-by <role>"
  );

  return `${lines.join("\n")}\n`;
}

function renderApproveReport(result) {
  const lines = ["Registered agents (active):"];
  for (const id of result.agents) {
    lines.push(`- ${id}`);
  }
  lines.push("", "Registered skills (draft):");
  for (const id of result.skills) {
    lines.push(`- ${id}`);
  }
  return `${lines.join("\n")}\n`;
}

async function handleBootstrap(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "profile-only"]
  });

  const cwd = resolveCommandCwd(options);
  const profile = analyzeRepository(cwd);
  writeProjectProfile(cwd, profile);

  if (options["profile-only"]) {
    outputResult(options.json ? { profile } : renderProfileOnlyReport(profile), options.json);
    return;
  }

  const { proposal } = await proposeTopology(cwd, { profile });
  writeTopologyProposal(cwd, proposal);

  outputResult(options.json ? { profile, proposal } : renderBootstrapReport(proposal), options.json);
}

async function handleApproveTopology(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "approved-by"],
    booleanOptions: ["json"]
  });

  if (!options["approved-by"]) {
    throw new Error("Missing required --approved-by <role>. Approving a topology requires a named approver.");
  }

  const cwd = resolveCommandCwd(options);
  const result = approveTopology(cwd, { approvedBy: options["approved-by"] });

  outputResult(options.json ? result : renderApproveReport(result), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "bootstrap":
      await handleBootstrap(argv);
      break;
    case "approve-topology":
      await handleApproveTopology(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

import { loadOrchestrationSchema, validateAgainstSchema } from "../lib/schema-validator.mjs";
import { listAgents } from "../agents/agent-registry.mjs";
import { assertSkillsActive } from "../skills/skill-registry.mjs";
import { matchGlob } from "../agents/permission-guard.mjs";

/**
 * Deterministic task router: skills FIRST, then ownership (per spec order).
 * Does not call any LLM — routing is pure code over the agent registry.
 */

function matchesAnyGlob(globs, relPath) {
  return Array.isArray(globs) && globs.some((glob) => matchGlob(glob, relPath));
}

function countMatches(globs, paths) {
  return paths.filter((relPath) => matchesAnyGlob(globs, relPath)).length;
}

function compareById(a, b) {
  return String(a.id).localeCompare(String(b.id));
}

/**
 * @param {string} rootDir
 * @param {object} task a task document (validated against the "task" schema)
 * @param {{ agents?: object[] }} [options] agents defaults to `listAgents(rootDir)`
 * @returns {{ owner: object, support: object[], writeGaps: string[] }}
 */
export function routeTask(rootDir, task, { agents = listAgents(rootDir) } = {}) {
  // 1. Validate the task document.
  const taskSchema = loadOrchestrationSchema("task");
  const { valid, errors } = validateAgainstSchema(task, taskSchema);
  if (!valid) {
    throw new Error(`Invalid task:\n${errors.join("\n")}`);
  }

  const requiredSkills = task.requiredSkills ?? [];
  const affectedPaths = task.affectedPaths ?? [];

  // 2. Candidate agents: active status only.
  const activeAgents = agents.filter((agent) => agent.status === "active");

  // 3. Skill filter: agent.skills must include EVERY required skill ref.
  const skillEligible = activeAgents.filter(
    (agent) => Array.isArray(agent.skills) && requiredSkills.every((ref) => agent.skills.includes(ref))
  );

  if (skillEligible.length === 0) {
    throw new Error(`No active agent has the required skills: ${requiredSkills.join(", ")}`);
  }

  // 4. Ownership score: primary match count, then secondary, then agent id.
  const scored = skillEligible.map((agent) => ({
    agent,
    primaryCount: countMatches(agent.ownership?.primary, affectedPaths),
    secondaryCount: countMatches(agent.ownership?.secondary, affectedPaths)
  }));

  scored.sort((a, b) => {
    if (b.primaryCount !== a.primaryCount) {
      return b.primaryCount - a.primaryCount;
    }
    if (b.secondaryCount !== a.secondaryCount) {
      return b.secondaryCount - a.secondaryCount;
    }
    return compareById(a.agent, b.agent);
  });

  // 5. Preset owner (if set) must be skill-eligible; wins regardless of score.
  let ownerEntry;
  if (task.owner) {
    ownerEntry = scored.find((entry) => entry.agent.id === task.owner);
    if (!ownerEntry) {
      throw new Error(`Preset owner ${task.owner} is not eligible`);
    }
  } else {
    ownerEntry = scored[0];
  }

  const owner = ownerEntry.agent;

  // 6. Support: remaining skill-eligible agents with any ownership overlap.
  const support = scored
    .filter((entry) => entry.agent.id !== owner.id && (entry.primaryCount > 0 || entry.secondaryCount > 0))
    .map((entry) => entry.agent)
    .sort(compareById);

  // 7. writeGaps: affectedPaths the owner cannot write (WARN-level, no throw).
  const writeGaps = affectedPaths.filter((relPath) => !matchesAnyGlob(owner.permissions?.write, relPath));

  // 8. Hard skill gate LAST: every required skill must actually be active.
  assertSkillsActive(rootDir, requiredSkills);

  return { owner, support, writeGaps };
}

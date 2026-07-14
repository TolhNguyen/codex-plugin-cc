import fs from "node:fs";
import path from "node:path";

/**
 * Append-only JSONL audit log for a campaign: one compact JSON object per
 * line under `<rootDir>/.ai-company/campaigns/<campaignId>/audit.log`. Never
 * rewritten, never truncated — every orchestration step appends exactly one
 * line here.
 */

function auditLogPath(rootDir, campaignId) {
  return path.join(rootDir, ".ai-company", "campaigns", campaignId, "audit.log");
}

/**
 * @param {string} rootDir
 * @param {string} campaignId
 * @param {object} event arbitrary JSON-serializable event payload; an `at`
 *   ISO timestamp is stamped on unless the caller already supplied one.
 * @returns {string} the audit log file path
 */
export function appendAuditEvent(rootDir, campaignId, event) {
  const filePath = auditLogPath(rootDir, campaignId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const stamped = { at: new Date().toISOString(), ...event };
  fs.appendFileSync(filePath, `${JSON.stringify(stamped)}\n`, "utf8");
  return filePath;
}

/**
 * @param {string} rootDir
 * @param {string} campaignId
 * @returns {object[]} events in append order; corrupt lines are skipped;
 *   returns [] when the audit log does not exist yet.
 */
export function readAuditEvents(rootDir, campaignId) {
  const filePath = auditLogPath(rootDir, campaignId);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const events = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Skip corrupt lines instead of throwing — the audit log must never
      // block orchestration because of a torn write.
    }
  }
  return events;
}

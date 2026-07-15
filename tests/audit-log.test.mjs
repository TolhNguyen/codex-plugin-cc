import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { appendAuditEvent, readAuditEvents } from "../plugins/codex/scripts/orchestration/audit-log.mjs";
import { makeTempDir } from "./helpers.mjs";

function withTempDir(fn) {
  const rootDir = makeTempDir("audit-log-test-");
  try {
    return fn(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

test("appendAuditEvent stamps `at` when the caller does not provide one", () => {
  withTempDir((rootDir) => {
    const filePath = appendAuditEvent(rootDir, "camp-1", { event: "task_attempt_started", taskId: "t1" });

    assert.equal(filePath, path.join(rootDir, ".ai-company", "campaigns", "camp-1", "audit.log"));
    assert.ok(fs.existsSync(filePath));

    const events = readAuditEvents(rootDir, "camp-1");
    assert.equal(events.length, 1);
    assert.equal(typeof events[0].at, "string");
    assert.match(events[0].at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(events[0].event, "task_attempt_started");
    assert.equal(events[0].taskId, "t1");
  });
});

test("appendAuditEvent preserves a caller-supplied `at`", () => {
  withTempDir((rootDir) => {
    appendAuditEvent(rootDir, "camp-1", { event: "worker_result", at: "2020-01-01T00:00:00.000Z" });

    const events = readAuditEvents(rootDir, "camp-1");
    assert.equal(events.length, 1);
    assert.equal(events[0].at, "2020-01-01T00:00:00.000Z");
  });
});

test("appendAuditEvent appends one compact JSON line per event", () => {
  withTempDir((rootDir) => {
    appendAuditEvent(rootDir, "camp-1", { event: "a" });
    appendAuditEvent(rootDir, "camp-1", { event: "b" });

    const filePath = path.join(rootDir, ".ai-company", "campaigns", "camp-1", "audit.log");
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter((line) => line.length > 0);

    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
    assert.equal(JSON.parse(lines[0]).event, "a");
    assert.equal(JSON.parse(lines[1]).event, "b");
  });
});

test("readAuditEvents returns [] when the audit log file is missing", () => {
  withTempDir((rootDir) => {
    assert.deepEqual(readAuditEvents(rootDir, "camp-does-not-exist"), []);
  });
});

test("readAuditEvents skips corrupt lines instead of throwing", () => {
  withTempDir((rootDir) => {
    appendAuditEvent(rootDir, "camp-1", { event: "a" });
    const filePath = path.join(rootDir, ".ai-company", "campaigns", "camp-1", "audit.log");
    fs.appendFileSync(filePath, "{ not valid json\n");
    appendAuditEvent(rootDir, "camp-1", { event: "b" });

    const events = readAuditEvents(rootDir, "camp-1");
    assert.deepEqual(events.map((event) => event.event), ["a", "b"]);
  });
});

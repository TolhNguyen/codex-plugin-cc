import test from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  normalizeArgv,
  splitRawArgumentString,
} from "../plugins/codex/scripts/lib/args.mjs";

// ---------------------------------------------------------------------------
// parseArgs – value options
// ---------------------------------------------------------------------------

test("parseArgs: --key value (separate token)", () => {
  const { options, positionals } = parseArgs(["--output", "out.txt"], {
    valueOptions: ["output"],
  });
  assert.deepEqual(options, { output: "out.txt" });
  assert.deepEqual(positionals, []);
});

test("parseArgs: --key=value (inline)", () => {
  const { options, positionals } = parseArgs(["--output=out.txt"], {
    valueOptions: ["output"],
  });
  assert.deepEqual(options, { output: "out.txt" });
  assert.deepEqual(positionals, []);
});

test("parseArgs: multiple value options", () => {
  const { options, positionals } = parseArgs(
    ["--name", "foo", "--path", "/tmp"],
    { valueOptions: ["name", "path"] }
  );
  assert.deepEqual(options, { name: "foo", path: "/tmp" });
  assert.deepEqual(positionals, []);
});

// ---------------------------------------------------------------------------
// parseArgs – boolean options
// ---------------------------------------------------------------------------

test("parseArgs: --flag (boolean true)", () => {
  const { options, positionals } = parseArgs(["--verbose"], {
    booleanOptions: ["verbose"],
  });
  assert.deepEqual(options, { verbose: true });
  assert.deepEqual(positionals, []);
});

test("parseArgs: --flag=false (boolean false)", () => {
  const { options, positionals } = parseArgs(["--verbose=false"], {
    booleanOptions: ["verbose"],
  });
  assert.deepEqual(options, { verbose: false });
  assert.deepEqual(positionals, []);
});

test("parseArgs: --flag=true (boolean true via inline)", () => {
  const { options, positionals } = parseArgs(["--verbose=true"], {
    booleanOptions: ["verbose"],
  });
  assert.deepEqual(options, { verbose: true });
  assert.deepEqual(positionals, []);
});

test("parseArgs: boolean option with --flag=value other than false is truthy", () => {
  const { options } = parseArgs(["--flag=0"], {
    booleanOptions: ["flag"],
  });
  assert.equal(options.flag, true);
});

// ---------------------------------------------------------------------------
// parseArgs – short flags
// ---------------------------------------------------------------------------

test("parseArgs: -k value (short value option)", () => {
  const { options, positionals } = parseArgs(["-o", "out.txt"], {
    valueOptions: ["o"],
  });
  assert.deepEqual(options, { o: "out.txt" });
  assert.deepEqual(positionals, []);
});

test("parseArgs: -k (short boolean option)", () => {
  const { options, positionals } = parseArgs(["-v"], {
    booleanOptions: ["v"],
  });
  assert.deepEqual(options, { v: true });
  assert.deepEqual(positionals, []);
});

// ---------------------------------------------------------------------------
// parseArgs – alias mapping
// ---------------------------------------------------------------------------

test("parseArgs: alias mapping for long options", () => {
  const { options, positionals } = parseArgs(["--output", "out.txt"], {
    valueOptions: ["out"],
    aliasMap: { output: "out" },
  });
  assert.deepEqual(options, { out: "out.txt" });
  assert.deepEqual(positionals, []);
});

test("parseArgs: alias mapping for short options", () => {
  const { options, positionals } = parseArgs(["-o", "out.txt"], {
    valueOptions: ["out"],
    aliasMap: { o: "out" },
  });
  assert.deepEqual(options, { out: "out.txt" });
  assert.deepEqual(positionals, []);
});

test("parseArgs: alias mapping for boolean options", () => {
  const { options, positionals } = parseArgs(["--verbose"], {
    booleanOptions: ["v"],
    aliasMap: { verbose: "v" },
  });
  assert.deepEqual(options, { v: true });
  assert.deepEqual(positionals, []);
});

// ---------------------------------------------------------------------------
// parseArgs – positionals
// ---------------------------------------------------------------------------

test("parseArgs: bare tokens become positionals", () => {
  const { options, positionals } = parseArgs(["file1", "file2"], {});
  assert.deepEqual(options, {});
  assert.deepEqual(positionals, ["file1", "file2"]);
});

test("parseArgs: positionals interleaved with options", () => {
  const { options, positionals } = parseArgs(
    ["--verbose", "file1", "--name", "foo", "file2"],
    { booleanOptions: ["verbose"], valueOptions: ["name"] }
  );
  assert.deepEqual(options, { verbose: true, name: "foo" });
  assert.deepEqual(positionals, ["file1", "file2"]);
});

test("parseArgs: lone dash is treated as positional", () => {
  const { options, positionals } = parseArgs(["-"], {});
  assert.deepEqual(options, {});
  assert.deepEqual(positionals, ["-"]);
});

// ---------------------------------------------------------------------------
// parseArgs – -- passthrough
// ---------------------------------------------------------------------------

test("parseArgs: -- stops option parsing, rest are positionals", () => {
  const { options, positionals } = parseArgs(
    ["--verbose", "--", "--name", "foo"],
    { booleanOptions: ["verbose"], valueOptions: ["name"] }
  );
  assert.deepEqual(options, { verbose: true });
  assert.deepEqual(positionals, ["--name", "foo"]);
});

test("parseArgs: -- with no trailing tokens", () => {
  const { options, positionals } = parseArgs(["--", "--verbose"], {
    booleanOptions: ["verbose"],
  });
  assert.deepEqual(options, {});
  assert.deepEqual(positionals, ["--verbose"]);
});

// ---------------------------------------------------------------------------
// parseArgs – missing-value error
// ---------------------------------------------------------------------------

test("parseArgs: throws on missing value for long option", () => {
  assert.throws(
    () => parseArgs(["--output"], { valueOptions: ["output"] }),
    { message: "Missing value for --output" }
  );
});

test("parseArgs: throws on missing value for short option", () => {
  assert.throws(
    () => parseArgs(["-o"], { valueOptions: ["o"] }),
    { message: "Missing value for -o" }
  );
});

test("parseArgs: missing value at end of argv for long option", () => {
  assert.throws(
    () => parseArgs(["--name", "foo", "--output"], {
      valueOptions: ["name", "output"],
    }),
    { message: "Missing value for --output" }
  );
});

// ---------------------------------------------------------------------------
// parseArgs – unknown options become positionals
// ---------------------------------------------------------------------------

test("parseArgs: unknown long option becomes positional", () => {
  const { options, positionals } = parseArgs(["--unknown"], {
    valueOptions: ["known"],
  });
  assert.deepEqual(options, {});
  assert.deepEqual(positionals, ["--unknown"]);
});

test("parseArgs: unknown short option becomes positional", () => {
  const { options, positionals } = parseArgs(["-x"], {
    valueOptions: ["k"],
  });
  assert.deepEqual(options, {});
  assert.deepEqual(positionals, ["-x"]);
});

// ---------------------------------------------------------------------------
// parseArgs – mixed usage
// ---------------------------------------------------------------------------

test("parseArgs: mixed value, boolean, short, positionals", () => {
  const { options, positionals } = parseArgs(
    ["-v", "--name", "hello", "--dry-run", "file.txt", "-o", "out.log"],
    {
      valueOptions: ["name", "o"],
      booleanOptions: ["v", "dry-run"],
    }
  );
  assert.deepEqual(options, { v: true, name: "hello", "dry-run": true, o: "out.log" });
  assert.deepEqual(positionals, ["file.txt"]);
});

// ---------------------------------------------------------------------------
// normalizeArgv
// ---------------------------------------------------------------------------

test("normalizeArgv: single token is split", () => {
  const result = normalizeArgv(['--verbose --name "hello world"']);
  assert.deepEqual(result, ["--verbose", "--name", "hello world"]);
});

test("normalizeArgv: multiple tokens returned as-is", () => {
  const result = normalizeArgv(["--verbose", "--name", "hello"]);
  assert.deepEqual(result, ["--verbose", "--name", "hello"]);
});

test("normalizeArgv: empty single token returns empty array", () => {
  const result = normalizeArgv([""]);
  assert.deepEqual(result, []);
});

test("normalizeArgv: whitespace-only single token returns empty array", () => {
  const result = normalizeArgv(["   "]);
  assert.deepEqual(result, []);
});

test("normalizeArgv: empty array returns empty array", () => {
  const result = normalizeArgv([]);
  assert.deepEqual(result, []);
});

// ---------------------------------------------------------------------------
// splitRawArgumentString – basic splitting
// ---------------------------------------------------------------------------

test("splitRawArgumentString: splits on whitespace", () => {
  const result = splitRawArgumentString("a b c");
  assert.deepEqual(result, ["a", "b", "c"]);
});

test("splitRawArgumentString: collapses multiple spaces", () => {
  const result = splitRawArgumentString("a   b");
  assert.deepEqual(result, ["a", "b"]);
});

test("splitRawArgumentString: trims leading/trailing whitespace", () => {
  const result = splitRawArgumentString("  foo bar  ");
  assert.deepEqual(result, ["foo", "bar"]);
});

// ---------------------------------------------------------------------------
// splitRawArgumentString – quoting
// ---------------------------------------------------------------------------

test("splitRawArgumentString: double-quoted string is one token", () => {
  const result = splitRawArgumentString('--name "hello world"');
  assert.deepEqual(result, ["--name", "hello world"]);
});

test("splitRawArgumentString: single-quoted string is one token", () => {
  const result = splitRawArgumentString("--name 'hello world'");
  assert.deepEqual(result, ["--name", "hello world"]);
});

test("splitRawArgumentString: mixed quotes", () => {
  const result = splitRawArgumentString("a 'b c' d \"e f\"");
  assert.deepEqual(result, ["a", "b c", "d", "e f"]);
});

test("splitRawArgumentString: empty double-quoted string produces no token", () => {
  const result = splitRawArgumentString('""');
  assert.deepEqual(result, []);
});

test("splitRawArgumentString: empty single-quoted string produces no token", () => {
  const result = splitRawArgumentString("''");
  assert.deepEqual(result, []);
});

// ---------------------------------------------------------------------------
// splitRawArgumentString – escaping
// ---------------------------------------------------------------------------

test("splitRawArgumentString: backslash escapes next character", () => {
  const result = splitRawArgumentString("a\\ b");
  assert.deepEqual(result, ["a b"]);
});

test("splitRawArgumentString: backslash at end keeps backslash", () => {
  const result = splitRawArgumentString("a\\");
  assert.deepEqual(result, ["a\\"]);
});

test("splitRawArgumentString: escaped quote inside quotes", () => {
  const result = splitRawArgumentString('"hello \\"world\\""');
  assert.deepEqual(result, ['hello "world"']);
});

test("splitRawArgumentString: backslash before normal char", () => {
  const result = splitRawArgumentString("\\n");
  assert.deepEqual(result, ["n"]);
});

// ---------------------------------------------------------------------------
// splitRawArgumentString – edge cases
// ---------------------------------------------------------------------------

test("splitRawArgumentString: empty string returns empty array", () => {
  const result = splitRawArgumentString("");
  assert.deepEqual(result, []);
});

test("splitRawArgumentString: only whitespace returns empty array", () => {
  const result = splitRawArgumentString("   ");
  assert.deepEqual(result, []);
});

test("splitRawArgumentString: unclosed double quote", () => {
  const result = splitRawArgumentString('"hello');
  assert.deepEqual(result, ["hello"]);
});

test("splitRawArgumentString: unclosed single quote", () => {
  const result = splitRawArgumentString("'hello");
  assert.deepEqual(result, ["hello"]);
});

// ---------------------------------------------------------------------------
// normalizeArgv + parseArgs integration
// ---------------------------------------------------------------------------

test("normalizeArgv then parseArgs: single-token input", () => {
  const argv = normalizeArgv(['--verbose --name "hello world" file.txt']);
  const { options, positionals } = parseArgs(argv, {
    booleanOptions: ["verbose"],
    valueOptions: ["name"],
  });
  assert.deepEqual(options, { verbose: true, name: "hello world" });
  assert.deepEqual(positionals, ["file.txt"]);
});

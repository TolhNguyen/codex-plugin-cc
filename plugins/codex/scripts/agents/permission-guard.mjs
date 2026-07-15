import fs from "node:fs";
import path from "node:path";

/**
 * Path-level enforcement for worker file access. No dependency on the agent
 * or skill registries — a `relPath` is treated as untrusted model output and
 * must never escape `rootDir`, even via symlinks or `..`/absolute tricks.
 */

const ALWAYS_WRITE_DENIED_GLOBS = [".ai-company", ".ai-company/**", ".git", ".git/**"];

// The governance store must never be readable through a worker's granted
// read globs, even a broad one like "**" — it holds other agents' memory
// namespaces, agent/skill/proposal state, etc. Unlike writes, `.git` is NOT
// read-denied here: reading a repo's own git-tracked files is normal.
const ALWAYS_READ_DENIED_GLOBS = [".ai-company", ".ai-company/**"];

function isWin32() {
  return process.platform === "win32";
}

function toPosixRelative(value) {
  return String(value).split(path.sep).join("/").replace(/\\/g, "/");
}

// --- glob matcher -----------------------------------------------------

// Tokenizes a glob pattern left to right: "**/" (any depth incl. empty,
// followed by a segment), a trailing "/**" (any depth incl. empty, anchored
// at the end), a bare "**" (matches everything), "*" (single segment
// wildcard), "?" (single char) and literal characters (escaped one at a
// time so nothing special leaks through).
const GLOB_TOKEN_RE = /\*\*\/|\/\*\*(?=$)|\*\*|\*|\?|[^*?]/g;

function escapeRegexChar(char) {
  return char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegExpSource(pattern) {
  const tokens = pattern.match(GLOB_TOKEN_RE) || [];
  let body = "";
  for (const token of tokens) {
    switch (token) {
      case "**/":
        body += "(?:.*/)?";
        break;
      case "**":
        body += ".*";
        break;
      case "*":
        body += "[^/]*";
        break;
      case "?":
        body += "[^/]";
        break;
      case "/**":
        body += "/.*";
        break;
      default:
        body += escapeRegexChar(token);
    }
  }
  return body;
}

export function matchGlob(pattern, relPath) {
  const normalizedPattern = toPosixRelative(pattern);
  const normalizedPath = toPosixRelative(relPath);
  const source = `^${globToRegExpSource(normalizedPattern)}$`;
  const regex = new RegExp(source, isWin32() ? "i" : "");
  return regex.test(normalizedPath);
}

// --- containment + symlink safety --------------------------------------

function computeRelativeCaseAware(rootDir, absPath) {
  if (isWin32()) {
    return path.relative(rootDir.toLowerCase(), absPath.toLowerCase());
  }
  return path.relative(rootDir, absPath);
}

function assertContained(rootDir, absPath, relPathForError) {
  const rel = computeRelativeCaseAware(rootDir, absPath);
  const escapes = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (escapes) {
    throw new Error(`Path escapes workspace: ${relPathForError}`);
  }
}

// Walks up from `absPath` until it finds an ancestor that actually exists,
// realpath's that ancestor (resolving any symlink in the existing portion of
// the path) and rejoins the not-yet-existing suffix on top. This catches a
// symlink pointing outside rootDir whether or not the final target exists
// yet (e.g. a write into a not-yet-created file inside a symlinked dir).
function realpathDeepestExisting(absPath) {
  let current = absPath;
  const trailing = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return absPath;
    }
    trailing.unshift(path.basename(current));
    current = parent;
  }

  let real;
  try {
    real = fs.realpathSync(current);
  } catch {
    real = current;
  }
  return trailing.length > 0 ? path.join(real, ...trailing) : real;
}

function safeRealpath(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return targetPath;
  }
}

function resolveAndCheckContainment(rootDir, canonicalRootDir, relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error(`Path escapes workspace: ${relPath}`);
  }

  // Lexical check first: catches ".."/absolute-path tricks by construction,
  // comparing like-for-like (both derived from the literal rootDir).
  const resolved = path.resolve(rootDir, relPath);
  assertContained(rootDir, resolved, relPath);

  // Symlink-aware check second: compares realpath'd target against a
  // realpath'd rootDir, so a symlinked rootDir itself (common for OS temp
  // dirs) doesn't produce a false "escapes workspace".
  const realResolved = realpathDeepestExisting(resolved);
  assertContained(canonicalRootDir, realResolved, relPath);

  return resolved;
}

// Derives the canonical, `.`/`..`-free, forward-slash repo-relative path from
// an already-resolved-and-contained absolute path. Deny-glob and allow-glob
// matching must run against this rather than the caller-supplied `relPath`,
// since the raw input can contain "./" or "../" segments that a glob like
// ".ai-company/**" or "tests/**" would not lexically match even though the
// resolved path does live inside (or outside) that scope.
function toCanonicalRelative(rootDir, resolvedAbsPath) {
  return toPosixRelative(path.relative(rootDir, resolvedAbsPath));
}

function isAlwaysWriteDenied(relPath) {
  const normalized = toPosixRelative(relPath);
  return ALWAYS_WRITE_DENIED_GLOBS.some((glob) => matchGlob(glob, normalized));
}

function isAlwaysReadDenied(relPath) {
  const normalized = toPosixRelative(relPath);
  return ALWAYS_READ_DENIED_GLOBS.some((glob) => matchGlob(glob, normalized));
}

function matchesAny(globs, relPath) {
  const normalized = toPosixRelative(relPath);
  return globs.some((glob) => matchGlob(glob, normalized));
}

export function createPermissionGuard(rootDir, permissions) {
  const readGlobs = (permissions && permissions.read) || [];
  const writeGlobs = (permissions && permissions.write) || [];
  const canonicalRootDir = safeRealpath(rootDir);

  function canRead(relPath) {
    let resolved;
    try {
      resolved = resolveAndCheckContainment(rootDir, canonicalRootDir, relPath);
    } catch {
      return false;
    }
    const canonicalRelPath = toCanonicalRelative(rootDir, resolved);
    if (isAlwaysReadDenied(canonicalRelPath)) {
      return false;
    }
    return matchesAny(readGlobs, canonicalRelPath);
  }

  function canWrite(relPath) {
    let resolved;
    try {
      resolved = resolveAndCheckContainment(rootDir, canonicalRootDir, relPath);
    } catch {
      return false;
    }
    const canonicalRelPath = toCanonicalRelative(rootDir, resolved);
    if (isAlwaysWriteDenied(canonicalRelPath)) {
      return false;
    }
    return matchesAny(writeGlobs, canonicalRelPath);
  }

  function assertRead(relPath) {
    const resolved = resolveAndCheckContainment(rootDir, canonicalRootDir, relPath);
    const canonicalRelPath = toCanonicalRelative(rootDir, resolved);
    if (isAlwaysReadDenied(canonicalRelPath) || !matchesAny(readGlobs, canonicalRelPath)) {
      throw new Error(`Permission denied: read ${relPath}`);
    }
    return resolved;
  }

  function assertWrite(relPath) {
    const resolved = resolveAndCheckContainment(rootDir, canonicalRootDir, relPath);
    const canonicalRelPath = toCanonicalRelative(rootDir, resolved);
    if (isAlwaysWriteDenied(canonicalRelPath) || !matchesAny(writeGlobs, canonicalRelPath)) {
      throw new Error(`Permission denied: write ${relPath}`);
    }
    return resolved;
  }

  return { canRead, canWrite, assertRead, assertWrite };
}

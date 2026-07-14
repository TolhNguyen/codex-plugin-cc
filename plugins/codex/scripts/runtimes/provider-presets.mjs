/**
 * Chat-completions provider presets for the OpenAI-compatible worker runtime.
 * A "provider" here is nothing but transport coordinates (base URL, model,
 * API key env var name) — resolution never touches the network and never
 * persists a resolved API key anywhere. The resolved object returned by
 * `resolveProvider` is intended to live in memory only, for the lifetime of
 * a single `execute()` call.
 */
import fs from "node:fs";
import path from "node:path";

const RUNTIMES_OVERRIDE_RELATIVE_PATH = path.join(".ai-company", "runtimes.json");

export const BUILTIN_PROVIDERS = Object.freeze({
  deepseek: Object.freeze({
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    defaultBaseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-chat"
  }),
  "openai-compatible": Object.freeze({
    baseUrlEnv: "OPENAI_COMPAT_BASE_URL",
    defaultBaseUrl: null,
    apiKeyEnv: "OPENAI_COMPAT_API_KEY",
    defaultModel: null
  })
});

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads `<rootDir>/.ai-company/runtimes.json` if present and parses it as
 * provider-id -> preset-fields overrides. Any failure (missing file,
 * unreadable, malformed JSON, non-object shape) is swallowed and treated as
 * "no overrides" so resolution deterministically falls back to builtins.
 */
function loadOverrides(rootDir) {
  if (!rootDir) {
    return {};
  }

  const filePath = path.join(rootDir, RUNTIMES_OVERRIDE_RELATIVE_PATH);
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {string} providerId
 * @param {{ env?: object, rootDir?: string | null }} [options]
 * @returns {{ id: string, baseUrl: string | null, apiKey: string | null, model: string | null, baseUrlEnv: string, apiKeyEnv: string }}
 */
export function resolveProvider(providerId, { env = process.env, rootDir = null } = {}) {
  const overrides = loadOverrides(rootDir);
  const builtin = BUILTIN_PROVIDERS[providerId];
  const override = isPlainObject(overrides[providerId]) ? overrides[providerId] : null;

  if (!builtin && !override) {
    throw new Error(`Unknown runtime provider: ${providerId}`);
  }

  const preset = { ...(builtin ?? {}), ...(override ?? {}) };

  return {
    id: providerId,
    baseUrl: (preset.baseUrlEnv ? env[preset.baseUrlEnv] : undefined) ?? preset.defaultBaseUrl ?? null,
    apiKey: (preset.apiKeyEnv ? env[preset.apiKeyEnv] : undefined) ?? null,
    model: preset.defaultModel ?? null,
    baseUrlEnv: preset.baseUrlEnv ?? null,
    apiKeyEnv: preset.apiKeyEnv ?? null
  };
}

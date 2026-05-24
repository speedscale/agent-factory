import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveEngineConfig,
  mapKindToProvider,
  providerRequiresAuth,
} from "./engine-config.js";
import { defaultModelFor } from "./llm-providers.js";

// ---------- mapKindToProvider ----------

test("mapKindToProvider: claude-sdk -> anthropic", () => {
  assert.equal(mapKindToProvider("claude-sdk"), "anthropic");
});

test("mapKindToProvider: ds4 -> ds4", () => {
  assert.equal(mapKindToProvider("ds4"), "ds4");
});

test("mapKindToProvider: omlx -> omlx", () => {
  assert.equal(mapKindToProvider("omlx"), "omlx");
});

test("mapKindToProvider: openrouter -> openrouter", () => {
  assert.equal(mapKindToProvider("openrouter"), "openrouter");
});

test("mapKindToProvider: generic-llm -> openrouter", () => {
  assert.equal(mapKindToProvider("generic-llm"), "openrouter");
});

test("mapKindToProvider: private-llm -> openrouter", () => {
  assert.equal(mapKindToProvider("private-llm"), "openrouter");
});

test("mapKindToProvider: unknown kind throws (no silent anthropic fallback)", () => {
  assert.throws(() => mapKindToProvider("bogus"), /unknown AF_ENGINE_KIND/);
});

test("mapKindToProvider: empty string throws", () => {
  assert.throws(() => mapKindToProvider(""), /unknown AF_ENGINE_KIND/);
});

test("mapKindToProvider: case-sensitive (CLAUDE-SDK is not claude-sdk)", () => {
  // We deliberately don't normalize case — values.yaml uses lowercase
  // canonical form, and accepting variant casing would let typos slip past.
  assert.throws(() => mapKindToProvider("CLAUDE-SDK"), /unknown AF_ENGINE_KIND/);
});

// ---------- resolveEngineConfig ----------

test("resolveEngineConfig: default (no env) -> anthropic + default model", () => {
  const cfg = resolveEngineConfig({});
  assert.equal(cfg.provider, "anthropic");
  assert.equal(cfg.model, defaultModelFor("anthropic"));
  assert.equal(cfg.endpoint, undefined);
});

test("resolveEngineConfig: AF_ENGINE_KIND=ds4 picks ds4 provider + ds4 default model", () => {
  const cfg = resolveEngineConfig({ AF_ENGINE_KIND: "ds4" });
  assert.equal(cfg.provider, "ds4");
  assert.equal(cfg.model, defaultModelFor("ds4"));
});

test("resolveEngineConfig: AF_ENGINE_KIND=omlx picks omlx provider", () => {
  const cfg = resolveEngineConfig({ AF_ENGINE_KIND: "omlx" });
  assert.equal(cfg.provider, "omlx");
  assert.equal(cfg.model, defaultModelFor("omlx"));
});

test("resolveEngineConfig: AF_ENGINE_KIND=generic-llm picks openrouter provider", () => {
  const cfg = resolveEngineConfig({ AF_ENGINE_KIND: "generic-llm" });
  assert.equal(cfg.provider, "openrouter");
  assert.equal(cfg.model, defaultModelFor("openrouter"));
});

test("resolveEngineConfig: AF_ENGINE_KIND=private-llm picks openrouter provider", () => {
  const cfg = resolveEngineConfig({ AF_ENGINE_KIND: "private-llm" });
  assert.equal(cfg.provider, "openrouter");
});

test("resolveEngineConfig: AF_ENGINE_MODEL overrides per-provider default", () => {
  const cfg = resolveEngineConfig({
    AF_ENGINE_KIND: "ds4",
    AF_ENGINE_MODEL: "deepseek-v4-coder",
  });
  assert.equal(cfg.provider, "ds4");
  assert.equal(cfg.model, "deepseek-v4-coder");
});

test("resolveEngineConfig: empty AF_ENGINE_MODEL falls back to default (not empty string)", () => {
  const cfg = resolveEngineConfig({
    AF_ENGINE_KIND: "anthropic" in {} ? "claude-sdk" : "claude-sdk",
    AF_ENGINE_MODEL: "",
  });
  assert.equal(cfg.model, defaultModelFor("anthropic"));
});

test("resolveEngineConfig: whitespace-only AF_ENGINE_MODEL falls back to default", () => {
  const cfg = resolveEngineConfig({ AF_ENGINE_MODEL: "   " });
  assert.equal(cfg.model, defaultModelFor("anthropic"));
});

test("resolveEngineConfig: AF_ENGINE_ENDPOINT is surfaced when set", () => {
  const cfg = resolveEngineConfig({
    AF_ENGINE_KIND: "openrouter",
    AF_ENGINE_ENDPOINT: "https://proxy.example.com/v1",
  });
  assert.equal(cfg.endpoint, "https://proxy.example.com/v1");
});

test("resolveEngineConfig: empty AF_ENGINE_ENDPOINT collapses to undefined", () => {
  const cfg = resolveEngineConfig({ AF_ENGINE_ENDPOINT: "" });
  assert.equal(cfg.endpoint, undefined);
});

test("resolveEngineConfig: whitespace AF_ENGINE_KIND is trimmed before lookup", () => {
  const cfg = resolveEngineConfig({ AF_ENGINE_KIND: "  ds4  " });
  assert.equal(cfg.provider, "ds4");
});

test("resolveEngineConfig: unknown AF_ENGINE_KIND throws with a helpful message", () => {
  assert.throws(
    () => resolveEngineConfig({ AF_ENGINE_KIND: "gpt4" }),
    /unknown AF_ENGINE_KIND.*gpt4/,
  );
});

test("resolveEngineConfig: ignores unrelated env vars", () => {
  const cfg = resolveEngineConfig({
    AF_ENGINE_KIND: "ds4",
    HOME: "/Users/nobody",
    PATH: "/usr/bin",
    NODE_ENV: "production",
  });
  assert.equal(cfg.provider, "ds4");
});

// ---------- providerRequiresAuth ----------

test("providerRequiresAuth: anthropic requires auth", () => {
  assert.equal(providerRequiresAuth("anthropic"), true);
});

test("providerRequiresAuth: openrouter requires auth", () => {
  assert.equal(providerRequiresAuth("openrouter"), true);
});

test("providerRequiresAuth: ds4 does not require auth (local)", () => {
  assert.equal(providerRequiresAuth("ds4"), false);
});

test("providerRequiresAuth: omlx does not require auth (local)", () => {
  assert.equal(providerRequiresAuth("omlx"), false);
});

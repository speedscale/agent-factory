import { test } from "node:test";
import assert from "node:assert/strict";
import { getInstanceConfig, formatInstanceBanner } from "./instance-config.js";

test("defaults to instance='local' with no overrides", () => {
  const cfg = getInstanceConfig({});
  assert.equal(cfg.instance, "local");
  assert.equal(cfg.linearQuery, undefined);
});

test("AF_INSTANCE env var is read", () => {
  const cfg = getInstanceConfig({ AF_INSTANCE: "k8s-staging" });
  assert.equal(cfg.instance, "k8s-staging");
});

test("AF_LINEAR_QUERY env var is read", () => {
  const cfg = getInstanceConfig({
    AF_INSTANCE: "ken-local-cli",
    AF_LINEAR_QUERY: 'team:"Speedscale" label:"auto-fix" state:Todo'
  });
  assert.equal(cfg.instance, "ken-local-cli");
  assert.equal(cfg.linearQuery, 'team:"Speedscale" label:"auto-fix" state:Todo');
});

test("CLI override takes precedence over env", () => {
  const cfg = getInstanceConfig(
    { AF_INSTANCE: "from-env" },
    { instance: "from-flag" }
  );
  assert.equal(cfg.instance, "from-flag");
});

test("empty/whitespace env values fall through to default", () => {
  const cfg = getInstanceConfig({ AF_INSTANCE: "   ", AF_LINEAR_QUERY: "" });
  assert.equal(cfg.instance, "local");
  assert.equal(cfg.linearQuery, undefined);
});

test("env values are trimmed", () => {
  const cfg = getInstanceConfig({ AF_INSTANCE: "  staging  " });
  assert.equal(cfg.instance, "staging");
});

test("formatInstanceBanner is deterministic and includes the role", () => {
  const cfg = { instance: "minikube-local", linearQuery: undefined };
  const banner = formatInstanceBanner(cfg, "intake-api");
  assert.equal(banner, "[instance=minikube-local] role=intake-api");
});

test("formatInstanceBanner surfaces linearQuery when set", () => {
  const cfg = { instance: "ken-local", linearQuery: "label:auto-fix" };
  const banner = formatInstanceBanner(cfg, "llm-run");
  assert.match(banner, /\[instance=ken-local\]/);
  assert.match(banner, /role=llm-run/);
  assert.match(banner, /linearQuery="label:auto-fix"/);
});

test("undefined env is harmless (no NPE)", () => {
  // process.env values that aren't set come back as undefined; the helper
  // must not blow up.
  const cfg = getInstanceConfig({ AF_INSTANCE: undefined as unknown as string });
  assert.equal(cfg.instance, "local");
});

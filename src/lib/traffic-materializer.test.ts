import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  materializeTrafficSource,
  materializeTrafficSources,
} from "./traffic-materializer.js";
import type { TrafficSource } from "../contracts/index.js";
import type { AgentLogger } from "../agents/types.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function noopLogger(): AgentLogger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function captureLogger(): { logger: AgentLogger; lines: Array<{ level: string; msg: string }> } {
  const lines: Array<{ level: string; msg: string }> = [];
  const logger: AgentLogger = {
    info: (msg) => lines.push({ level: "info", msg }),
    warn: (msg) => lines.push({ level: "warn", msg }),
    error: (msg) => lines.push({ level: "error", msg }),
  };
  return { logger, lines };
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mat-test-"));
}

function makeSource(
  kind: TrafficSource["spec"]["store"]["kind"],
  extras: Partial<TrafficSource["spec"]["store"]> = {},
  scopeExtras: Partial<TrafficSource["spec"]["scope"]> = {},
  name = "test-ts",
): TrafficSource {
  return {
    apiVersion: "agents.speedscale.io/v1alpha1",
    kind: "TrafficSource",
    metadata: { name },
    spec: {
      store: { kind, ...extras },
      scope: { clusters: ["prod"], ...scopeExtras },
      dlp: { profile: "standard" },
    },
  };
}

/** Exec stub that captures the last call and succeeds. */
function makeExecStub(stdout = "", stderr = "") {
  let lastCmd = "";
  let lastEnv: NodeJS.ProcessEnv | undefined;
  const execFn = async (
    cmd: string,
    opts?: { env?: NodeJS.ProcessEnv },
  ): Promise<{ stdout: string; stderr: string }> => {
    lastCmd = cmd;
    lastEnv = opts?.env;
    return { stdout, stderr };
  };
  return {
    execFn,
    get lastCmd() { return lastCmd; },
    get lastEnv() { return lastEnv; },
  };
}

function failingExecStub(msg = "exec failed") {
  return async (_cmd: string): Promise<never> => { throw new Error(msg); };
}

// ── local-fs ──────────────────────────────────────────────────────────────────

test("local-fs: returned unchanged (no exec, no dir creation)", async () => {
  const source = makeSource("local-fs", { path: "/existing/snap" });
  const runDir = await tempDir();
  try {
    const result = await materializeTrafficSource(source, { runDir, logger: noopLogger() });
    assert.equal(result, source, "should be the exact same object reference");
    // no snapshot subdir should have been created
    const entries = await fs.readdir(runDir);
    assert.equal(entries.length, 0, "runDir should remain empty for local-fs");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

// ── unknown kind ──────────────────────────────────────────────────────────────

test("unknown kind throws with helpful message", async () => {
  const source = makeSource("local-fs");
  // @ts-ignore — force an unknown kind to test the guard
  source.spec.store.kind = "fluent-bit";
  const runDir = await tempDir();
  try {
    await assert.rejects(
      () => materializeTrafficSource(source, { runDir, logger: noopLogger() }),
      (err: Error) => {
        assert.ok(err.message.includes('"fluent-bit"'), "error should name the unknown kind");
        assert.ok(err.message.includes("no adapter"), "error should say no adapter");
        return true;
      },
    );
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

// ── speedscale-cloud ──────────────────────────────────────────────────────────

test("speedscale-cloud: calls proxymock cloud pull snapshot with snapshot ID", async () => {
  const source = makeSource("speedscale-cloud", { path: "abc-123-snapshot-id" });
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(source, {
      runDir, logger: noopLogger(), execFn: stub.execFn,
      proxymockPath: "/usr/local/bin/proxymock",
    });
    assert.ok(stub.lastCmd.includes("cloud"), "cmd should include 'cloud'");
    assert.ok(stub.lastCmd.includes("pull"), "cmd should include 'pull'");
    assert.ok(stub.lastCmd.includes("snapshot"), "cmd should include 'snapshot'");
    assert.ok(stub.lastCmd.includes("abc-123-snapshot-id"), "cmd should include snapshot ID");
    assert.ok(stub.lastCmd.includes("--out"), "cmd should include --out");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("speedscale-cloud: result has kind=local-fs pointing at snapshot subdir", async () => {
  const source = makeSource("speedscale-cloud", { path: "snap-uuid" }, {}, "cloud-ts");
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    const result = await materializeTrafficSource(source, {
      runDir, logger: noopLogger(), execFn: stub.execFn,
    });
    assert.equal(result.spec.store.kind, "local-fs");
    assert.equal(result.spec.store.path, path.join(runDir, "snapshot", "cloud-ts"));
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("speedscale-cloud: throws when store.path (snapshot ID) is missing", async () => {
  const source = makeSource("speedscale-cloud"); // no path
  const runDir = await tempDir();
  try {
    await assert.rejects(
      () => materializeTrafficSource(source, { runDir, logger: noopLogger(), execFn: makeExecStub().execFn }),
      /snapshot ID/,
    );
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("speedscale-cloud: injects SPEEDSCALE_API_KEY from auth secret", async () => {
  const source = makeSource("speedscale-cloud", {
    path: "snap-id",
    auth: { secretRef: { name: "spd-key", key: "api-key" } },
  });
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(source, {
      runDir, logger: noopLogger(), execFn: stub.execFn,
      namespace: "default",
      readSecret: async (_ns, name, key) => {
        assert.equal(name, "spd-key");
        assert.equal(key, "api-key");
        return "my-api-key";
      },
    });
    assert.equal(stub.lastEnv?.SPEEDSCALE_API_KEY, "my-api-key");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

// ── speedscale-onprem ─────────────────────────────────────────────────────────

test("speedscale-onprem: cmd includes --app-url from store.endpoint", async () => {
  const source = makeSource("speedscale-onprem", {
    path: "snap-uuid",
    endpoint: "https://speedscale.mycompany.com",
  });
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(source, {
      runDir, logger: noopLogger(), execFn: stub.execFn,
    });
    assert.ok(stub.lastCmd.includes("--app-url"), "cmd should include --app-url");
    assert.ok(stub.lastCmd.includes("mycompany.com"), "cmd should include on-prem URL");
    assert.ok(stub.lastCmd.includes("snap-uuid"), "cmd should include snapshot ID");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("speedscale-onprem: throws when store.endpoint is missing", async () => {
  const source = makeSource("speedscale-onprem", { path: "snap-uuid" }); // no endpoint
  const runDir = await tempDir();
  try {
    await assert.rejects(
      () => materializeTrafficSource(source, { runDir, logger: noopLogger(), execFn: makeExecStub().execFn }),
      /store\.endpoint/,
    );
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("speedscale-onprem: throws when store.path (snapshot ID) is missing", async () => {
  const source = makeSource("speedscale-onprem", { endpoint: "https://speedscale.mycompany.com" });
  const runDir = await tempDir();
  try {
    await assert.rejects(
      () => materializeTrafficSource(source, { runDir, logger: noopLogger(), execFn: makeExecStub().execFn }),
      /snapshot ID/,
    );
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

// ── loki ─────────────────────────────────────────────────────────────────────

test("loki: snapshot dir is created", async () => {
  const source = makeSource("loki", { endpoint: "http://loki:3100" }, {}, "loki-ts");
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(source, { runDir, logger: noopLogger(), execFn: stub.execFn });
    const snapshotDir = path.join(runDir, "snapshot", "loki-ts");
    assert.ok((await fs.stat(snapshotDir)).isDirectory());
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("loki: cmd includes --loki-url and --out-dir", async () => {
  const source = makeSource("loki", { endpoint: "http://loki.monitoring:3100" });
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(source, { runDir, logger: noopLogger(), execFn: stub.execFn });
    assert.ok(stub.lastCmd.includes("--loki-url"));
    assert.ok(stub.lastCmd.includes("loki.monitoring:3100"));
    assert.ok(stub.lastCmd.includes("--out-dir"));
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("loki: --logql flag used when store.logql is set (no --cluster)", async () => {
  const source = makeSource("loki", { endpoint: "http://loki:3100", logql: '{app="x"} |= "ERR"' });
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(source, { runDir, logger: noopLogger(), execFn: stub.execFn });
    assert.ok(stub.lastCmd.includes("--logql"));
    assert.ok(!stub.lastCmd.includes("--cluster"), "should not include --cluster when logql is set");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("loki: scope cluster/service filters used when no logql", async () => {
  const source = makeSource("loki", { endpoint: "http://loki:3100" }, { clusters: ["us-east"], services: ["radar"] });
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(source, { runDir, logger: noopLogger(), execFn: stub.execFn });
    assert.ok(stub.lastCmd.includes("--cluster"));
    assert.ok(stub.lastCmd.includes("us-east"));
    assert.ok(stub.lastCmd.includes("--service"));
    assert.ok(stub.lastCmd.includes("radar"));
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("loki: default window is -1h", async () => {
  const source = makeSource("loki", { endpoint: "http://loki:3100" });
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(source, { runDir, logger: noopLogger(), execFn: stub.execFn });
    assert.ok(stub.lastCmd.includes("-1h"));
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("loki: custom window passed as --start", async () => {
  const source = makeSource("loki", { endpoint: "http://loki:3100", window: "-30m" });
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(source, { runDir, logger: noopLogger(), execFn: stub.execFn });
    assert.ok(stub.lastCmd.includes("--start"));
    assert.ok(stub.lastCmd.includes("-30m"));
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("loki: throws when store.endpoint is missing", async () => {
  const source = makeSource("loki"); // no endpoint
  const runDir = await tempDir();
  try {
    await assert.rejects(
      () => materializeTrafficSource(source, { runDir, logger: noopLogger(), execFn: makeExecStub().execFn }),
      /store\.endpoint/,
    );
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("loki: LOKI_AUTH_TOKEN injected from auth secret", async () => {
  const source = makeSource("loki", {
    endpoint: "http://loki:3100",
    auth: { secretRef: { name: "loki-creds", key: "token" } },
  });
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(source, {
      runDir, logger: noopLogger(), execFn: stub.execFn,
      namespace: "prod",
      readSecret: async () => "my-loki-token",
    });
    assert.equal(stub.lastEnv?.LOKI_AUTH_TOKEN, "my-loki-token");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("loki: auth secret failure logs warning but does not throw", async () => {
  const source = makeSource("loki", {
    endpoint: "http://loki:3100",
    auth: { secretRef: { name: "missing-secret", key: "token" } },
  });
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    const { logger, lines } = captureLogger();
    await materializeTrafficSource(source, {
      runDir, logger, execFn: stub.execFn,
      namespace: "prod",
      readSecret: async () => { throw new Error("not found"); },
    });
    assert.ok(lines.some((l) => l.level === "warn"), "should warn on secret read failure");
    assert.equal(stub.lastEnv, undefined, "env should be undefined when auth fails");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

// ── elasticsearch ─────────────────────────────────────────────────────────────

test("elasticsearch: cmd includes --es-url and --out-dir", async () => {
  const source = makeSource("elasticsearch", { endpoint: "http://es.observability:9200" });
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(source, { runDir, logger: noopLogger(), execFn: stub.execFn });
    assert.ok(stub.lastCmd.includes("--es-url"), "cmd should include --es-url");
    assert.ok(stub.lastCmd.includes("es.observability:9200"), "cmd should include the ES URL");
    assert.ok(stub.lastCmd.includes("--out-dir"), "cmd should include --out-dir");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("elasticsearch: result has kind=local-fs and correct path", async () => {
  const source = makeSource("elasticsearch", { endpoint: "http://es:9200" }, {}, "es-ts");
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    const result = await materializeTrafficSource(source, {
      runDir, logger: noopLogger(), execFn: stub.execFn,
    });
    assert.equal(result.spec.store.kind, "local-fs");
    assert.equal(result.spec.store.path, path.join(runDir, "snapshot", "es-ts"));
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("elasticsearch: --query flag used when store.query is set (no --cluster)", async () => {
  const source = makeSource("elasticsearch", {
    endpoint: "http://es:9200",
    query: '{"match":{"service":"radar"}}',
  });
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(source, { runDir, logger: noopLogger(), execFn: stub.execFn });
    assert.ok(stub.lastCmd.includes("--query"), "cmd should include --query");
    assert.ok(stub.lastCmd.includes("radar"), "cmd should include query content");
    assert.ok(!stub.lastCmd.includes("--cluster"), "should not include --cluster when query is set");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("elasticsearch: scope cluster/service filters used when no query", async () => {
  const source = makeSource("elasticsearch", { endpoint: "http://es:9200" }, { clusters: ["prod"], services: ["frontend"] });
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(source, { runDir, logger: noopLogger(), execFn: stub.execFn });
    assert.ok(stub.lastCmd.includes("--cluster"));
    assert.ok(stub.lastCmd.includes("prod"));
    assert.ok(stub.lastCmd.includes("--service"));
    assert.ok(stub.lastCmd.includes("frontend"));
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("elasticsearch: default window is -1h", async () => {
  const source = makeSource("elasticsearch", { endpoint: "http://es:9200" });
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(source, { runDir, logger: noopLogger(), execFn: stub.execFn });
    assert.ok(stub.lastCmd.includes("-1h"));
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("elasticsearch: custom window passed as --start", async () => {
  const source = makeSource("elasticsearch", { endpoint: "http://es:9200", window: "-30m" });
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(source, { runDir, logger: noopLogger(), execFn: stub.execFn });
    assert.ok(stub.lastCmd.includes("--start"));
    assert.ok(stub.lastCmd.includes("-30m"));
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("elasticsearch: custom esGatherPath used in command", async () => {
  const source = makeSource("elasticsearch", { endpoint: "http://es:9200" });
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(source, {
      runDir, logger: noopLogger(), execFn: stub.execFn,
      esGatherPath: "/opt/es-gather",
    });
    assert.ok(stub.lastCmd.includes("/opt/es-gather"));
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("elasticsearch: throws when store.endpoint is missing", async () => {
  const source = makeSource("elasticsearch"); // no endpoint
  const runDir = await tempDir();
  try {
    await assert.rejects(
      () => materializeTrafficSource(source, { runDir, logger: noopLogger(), execFn: makeExecStub().execFn }),
      /store\.endpoint/,
    );
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

// ── error propagation ────────────────────────────────────────────────────────

test("exec failure is wrapped with source name and kind", async () => {
  const source = makeSource("loki", { endpoint: "http://loki:3100" }, {}, "my-loki-src");
  const runDir = await tempDir();
  try {
    await assert.rejects(
      () => materializeTrafficSource(source, {
        runDir, logger: noopLogger(), execFn: failingExecStub("connection refused"),
      }),
      (err: Error) => {
        assert.ok(err.message.includes("my-loki-src"), "error should name the source");
        assert.ok(err.message.includes("loki"), "error should name the kind");
        assert.ok(err.message.includes("connection refused"), "error should include original message");
        return true;
      },
    );
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

// ── immutability ──────────────────────────────────────────────────────────────

test("original source object is not mutated by materialization", async () => {
  const source = makeSource("loki", { endpoint: "http://loki:3100", logql: "{x=1}" });
  const originalKind = source.spec.store.kind;
  const originalEndpoint = source.spec.store.endpoint;
  const runDir = await tempDir();
  try {
    await materializeTrafficSource(source, {
      runDir, logger: noopLogger(), execFn: makeExecStub().execFn,
    });
    assert.equal(source.spec.store.kind, originalKind);
    assert.equal(source.spec.store.endpoint, originalEndpoint);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

// ── materializeTrafficSources (batch) ────────────────────────────────────────

test("materializeTrafficSources handles mixed source list", async () => {
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    const sources: TrafficSource[] = [
      makeSource("local-fs", { path: "/snap1" }, {}, "src-local"),
      makeSource("loki", { endpoint: "http://loki:3100" }, {}, "src-loki"),
      makeSource("speedscale-cloud", { path: "uuid-456" }, {}, "src-cloud"),
    ];
    const results = await materializeTrafficSources(sources, {
      runDir, logger: noopLogger(), execFn: stub.execFn,
    });
    assert.equal(results.length, 3);
    // local-fs: same reference, path unchanged
    assert.equal(results[0], sources[0]);
    // loki: rewritten to local-fs
    assert.equal(results[1].spec.store.kind, "local-fs");
    assert.equal(results[1].metadata.name, "src-loki");
    // speedscale-cloud: rewritten to local-fs
    assert.equal(results[2].spec.store.kind, "local-fs");
    assert.equal(results[2].metadata.name, "src-cloud");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

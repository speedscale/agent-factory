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
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
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

function makeLocalSource(name = "my-ts"): TrafficSource {
  return {
    apiVersion: "agents.speedscale.io/v1alpha1",
    kind: "TrafficSource",
    metadata: { name },
    spec: {
      store: { kind: "local-fs", path: "/some/path" },
      scope: { clusters: ["prod"] },
      dlp: { profile: "standard" },
    },
  };
}

function makeLokiSource(
  opts: {
    name?: string;
    endpoint?: string;
    logql?: string;
    window?: string;
    clusters?: string[];
    services?: string[];
    auth?: TrafficSource["spec"]["store"]["auth"];
  } = {},
): TrafficSource {
  return {
    apiVersion: "agents.speedscale.io/v1alpha1",
    kind: "TrafficSource",
    metadata: { name: opts.name ?? "loki-ts" },
    spec: {
      store: {
        kind: "loki",
        endpoint: opts.endpoint ?? "http://loki:3100",
        logql: opts.logql,
        window: opts.window,
        auth: opts.auth,
      },
      scope: {
        clusters: opts.clusters ?? ["prod"],
        services: opts.services,
      },
      dlp: { profile: "standard" },
    },
  };
}

/** Exec stub that succeeds immediately, recording the last call. */
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
  return { execFn, get lastCmd() { return lastCmd; }, get lastEnv() { return lastEnv; } };
}

/** Exec stub that always throws. */
function failingExecStub(msg = "loki unavailable") {
  return async (_cmd: string): Promise<never> => {
    throw new Error(msg);
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

test("non-loki sources pass through unchanged", async () => {
  const source = makeLocalSource();
  const runDir = await tempDir();
  try {
    const result = await materializeTrafficSource(source, {
      runDir,
      logger: noopLogger(),
    });
    assert.deepEqual(result, source);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("loki source: snapshot dir is created", async () => {
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(makeLokiSource({ name: "ts1" }), {
      runDir,
      logger: noopLogger(),
      execFn: stub.execFn,
    });
    const snapshotDir = path.join(runDir, "snapshot", "ts1");
    const stat = await fs.stat(snapshotDir);
    assert.ok(stat.isDirectory(), "snapshot dir should be created");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("loki source: returned source has kind=local-fs and correct path", async () => {
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    const result = await materializeTrafficSource(makeLokiSource({ name: "ts2" }), {
      runDir,
      logger: noopLogger(),
      execFn: stub.execFn,
    });
    assert.equal(result.spec.store.kind, "local-fs");
    assert.equal(result.spec.store.path, path.join(runDir, "snapshot", "ts2"));
    // loki-specific fields cleared
    assert.equal(result.spec.store.logql, undefined);
    assert.equal(result.spec.store.window, undefined);
    assert.equal(result.spec.store.endpoint, undefined);
    assert.equal(result.spec.store.auth, undefined);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("loki source: command includes --loki-url and --out-dir", async () => {
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(
      makeLokiSource({ endpoint: "http://loki.monitoring:3100" }),
      { runDir, logger: noopLogger(), execFn: stub.execFn },
    );
    assert.ok(stub.lastCmd.includes("--loki-url"), "cmd should include --loki-url");
    assert.ok(stub.lastCmd.includes("http://loki.monitoring:3100"), "cmd should contain the endpoint");
    assert.ok(stub.lastCmd.includes("--out-dir"), "cmd should include --out-dir");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("loki source: --logql used when store.logql is set", async () => {
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(
      makeLokiSource({ logql: '{app="my-app"} |= "ERROR"' }),
      { runDir, logger: noopLogger(), execFn: stub.execFn },
    );
    assert.ok(stub.lastCmd.includes("--logql"), "cmd should include --logql flag");
    assert.ok(stub.lastCmd.includes("my-app"), "cmd should embed the query");
    // cluster/service filters must NOT appear when --logql is set
    assert.ok(!stub.lastCmd.includes("--cluster"), "cmd should not include --cluster when logql is set");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("loki source: scope filters used when no logql", async () => {
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(
      makeLokiSource({ clusters: ["us-east-1"], services: ["radar"] }),
      { runDir, logger: noopLogger(), execFn: stub.execFn },
    );
    assert.ok(stub.lastCmd.includes("--cluster"), "cmd should include --cluster");
    assert.ok(stub.lastCmd.includes("us-east-1"), "cmd should include cluster name");
    assert.ok(stub.lastCmd.includes("--service"), "cmd should include --service");
    assert.ok(stub.lastCmd.includes("radar"), "cmd should include service name");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("loki source: custom window passed as --start", async () => {
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(
      makeLokiSource({ window: "-30m" }),
      { runDir, logger: noopLogger(), execFn: stub.execFn },
    );
    assert.ok(stub.lastCmd.includes("--start"), "cmd should include --start");
    assert.ok(stub.lastCmd.includes("-30m"), "cmd should include custom window");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("loki source: default window is -1h", async () => {
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(
      makeLokiSource(), // no window set
      { runDir, logger: noopLogger(), execFn: stub.execFn },
    );
    assert.ok(stub.lastCmd.includes("-1h"), "default window should be -1h");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("loki source: custom lokiGatherPath used in command", async () => {
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    await materializeTrafficSource(makeLokiSource(), {
      runDir,
      logger: noopLogger(),
      execFn: stub.execFn,
      lokiGatherPath: "/opt/my-loki-gather",
    });
    assert.ok(
      stub.lastCmd.includes("/opt/my-loki-gather"),
      "custom lokiGatherPath should appear in command",
    );
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("loki source: exec failure is wrapped and rethrown", async () => {
  const runDir = await tempDir();
  try {
    await assert.rejects(
      () =>
        materializeTrafficSource(makeLokiSource(), {
          runDir,
          logger: noopLogger(),
          execFn: failingExecStub("connection refused"),
        }),
      (err: Error) => {
        assert.ok(err.message.includes("loki-gather failed"), "error should mention loki-gather failed");
        assert.ok(err.message.includes("connection refused"), "error should include original message");
        return true;
      },
    );
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("loki source: missing endpoint throws before exec", async () => {
  const runDir = await tempDir();
  try {
    const source = makeLokiSource();
    source.spec.store.endpoint = undefined; // endpoint is optional — remove it to trigger validation
    const stub = makeExecStub();
    await assert.rejects(
      () => materializeTrafficSource(source, { runDir, logger: noopLogger(), execFn: stub.execFn }),
      /store\.endpoint is not set/,
    );
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("loki source: auth secret is read and injected as LOKI_AUTH_TOKEN env var", async () => {
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    const source = makeLokiSource({
      auth: { secretRef: { name: "loki-creds", key: "token" } },
    });
    await materializeTrafficSource(source, {
      runDir,
      logger: noopLogger(),
      execFn: stub.execFn,
      readSecret: async (_ns, name, key) => {
        assert.equal(name, "loki-creds");
        assert.equal(key, "token");
        return "my-bearer-token";
      },
      namespace: "prod",
    });
    assert.equal(stub.lastEnv?.LOKI_AUTH_TOKEN, "my-bearer-token");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("loki source: auth secret failure logs warning but does not throw", async () => {
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    const { logger, lines } = captureLogger();
    const source = makeLokiSource({
      auth: { secretRef: { name: "missing-secret", key: "token" } },
    });
    // Should NOT throw — missing auth is a warn-and-continue
    await materializeTrafficSource(source, {
      runDir,
      logger,
      execFn: stub.execFn,
      readSecret: async () => { throw new Error("secret not found"); },
      namespace: "prod",
    });
    const warnLine = lines.find((l) => l.level === "warn" && l.msg.includes("auth secret"));
    assert.ok(warnLine, "should log a warning when secret read fails");
    // env should not have LOKI_AUTH_TOKEN
    assert.equal(stub.lastEnv, undefined);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("materializeTrafficSources: passes through mixed source list", async () => {
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    const sources: TrafficSource[] = [
      makeLocalSource("local1"),
      makeLokiSource({ name: "loki1" }),
      makeLocalSource("local2"),
    ];
    const results = await materializeTrafficSources(sources, {
      runDir,
      logger: noopLogger(),
      execFn: stub.execFn,
    });
    assert.equal(results.length, 3);
    assert.equal(results[0].spec.store.kind, "local-fs");
    assert.equal(results[0].metadata.name, "local1");
    assert.equal(results[1].spec.store.kind, "local-fs"); // materialized
    assert.equal(results[1].metadata.name, "loki1");
    assert.equal(results[2].spec.store.kind, "local-fs");
    assert.equal(results[2].metadata.name, "local2");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("original source object is not mutated by materialization", async () => {
  const runDir = await tempDir();
  try {
    const stub = makeExecStub();
    const source = makeLokiSource();
    const originalKind = source.spec.store.kind;
    const originalEndpoint = source.spec.store.endpoint;
    await materializeTrafficSource(source, { runDir, logger: noopLogger(), execFn: stub.execFn });
    assert.equal(source.spec.store.kind, originalKind, "original kind must not be mutated");
    assert.equal(source.spec.store.endpoint, originalEndpoint, "original endpoint must not be mutated");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

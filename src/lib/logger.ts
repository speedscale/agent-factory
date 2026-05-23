/**
 * Structured JSON logger.
 *
 * Every line is a single JSON object on stdout so the OTel Collector +
 * Loki can parse fields without bespoke regex. The Grafana dashboard
 * filters on `run_id`, so dispatcher/worker code paths must carry that
 * field on every line they emit during a run.
 *
 * Replaces the ad-hoc `console.log("[run=...]", ...)` prefix style.
 *
 * Shape:
 *   {"ts":"2026-05-23T15:30:00.000Z","level":"info","component":"controller",
 *    "instance":"minikube-local","run_id":"smoke-test-demo-node-002",
 *    "agent_app":"demo-node","msg":"dispatching agent","agent":"triage"}
 *
 * Field promotion to Loki labels is collector-side. The dashboard's
 * logs panel uses `| json | run_id="$run_id"` so filtering works even
 * when `run_id` is part of the log body rather than a Loki label.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerFields {
  instance?: string;
  run_id?: string;
  agent_app?: string;
  agent?: string;
  namespace?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  /**
   * Child logger with additional bound fields. Bound fields appear on
   * every subsequent line; per-call `extra` merges on top.
   */
  child(fields: LoggerFields): Logger;
}

export interface CreateLoggerOptions {
  component: string;
  fields?: LoggerFields;
  /** Override for tests; defaults to writing to stdout/stderr. */
  write?: (level: LogLevel, line: string) => void;
}

function defaultWrite(level: LogLevel, line: string): void {
  if (level === "warn" || level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  const component = opts.component;
  const bound: LoggerFields = { ...(opts.fields ?? {}) };
  const write = opts.write ?? defaultWrite;

  function emit(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      component,
      ...bound,
      ...(extra ?? {}),
      msg,
    };
    // Drop undefined values so JSON stays compact.
    for (const k of Object.keys(record)) {
      if (record[k] === undefined) delete record[k];
    }
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      // Fall back to a minimal record if `extra` contained a cycle.
      line = JSON.stringify({ ts: record.ts, level, component, msg, jsonError: true });
    }
    write(level, line);
  }

  const logger: Logger = {
    debug: (msg, extra) => emit("debug", msg, extra),
    info: (msg, extra) => emit("info", msg, extra),
    warn: (msg, extra) => emit("warn", msg, extra),
    error: (msg, extra) => emit("error", msg, extra),
    child: (fields) =>
      createLogger({
        component,
        fields: { ...bound, ...fields },
        write,
      }),
  };

  return logger;
}

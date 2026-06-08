/**
 * otlp-converter — converts OTLP log record bodies back to RRPair JSON.
 *
 * The Speedscale forwarder encodes each RRPair as an OTLP log record:
 *   RRPair → protojson → map[string]any → OTLP MapValue (KeyValue pairs)
 *
 * The @grpc/proto-loader deserializes the protobuf into plain JS objects.
 * This module reverses the OTLP MapValue encoding back to flat JSON objects
 * that match the RawRRPair shape analyzeSnapshot() reads from .json files.
 */

// ── OTLP wire types as deserialized by @grpc/proto-loader ────────────────────
// proto-loader with { longs: String, enums: String, defaults: true, oneofs: true }
// produces these shapes from the AnyValue oneof.

export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;   // proto-loader encodes int64 as string
  doubleValue?: number;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: OtlpKeyValue[] };
  bytesValue?: Buffer | Uint8Array | string;
}

export interface OtlpKeyValue {
  key: string;
  value?: OtlpAnyValue;
}

export interface OtlpLogRecord {
  timeUnixNano?: string | number;
  observedTimeUnixNano?: string | number;
  severityNumber?: number | string;
  severityText?: string;
  body?: OtlpAnyValue;
  attributes?: OtlpKeyValue[];
  droppedAttributesCount?: number;
  flags?: number;
  traceId?: Buffer | Uint8Array;
  spanId?: Buffer | Uint8Array;
}

export interface OtlpScopeLogs {
  scope?: { name?: string; version?: string };
  logRecords?: OtlpLogRecord[];
  schemaUrl?: string;
}

export interface OtlpResourceLogs {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeLogs?: OtlpScopeLogs[];
  schemaUrl?: string;
}

export interface ExportLogsServiceRequest {
  resourceLogs?: OtlpResourceLogs[];
}

// ── Parsed output ────────────────────────────────────────────────────────────

export interface ParsedOtlpRecord {
  service: string;
  namespace: string;
  rrpair: Record<string, unknown>;
  tags: Record<string, string>;
}

// ── Conversion ───────────────────────────────────────────────────────────────

/**
 * Convert an OTLP AnyValue (as deserialized by proto-loader) to a plain JS value.
 * Reverses the forwarder's jsonValueToOTEL().
 */
export function anyValueToJs(v: OtlpAnyValue | undefined | null): unknown {
  if (!v) return null;

  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.boolValue === "boolean") return v.boolValue;
  if (v.intValue !== undefined && v.intValue !== null) {
    const n = typeof v.intValue === "string" ? Number(v.intValue) : v.intValue;
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v.doubleValue === "number") return v.doubleValue;

  if (v.kvlistValue?.values) {
    const obj: Record<string, unknown> = {};
    for (const kv of v.kvlistValue.values) {
      obj[kv.key] = anyValueToJs(kv.value);
    }
    return obj;
  }

  if (v.arrayValue?.values) {
    return v.arrayValue.values.map((item) => anyValueToJs(item));
  }

  if (v.bytesValue !== undefined && v.bytesValue !== null) {
    if (Buffer.isBuffer(v.bytesValue)) return v.bytesValue.toString("base64");
    if (v.bytesValue instanceof Uint8Array) return Buffer.from(v.bytesValue).toString("base64");
    return String(v.bytesValue);
  }

  return null;
}

/**
 * Extract service, namespace, and tag.* attributes from an OTLP log record.
 */
function extractAttributes(attrs: OtlpKeyValue[] | undefined): {
  service: string;
  namespace: string;
  tags: Record<string, string>;
} {
  let service = "";
  let namespace = "";
  const tags: Record<string, string> = {};

  if (!attrs) return { service, namespace, tags };

  for (const kv of attrs) {
    const val = anyValueToJs(kv.value);
    const str = typeof val === "string" ? val : String(val ?? "");

    if (kv.key === "service") {
      service = str;
    } else if (kv.key === "namespace") {
      namespace = str;
    } else if (kv.key.startsWith("tag.")) {
      tags[kv.key.slice(4)] = str;
    }
  }

  return { service, namespace, tags };
}

/**
 * Parse a single OTLP log record into a ParsedOtlpRecord.
 * Returns null if the record body cannot be converted (malformed data).
 */
export function parseOtlpLogRecord(record: OtlpLogRecord): ParsedOtlpRecord | null {
  const body = record.body;
  if (!body) return null;

  const rrpair = anyValueToJs(body);
  if (typeof rrpair !== "object" || rrpair === null || Array.isArray(rrpair)) {
    return null;
  }

  const { service, namespace, tags } = extractAttributes(record.attributes);

  return {
    service: service || (rrpair as Record<string, unknown>).service as string || "unknown",
    namespace: namespace || (rrpair as Record<string, unknown>).namespace as string || "",
    rrpair: rrpair as Record<string, unknown>,
    tags,
  };
}

/**
 * Extract all log records from an ExportLogsServiceRequest.
 * Yields ParsedOtlpRecord for each successfully parsed record.
 */
export function* extractRecords(request: ExportLogsServiceRequest): Generator<ParsedOtlpRecord> {
  if (!request.resourceLogs) return;

  for (const rl of request.resourceLogs) {
    if (!rl.scopeLogs) continue;
    for (const sl of rl.scopeLogs) {
      if (!sl.logRecords) continue;
      for (const lr of sl.logRecords) {
        const parsed = parseOtlpLogRecord(lr);
        if (parsed) yield parsed;
      }
    }
  }
}

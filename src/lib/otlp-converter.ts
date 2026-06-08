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
  // Support both camelCase (tests) and snake_case (proto-loader keepCase:true).
  stringValue?: string;
  string_value?: string;
  boolValue?: boolean;
  bool_value?: boolean;
  intValue?: string | number;   // proto-loader encodes int64 as string
  int_value?: string | number;
  doubleValue?: number;
  double_value?: number;
  arrayValue?: { values?: OtlpAnyValue[] };
  array_value?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: OtlpKeyValue[] };
  kvlist_value?: { values?: OtlpKeyValue[] };
  bytesValue?: Buffer | Uint8Array | string;
  bytes_value?: Buffer | Uint8Array | string;
}

export interface OtlpKeyValue {
  key: string;
  value?: OtlpAnyValue;
}

export interface OtlpLogRecord {
  // proto-loader with keepCase:true preserves snake_case from the proto.
  // Support both snake_case (runtime) and camelCase (tests / manual construction).
  timeUnixNano?: string | number;
  time_unix_nano?: string | number;
  observedTimeUnixNano?: string | number;
  observed_time_unix_nano?: string | number;
  severityNumber?: number | string;
  severity_number?: number | string;
  severityText?: string;
  severity_text?: string;
  body?: OtlpAnyValue;
  attributes?: OtlpKeyValue[];
  droppedAttributesCount?: number;
  dropped_attributes_count?: number;
  flags?: number;
  traceId?: Buffer | Uint8Array;
  trace_id?: Buffer | Uint8Array;
  spanId?: Buffer | Uint8Array;
  span_id?: Buffer | Uint8Array;
}

export interface OtlpScopeLogs {
  scope?: { name?: string; version?: string };
  logRecords?: OtlpLogRecord[];
  log_records?: OtlpLogRecord[];
  schemaUrl?: string;
  schema_url?: string;
}

export interface OtlpResourceLogs {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeLogs?: OtlpScopeLogs[];
  scope_logs?: OtlpScopeLogs[];
  schemaUrl?: string;
  schema_url?: string;
}

export interface ExportLogsServiceRequest {
  resourceLogs?: OtlpResourceLogs[];
  resource_logs?: OtlpResourceLogs[];
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

  // Handle both camelCase and snake_case field names (proto-loader keepCase:true).
  const strVal = v.stringValue ?? v.string_value;
  if (typeof strVal === "string") return strVal;

  const boolVal = v.boolValue ?? v.bool_value;
  if (typeof boolVal === "boolean") return boolVal;

  const intVal = v.intValue ?? v.int_value;
  if (intVal !== undefined && intVal !== null) {
    const n = typeof intVal === "string" ? Number(intVal) : intVal;
    return Number.isFinite(n) ? n : 0;
  }

  const dblVal = v.doubleValue ?? v.double_value;
  if (typeof dblVal === "number") return dblVal;

  const kvList = v.kvlistValue ?? v.kvlist_value;
  if (kvList?.values) {
    const obj: Record<string, unknown> = {};
    for (const kv of kvList.values) {
      obj[kv.key] = anyValueToJs(kv.value);
    }
    return obj;
  }

  const arrVal = v.arrayValue ?? v.array_value;
  if (arrVal?.values) {
    return arrVal.values.map((item) => anyValueToJs(item));
  }

  const bytesVal = v.bytesValue ?? v.bytes_value;
  if (bytesVal !== undefined && bytesVal !== null) {
    if (Buffer.isBuffer(bytesVal)) return bytesVal.toString("base64");
    if (bytesVal instanceof Uint8Array) return Buffer.from(bytesVal).toString("base64");
    return String(bytesVal);
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
  const resourceLogs = request.resourceLogs ?? request.resource_logs;
  if (!resourceLogs) return;

  for (const rl of resourceLogs) {
    const scopeLogs = rl.scopeLogs ?? rl.scope_logs;
    if (!scopeLogs) continue;
    for (const sl of scopeLogs) {
      const logRecords = sl.logRecords ?? sl.log_records;
      if (!logRecords) continue;
      for (const lr of logRecords) {
        const parsed = parseOtlpLogRecord(lr);
        if (parsed) yield parsed;
      }
    }
  }
}

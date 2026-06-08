import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  anyValueToJs,
  parseOtlpLogRecord,
  extractRecords,
  type OtlpAnyValue,
  type OtlpLogRecord,
  type ExportLogsServiceRequest,
} from "./otlp-converter.js";

describe("anyValueToJs", () => {
  it("converts stringValue", () => {
    assert.equal(anyValueToJs({ stringValue: "hello" }), "hello");
  });

  it("converts boolValue", () => {
    assert.equal(anyValueToJs({ boolValue: true }), true);
    assert.equal(anyValueToJs({ boolValue: false }), false);
  });

  it("converts intValue as string (proto-loader longs:String)", () => {
    assert.equal(anyValueToJs({ intValue: "150" }), 150);
  });

  it("converts intValue as number", () => {
    assert.equal(anyValueToJs({ intValue: 42 }), 42);
  });

  it("converts doubleValue", () => {
    assert.equal(anyValueToJs({ doubleValue: 3.14 }), 3.14);
  });

  it("converts kvlistValue to object", () => {
    const v: OtlpAnyValue = {
      kvlistValue: {
        values: [
          { key: "method", value: { stringValue: "GET" } },
          { key: "statusCode", value: { intValue: "200" } },
        ],
      },
    };
    assert.deepEqual(anyValueToJs(v), { method: "GET", statusCode: 200 });
  });

  it("converts nested kvlistValue", () => {
    const v: OtlpAnyValue = {
      kvlistValue: {
        values: [
          {
            key: "http",
            value: {
              kvlistValue: {
                values: [
                  {
                    key: "request",
                    value: {
                      kvlistValue: {
                        values: [
                          { key: "method", value: { stringValue: "POST" } },
                          { key: "url", value: { stringValue: "https://api.example.com/v1/items" } },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    };
    const result = anyValueToJs(v) as Record<string, unknown>;
    const http = result.http as Record<string, unknown>;
    const request = http.request as Record<string, unknown>;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "https://api.example.com/v1/items");
  });

  it("converts arrayValue", () => {
    const v: OtlpAnyValue = {
      arrayValue: {
        values: [
          { stringValue: "a" },
          { stringValue: "b" },
          { intValue: "3" },
        ],
      },
    };
    assert.deepEqual(anyValueToJs(v), ["a", "b", 3]);
  });

  it("returns null for undefined/null input", () => {
    assert.equal(anyValueToJs(undefined), null);
    assert.equal(anyValueToJs(null), null);
  });

  it("returns null for empty object", () => {
    assert.equal(anyValueToJs({}), null);
  });
});

describe("parseOtlpLogRecord", () => {
  it("parses a minimal HTTP RRPair log record", () => {
    const record: OtlpLogRecord = {
      timeUnixNano: "1717200000000000000",
      body: {
        kvlistValue: {
          values: [
            { key: "ts", value: { stringValue: "2026-06-01T00:00:00Z" } },
            { key: "l7protocol", value: { stringValue: "http" } },
            { key: "duration", value: { intValue: "250" } },
            { key: "direction", value: { stringValue: "IN" } },
            {
              key: "http",
              value: {
                kvlistValue: {
                  values: [
                    {
                      key: "request",
                      value: {
                        kvlistValue: {
                          values: [
                            { key: "method", value: { stringValue: "GET" } },
                            { key: "url", value: { stringValue: "https://radar.speedscale.com/api/accounts" } },
                          ],
                        },
                      },
                    },
                    {
                      key: "response",
                      value: {
                        kvlistValue: {
                          values: [
                            { key: "statusCode", value: { intValue: "200" } },
                          ],
                        },
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
      },
      attributes: [
        { key: "service", value: { stringValue: "radar" } },
        { key: "namespace", value: { stringValue: "default" } },
        { key: "tag.env", value: { stringValue: "staging" } },
      ],
    };

    const parsed = parseOtlpLogRecord(record);
    assert.ok(parsed);
    assert.equal(parsed.service, "radar");
    assert.equal(parsed.namespace, "default");
    assert.equal(parsed.tags.env, "staging");
    assert.equal(parsed.rrpair.ts, "2026-06-01T00:00:00Z");
    assert.equal(parsed.rrpair.l7protocol, "http");
    assert.equal(parsed.rrpair.duration, 250);
    assert.equal(parsed.rrpair.direction, "IN");

    const http = parsed.rrpair.http as Record<string, unknown>;
    const request = http.request as Record<string, unknown>;
    assert.equal(request.method, "GET");
    assert.equal(request.url, "https://radar.speedscale.com/api/accounts");
  });

  it("returns null for missing body", () => {
    assert.equal(parseOtlpLogRecord({ body: undefined }), null);
  });

  it("returns null for non-map body", () => {
    assert.equal(parseOtlpLogRecord({ body: { stringValue: "just a string" } }), null);
  });

  it("falls back to rrpair.service when attribute is missing", () => {
    const record: OtlpLogRecord = {
      body: {
        kvlistValue: {
          values: [
            { key: "service", value: { stringValue: "my-svc" } },
          ],
        },
      },
      attributes: [],
    };
    const parsed = parseOtlpLogRecord(record);
    assert.ok(parsed);
    assert.equal(parsed.service, "my-svc");
  });
});

describe("extractRecords", () => {
  it("yields records from nested resourceLogs/scopeLogs/logRecords", () => {
    const request: ExportLogsServiceRequest = {
      resourceLogs: [
        {
          resource: { attributes: [{ key: "cluster", value: { stringValue: "staging" } }] },
          scopeLogs: [
            {
              logRecords: [
                {
                  body: {
                    kvlistValue: {
                      values: [{ key: "l7protocol", value: { stringValue: "http" } }],
                    },
                  },
                  attributes: [{ key: "service", value: { stringValue: "svc-a" } }],
                },
                {
                  body: {
                    kvlistValue: {
                      values: [{ key: "l7protocol", value: { stringValue: "postgres" } }],
                    },
                  },
                  attributes: [{ key: "service", value: { stringValue: "svc-b" } }],
                },
              ],
            },
          ],
        },
      ],
    };

    const records = [...extractRecords(request)];
    assert.equal(records.length, 2);
    assert.equal(records[0].service, "svc-a");
    assert.equal(records[1].service, "svc-b");
  });

  it("skips malformed records without throwing", () => {
    const request: ExportLogsServiceRequest = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                { body: { stringValue: "not a map" }, attributes: [] },
                {
                  body: {
                    kvlistValue: { values: [{ key: "ok", value: { stringValue: "yes" } }] },
                  },
                  attributes: [{ key: "service", value: { stringValue: "good" } }],
                },
              ],
            },
          ],
        },
      ],
    };

    const records = [...extractRecords(request)];
    assert.equal(records.length, 1);
    assert.equal(records[0].service, "good");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OtlpBuffer } from "./otlp-buffer.js";

describe("OtlpBuffer", () => {
  it("buffers records by service and returns on closeWindows", () => {
    const buf = new OtlpBuffer({ windowMs: 60_000, maxRecordsPerService: 100 });

    buf.push("svc-a", { l7protocol: "http", duration: 100 });
    buf.push("svc-a", { l7protocol: "http", duration: 200 });
    buf.push("svc-b", { l7protocol: "postgres", duration: 50 });

    const windows = buf.closeWindows();
    assert.equal(windows.length, 2);

    const a = windows.find((w) => w.service === "svc-a");
    const b = windows.find((w) => w.service === "svc-b");
    assert.ok(a);
    assert.ok(b);
    assert.equal(a.records.length, 2);
    assert.equal(b.records.length, 1);
    assert.equal(a.droppedCount, 0);
  });

  it("returns empty array when no records buffered", () => {
    const buf = new OtlpBuffer();
    assert.deepEqual(buf.closeWindows(), []);
  });

  it("resets after closeWindows", () => {
    const buf = new OtlpBuffer();
    buf.push("svc-a", { x: 1 });
    buf.closeWindows();

    const second = buf.closeWindows();
    assert.equal(second.length, 0);
  });

  it("enforces high-water mark and counts drops", () => {
    const buf = new OtlpBuffer({ windowMs: 60_000, maxRecordsPerService: 3 });

    buf.push("svc", { id: 1 });
    buf.push("svc", { id: 2 });
    buf.push("svc", { id: 3 });
    buf.push("svc", { id: 4 });
    buf.push("svc", { id: 5 });

    const windows = buf.closeWindows();
    assert.equal(windows.length, 1);
    assert.equal(windows[0].records.length, 3);
    assert.equal(windows[0].droppedCount, 2);

    // Oldest records (id:1, id:2) were dropped; newest retained
    const ids = windows[0].records.map((r) => (r as { id: number }).id);
    assert.deepEqual(ids, [3, 4, 5]);
  });

  it("flush returns all pending data", () => {
    const buf = new OtlpBuffer();
    buf.push("a", { x: 1 });
    buf.push("b", { x: 2 });

    const flushed = buf.flush();
    assert.equal(flushed.length, 2);

    // Buffer is empty after flush
    assert.deepEqual(buf.flush(), []);
  });

  it("stats reflects current buffer state", () => {
    const buf = new OtlpBuffer();
    buf.push("a", { x: 1 });
    buf.push("a", { x: 2 });
    buf.push("b", { x: 3 });

    const s = buf.stats();
    assert.equal(s.totalRecords, 3);
    assert.equal(s.serviceCount, 2);
    assert.equal(s.perService.get("a"), 2);
    assert.equal(s.perService.get("b"), 1);
  });

  it("windowStart and windowEnd are ISO timestamps", () => {
    const buf = new OtlpBuffer();
    buf.push("svc", { x: 1 });

    const windows = buf.closeWindows();
    assert.equal(windows.length, 1);
    // ISO format: YYYY-MM-DDTHH:mm:ss.sssZ
    assert.ok(windows[0].windowStart.match(/^\d{4}-\d{2}-\d{2}T/));
    assert.ok(windows[0].windowEnd.match(/^\d{4}-\d{2}-\d{2}T/));
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { getArchiveStorage, LocalArchiveStorage, GcsArchiveStorage, resetArchiveCache } from "./index.js";

function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return silentLogger();
    },
  };
}

test("getArchiveStorage defaults to local with a warning", () => {
  resetArchiveCache();
  let warned = false;
  const log = {
    ...silentLogger(),
    warn() {
      warned = true;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = getArchiveStorage({ env: {}, logger: log as any, fresh: true });
  assert.ok(s instanceof LocalArchiveStorage);
  assert.equal(warned, true, "should warn when defaulting to local");
});

test("AF_ARCHIVE_BUCKET set → gcs", () => {
  resetArchiveCache();
  const s = getArchiveStorage({
    env: { AF_ARCHIVE_BUCKET: "some-bucket" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: silentLogger() as any,
    fresh: true,
  });
  assert.ok(s instanceof GcsArchiveStorage);
});

test("AF_ARCHIVE_BACKEND=gcs forces gcs", () => {
  resetArchiveCache();
  const s = getArchiveStorage({
    env: { AF_ARCHIVE_BACKEND: "gcs" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: silentLogger() as any,
    fresh: true,
  });
  assert.ok(s instanceof GcsArchiveStorage);
});

test("AF_ARCHIVE_BACKEND=local forces local without warning", () => {
  resetArchiveCache();
  let warned = false;
  const log = {
    ...silentLogger(),
    warn() {
      warned = true;
    },
  };
  const s = getArchiveStorage({
    env: { AF_ARCHIVE_BACKEND: "local", AF_ARCHIVE_BUCKET: "ignored" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: log as any,
    fresh: true,
  });
  assert.ok(s instanceof LocalArchiveStorage);
  assert.equal(warned, false, "explicit local should not warn");
});

test("result is cached across calls", () => {
  resetArchiveCache();
  const s1 = getArchiveStorage({
    env: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: silentLogger() as any,
    fresh: true,
  });
  const s2 = getArchiveStorage();
  assert.equal(s1, s2);
});

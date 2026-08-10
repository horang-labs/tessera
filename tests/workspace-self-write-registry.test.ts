import assert from "node:assert/strict";
import test from "node:test";
import {
  clearSelfWrite,
  isSelfWrite,
  markSelfWrite,
} from "../src/lib/workspace-files/workspace-self-write-registry";

const SESSION = "session-1";

test("a path we just wrote is recognised as our own echo, and only that path", () => {
  markSelfWrite(SESSION, "src/app.ts", 1_000);

  assert.equal(isSelfWrite(SESSION, "src/app.ts", 1_000), true);
  assert.equal(isSelfWrite(SESSION, "src/other.ts", 1_000), false);
  assert.equal(isSelfWrite("session-2", "src/app.ts", 1_000), false);
});

test("the stamp expires after the TTL so a later external change is not swallowed", () => {
  markSelfWrite(SESSION, "ttl.ts", 1_000);

  assert.equal(isSelfWrite(SESSION, "ttl.ts", 1_000 + 2_999), true);
  assert.equal(isSelfWrite(SESSION, "ttl.ts", 1_000 + 3_001), false);
});

test("a failed write clears its stamp, so the watcher event is treated as external", () => {
  markSelfWrite(SESSION, "failed.ts", 1_000);
  clearSelfWrite(SESSION, "failed.ts");

  assert.equal(isSelfWrite(SESSION, "failed.ts", 1_000), false);
});

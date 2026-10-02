import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { AutomationRepository } from '../src/lib/automation/repository';
import { DatabaseWrapper } from '../src/lib/db/database';
import { AUTOMATION_SCHEMA } from '../src/lib/db/schema';
const SQLite = require('better-sqlite3');

test('two connections elect one scheduler; expiry fences the old epoch and persists takeover', () => {
  fs.mkdirSync('tmp', { recursive: true });
  const dir = fs.mkdtempSync(path.resolve('tmp/automation-'));
  const one = new DatabaseWrapper(new SQLite(path.join(dir, 'test.db')));
  const two = new DatabaseWrapper(new SQLite(path.join(dir, 'test.db')));
  try {
    one.exec(AUTOMATION_SCHEMA);
    const a = new AutomationRepository(one);
    const b = new AutomationRepository(two);
    assert.equal(a.acquireLease('a', 1000), 1);
    assert.equal(b.acquireLease('b', 1001), null);
    assert.equal(b.acquireLease('b', 21_001), 2);
    assert.equal(a.ownsLease('a', 1, 21_002), false);
    assert.equal(b.ownsLease('b', 2, 21_002), true);
    assert.equal(a.acquireLease('a', 21_003), null);
  } finally { one.close(); two.close(); fs.rmSync(dir, { recursive: true }); }
});

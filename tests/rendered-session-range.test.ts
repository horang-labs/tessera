import assert from 'node:assert/strict';
import test from 'node:test';

import { useSelectionStore } from '../src/stores/selection-store';
import {
  SESSION_RANGE_ROW_ATTRIBUTE,
  SESSION_RANGE_SCOPE_ATTRIBUTE,
  getRenderedSessionRangeIds,
} from '../src/lib/session/rendered-session-range';

class FakeElement {
  parent: FakeElement | null = null;
  readonly children: FakeElement[] = [];

  constructor(private readonly attributes: Record<string, string> = {}) {}

  append(...children: FakeElement[]): this {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
    return this;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  private matches(selector: string): boolean {
    const attribute = /^\[([^\]]+)\]$/.exec(selector)?.[1];
    assert.ok(attribute, `unsupported selector ${selector}`);
    return attribute in this.attributes;
  }

  closest(selector: string): FakeElement | null {
    for (let node: FakeElement | null = this; node; node = node.parent) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

const scope = (name: string) => new FakeElement({ [SESSION_RANGE_SCOPE_ATTRIBUTE]: name });
const row = (id: string) => new FakeElement({ [SESSION_RANGE_ROW_ATTRIBUTE]: id });

test('range order follows rendered rows, not the project-wide sort order', () => {
  // All Projects used each Session's project-wide sortOrder. Rows of other
  // Worktrees sharing those sortOrder values were swept into the range.
  const label = new FakeElement();
  const clicked = row('bl-14').append(label);
  const sidebar = scope('sidebar').append(
    new FakeElement().append(row('other-worktree-8'), row('chat-9')),
    new FakeElement().append(
      new FakeElement(), // expanded Worktree header: not a range row
      row('bl-8'),
      row('bl-9'),
      clicked,
    ),
  );
  assert.ok(sidebar);

  const ids = getRenderedSessionRangeIds(label);
  assert.deepEqual(ids, ['other-worktree-8', 'chat-9', 'bl-8', 'bl-9', 'bl-14']);

  useSelectionStore.getState().setRangeAnchor('bl-8');
  useSelectionStore.getState().rangeSelect('bl-14', ids ?? []);
  assert.deepEqual([...useSelectionStore.getState().selectedIds], ['bl-8', 'bl-9', 'bl-14']);
  useSelectionStore.getState().clearSelection();
});

test('a nested scope keeps its rows out of the outer range', () => {
  const recent = scope('recent-work').append(row('recent-a'), row('shared'));
  const target = row('main-b');
  scope('sidebar').append(recent, row('main-a'), row('shared'), target);

  assert.deepEqual(getRenderedSessionRangeIds(target), ['main-a', 'shared', 'main-b']);
  assert.deepEqual(getRenderedSessionRangeIds(recent.children[0]), ['recent-a', 'shared']);
});

test('clicks outside a scoped row fall back to the caller order', () => {
  assert.equal(getRenderedSessionRangeIds(row('unscoped')), null);
  assert.equal(getRenderedSessionRangeIds(null), null);
  assert.equal(getRenderedSessionRangeIds({}), null);
});

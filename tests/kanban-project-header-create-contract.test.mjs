import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const boardSource = readFileSync(
  new URL('../src/components/board/kanban-board.tsx', import.meta.url),
  'utf8',
);
const columnSource = readFileSync(
  new URL('../src/components/board/kanban-column.tsx', import.meta.url),
  'utf8',
);

test('all-projects kanban exposes quick create from project headers', () => {
  assert.equal(boardSource.match(/groupByProject=\{isAllProjects\}/g)?.length, 2);
  assert.match(columnSource, /testId=\{`kanban-project-add-\$\{column\}-\$\{project\.encodedDir\}`\}/);
  assert.match(columnSource, /projectDir=\{project\.decodedPath\}/);
  assert.match(columnSource, /projectId=\{project\.encodedDir\}/);
});

test('single-project kanban keeps quick create in column headers', () => {
  assert.equal(columnSource.match(/!groupByProject && \(/g)?.length, 2);
  assert.match(columnSource, /testId="kanban-column-add-btn"/);
  assert.match(columnSource, /testId="kanban-workflow-column-add-btn"/);
});

test('project headers remain available as create targets when their column is empty', () => {
  assert.doesNotMatch(
    columnSource,
    /\.filter\(\(group\) => group\.chats\.length > 0\)/,
  );
  assert.doesNotMatch(
    columnSource,
    /\.filter\(\(group\) => group\.tasks\.length \+ group\.chats\.length > 0\)/,
  );
});

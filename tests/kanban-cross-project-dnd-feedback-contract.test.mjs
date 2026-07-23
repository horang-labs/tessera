import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const boardSource = readFileSync('src/components/board/kanban-board.tsx', 'utf8');
const columnSource = readFileSync('src/components/board/kanban-column.tsx', 'utf8');

test('cross-project chat card positions show the native forbidden drop indicator', () => {
  assert.match(
    boardSource,
    /draggingSession\.projectDir !== targetSession\.projectDir[\s\S]*?e\.preventDefault\(\);[\s\S]*?e\.stopPropagation\(\);[\s\S]*?e\.dataTransfer\.dropEffect = 'none';/,
  );
});

test('cross-project task card positions show the native forbidden drop indicator', () => {
  assert.match(
    columnSource,
    /draggingTask\.projectId !== targetTask\.projectId[\s\S]*?e\.preventDefault\(\);[\s\S]*?e\.stopPropagation\(\);[\s\S]*?e\.dataTransfer\.dropEffect = 'none';/,
  );
});

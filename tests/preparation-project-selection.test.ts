import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL_PROJECTS_SENTINEL } from '@/lib/constants/project-strip';
import { resolvePreparationProject } from '@/lib/projects/preparation-project-selection';

const projects = [
  { encodedDir: '/home/work/src/alpha' },
  { encodedDir: '/home/work/src/beta' },
];

test('an asked-for project wins, because somebody named it', () => {
  assert.equal(
    resolvePreparationProject({
      requested: '/home/work/src/beta',
      boardSelection: '/home/work/src/alpha',
      projects,
    }),
    '/home/work/src/beta',
  );
});

test('with nothing asked for, the project on screen is the one to edit', () => {
  assert.equal(
    resolvePreparationProject({
      requested: null,
      boardSelection: '/home/work/src/alpha',
      projects,
    }),
    '/home/work/src/alpha',
  );
});

test('viewing every project at once names none of them, so the first stands in', () => {
  assert.equal(
    resolvePreparationProject({
      requested: null,
      boardSelection: ALL_PROJECTS_SENTINEL,
      projects,
    }),
    '/home/work/src/alpha',
  );
});

test('a project that is no longer registered is not offered', () => {
  // A worktree can outlive the project being removed, and the request that
  // came with it would otherwise select something the editor cannot load.
  assert.equal(
    resolvePreparationProject({
      requested: '/home/work/src/gone',
      boardSelection: '/home/work/src/beta',
      projects,
    }),
    '/home/work/src/beta',
  );
});

test('a board selection that is no longer registered falls through too', () => {
  assert.equal(
    resolvePreparationProject({
      requested: null,
      boardSelection: '/home/work/src/gone',
      projects,
    }),
    '/home/work/src/alpha',
  );
});

test('no projects at all means there is nothing to edit', () => {
  assert.equal(
    resolvePreparationProject({ requested: null, boardSelection: null, projects: [] }),
    null,
  );
});

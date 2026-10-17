import type { GitChangedFile } from '@/types/git';
import {
  buildWorkspaceFileTree,
  type WorkspaceTreeNode,
} from '@/lib/workspace-files/workspace-file-tree';

export type ChangedFileRow =
  | {
      kind: 'folder';
      path: string;
      name: string;
      depth: number;
      /** Every changed file under this folder, collapsed or not, for folder-level selection. */
      filePaths: readonly string[];
    }
  | { kind: 'file'; path: string; name: string; depth: number; file: GitChangedFile };

function collectFilePaths(node: WorkspaceTreeNode, into: string[]): string[] {
  if (node.type === 'file') into.push(node.path);
  else for (const child of node.children) collectFilePaths(child, into);
  return into;
}

/**
 * Use the Files tab's hierarchy and natural sorting for the changed subset.
 * Like the SCM views of VS Code and JetBrains, a folder whose only child is
 * another folder folds into it (`.agents/skills`), so deep paths do not spend a
 * row per segment. The row takes the innermost folder's path.
 */
export function buildChangedFileRows(
  files: readonly GitChangedFile[],
  collapsed: ReadonlySet<string>,
): ChangedFileRow[] {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const tree = buildWorkspaceFileTree([...filesByPath.keys()], new Set(), []);
  const rows: ChangedFileRow[] = [];
  function visit(nodes: WorkspaceTreeNode[], depth: number) {
    for (const node of nodes) {
      if (node.type === 'directory') {
        let folder = node;
        let name = node.name;
        while (folder.children.length === 1 && folder.children[0].type === 'directory') {
          folder = folder.children[0];
          name = `${name}/${folder.name}`;
        }
        rows.push({ kind: 'folder', path: folder.path, name, depth, filePaths: collectFilePaths(folder, []) });
        if (!collapsed.has(folder.path)) visit(folder.children, depth + 1);
      } else {
        rows.push({ kind: 'file', path: node.path, name: node.name, depth, file: filesByPath.get(node.path)! });
      }
    }
  }
  visit(tree, 0);
  return rows;
}

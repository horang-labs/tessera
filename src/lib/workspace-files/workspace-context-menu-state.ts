export interface WorkspacePathContextMenuState<TNode> {
  absolutePath: string;
  canOpenFile: boolean;
  node: TNode | null;
  position: { x: number; y: number };
}

export function buildWorkspacePathContextMenuState<TNode>({
  absolutePath,
  canOpenFile,
  node,
  x,
  y,
}: {
  absolutePath: string | null;
  canOpenFile: boolean;
  node: TNode | null;
  x: number;
  y: number;
}): WorkspacePathContextMenuState<TNode> | null {
  if (!absolutePath) return null;
  return {
    absolutePath,
    canOpenFile,
    node,
    position: { x, y },
  };
}

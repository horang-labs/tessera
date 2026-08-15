import fs from 'node:fs';
import path from 'node:path';
import { mirrorOverlayEntry } from '@/lib/filesystem/overlay-filesystem';

const MERGED_DIRECTORIES = new Set(['plugins', 'skills']);

function entryExists(entryPath: string): boolean {
  try {
    fs.lstatSync(entryPath);
    return true;
  } catch {
    return false;
  }
}

/** Mirror an explicit OpenCode config root without changing any user-owned entry. */
export function mirrorOpenCodeConfigIntoOverlay(
  sourceConfigDir: string | undefined,
  overlayDir: string,
): void {
  const source = sourceConfigDir?.trim();
  if (!source || path.resolve(source) === path.resolve(overlayDir)) return;
  if (!fs.statSync(source).isDirectory()) {
    throw new Error(`OpenCode config root is not a directory: ${source}`);
  }

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(overlayDir, entry.name);
    if (MERGED_DIRECTORIES.has(entry.name) && fs.statSync(sourcePath).isDirectory()) {
      fs.mkdirSync(targetPath, { recursive: true, mode: 0o700 });
      for (const child of fs.readdirSync(sourcePath)) {
        const childTarget = path.join(targetPath, child);
        if (entryExists(childTarget)) continue;
        mirrorOverlayEntry(path.join(sourcePath, child), childTarget);
      }
      continue;
    }
    if (!entryExists(targetPath)) mirrorOverlayEntry(sourcePath, targetPath);
  }
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Preserve the config root set by login rc files, then activate Tessera's overlay. */
export function buildPosixOpenCodeOverlayActivation(overlayDir?: string): string {
  const overlayAssignment = overlayDir
    ? `tessera_oc_overlay=${quotePosix(overlayDir)}; `
    : 'tessera_oc_overlay="${TESSERA_OPENCODE_CONFIG_DIR:-}"; ';
  return overlayAssignment
    + 'if [ -n "$tessera_oc_overlay" ]; then '
    + 'tessera_oc_source="${OPENCODE_CONFIG_DIR:-}"; mkdir -p "$tessera_oc_overlay"; '
    + 'if [ -n "$tessera_oc_source" ] && [ "$tessera_oc_source" != "$tessera_oc_overlay" ] && [ -d "$tessera_oc_source" ]; then '
    + 'for tessera_oc_entry in "$tessera_oc_source"/* "$tessera_oc_source"/.[!.]* "$tessera_oc_source"/..?*; do '
    + '[ -e "$tessera_oc_entry" ] || [ -L "$tessera_oc_entry" ] || continue; '
    + 'tessera_oc_name=${tessera_oc_entry##*/}; tessera_oc_target="$tessera_oc_overlay/$tessera_oc_name"; '
    + 'case "$tessera_oc_name" in plugins|skills) '
    + 'if [ -d "$tessera_oc_entry" ]; then mkdir -p "$tessera_oc_target"; '
    + 'for tessera_oc_child in "$tessera_oc_entry"/* "$tessera_oc_entry"/.[!.]* "$tessera_oc_entry"/..?*; do '
    + '[ -e "$tessera_oc_child" ] || [ -L "$tessera_oc_child" ] || continue; '
    + 'tessera_oc_child_target="$tessera_oc_target/${tessera_oc_child##*/}"; '
    + '[ -e "$tessera_oc_child_target" ] || [ -L "$tessera_oc_child_target" ] || ln -s "$tessera_oc_child" "$tessera_oc_child_target" 2>/dev/null || true; '
    + 'done; else [ -e "$tessera_oc_target" ] || [ -L "$tessera_oc_target" ] || ln -s "$tessera_oc_entry" "$tessera_oc_target" 2>/dev/null || true; fi ;; '
    + '*) [ -e "$tessera_oc_target" ] || [ -L "$tessera_oc_target" ] || ln -s "$tessera_oc_entry" "$tessera_oc_target" 2>/dev/null || true ;; esac; '
    + 'done; fi; OPENCODE_CONFIG_DIR="$tessera_oc_overlay"; export OPENCODE_CONFIG_DIR; fi; ';
}

import { SHORTCUT_REGISTRY, type ShortcutId } from './registry';

export type ShortcutOverrides = Partial<Record<ShortcutId, string>>;

export function getEffectiveShortcut(
  id: ShortcutId,
  overrides: ShortcutOverrides | undefined,
): string | null {
  const override = overrides?.[id];
  if (override === '') return null;
  return override ?? SHORTCUT_REGISTRY[id].default;
}

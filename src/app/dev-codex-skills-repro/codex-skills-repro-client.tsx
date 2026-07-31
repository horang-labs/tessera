'use client';

import { useEffect } from 'react';
import { SkillPicker } from '@/components/chat/skill-picker';
import { useSkillPicker } from '@/hooks/use-skill-picker';

const SESSION_ID = 'codex-skills-browser-repro';

export function CodexSkillsReproClient() {
  const skillPicker = useSkillPicker(
    SESSION_ID,
    'codex',
    true,
    true,
    'linux',
    'native',
  );
  const { openSkillsOnly } = skillPicker;

  useEffect(
    function openSkillsOnMount() {
      openSkillsOnly();
    },
    [openSkillsOnly],
  );

  const state = skillPicker.isLoading
    ? 'loading'
    : skillPicker.isEmpty
      ? 'empty'
      : skillPicker.filteredSkills.length > 0
        ? 'ready'
        : 'closed';

  return (
    <main
      data-testid="codex-skills-repro"
      className="flex min-h-screen items-center justify-center bg-(--chat-bg) p-8 text-(--text-primary)"
    >
      <section className="w-full max-w-2xl rounded-2xl border border-(--divider) bg-(--sidebar-bg) p-8 shadow-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-(--accent)">
          Browser E2E
        </p>
        <h1 className="mt-2 text-2xl font-semibold">Codex skill discovery recovery</h1>
        <p className="mt-2 text-sm leading-6 text-(--text-secondary)">
          The real picker retries a temporary provider failure and renders the refreshed skill list.
        </p>

        <div className="mt-6 flex items-center gap-3 rounded-lg border border-(--divider) px-4 py-3">
          <span className="text-xs text-(--text-muted)">Picker state</span>
          <strong data-testid="codex-skills-state" className="text-sm text-(--accent-light)">
            {state}
          </strong>
        </div>

        <div className="relative mt-80">
          <SkillPicker
            isOpen={skillPicker.isOpen}
            isLoading={skillPicker.isLoading}
            isInactive={skillPicker.isInactive}
            isEmpty={skillPicker.isEmpty}
            skills={skillPicker.filteredSkills}
            selectedIndex={skillPicker.selectedIndex}
            onSelect={skillPicker.selectSkill}
            onClose={skillPicker.close}
          />
          <button
            type="button"
            data-testid="open-codex-skills"
            onClick={skillPicker.openSkillsOnly}
            className="w-full rounded-lg border border-(--accent)/40 bg-(--input-bg) px-4 py-3 text-left text-sm hover:border-(--accent)"
          >
            Open provider skills
          </button>
        </div>
      </section>
    </main>
  );
}

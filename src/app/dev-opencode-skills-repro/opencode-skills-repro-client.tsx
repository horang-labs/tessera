'use client';

import { useEffect, useState } from 'react';
import { SkillPicker } from '@/components/chat/skill-picker';
import { useSkillPicker } from '@/hooks/use-skill-picker';

const SESSION_ID = 'opencode-skills-browser-repro';

export function OpenCodeSkillsReproClient() {
  const [isSessionRunning, setIsSessionRunning] = useState(false);
  const skillPicker = useSkillPicker(SESSION_ID, 'opencode', isSessionRunning);
  const { onInputChange } = skillPicker;

  useEffect(function replaySessionStateHydration() {
    const markRunning = window.setTimeout(() => setIsSessionRunning(true), 25);
    const markStopped = window.setTimeout(() => setIsSessionRunning(false), 50);
    return () => {
      window.clearTimeout(markRunning);
      window.clearTimeout(markStopped);
    };
  }, []);

  useEffect(
    function typeSlashOnMount() {
      onInputChange('/');
    },
    [onInputChange],
  );

  const state = skillPicker.isLoading
    ? 'loading'
    : skillPicker.filteredSkills.length > 0
      ? 'ready'
      : 'empty';

  return (
    <main data-testid="opencode-skills-repro">
      <strong data-testid="opencode-skills-state">{state}</strong>
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
    </main>
  );
}

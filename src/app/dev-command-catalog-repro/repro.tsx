'use client';

import { useState } from 'react';
import { SkillPicker } from '@/components/chat/skill-picker';
import { useSkillPicker } from '@/hooks/use-skill-picker';
import { useCommandStore, type CommandInfo } from '@/stores/command-store';

const SESSION_ID = 'command-catalog-repro';

export function CommandCatalogRepro() {
  const [catalog, setCatalog] = useState('[]');
  const [input, setInput] = useState('');
  const picker = useSkillPicker(SESSION_ID, 'opencode', true);
  const commands = useCommandStore((state) => state.commands[SESSION_ID]);
  return (
    <main className="mx-auto w-[600px] pt-8">
      <label>Reported commands
        <textarea aria-label="Reported commands" value={catalog} onChange={(event) => setCatalog(event.target.value)} />
      </label>
      <button onClick={() => useCommandStore.getState().setCommands(SESSION_ID, JSON.parse(catalog) as CommandInfo[])}>
        Apply provider update
      </button>
      <output hidden data-testid="stored-commands">{JSON.stringify(commands ?? [])}</output>
      <div className="relative mt-[350px]">
        <input aria-label="Slash command" value={input} onChange={(event) => {
          setInput(event.target.value);
          picker.onInputChange(event.target.value);
        }} />
        <SkillPicker
          isOpen={picker.isOpen} isLoading={picker.isLoading}
          skills={picker.filteredSkills} selectedIndex={picker.selectedIndex}
          onSelect={picker.selectSkill} onClose={picker.close}
        />
      </div>
    </main>
  );
}

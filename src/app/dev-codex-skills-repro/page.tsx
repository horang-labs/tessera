import { notFound } from 'next/navigation';
import { CodexSkillsReproClient } from './codex-skills-repro-client';

export default function CodexSkillsReproPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound();
  }

  return <CodexSkillsReproClient />;
}

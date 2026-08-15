import { notFound } from 'next/navigation';
import { OpenCodeSkillsReproClient } from './opencode-skills-repro-client';

export default function OpenCodeSkillsReproPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound();
  }

  return <OpenCodeSkillsReproClient />;
}

import { notFound } from 'next/navigation';
import { TerminalInputBarReproClient } from './terminal-input-bar-repro-client';

export default function TerminalInputBarReproPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound();
  }

  return <TerminalInputBarReproClient />;
}

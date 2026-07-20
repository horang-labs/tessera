import { notFound } from 'next/navigation';
import { TerminalScrollReproClient } from './terminal-scroll-repro-client';

export default function TerminalScrollReproPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound();
  }

  return <TerminalScrollReproClient />;
}

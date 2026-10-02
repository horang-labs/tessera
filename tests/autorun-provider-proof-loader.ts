// File-open-only traces: never parse or retain read buffers, auth contents or environments.
export interface InstructionSource { role: string; path: string; positiveRequired: boolean }
export function attestInstructionExclusion(control: string, candidate: string, sources: InstructionSource[]) {
  const isOpen = (line: string) => /(?:\bopen(?:at2?)?\(|<\.\.\. open(?:at2?)? resumed>)/.test(line);
  const opens = (trace: string, path: string) => trace.split('\n').filter(line =>
    isOpen(line) && line.match(/=\s*\d+<([^>]+)>/)?.[1] === path).length;
  const evidence = sources.map(source => ({ role: source.role,
    controlOpens: opens(control, source.path), candidateOpens: opens(candidate, source.path) }));
  if (!candidate.split('\n').some(line => isOpen(line) && /=\s*\d+<[^>]+>/.test(line))
    || !sources.length || sources.some((s, i) => s.positiveRequired && !evidence[i].controlOpens)
    || evidence.some(e => e.candidateOpens)) throw new Error('instruction exclusion not established');
  return evidence;
}

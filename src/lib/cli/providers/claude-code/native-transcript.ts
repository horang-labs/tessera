import type { NativeTranscriptMessage } from '@/lib/session/native-transcript-types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractText(content: unknown, images = true): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((block) => {
    if (!isRecord(block)) return [];
    if (block.type === 'text' && typeof block.text === 'string') return [block.text];
    return images && block.type === 'image' ? ['[이미지 첨부]'] : [];
  }).join('\n');
}

function clean(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

/** Dialogue extraction follows extract_dialogue.py, including its ten-row dedup window. */
export function parseClaudeNativeTranscript(content: string): NativeTranscriptMessage[] {
  const rows: NativeTranscriptMessage[] = [];
  const seenQueued = new Set<unknown>();
  for (const line of content.split('\n')) {
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!isRecord(entry) || entry.isSidechain) continue;
    if (entry.type === 'attachment') {
      const a = entry.attachment;
      if (!isRecord(a) || a.type !== 'queued_command' || !isRecord(a.origin) || a.origin.kind !== 'human') continue;
      const text = clean(extractText(a.prompt));
      if (!text) continue;
      const key = a.delivery_id || a.source_uuid || JSON.stringify(a.prompt);
      if (seenQueued.has(key)) continue;
      seenQueued.add(key);
      rows.push({ role: 'user', text, label: '사용자(작업 중 보냄)' });
      continue;
    }
    if (!isRecord(entry.message)) continue;
    if (entry.type === 'user') {
      const content = entry.message.content;
      if (Array.isArray(content) && content.some((b) => isRecord(b) && b.type === 'tool_result')) continue;
      let text = clean(extractText(content));
      if (entry.isCompactSummary) {
        if (text) rows.push({ role: 'user', text, label: '대화 압축 요약' });
        continue;
      }
      if (entry.isMeta || !text) continue;
      const command = text.match(/^<command-name>(.*?)<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>/);
      if (command) {
        if (!command[2].trim() && command[1] !== '/compact') continue;
        text = `${command[1]} ${command[2].trim()}`.trim();
      } else if (/^<(task-notification|command-name|command-message|local-command-stdout|local-command-stderr)>/.test(text)
        || text.startsWith('Another Claude session sent a message') || text.startsWith('[Request interrupted')) continue;
      rows.push({ role: 'user', text });
    } else if (entry.type === 'assistant') {
      if (entry.message.model === '<synthetic>') continue;
      const text = clean(extractText(entry.message.content, false));
      if (!text) continue;
      const previous = rows.at(-1);
      if (previous?.role === 'assistant') previous.text += `\n\n${text}`;
      else rows.push({ role: 'assistant', text });
    }
  }
  const messages: NativeTranscriptMessage[] = [];
  for (const row of rows) {
    if (row.role === 'user' && row.label !== '대화 압축 요약') {
      if (/^\/[\p{L}\p{N}_:-]+$/u.test(row.text) && row.text !== '/compact') continue;
      if (messages.slice(-10).some((other) => other.role === 'user' && other.label !== '대화 압축 요약' && other.text === row.text)) continue;
    }
    messages.push(row);
  }
  return messages;
}

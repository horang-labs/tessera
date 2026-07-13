#!/usr/bin/env node

import readline from 'node:readline';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('2.1.207 (Claude Code)\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: true }) + '\n');
  process.exit(0);
}

const sessionId = valueAfter('--session-id') || valueAfter('--resume') || 'mock-claude-task-session';
let turnStarted = false;

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function emit(message) {
  process.stdout.write(JSON.stringify({ session_id: sessionId, ...message }) + '\n');
}

function assistantTool(id, name, input) {
  emit({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
}

function toolResult(id, result, spelling = 'tool_use_result') {
  emit({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: id,
        is_error: false,
        content: `Completed ${id}`,
      }],
    },
    [spelling]: result,
  });
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function runTaskTurn() {
  const tasks = [
    ['1', 'Inspect Claude task events'],
    ['2', 'Translate tasks into todos'],
    ['3', 'Verify the checklist UI'],
  ];

  for (const [id, subject] of tasks) {
    assistantTool(`create-${id}`, 'TaskCreate', { subject, activeForm: `${subject}…` });
    await delay(100);
    toolResult(`create-${id}`, { task: { id, subject, status: 'pending' } }, id === '2' ? 'toolUseResult' : 'tool_use_result');
    await delay(100);
  }

  assistantTool('list-snapshot', 'TaskList', {});
  await delay(100);
  toolResult('list-snapshot', {
    tasks: tasks.map(([id, subject]) => ({ id, subject, status: 'pending' })),
  });

  assistantTool('update-1-active', 'TaskUpdate', { taskId: '1', status: 'in_progress', activeForm: 'Inspecting Claude task events' });
  await delay(120);
  toolResult('update-1-active', { success: true, taskId: '1' });

  for (const [id] of tasks) {
    assistantTool(`update-${id}-done`, 'TaskUpdate', { taskId: id, status: 'completed' });
    await delay(120);
    toolResult(`update-${id}-done`, { success: true, taskId: id });
  }

  emit({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Task checklist verified.' }] },
  });
  emit({ type: 'result', subtype: 'success', result: 'Task checklist verified.', is_error: false });
}

emit({ type: 'system', subtype: 'init', message: { model: 'mock-claude-task', tools: ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'] } });

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.type === 'control_request') {
    emit({
      type: 'control_response',
      request_id: message.request_id,
      response: { subtype: 'success', request_id: message.request_id, response: { commands: [] } },
    });
    return;
  }

  if (message.type === 'user' && !turnStarted) {
    turnStarted = true;
    void runTaskTurn();
  }
});

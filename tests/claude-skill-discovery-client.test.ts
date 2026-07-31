import assert from 'node:assert/strict';
import test from 'node:test';

import { parseClaudeSkillDiscoveryResponse } from '@/lib/cli/providers/claude-code/skill-discovery-client';

test('Claude initialize response exposes the provider-reported invocable command names', () => {
  const response = parseClaudeSkillDiscoveryResponse(JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'request-1',
      response: {
        commands: [
          {
            name: 'diagnosing-bugs',
            description: '(mattpocock-skills) Diagnose hard bugs',
            argumentHint: '',
          },
          { name: 42, description: 'invalid' },
        ],
      },
    },
  }), 'request-1');

  assert.deepEqual(response, {
    skills: [{
      name: 'diagnosing-bugs',
      description: '(mattpocock-skills) Diagnose hard bugs',
    }],
  });
});

test('Claude discovery ignores unrelated control responses', () => {
  assert.equal(parseClaudeSkillDiscoveryResponse(JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'another-request',
      response: { commands: [] },
    },
  }), 'request-1'), null);
});

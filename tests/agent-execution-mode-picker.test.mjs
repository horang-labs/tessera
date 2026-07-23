import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as pickerModule from '../src/components/settings/agent-execution-mode-picker.tsx';

const { AgentExecutionModePicker } = pickerModule.default ?? pickerModule;

function renderPicker(value, overrides = {}) {
  return renderToStaticMarkup(createElement(AgentExecutionModePicker, {
    value,
    onChange: () => {},
    title: 'Choose how agents open',
    description: 'This preference applies to new sessions.',
    note: 'You can change this later.',
    recommendedMode: 'pty',
    ...overrides,
  }));
}

function inputFor(html, mode) {
  const input = html.match(new RegExp(`<input[^>]+data-testid="execution-mode-${mode}"[^>]*>`))?.[0];
  assert.ok(input, `${mode} radio input should render`);
  return input;
}

test('execution mode picker exposes both mutually exclusive choices with the current preference selected', () => {
  const html = renderPicker('pty');

  assert.match(html, /<fieldset/);
  assert.match(html, /<legend[^>]*>Choose how agents open<\/legend>/);
  assert.match(html, /Terminal \(PTY\)/);
  assert.match(html, /Tessera Chat \(GUI\)/);
  assert.match(html, /Recommended/);
  assert.match(inputFor(html, 'pty'), /checked=""/);
  assert.doesNotMatch(inputFor(html, 'gui'), /checked=""/);
  assert.equal((html.match(/type="radio"/g) ?? []).length, 2);
});

test('execution mode picker reflects a GUI preference and disables every choice while saving', () => {
  const html = renderPicker('gui', { disabled: true });

  assert.doesNotMatch(inputFor(html, 'pty'), /checked=""/);
  assert.match(inputFor(html, 'gui'), /checked=""/);
  assert.match(inputFor(html, 'pty'), /disabled=""/);
  assert.match(inputFor(html, 'gui'), /disabled=""/);
  assert.match(html, /You can change this later\./);
});

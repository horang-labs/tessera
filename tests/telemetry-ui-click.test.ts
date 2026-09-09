import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TELEMETRY_UI_CONTROLS,
  TELEMETRY_UI_SURFACES,
  SETTINGS_SECTION_TELEMETRY_CONTROLS,
  sanitizeAutocaptureClickProperties,
  settingsTelemetryClickAttributes,
  telemetryClickAttributes,
  telemetryIgnoreAttributes,
  telemetryTargetAttributes,
} from '../src/lib/telemetry/ui-click';
import { isSensitiveTelemetryPropertyName } from '../src/lib/telemetry/privacy';
import {
  detectTelemetryClientFormFactor,
  prepareTelemetryCaptureForTransport,
  sanitizeTelemetryProperties,
} from '../src/lib/telemetry/client';

test('telemetry click attributes expose only registered static metadata', () => {
  assert.deepEqual(
    telemetryClickAttributes('right_panel.toggle', 'tab_bar'),
    {
      'data-ph-capture': 'true',
      'data-ph-capture-attribute-control': 'right_panel.toggle',
      'data-ph-capture-attribute-surface': 'tab_bar',
    },
  );
});

test('optional telemetry targets and explicit exclusions remain static metadata', () => {
  assert.deepEqual(
    telemetryTargetAttributes({ control: 'composer.model.open', surface: 'composer' }),
    telemetryClickAttributes('composer.model.open', 'composer'),
  );
  assert.deepEqual(telemetryTargetAttributes(), {});
  assert.deepEqual(telemetryIgnoreAttributes('drag_only'), {
    'data-telemetry-ignore': 'drag_only',
  });
});

test('settings click attributes use the settings surface and registered section controls', () => {
  assert.deepEqual(
    settingsTelemetryClickAttributes('settings.notifications.ai_title_generation'),
    {
      'data-ph-capture': 'true',
      'data-ph-capture-attribute-control': 'settings.notifications.ai_title_generation',
      'data-ph-capture-attribute-surface': 'settings',
    },
  );

  assert.deepEqual(Object.keys(SETTINGS_SECTION_TELEMETRY_CONTROLS).sort(), [
    'appearance',
    'development',
    'general',
    'git',
    'models',
    'project',
    'remote-access',
  ]);
  for (const control of Object.values(SETTINGS_SECTION_TELEMETRY_CONTROLS)) {
    assert.equal(TELEMETRY_UI_CONTROLS.includes(control), true, control);
  }
});

test('settings controls are static identifiers that cannot contain user values', () => {
  const settingsControls = TELEMETRY_UI_CONTROLS.filter((control) => control.startsWith('settings.'));
  assert.ok(settingsControls.length >= 90);
  for (const control of settingsControls) {
    assert.match(control, /^settings\.[a-z0-9_.]+$/);
    assert.doesNotMatch(control, /prompt_value|display_name_value|path_value|url_value|device_name/);
  }
});

test('autocapture sanitization discards DOM and user-authored properties', () => {
  const result = sanitizeAutocaptureClickProperties({
    control: 'composer.send',
    surface: 'composer',
    '$el_text': 'private prompt',
    '$elements_chain': 'button:private prompt; div:path=/home/private',
    '$current_url': 'http://localhost/session/private-id',
    title: 'private session title',
    path: '/home/private/repository',
  });

  assert.deepEqual(result, {
    control: 'composer.send',
    surface: 'composer',
  });
  assert.doesNotMatch(JSON.stringify(result), /private|prompt|repository/);
});

test('autocapture sanitization rejects unregistered or malformed metadata', () => {
  assert.equal(sanitizeAutocaptureClickProperties({
    control: 'composer.send.private-session-id',
    surface: 'composer',
  }), null);
  assert.equal(sanitizeAutocaptureClickProperties({
    control: 'composer.send',
    surface: '/home/private',
  }), null);
  assert.equal(sanitizeAutocaptureClickProperties({
    control: 'composer.send',
  }), null);
});

test('telemetry registries contain no duplicate identifiers', () => {
  assert.equal(new Set(TELEMETRY_UI_CONTROLS).size, TELEMETRY_UI_CONTROLS.length);
  assert.equal(new Set(TELEMETRY_UI_SURFACES).size, TELEMETRY_UI_SURFACES.length);
});

test('server telemetry rejects fields that can carry private user data', () => {
  for (const key of [
    'prompt',
    'assistant_message',
    'session_title',
    'file_path',
    'repository_url',
    'raw_log_jsonl',
    'smoke_trace_jsonl',
    'command_output',
    'spawn_error_message',
    'promptText',
    'worktree-path',
  ]) {
    assert.equal(isSensitiveTelemetryPropertyName(key), true, key);
  }

  for (const key of ['provider_id', 'result', 'duration_ms', 'command_shape']) {
    assert.equal(isSensitiveTelemetryPropertyName(key), false, key);
  }
});

test('semantic telemetry transport keeps only allowlisted safe properties', () => {
  const result = sanitizeTelemetryProperties({
    control: 'composer.send',
    surface: 'composer',
    result: 'success',
    client_form_factor: 'mobile',
    prompt: 'private prompt',
    title: 'private title',
    file_path: '/home/private/repo',
    '$current_url': 'http://localhost/private',
    '$elements_chain': 'button.private',
  });

  assert.deepEqual(result, {
    control: 'composer.send',
    surface: 'composer',
    result: 'success',
    client_form_factor: 'mobile',
  });
});

test('client form factor is reduced locally without transmitting raw device signals', () => {
  assert.equal(detectTelemetryClientFormFactor({
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel) AppleWebKit Mobile',
    platform: 'Linux armv8l',
    maxTouchPoints: 5,
  }), 'mobile');
  assert.equal(detectTelemetryClientFormFactor({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit',
    platform: 'MacIntel',
    maxTouchPoints: 5,
  }), 'mobile');
  assert.equal(detectTelemetryClientFormFactor({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/37.0',
    platform: 'Win32',
    maxTouchPoints: 0,
  }), 'desktop');

  assert.deepEqual(sanitizeTelemetryProperties({
    client_form_factor: 'mobile',
    user_agent: 'private raw agent',
    viewport_width: 390,
    screen_width: 430,
  }), {
    client_form_factor: 'mobile',
  });
  assert.deepEqual(sanitizeTelemetryProperties({
    client_form_factor: 'phone-with-model-name',
  }), {});
});

test('PostHog transport keeps its public project token while dropping private SDK properties', () => {
  const result = prepareTelemetryCaptureForTransport(
    {
      event: '$autocapture',
      properties: {
        token: 'sdk-token-that-must-not-be-trusted',
        control: 'composer.send',
        surface: 'composer',
        '$browser': 'Chrome',
        '$browser_version': 130,
        '$browser_language': 'en-US',
        '$browser_language_prefix': 'en',
        '$timezone': 'Asia/Singapore',
        '$el_text': 'private prompt',
        '$current_url': 'http://localhost/private',
      },
    },
    {
      installId: 'install-test',
      appSessionId: 'app-session-test',
      appVersion: 'test',
      platform: 'linux',
      arch: 'x64',
      channel: 'development',
    },
    true,
    'phc-public-project-token',
  );

  assert.equal(result?.event, 'ui_control_clicked');
  assert.equal(result?.properties?.token, 'phc-public-project-token');
  assert.equal(result?.properties?.control, 'composer.send');
  assert.equal(result?.properties?.surface, 'composer');
  assert.equal(result?.properties?.client_form_factor, 'desktop');
  assert.equal(result?.properties?.['$browser'], 'Chrome');
  assert.equal(result?.properties?.['$browser_version'], 130);
  assert.equal(result?.properties?.['$browser_language'], 'en-US');
  assert.equal(result?.properties?.['$browser_language_prefix'], 'en');
  assert.equal(result?.properties?.['$timezone'], 'Asia/Singapore');
  assert.doesNotMatch(JSON.stringify(result), /private prompt|localhost\/private|sdk-token/);
});

test('PostHog transport preserves safe browser locale and timezone properties', () => {
  const result = prepareTelemetryCaptureForTransport(
    {
      event: 'app_started',
      properties: {
        '$browser': 'Chrome',
        '$browser_version': 130,
        '$browser_language': 'en-US',
        '$browser_language_prefix': 'en',
        '$timezone': 'Asia/Singapore',
        '$current_url': 'http://localhost/private',
        '$raw_user_agent': 'private raw agent',
      },
    },
    null,
    true,
    'phc-public-project-token',
  );

  assert.deepEqual(result?.properties, {
    token: 'phc-public-project-token',
    '$browser': 'Chrome',
    '$browser_version': 130,
    '$browser_language': 'en-US',
    '$browser_language_prefix': 'en',
    '$timezone': 'Asia/Singapore',
  });
});

test('prompt submission telemetry keeps only privacy-safe composition metadata', () => {
  const result = prepareTelemetryCaptureForTransport(
    {
      event: 'prompt_submitted',
      properties: {
        token: 'sdk-token-that-must-not-be-trusted',
        source: 'pty_chat_view',
        has_skill: true,
        has_attachment: true,
        attachment_count: 2,
        has_session_reference: true,
        translation_requested: false,
        used_voice_input: false,
        prompt: 'the private user prompt',
        content: [{ type: 'text', text: 'another private prompt' }],
        message: 'private message',
        displayContent: 'private display content',
      },
    },
    {
      installId: 'install-test',
      appSessionId: 'app-session-test',
      appVersion: 'test',
      platform: 'linux',
      arch: 'x64',
      channel: 'development',
    },
    true,
    'phc-public-project-token',
  );

  assert.equal(result?.event, 'prompt_submitted');
  assert.equal(result?.properties?.source, 'pty_chat_view');
  assert.equal(result?.properties?.has_skill, true);
  assert.equal(result?.properties?.has_attachment, true);
  assert.equal(result?.properties?.attachment_count, 2);
  assert.equal(result?.properties?.has_session_reference, true);
  assert.equal(result?.properties?.token, 'phc-public-project-token');
  assert.doesNotMatch(JSON.stringify(result), /private|display content|sdk-token/);
});

test('shortcut, movement, and prompt outcome dimensions reject free-form values', () => {
  assert.deepEqual(sanitizeTelemetryProperties({
    shortcut: 'toggle-view',
    item_type: 'task',
    move_kind: 'workflow_status',
    item_count: 3,
    duration_bucket: '30_to_120s',
    session_kind: 'terminal',
    readiness: 'ready',
    execution_mode: 'pty',
    file_action: 'save',
    entry_kind: 'file',
  }), {
    shortcut: 'toggle-view',
    item_type: 'task',
    move_kind: 'workflow_status',
    item_count: 3,
    duration_bucket: '30_to_120s',
    session_kind: 'terminal',
    readiness: 'ready',
    execution_mode: 'pty',
    file_action: 'save',
    entry_kind: 'file',
  });

  assert.deepEqual(sanitizeTelemetryProperties({
    shortcut: 'custom-private-shortcut',
    item_type: 'private-task-name',
    move_kind: '/home/private',
    duration_bucket: '12.345 seconds',
    session_kind: 'private-kind',
    readiness: 'private-readiness',
    execution_mode: 'private-mode',
    file_action: 'save-private-file',
    entry_kind: '/private/file.txt',
  }), {});
});

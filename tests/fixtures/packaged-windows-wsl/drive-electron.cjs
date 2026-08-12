#!/usr/bin/env node

const path = require('node:path');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requiredOption(name) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`Missing ${prefix}<value>`);
  return value;
}

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const repo = requiredOption('repo');
  const cdp = requiredOption('cdp');
  const phase = requiredOption('phase');
  requiredOption('fixture-root');
  const { chromium } = require(path.join(repo, 'node_modules', '@playwright', 'test'));
  const browser = await chromium.connectOverCDP(cdp);
  try {
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) throw new Error(`No Electron renderer page at ${cdp}`);
    await page.waitForLoadState('domcontentloaded');

    const request = async (url, init = {}, expectedStatus = 200) => {
      const response = await page.evaluate(async ({ url, init }) => {
        const response = await fetch(url, {
          ...init,
          headers: { 'content-type': 'application/json', ...(init.headers || {}) },
        });
        const text = await response.text();
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        return { status: response.status, body };
      }, { url, init });
      assert(
        response.status === expectedStatus,
        `${init.method || 'GET'} ${url} returned ${response.status}: ${JSON.stringify(response.body)}`,
      );
      return response;
    };

    const settings = await request('/api/settings');
    const result = {
      phase,
      page: { url: page.url(), title: await page.title() },
      settings,
    };
    assert(result.page.title === 'Tessera', `Unexpected Electron page title: ${result.page.title}`);
    assert(/^http:\/\/(?:localhost|127\.0\.0\.1):\d+\//.test(result.page.url), `Unexpected packaged page URL: ${result.page.url}`);
    assert(settings.body?.serverHostInfo?.platform === 'win32', 'Backend is not packaged Windows');

    if (phase === 'configure') {
      result.configured = await request('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ agentEnvironment: 'wsl' }),
      });
      assert(result.configured.body?.settings?.agentEnvironment === 'wsl', 'Could not select WSL Agent Environment');
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    assert(settings.body?.settings?.agentEnvironment === 'wsl', 'Agent Environment is not WSL');
    const lifecycleBefore = await request('/api/provider-integrations/codex/lifecycle');
    const skillsBefore = await request('/api/provider-integrations/skills?all=1');
    result.lifecycleBefore = lifecycleBefore;
    result.skillsBefore = skillsBefore;

    if (phase === 'install') {
      result.lifecycleInstall = await request('/api/provider-integrations/codex/lifecycle', {
        method: 'POST',
        body: JSON.stringify({ operation: 'install', consent: 'granted' }),
      });
      result.skillsInstall = await request('/api/provider-integrations/skills', {
        method: 'POST',
        body: JSON.stringify({
          operation: 'install',
          providerIds: ['claude-code', 'codex', 'opencode'],
          expectedAgentEnvironment: 'wsl',
        }),
      });
      result.lifecycleAfter = await request('/api/provider-integrations/codex/lifecycle');
      result.skillsAfter = await request('/api/provider-integrations/skills?all=1');
      assert(result.lifecycleAfter.body?.lifecycle?.state === 'installed', 'Codex lifecycle hook was not installed');
      assert(result.lifecycleAfter.body?.lifecycle?.trust === 'trusted', 'Codex lifecycle hook was not trusted');
      assert(result.lifecycleAfter.body?.health?.state === 'healthy', 'Codex lifecycle integration is not healthy');
      assert(result.skillsAfter.body?.success === true, 'Provider skill status failed');
      assert(
        result.skillsAfter.body.providers?.every((provider) => provider.state === 'ready'),
        `Provider skills are not all ready: ${JSON.stringify(result.skillsAfter.body)}`,
      );
    }

    if (phase === 'lifecycle-status') {
      result.lifecycle = await request('/api/provider-integrations/codex/lifecycle');
      const expectedHealth = option('expect-health');
      const expectedTrust = option('expect-trust');
      const expectedState = option('expect-state');
      if (expectedHealth) assert(result.lifecycle.body?.health?.state === expectedHealth, `Expected health ${expectedHealth}: ${JSON.stringify(result.lifecycle.body)}`);
      if (expectedTrust) assert(result.lifecycle.body?.lifecycle?.trust === expectedTrust, `Expected trust ${expectedTrust}: ${JSON.stringify(result.lifecycle.body)}`);
      if (expectedState) assert(result.lifecycle.body?.lifecycle?.state === expectedState, `Expected lifecycle ${expectedState}: ${JSON.stringify(result.lifecycle.body)}`);
    }
    if (phase === 'session-health') {
      const sessionId = option('session-id');
      const expectedHealth = option('expect-health');
      if (!sessionId || !expectedHealth) throw new Error('--session-id and --expect-health are required');
      const deadline = Date.now() + 45_000;
      do {
        result.projects = await request('/api/sessions/projects');
        const sessions = result.projects.body?.projects?.flatMap((project) => project.sessions || []) || [];
        result.session = sessions.find((session) => session.id === sessionId);
        if (result.session?.integrationHealth === expectedHealth) break;
        await page.waitForTimeout(500);
      } while (Date.now() < deadline);
      assert(result.session, `Managed Session not found: ${sessionId}`);
      assert(result.session.integrationHealth === expectedHealth, `Expected Session health ${expectedHealth}: ${JSON.stringify(result.session)}`);
    }
    if (phase === 'skills-install' || phase === 'skills-remove' || phase === 'skills-remove-conflict') {
      const operation = phase === 'skills-install' ? 'install' : 'remove';
      const expectedStatus = phase === 'skills-remove-conflict' ? 409 : 200;
      result.skillsMutation = await request('/api/provider-integrations/skills', {
        method: 'POST',
        body: JSON.stringify({
          operation,
          providerIds: ['claude-code', 'codex', 'opencode'],
          expectedAgentEnvironment: 'wsl',
        }),
      }, expectedStatus);
      if (phase === 'skills-remove-conflict') {
        assert(result.skillsMutation.body?.success === false, 'Conflicted cleanup was reported complete');
        assert(result.skillsMutation.body?.error?.code === 'PROVIDER_SKILL_CONFLICT', `Unexpected cleanup conflict: ${JSON.stringify(result.skillsMutation.body)}`);
      } else {
        assert(result.skillsMutation.body?.success === true, `Skill ${operation} failed`);
      }
      result.skillsAfter = await request('/api/provider-integrations/skills?all=1');
      if (phase === 'skills-remove') {
        assert(result.skillsAfter.body.providers?.every((provider) => provider.state === 'absent'), 'Optional skills remain after removal');
      }
      if (phase === 'skills-install') {
        assert(result.skillsAfter.body.providers?.every((provider) => provider.state === 'ready'), 'Optional skills are not ready after install');
      }
    }
    if (phase === 'remove') {
      result.lifecycleRemove = await request('/api/provider-integrations/codex/lifecycle', {
        method: 'POST',
        body: JSON.stringify({ operation: 'remove' }),
      });
      result.skillsRemove = await request('/api/provider-integrations/skills', {
        method: 'POST',
        body: JSON.stringify({
          operation: 'remove',
          providerIds: ['claude-code', 'codex', 'opencode'],
          expectedAgentEnvironment: 'wsl',
        }),
      });
      result.lifecycleAfter = await request('/api/provider-integrations/codex/lifecycle');
      result.skillsAfter = await request('/api/provider-integrations/skills?all=1');
      assert(result.lifecycleAfter.body?.lifecycle?.state === 'absent', 'Codex lifecycle hook remains after removal');
      assert(result.lifecycleAfter.body?.lifecycle?.consent === 'revoked', 'Codex lifecycle consent was not revoked');
      assert(
        result.skillsAfter.body.providers?.every((provider) => provider.state === 'absent'),
        `Provider skills remain after removal: ${JSON.stringify(result.skillsAfter.body)}`,
      );
    }

    if (phase === 'start' || phase === 'create-only') {
      const workDir = option('work-dir');
      if (!workDir?.startsWith('/')) throw new Error('--work-dir must be an absolute WSL path');
      result.project = await request('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ folderPath: workDir }),
      });
      assert(result.project.body?.ok === true, `Project registration failed: ${JSON.stringify(result.project.body)}`);
      const sessionWorkDir = result.project.body.projectId;
      assert(typeof sessionWorkDir === 'string', 'Project registration did not return a filesystem identity');
      result.created = await request('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          workDir: sessionWorkDir,
          parentProjectId: sessionWorkDir,
          title: 'Issue 349 packaged acceptance',
          hasCustomTitle: true,
          providerId: 'codex',
          executionMode: 'pty',
          model: 'gpt-5.6-sol',
          reasoningEffort: 'high',
          sessionMode: 'work',
          accessMode: 'fullAccess',
        }),
      }, 201);
      const sessionId = result.created.body?.sessionId;
      if (result.created.status !== 201 || typeof sessionId !== 'string') {
        throw new Error(`Session creation failed: ${JSON.stringify(result.created)}`);
      }
      assert(typeof result.created.body?.worktreeId === 'string', 'Git Project Session is not Worktree-scoped');
    }

    if (phase === 'open') {
      const title = option('title') || 'Issue 349 packaged acceptance';
      await page.reload({ waitUntil: 'domcontentloaded' });
      const candidate = page.getByText(title, { exact: true }).first();
      await candidate.waitFor({ state: 'visible', timeout: 20_000 });
      await candidate.click();
      await page.waitForTimeout(5_000);
      result.opened = {
        title,
        url: page.url(),
        bodyContainsFixture: (await page.locator('body').innerText()).includes(
          'Tessera packaged acceptance fixture ready',
        ),
      };
      assert(result.opened.bodyContainsFixture, 'Opened Session never displayed fixture terminal output');
    }
    if (phase === 'ws-resume') {
      const sessionId = option('session-id');
      if (!sessionId) throw new Error('--session-id is required');
      result.websocket = await page.evaluate(async (sessionId) => new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://${window.location.host}/ws`);
        const messages = [];
        let sent = false;
        const timer = window.setTimeout(() => {
          socket.close();
          reject(new Error(`Timed out waiting for terminal launch: ${JSON.stringify(messages)}`));
        }, 20_000);
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data);
          messages.push(message);
          if (!sent) {
            sent = true;
            socket.send(JSON.stringify({
              type: 'resume_session',
              requestId: `acceptance-${Date.now()}`,
              sessionId,
            }));
          }
          if (message.type === 'error' || message.type === 'terminal_error') {
            window.clearTimeout(timer);
            socket.close();
            reject(new Error(`Session resume failed: ${JSON.stringify(message)}`));
          }
          if (['session_resumed', 'terminal_created'].includes(message.type)) {
            window.clearTimeout(timer);
            window.setTimeout(() => socket.close(), 500);
            resolve(messages);
          }
        };
        socket.onerror = () => reject(new Error('Acceptance WebSocket failed'));
      }), sessionId);
      await page.waitForTimeout(5_000);
    }
    if (phase === 'terminal-create' || phase === 'terminal-create-blocked') {
      const sessionId = option('session-id');
      const workDir = option('work-dir');
      if (!sessionId || !workDir) throw new Error('--session-id and --work-dir are required');
      const expectBlocked = phase === 'terminal-create-blocked';
      result.websocket = await page.evaluate(async ({ sessionId, workDir, expectBlocked }) => new Promise((resolve, reject) => {
        const terminalId = `session-${sessionId}`;
        const surfaceId = `acceptance-${Date.now()}`;
        const socket = new WebSocket(`ws://${window.location.host}/ws`);
        const messages = [];
        let sent = false;
        const timer = window.setTimeout(() => {
          socket.close();
          reject(new Error(`Timed out waiting for terminal output: ${JSON.stringify(messages)}`));
        }, 90_000);
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data);
          messages.push(message);
          if (!sent) {
            sent = true;
            socket.send(JSON.stringify({
              type: 'terminal_create',
              requestId: `acceptance-${Date.now()}`,
              terminalId,
              surfaceId,
              cwd: workDir,
              sessionId,
              shellKind: 'wsl',
              cols: 100,
              rows: 30,
              launch: { providerId: 'codex', sessionId },
            }));
          }
          if (message.type === 'terminal_error' || message.type === 'error') {
            window.clearTimeout(timer);
            socket.close();
            if (expectBlocked && /hook|lifecycle|unavailable|trust/i.test(JSON.stringify(message))) {
              resolve(messages);
            } else {
              reject(new Error(`Terminal launch failed: ${JSON.stringify(message)}`));
            }
          }
          if (
            message.type === 'terminal_output'
            && String(message.data || '').includes('packaged acceptance fixture ready')
          ) {
            window.clearTimeout(timer);
            if (expectBlocked) {
              socket.close();
              reject(new Error('Fail-closed terminal launch unexpectedly succeeded'));
            } else {
              resolve(messages);
            }
          }
        };
        socket.onerror = () => reject(new Error('Acceptance terminal WebSocket failed'));
      }), { sessionId, workDir, expectBlocked });
    }
    if (phase === 'terminal-input') {
      const sessionId = option('session-id');
      if (!sessionId) throw new Error('--session-id is required');
      const input = option('input') || 'acceptance-persistence-input';
      result.websocket = await page.evaluate(async ({ sessionId, input }) => new Promise((resolve, reject) => {
        const terminalId = `session-${sessionId}`;
        const surfaceId = `acceptance-input-${Date.now()}`;
        const socket = new WebSocket(`ws://${window.location.host}/ws`);
        const messages = [];
        let attached = false;
        let inputSent = false;
        const timer = window.setTimeout(() => {
          socket.close();
          reject(new Error(`Timed out waiting for terminal input: ${JSON.stringify(messages)}`));
        }, 45_000);
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data);
          messages.push(message);
          if (!attached) {
            attached = true;
            socket.send(JSON.stringify({
              type: 'terminal_create', requestId: surfaceId, terminalId, surfaceId,
              sessionId, shellKind: 'wsl', cols: 100, rows: 30,
            }));
          }
          if (message.type === 'terminal_error' || message.type === 'error') {
            window.clearTimeout(timer);
            socket.close();
            reject(new Error(`Terminal input attach failed: ${JSON.stringify(message)}`));
          }
          if (message.type === 'terminal_started' && !inputSent) {
            inputSent = true;
            socket.send(JSON.stringify({
              type: 'terminal_input', requestId: `${surfaceId}-input`, terminalId,
              surfaceId, data: `${input}\r`,
            }));
          }
          if (message.type === 'terminal_output' && String(message.data || '').includes('fixture accepted input')) {
            window.clearTimeout(timer);
            socket.close();
            resolve(messages);
          }
        };
      }), { sessionId, input });
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

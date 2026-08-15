import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  CONTROL_API_VERSION_HEADER,
  CONTROL_APP_VERSION_HEADER,
  CONTROL_RUNTIME_ID_HEADER,
  createControlHttpHandler,
  classifyControlTelemetryOperation,
  isLoopbackAddress,
  isValidBearerToken,
} from '../src/lib/control/http-handler';
import type { RuntimeDescriptor } from '../src/lib/control/runtime-descriptor';
import { createControlService } from '../src/lib/control/service';

const TOKEN = Buffer.alloc(32, 5).toString('base64url');
const DESCRIPTOR: RuntimeDescriptor = {
  runtimeId: 'runtime-http-test',
  pid: process.pid,
  appVersion: '1.2.3',
  controlApiVersion: 1,
  origin: 'http://127.0.0.1:1',
  token: TOKEN,
};

test('bearer validation accepts only the exact token without length-dependent comparison', () => {
  assert.equal(isValidBearerToken(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(isValidBearerToken(`Bearer ${TOKEN.slice(1)}`, TOKEN), false);
  assert.equal(isValidBearerToken('Basic abc', TOKEN), false);
  assert.equal(isValidBearerToken(undefined, TOKEN), false);
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.10'), false);
});

test('Control telemetry reduces routes to static operation names', () => {
  assert.equal(classifyControlTelemetryOperation('GET', '/__tessera/control/v1/status'), 'status');
  assert.equal(
    classifyControlTelemetryOperation('POST', '/__tessera/control/v1/sessions/private-id/prompt'),
    'session_prompt',
  );
  assert.equal(
    classifyControlTelemetryOperation('GET', '/__tessera/control/v1/worktrees/private-id'),
    'worktree_show',
  );
  assert.equal(
    classifyControlTelemetryOperation('GET', '/__tessera/control/v1/private-user-input'),
    null,
  );
});

test('every Control request authenticates and negotiates the exact runtime and versions', async () => {
  const service = createControlService({
    appVersion: DESCRIPTOR.appVersion,
    runtimeId: DESCRIPTOR.runtimeId,
    projects: { list: () => [], get: () => undefined },
    worktrees: { list: () => [], get: () => undefined },
  });
  const telemetry: Array<{ operation: string; result: string }> = [];
  const handler = createControlHttpHandler({
    descriptor: DESCRIPTOR,
    service,
    captureTelemetry: (record) => { telemetry.push(record); },
  });
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const previousBypass = process.env.TESSERA_ELECTRON_AUTH_BYPASS;
  process.env.TESSERA_ELECTRON_AUTH_BYPASS = '1';

  try {
    const unauthorized = await getJson(origin, '/__tessera/control/v1/status', {});
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(unauthorized.body, {
      ok: false,
      apiVersion: 1,
      error: {
        code: 'UNAUTHORIZED',
        message: 'The Control credential was rejected.',
        details: {},
      },
    });

    const versionMismatch = await getJson(origin, '/__tessera/control/v1/status', {
      authorization: `Bearer ${TOKEN}`,
      [CONTROL_RUNTIME_ID_HEADER]: DESCRIPTOR.runtimeId,
      [CONTROL_API_VERSION_HEADER]: '2',
      [CONTROL_APP_VERSION_HEADER]: DESCRIPTOR.appVersion,
    });
    assert.equal(versionMismatch.status, 409);
    assert.equal(versionMismatch.body.error.code, 'CONTROL_VERSION_MISMATCH');

    const neighboringRuntime = await getJson(origin, '/__tessera/control/v1/status', {
      authorization: `Bearer ${TOKEN}`,
      [CONTROL_RUNTIME_ID_HEADER]: 'runtime-neighbor',
      [CONTROL_API_VERSION_HEADER]: '1',
      [CONTROL_APP_VERSION_HEADER]: DESCRIPTOR.appVersion,
    });
    assert.equal(neighboringRuntime.status, 409);
    assert.equal(neighboringRuntime.body.error.code, 'INSTANCE_UNAVAILABLE');

    const success = await getJson(origin, '/__tessera/control/v1/status', {
      authorization: `Bearer ${TOKEN}`,
      [CONTROL_RUNTIME_ID_HEADER]: DESCRIPTOR.runtimeId,
      [CONTROL_API_VERSION_HEADER]: '1',
      [CONTROL_APP_VERSION_HEADER]: DESCRIPTOR.appVersion,
      'x-tessera-caller-project-id': 'project-caller',
      'x-tessera-agent-environment': 'wsl',
    });
    assert.equal(success.status, 200);
    assert.deepEqual(success.body, {
      ok: true,
      apiVersion: 1,
      data: {
        appVersion: '1.2.3',
        controlVersion: 1,
        instanceId: 'runtime-http-test',
        connectionState: 'connected',
        callerContext: { projectId: 'project-caller' },
      },
    });
    assert.deepEqual(telemetry, [{ operation: 'status', result: 'success' }]);
  } finally {
    if (previousBypass === undefined) delete process.env.TESSERA_ELECTRON_AUTH_BYPASS;
    else process.env.TESSERA_ELECTRON_AUTH_BYPASS = previousBypass;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function getJson(
  origin: string,
  requestPath: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const request = http.get(`${origin}${requestPath}`, { headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
  });
}

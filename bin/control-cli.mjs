import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const CONTROL_API_VERSION = 1;
const CONTROL_DESCRIPTOR_ENV = 'TESSERA_CONTROL_DESCRIPTOR';
const CONTROL_DESCRIPTOR_OPTION = '--control-descriptor';
const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export function isControlInvocation(argv) {
  if (argv.some((arg) => (
    arg === CONTROL_DESCRIPTOR_OPTION || arg.startsWith(`${CONTROL_DESCRIPTOR_OPTION}=`)
  ))) {
    return true;
  }
  const args = withoutDescriptorSelector(argv);
  return args[0] === 'status' || args[0] === 'project';
}

export async function runControlCli(options) {
  const { argv, packageRoot, env = process.env } = options;
  const json = argv.includes('--json');
  if (argv.includes('--help') || argv.includes('-h')) {
    if (json) {
      return writeEnvelope(true, {
        ok: true,
        apiVersion: CONTROL_API_VERSION,
        data: { usage: controlUsage() },
      }, 0);
    }
    process.stdout.write(controlUsage());
    return 0;
  }
  let invocation;
  try {
    invocation = parseControlInvocation(argv, env);
  } catch (error) {
    return writeFailure(json, 2, 'INVALID_USAGE', error.message || 'Invalid Control CLI usage.');
  }

  let descriptor;
  try {
    descriptor = await readLiveDescriptor(invocation.descriptorPath);
  } catch {
    return writeFailure(json, 1, 'INSTANCE_UNAVAILABLE', 'The selected Tessera runtime is unavailable.');
  }

  let cliAppVersion;
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    if (typeof packageJson.version !== 'string' || !packageJson.version.trim()) {
      throw new Error('invalid package version');
    }
    cliAppVersion = packageJson.version.trim();
  } catch {
    return writeFailure(json, 1, 'INSTANCE_UNAVAILABLE', 'The Tessera CLI installation is unavailable.');
  }
  if (
    descriptor.controlApiVersion !== CONTROL_API_VERSION
    || descriptor.appVersion !== cliAppVersion
  ) {
    return writeFailure(
      json,
      1,
      'CONTROL_VERSION_MISMATCH',
      'The Tessera CLI and selected runtime are not compatible.',
    );
  }

  let response;
  try {
    response = await requestControl(descriptor, invocation.requestPath, env, cliAppVersion);
  } catch {
    return writeFailure(json, 1, 'INSTANCE_UNAVAILABLE', 'The selected Tessera runtime is unavailable.');
  }

  if (!isControlEnvelope(response)) {
    return writeFailure(json, 1, 'INSTANCE_UNAVAILABLE', 'The selected Tessera runtime returned an invalid response.');
  }

  if (!response.ok) {
    return writeEnvelope(json, response, 1, invocation.kind);
  }

  if (
    invocation.kind === 'status'
    && (
      response.data?.instanceId !== descriptor.runtimeId
      || response.data?.appVersion !== descriptor.appVersion
      || response.data?.controlVersion !== descriptor.controlApiVersion
    )
  ) {
    return writeFailure(json, 1, 'INSTANCE_UNAVAILABLE', 'The selected Tessera runtime did not match its descriptor.');
  }

  return writeEnvelope(json, response, 0, invocation.kind);
}

export function controlUsage() {
  return `Control commands:
  tessera status [--json]
  tessera project list [--json]
  tessera project show <project-id> [--json]

Runtime selection:
  --control-descriptor PATH  Select one exact local Tessera runtime.
`;
}

function parseControlInvocation(argv, env) {
  let descriptorPath = env[CONTROL_DESCRIPTOR_ENV]?.trim() || '';
  let descriptorSeen = false;
  let jsonSeen = false;
  const commandArgs = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      if (jsonSeen) throw new Error('--json may be supplied only once.');
      jsonSeen = true;
      continue;
    }
    if (arg === CONTROL_DESCRIPTOR_OPTION) {
      if (descriptorSeen) throw new Error(`${CONTROL_DESCRIPTOR_OPTION} may be supplied only once.`);
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        throw new Error(`${CONTROL_DESCRIPTOR_OPTION} requires a path.`);
      }
      descriptorPath = value;
      descriptorSeen = true;
      index += 1;
      continue;
    }
    if (arg.startsWith(`${CONTROL_DESCRIPTOR_OPTION}=`)) {
      if (descriptorSeen) throw new Error(`${CONTROL_DESCRIPTOR_OPTION} may be supplied only once.`);
      descriptorPath = arg.slice(CONTROL_DESCRIPTOR_OPTION.length + 1);
      if (!descriptorPath) throw new Error(`${CONTROL_DESCRIPTOR_OPTION} requires a path.`);
      descriptorSeen = true;
      continue;
    }
    commandArgs.push(arg);
  }

  if (!descriptorPath) {
    throw new Error('No Tessera Control runtime was selected.');
  }

  if (commandArgs.length === 1 && commandArgs[0] === 'status') {
    return {
      descriptorPath,
      kind: 'status',
      requestPath: '/__tessera/control/v1/status',
    };
  }

  if (
    commandArgs.length === 2
    && commandArgs[0] === 'project'
    && commandArgs[1] === 'list'
  ) {
    return {
      descriptorPath,
      kind: 'project-list',
      requestPath: '/__tessera/control/v1/projects',
    };
  }

  if (
    commandArgs.length === 3
    && commandArgs[0] === 'project'
    && commandArgs[1] === 'show'
    && commandArgs[2]
  ) {
    return {
      descriptorPath,
      kind: 'project-show',
      requestPath: `/__tessera/control/v1/projects/${encodeURIComponent(commandArgs[2])}`,
    };
  }

  throw new Error('Usage: tessera status | project list | project show <project-id> [--json]');
}

function withoutDescriptorSelector(argv) {
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === CONTROL_DESCRIPTOR_OPTION) {
      index += 1;
      continue;
    }
    if (arg.startsWith(`${CONTROL_DESCRIPTOR_OPTION}=`) || arg === '--json') continue;
    result.push(arg);
  }
  return result;
}

async function readLiveDescriptor(descriptorPath) {
  const resolvedPath = path.resolve(descriptorPath);
  const fileStat = await fs.lstat(resolvedPath);
  const parentStat = await fs.lstat(path.dirname(resolvedPath));
  if (
    !fileStat.isFile()
    || fileStat.isSymbolicLink()
    || fileStat.size > MAX_DESCRIPTOR_BYTES
    || !parentStat.isDirectory()
    || parentStat.isSymbolicLink()
  ) {
    throw new Error('unavailable');
  }

  if (process.platform !== 'win32') {
    const currentUid = process.getuid?.();
    if (
      (fileStat.mode & 0o077) !== 0
      || (parentStat.mode & 0o077) !== 0
      || (currentUid !== undefined && (fileStat.uid !== currentUid || parentStat.uid !== currentUid))
    ) {
      throw new Error('unavailable');
    }
  }

  const value = JSON.parse(await fs.readFile(resolvedPath, 'utf8'));
  if (!isDescriptor(value) || !isProcessAlive(value.pid)) throw new Error('unavailable');
  return { ...value, origin: normalizeLoopbackOrigin(value.origin) };
}

function isDescriptor(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.runtimeId === 'string'
    && value.runtimeId.trim().length > 0
    && Number.isInteger(value.pid)
    && value.pid > 0
    && typeof value.appVersion === 'string'
    && value.appVersion.trim().length > 0
    && Number.isInteger(value.controlApiVersion)
    && value.controlApiVersion > 0
    && typeof value.origin === 'string'
    && typeof value.token === 'string'
    && /^[A-Za-z0-9_-]{43}$/.test(value.token)
    && Buffer.from(value.token, 'base64url').byteLength === 32;
}

function normalizeLoopbackOrigin(value) {
  const origin = new URL(value);
  const hostname = origin.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const ipv4 = hostname.split('.');
  const loopback = hostname === '::1'
    || (
      ipv4.length === 4
      && Number(ipv4[0]) === 127
      && ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    );
  if (
    origin.protocol !== 'http:'
    || !loopback
    || origin.username
    || origin.password
    || origin.pathname !== '/'
    || origin.search
    || origin.hash
  ) {
    throw new Error('unavailable');
  }
  return origin.origin;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function requestControl(descriptor, requestPath, env, appVersion) {
  return new Promise((resolve, reject) => {
    const url = new URL(requestPath, descriptor.origin);
    const headers = {
      authorization: `Bearer ${descriptor.token}`,
      'x-tessera-runtime-id': descriptor.runtimeId,
      'x-tessera-control-version': String(CONTROL_API_VERSION),
      'x-tessera-app-version': appVersion,
      'x-tessera-agent-environment': callerAgentEnvironment(env),
    };
    copyCallerHeader(headers, 'x-tessera-caller-project-id', env.TESSERA_PROJECT_ID);
    copyCallerHeader(headers, 'x-tessera-caller-session-id', env.TESSERA_SESSION_ID);
    copyCallerHeader(headers, 'x-tessera-caller-worktree-id', env.TESSERA_WORKTREE_ID);

    const request = http.get(url, { headers }, (response) => {
      let body = '';
      let bytes = 0;
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_RESPONSE_BYTES) {
          request.destroy(new Error('response too large'));
          return;
        }
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

function callerAgentEnvironment(env) {
  if (env.TESSERA_AGENT_ENVIRONMENT === 'wsl') return 'wsl';
  if (env.TESSERA_AGENT_ENVIRONMENT === 'native') return 'native';
  return env.WSL_DISTRO_NAME || env.WSL_INTEROP ? 'wsl' : 'native';
}

function copyCallerHeader(headers, name, value) {
  const trimmed = value?.trim();
  if (trimmed) headers[name] = trimmed;
}

function isControlEnvelope(value) {
  if (!value || typeof value !== 'object' || value.apiVersion !== CONTROL_API_VERSION) return false;
  if (value.ok === true) return Object.hasOwn(value, 'data');
  return value.ok === false
    && value.error
    && typeof value.error === 'object'
    && typeof value.error.code === 'string'
    && typeof value.error.message === 'string'
    && value.error.details
    && typeof value.error.details === 'object';
}

function writeFailure(json, exitCode, code, message, details = {}) {
  return writeEnvelope(json, {
    ok: false,
    apiVersion: CONTROL_API_VERSION,
    error: { code, message, details },
  }, exitCode);
}

function writeEnvelope(json, envelope, exitCode, kind) {
  if (json) {
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
  } else if (!envelope.ok) {
    process.stderr.write(`error: ${envelope.error.message}\n`);
  } else {
    writeHumanSuccess(kind, envelope.data);
  }
  return exitCode;
}

function writeHumanSuccess(kind, data) {
  if (kind === 'status') {
    process.stdout.write(
      `Connected to Tessera ${data.appVersion} (Control v${data.controlVersion}, instance ${data.instanceId})\n`,
    );
    return;
  }
  if (kind === 'project-list') {
    for (const project of data.projects) {
      process.stdout.write(`${project.id}\t${project.displayName}\t${project.path}\t${project.visible ? 'visible' : 'hidden'}\n`);
    }
    return;
  }
  if (kind === 'project-show') {
    process.stdout.write(`${data.displayName}\n${data.id}\n${data.path}\n${data.visible ? 'visible' : 'hidden'}\n`);
  }
}

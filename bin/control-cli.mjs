import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const CONTROL_API_VERSION = 1;
const CONTROL_DESCRIPTOR_ENV = 'TESSERA_CONTROL_DESCRIPTOR';
const CONTROL_DESCRIPTOR_OPTION = '--control-descriptor';
const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const MAX_INITIAL_PROMPT_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
// The server owns the ten-minute preparation deadline. Leave additional room
// for the preceding Git worktree creation, which intentionally has no short
// timeout because large repositories can take materially longer to checkout.
const MUTATION_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

export function isControlInvocation(argv) {
  if (argv.some((arg) => (
    arg === CONTROL_DESCRIPTOR_OPTION || arg.startsWith(`${CONTROL_DESCRIPTOR_OPTION}=`)
  ))) {
    return true;
  }
  const args = withoutDescriptorSelector(argv);
  return args[0] === 'status'
    || args[0] === 'project'
    || args[0] === 'worktree'
    || args[0] === 'session';
}

export async function runControlCli(options) {
  const { argv, packageRoot, env = process.env } = options;
  const json = hasGlobalOption(argv, '--json');
  if (hasGlobalOption(argv, '--help') || hasGlobalOption(argv, '-h')) {
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
    await materializePromptChoice(invocation);
  } catch (error) {
    return writeFailure(
      json,
      error instanceof ControlCliInputError ? 1 : 2,
      error instanceof ControlCliInputError ? error.code : 'INVALID_USAGE',
      error.message || 'Invalid Control CLI usage.',
    );
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
    response = await requestControl(descriptor, invocation, env, cliAppVersion);
  } catch {
    return writeFailure(json, 1, 'INSTANCE_UNAVAILABLE', 'The selected Tessera runtime is unavailable.');
  }

  if (!isControlEnvelope(response)) {
    return writeFailure(json, 1, 'INSTANCE_UNAVAILABLE', 'The selected Tessera runtime returned an invalid response.');
  }

  if (!response.ok) {
    return writeEnvelope(
      json,
      response,
      response.error.code === 'PREPARATION_TIMEOUT' ? 124 : 1,
      invocation.kind,
    );
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
  tessera worktree list (--current | --project <project-id>) [--json]
  tessera worktree show <worktree-id> [--json]
  tessera worktree create (--current | --project <project-id>) -b <new-branch> <start-point> [--title <title>] [--json]
  tessera session list --worktree <worktree-id> [--json]
  tessera session show <session-id> [--json]
  tessera session create --worktree <worktree-id> --provider <provider-id> [--title <title>] [--json]
  tessera session start <session-id> (--prompt <text> | --prompt-file <path|-> | --no-prompt) [--allow-preparation-failure] [--json]
  tessera session launch --worktree <worktree-id> --provider <provider-id> (--prompt <text> | --prompt-file <path|-> | --no-prompt) [--title <title>] [--allow-preparation-failure] [--json]

Runtime selection:
  --control-descriptor PATH  Select one exact local Tessera runtime.
`;
}

function parseControlInvocation(argv, env) {
  let descriptorPath = env[CONTROL_DESCRIPTOR_ENV]?.trim() || '';
  let descriptorSeen = false;
  let jsonSeen = false;
  const commandArgs = [];
  const partitioned = partitionAtOptionTerminator(argv);

  for (let index = 0; index < partitioned.before.length; index += 1) {
    const arg = partitioned.before[index];
    if (arg === '--prompt' || arg === '--prompt-file') {
      commandArgs.push(arg);
      if (index + 1 < partitioned.before.length) {
        commandArgs.push(partitioned.before[index + 1]);
        index += 1;
      }
      continue;
    }
    if (arg === '--json') {
      if (jsonSeen) throw new Error('--json may be supplied only once.');
      jsonSeen = true;
      continue;
    }
    if (arg === CONTROL_DESCRIPTOR_OPTION) {
      if (descriptorSeen) throw new Error(`${CONTROL_DESCRIPTOR_OPTION} may be supplied only once.`);
      const value = partitioned.before[index + 1];
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
  if (partitioned.terminated) commandArgs.push('--', ...partitioned.after);

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
    && commandArgs[0] === 'session'
    && commandArgs[1] === 'show'
    && commandArgs[2]
  ) {
    return {
      descriptorPath,
      kind: 'session-show',
      requestPath: `/__tessera/control/v1/sessions/${encodeURIComponent(commandArgs[2])}`,
    };
  }

  if (
    commandArgs.length >= 3
    && commandArgs[0] === 'session'
    && commandArgs[1] === 'list'
  ) {
    const worktreeId = parseRequiredNamedValue(commandArgs.slice(2), '--worktree', 'Worktree ID');
    return {
      descriptorPath,
      kind: 'session-list',
      requestPath: `/__tessera/control/v1/worktrees/${encodeURIComponent(worktreeId)}/sessions`,
    };
  }

  if (
    commandArgs.length >= 3
    && commandArgs[0] === 'session'
    && commandArgs[1] === 'create'
  ) {
    const creation = parseSessionCreation(commandArgs.slice(2));
    return {
      descriptorPath,
      kind: 'session-create',
      requestPath: '/__tessera/control/v1/sessions',
      requestBody: creation,
    };
  }

  if (
    commandArgs.length >= 4
    && commandArgs[0] === 'session'
    && commandArgs[1] === 'start'
    && commandArgs[2]
  ) {
    const start = parseSessionStart(commandArgs.slice(3));
    return {
      descriptorPath,
      kind: 'session-start',
      requestPath: `/__tessera/control/v1/sessions/${encodeURIComponent(commandArgs[2])}/start`,
      requestBody: {
        initialPrompt: null,
        ...(start.allowPreparationFailure ? { allowPreparationFailure: true } : {}),
      },
      promptChoice: start.promptChoice,
    };
  }

  if (
    commandArgs.length >= 3
    && commandArgs[0] === 'session'
    && commandArgs[1] === 'launch'
  ) {
    const launch = parseSessionLaunch(commandArgs.slice(2));
    return {
      descriptorPath,
      kind: 'session-launch',
      requestPath: '/__tessera/control/v1/sessions/launch',
      requestBody: {
        worktreeId: launch.worktreeId,
        provider: launch.provider,
        ...(launch.title === undefined ? {} : { title: launch.title }),
        initialPrompt: null,
        ...(launch.allowPreparationFailure ? { allowPreparationFailure: true } : {}),
      },
      promptChoice: launch.promptChoice,
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

  if (
    commandArgs.length >= 3
    && commandArgs[0] === 'worktree'
    && commandArgs[1] === 'create'
  ) {
    const creation = parseWorktreeCreation(commandArgs.slice(2));
    return {
      descriptorPath,
      kind: 'worktree-create',
      requestPath: creation.selector.kind === 'current'
        ? '/__tessera/control/v1/worktrees?current=1'
        : `/__tessera/control/v1/worktrees?projectId=${encodeURIComponent(creation.selector.projectId)}`,
      requestBody: {
        branch: creation.branch,
        startPoint: creation.startPoint,
        ...(creation.title === undefined ? {} : { title: creation.title }),
      },
    };
  }

  if (
    commandArgs.length >= 3
    && commandArgs[0] === 'worktree'
    && commandArgs[1] === 'list'
  ) {
    const selector = parseWorktreeProjectSelector(commandArgs.slice(2));
    return {
      descriptorPath,
      kind: 'worktree-list',
      requestPath: selector.kind === 'current'
        ? '/__tessera/control/v1/worktrees?current=1'
        : `/__tessera/control/v1/worktrees?projectId=${encodeURIComponent(selector.projectId)}`,
    };
  }

  if (
    commandArgs.length === 3
    && commandArgs[0] === 'worktree'
    && commandArgs[1] === 'show'
    && commandArgs[2]
  ) {
    return {
      descriptorPath,
      kind: 'worktree-show',
      requestPath: `/__tessera/control/v1/worktrees/${encodeURIComponent(commandArgs[2])}`,
    };
  }

  throw new Error('Usage: tessera status | project list | project show <project-id> | worktree list | worktree show <worktree-id> [--json]');
}

function parseRequiredNamedValue(args, option, label) {
  if (args.length !== 2 || args[0] !== option || !args[1] || args[1].startsWith('-')) {
    throw new Error(`${option} requires exactly one ${label}.`);
  }
  return args[1];
}

function parseSessionCreation(args) {
  const parsed = parseSessionOptions(args, { promptRequired: false });
  if (!parsed.worktreeId) throw new Error('--worktree requires a Worktree ID.');
  if (!parsed.provider) throw new Error('--provider requires a provider ID.');
  return {
    worktreeId: parsed.worktreeId,
    provider: parsed.provider,
    ...(parsed.title === undefined ? {} : { title: parsed.title }),
  };
}

function parseSessionStart(args) {
  const parsed = parseSessionOptions(args, {
    promptRequired: true,
    allowed: new Set(['--prompt', '--prompt-file', '--no-prompt', '--allow-preparation-failure']),
  });
  return {
    promptChoice: parsed.promptChoice,
    allowPreparationFailure: parsed.allowPreparationFailure,
  };
}

function parseSessionLaunch(args) {
  const parsed = parseSessionOptions(args, { promptRequired: true });
  if (!parsed.worktreeId) throw new Error('--worktree requires a Worktree ID.');
  if (!parsed.provider) throw new Error('--provider requires a provider ID.');
  return parsed;
}

function parseSessionOptions(args, options) {
  const allowed = options.allowed ?? new Set([
    '--worktree', '--provider', '--title', '--prompt', '--prompt-file', '--no-prompt',
    '--allow-preparation-failure',
  ]);
  const parsed = {
    worktreeId: '',
    provider: '',
    title: undefined,
    promptChoice: undefined,
    allowPreparationFailure: false,
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!allowed.has(arg)) throw new Error(`Unknown Session option: ${arg}`);
    if (seen.has(arg)) throw new Error(`${arg} may be supplied only once.`);
    seen.add(arg);
    if (arg === '--no-prompt') {
      if (parsed.promptChoice) throw new Error('Exactly one initial prompt choice is required.');
      parsed.promptChoice = { kind: 'none' };
      continue;
    }
    if (arg === '--allow-preparation-failure') {
      parsed.allowPreparationFailure = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || (arg !== '--prompt' && arg !== '--prompt-file' && value.startsWith('-'))) {
      throw new Error(`${arg} requires a value.`);
    }
    index += 1;
    if (arg === '--prompt' || arg === '--prompt-file') {
      if (parsed.promptChoice) throw new Error('Exactly one initial prompt choice is required.');
      parsed.promptChoice = { kind: arg === '--prompt' ? 'text' : 'file', value };
    } else if (arg === '--worktree') {
      parsed.worktreeId = value;
    } else if (arg === '--provider') {
      parsed.provider = value;
    } else if (arg === '--title') {
      parsed.title = value;
    }
  }
  if (options.promptRequired && !parsed.promptChoice) {
    throw new Error('Exactly one of --prompt, --prompt-file, and --no-prompt is required.');
  }
  return parsed;
}

async function materializePromptChoice(invocation) {
  if (!invocation.promptChoice) return;
  if (invocation.promptChoice.kind === 'none') return;
  const initialPrompt = invocation.promptChoice.kind === 'text'
    ? invocation.promptChoice.value
    : await fs.readFile(invocation.promptChoice.value === '-' ? 0 : invocation.promptChoice.value, 'utf8');
  if (Buffer.byteLength(initialPrompt, 'utf8') > MAX_INITIAL_PROMPT_BYTES) {
    throw new ControlCliInputError(
      'INITIAL_PROMPT_TOO_LARGE',
      `The initial prompt exceeds ${MAX_INITIAL_PROMPT_BYTES.toLocaleString('en-US')} UTF-8 bytes.`,
    );
  }
  invocation.requestBody.initialPrompt = initialPrompt;
  delete invocation.promptChoice;
}

class ControlCliInputError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseWorktreeCreation(args) {
  let current = false;
  let currentSeen = false;
  let projectId = '';
  let projectSeen = false;
  let branch = '';
  let branchSeen = false;
  let title;
  let titleSeen = false;
  let positionalOnly = false;
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!positionalOnly && arg === '--') {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && arg === '--current') {
      if (currentSeen) throw new Error('--current may be supplied only once.');
      current = true;
      currentSeen = true;
      continue;
    }
    if (!positionalOnly && arg === '--project') {
      if (projectSeen) throw new Error('--project may be supplied only once.');
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new Error('--project requires a Project ID.');
      projectId = value;
      projectSeen = true;
      index += 1;
      continue;
    }
    if (!positionalOnly && (arg === '-b' || arg === '--branch')) {
      if (branchSeen) throw new Error('-b/--branch may be supplied only once.');
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new Error('-b/--branch requires a new branch.');
      branch = value;
      branchSeen = true;
      index += 1;
      continue;
    }
    if (!positionalOnly && arg === '--title') {
      if (titleSeen) throw new Error('--title may be supplied only once.');
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new Error('--title requires a title.');
      title = value;
      titleSeen = true;
      index += 1;
      continue;
    }
    if (!positionalOnly && arg.startsWith('-')) {
      throw new Error(`Unknown Worktree creation option: ${arg}`);
    }
    positionals.push(arg);
  }

  if (current === projectSeen) {
    throw new Error('Exactly one of --current and --project <project-id> is required.');
  }
  if (!branchSeen) throw new Error('-b/--branch is required.');
  if (positionals.length !== 1 || !positionals[0]) {
    throw new Error('Exactly one Worktree start point is required.');
  }
  return {
    selector: current ? { kind: 'current' } : { kind: 'project', projectId },
    branch,
    startPoint: positionals[0],
    ...(title === undefined ? {} : { title }),
  };
}

function parseWorktreeProjectSelector(args) {
  let current = false;
  let projectId = '';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--current') {
      if (current) throw new Error('--current may be supplied only once.');
      current = true;
      continue;
    }
    if (arg === '--project') {
      if (projectId) throw new Error('--project may be supplied only once.');
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new Error('--project requires a Project ID.');
      projectId = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown Worktree selector: ${arg}`);
  }
  if (current === Boolean(projectId)) {
    throw new Error('Exactly one of --current and --project <project-id> is required.');
  }
  return current ? { kind: 'current' } : { kind: 'project', projectId };
}

function withoutDescriptorSelector(argv) {
  const result = [];
  const partitioned = partitionAtOptionTerminator(argv);
  for (let index = 0; index < partitioned.before.length; index += 1) {
    const arg = partitioned.before[index];
    if (arg === CONTROL_DESCRIPTOR_OPTION) {
      index += 1;
      continue;
    }
    if (
      arg.startsWith(`${CONTROL_DESCRIPTOR_OPTION}=`) || arg === '--json'
    ) continue;
    result.push(arg);
  }
  if (partitioned.terminated) result.push('--', ...partitioned.after);
  return result;
}

function hasGlobalOption(argv, option) {
  const args = partitionAtOptionTerminator(argv).before;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--prompt' || args[index] === '--prompt-file') {
      index += 1;
      continue;
    }
    if (args[index] === option) return true;
  }
  return false;
}

function partitionAtOptionTerminator(argv) {
  const separatorIndex = argv.indexOf('--');
  return separatorIndex === -1
    ? { before: argv, after: [], terminated: false }
    : {
        before: argv.slice(0, separatorIndex),
        after: argv.slice(separatorIndex + 1),
        terminated: true,
      };
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

function requestControl(descriptor, invocation, env, appVersion) {
  return new Promise((resolve, reject) => {
    const url = new URL(invocation.requestPath, descriptor.origin);
    const requestBody = invocation.requestBody === undefined
      ? null
      : JSON.stringify(invocation.requestBody);
    const headers = {
      authorization: `Bearer ${descriptor.token}`,
      'x-tessera-runtime-id': descriptor.runtimeId,
      'x-tessera-control-version': String(CONTROL_API_VERSION),
      'x-tessera-app-version': appVersion,
      'x-tessera-agent-environment': callerAgentEnvironment(env),
    };
    if (requestBody !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(requestBody));
    }
    copyCallerHeader(headers, 'x-tessera-caller-project-id', env.TESSERA_PROJECT_ID);
    copyCallerHeader(headers, 'x-tessera-caller-session-id', env.TESSERA_SESSION_ID);
    copyCallerHeader(headers, 'x-tessera-caller-worktree-id', env.TESSERA_WORKTREE_ID);

    const request = http.request(url, {
      headers,
      method: requestBody === null ? 'GET' : 'POST',
    }, (response) => {
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
    request.setTimeout(
      requestBody === null ? REQUEST_TIMEOUT_MS : MUTATION_REQUEST_TIMEOUT_MS,
      () => request.destroy(new Error('timeout')),
    );
    request.on('error', reject);
    if (requestBody !== null) request.write(requestBody);
    request.end();
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
    return;
  }
  if (kind === 'worktree-list') {
    for (const worktree of data.worktrees) {
      process.stdout.write(`${worktree.worktreeId}\t${worktree.title}\t${worktree.branch ?? ''}\t${worktree.path ?? ''}\n`);
    }
    return;
  }
  if (kind === 'worktree-show') {
    process.stdout.write(`${data.title}\n${data.worktreeId}\n${data.branch ?? ''}\n${data.path ?? ''}\n`);
    return;
  }
  if (kind === 'worktree-create') {
    process.stdout.write(`${data.worktreeId}\n${data.title}\n${data.branch}\n${data.path}\n`);
    return;
  }
  if (kind === 'session-list') {
    for (const session of data.sessions) {
      process.stdout.write(`${session.sessionId}\t${session.title}\t${session.provider}\n`);
    }
    return;
  }
  if (kind === 'session-show' || kind === 'session-create') {
    process.stdout.write(`${data.sessionId}\n${data.title}\n${data.provider}\n`);
    return;
  }
  if (kind === 'session-start' || kind === 'session-launch') {
    process.stdout.write(`${data.session.sessionId}\n${data.terminalId}\n`);
  }
}

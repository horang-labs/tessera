import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
const PROVIDER_SKILL_IDS = Object.freeze(Object.keys(JSON.parse(
  fsSync.readFileSync(new URL('./provider-skill-ids.json', import.meta.url), 'utf8'),
)));

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
const execFileAsync = promisify(execFile);

export function isControlInvocation(argv) {
  if (argv.some((arg) => (
    arg === CONTROL_DESCRIPTOR_OPTION || arg.startsWith(`${CONTROL_DESCRIPTOR_OPTION}=`)
  ))) {
    return true;
  }
  const args = withoutDescriptorSelector(argv);
  return args[0] === 'status'
    || args[0] === 'skills'
    || args[0] === 'project'
    || args[0] === 'worktree'
    || args[0] === 'session'
    || args[0] === 'provider';
}

export async function runControlCli(options) {
  const { argv, packageRoot, env = process.env } = options;
  const json = hasGlobalOption(argv, '--json');
  if (hasGlobalOption(argv, '--help') || hasGlobalOption(argv, '-h')) {
    try {
      validateHelpInvocation(argv);
    } catch (error) {
      return writeFailure(
        json,
        2,
        'INVALID_USAGE',
        error.message || 'Invalid Control CLI usage.',
      );
    }
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
    await materializePromptChoice(invocation, env);
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
      ['PREPARATION_TIMEOUT', 'WAIT_TIMEOUT'].includes(response.error.code) ? 124 : 1,
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

  const validatedData = validateSuccessData(invocation.kind, response.data);
  if (validatedData === INVALID_SUCCESS_DATA) {
    return writeFailure(
      json,
      1,
      'INSTANCE_UNAVAILABLE',
      'The selected Tessera runtime returned an invalid response.',
    );
  }

  const exitCode = [
    'provider-codex-lifecycle-install',
    'provider-codex-lifecycle-update',
  ].includes(invocation.kind)
    && validatedData.health.state !== 'healthy'
    ? 1
    : 0;
  return writeEnvelope(json, { ...response, data: validatedData }, exitCode, invocation.kind);
}

export function controlUsage() {
  return `Control commands:
  tessera status [--json]
  tessera skills status [--provider <claude-code|codex|opencode>]... [--json]
  tessera skills install [--provider <claude-code|codex|opencode>]... [--json]
  tessera skills update [--provider <claude-code|codex|opencode>]... [--json]
  tessera skills remove [--provider <claude-code|codex|opencode>]... [--json]
  tessera project list [--json]
  tessera project show <project-id> [--json]
  tessera project audit (--current | --project <project-id>) [--json]
  tessera worktree list (--current | --project <project-id>) [--json]
  tessera worktree show <worktree-id> [--json]
  tessera worktree create (--current | --project <project-id>) [--mode <branch-off|checkout-branch>] -b <branch> [<start-point>] [--title <title>] [--json]
  tessera session list --worktree <worktree-id> [--json]
  tessera session show <session-id> [--json]
  tessera session create --worktree <worktree-id> --provider <provider-id> [--title <title>] [--model <model>] [--effort <level>] [--fast | --no-fast] [--json]
  tessera session start <session-id> (--prompt <text> | --prompt-file <path|-> | --no-prompt) [--allow-preparation-failure] [--json]
  tessera session launch --worktree <worktree-id> --provider <provider-id> (--prompt <text> | --prompt-file <path|-> | --no-prompt) [--title <title>] [--model <model>] [--effort <level>] [--fast | --no-fast] [--allow-preparation-failure] [--json]
  tessera session read <session-id> [--json]
  tessera session wait <session-id> --for <running|turn-complete|input-required|runtime-exit> [--timeout <seconds>] [--json]
  tessera session prompt <session-id> (--text <text> | --file <path|->) [--json]
  tessera session send-keys <session-id> <enter|escape|ctrl-c|up|down|left|right>... [--json]
  tessera session stop <session-id> [--json]
  tessera provider codex lifecycle status [--json]
  tessera provider codex lifecycle install --consent [--json]
  tessera provider codex lifecycle update [--json]
  tessera provider codex lifecycle remove [--json]

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
    if (isLiteralValueOption(arg)) {
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
    commandArgs.length === 4
    && commandArgs[0] === 'provider'
    && commandArgs[1] === 'codex'
    && commandArgs[2] === 'lifecycle'
    && commandArgs[3] === 'status'
  ) {
    return {
      descriptorPath,
      kind: 'provider-codex-lifecycle-status',
      requestPath: '/__tessera/control/v1/provider-integrations/codex/lifecycle',
    };
  }

  if (
    commandArgs.length === 4
    && commandArgs[0] === 'provider'
    && commandArgs[1] === 'codex'
    && commandArgs[2] === 'lifecycle'
    && ['update', 'remove'].includes(commandArgs[3])
  ) {
    return {
      descriptorPath,
      kind: `provider-codex-lifecycle-${commandArgs[3]}`,
      requestPath: '/__tessera/control/v1/provider-integrations/codex/lifecycle',
      requestBody: { operation: commandArgs[3] },
    };
  }

  if (
    commandArgs.length === 5
    && commandArgs[0] === 'provider'
    && commandArgs[1] === 'codex'
    && commandArgs[2] === 'lifecycle'
    && commandArgs[3] === 'install'
    && commandArgs[4] === '--consent'
  ) {
    return {
      descriptorPath,
      kind: 'provider-codex-lifecycle-install',
      requestPath: '/__tessera/control/v1/provider-integrations/codex/lifecycle',
      requestBody: { consent: 'granted' },
    };
  }

  if (
    commandArgs.length >= 2
    && commandArgs[0] === 'skills'
    && ['status', 'install', 'update', 'remove'].includes(commandArgs[1])
  ) {
    const operation = commandArgs[1];
    const providerIds = parseProviderSkillSelection(commandArgs.slice(2));
    if (operation === 'status') {
      const query = providerIds.length === 0
        ? ''
        : `?${providerIds.map((providerId) => `provider=${encodeURIComponent(providerId)}`).join('&')}`;
      return {
        descriptorPath,
        kind: 'provider-skills-status',
        requestPath: `/__tessera/control/v1/provider-skills${query}`,
      };
    }
    return {
      descriptorPath,
      kind: `provider-skills-${operation}`,
      requestPath: `/__tessera/control/v1/provider-skills/${operation}`,
      requestBody: providerIds.length === 0 ? {} : { providerIds },
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
    commandArgs.length >= 3
    && commandArgs[0] === 'project'
    && commandArgs[1] === 'audit'
  ) {
    const selector = parseWorktreeProjectSelector(commandArgs.slice(2));
    return {
      descriptorPath,
      kind: 'project-audit',
      requestPath: selector.kind === 'current'
        ? '/__tessera/control/v1/audit?current=1'
        : `/__tessera/control/v1/audit?projectId=${encodeURIComponent(selector.projectId)}`,
    };
  }

  if (
    commandArgs.length >= 5
    && commandArgs[0] === 'session'
    && commandArgs[1] === 'prompt'
    && commandArgs[2]
  ) {
    return {
      descriptorPath,
      kind: 'session-prompt',
      requestPath: `/__tessera/control/v1/sessions/${encodeURIComponent(commandArgs[2])}/prompt`,
      requestBody: {},
      sessionPromptChoice: parseSessionPrompt(commandArgs.slice(3)),
    };
  }

  if (
    commandArgs.length >= 4
    && commandArgs[0] === 'session'
    && commandArgs[1] === 'send-keys'
    && commandArgs[2]
  ) {
    const keys = commandArgs.slice(3);
    const supported = new Set(['enter', 'escape', 'ctrl-c', 'up', 'down', 'left', 'right']);
    if (keys.length === 0 || !keys.every((key) => supported.has(key))) {
      throw new Error('Session keys must use only the supported names.');
    }
    return {
      descriptorPath,
      kind: 'session-send-keys',
      requestPath: `/__tessera/control/v1/sessions/${encodeURIComponent(commandArgs[2])}/keys`,
      requestBody: { keys },
    };
  }

  if (
    commandArgs.length === 3
    && commandArgs[0] === 'session'
    && commandArgs[1] === 'stop'
    && commandArgs[2]
  ) {
    return {
      descriptorPath,
      kind: 'session-stop',
      requestPath: `/__tessera/control/v1/sessions/${encodeURIComponent(commandArgs[2])}/stop`,
      requestBody: {},
    };
  }

  if (
    commandArgs.length === 3
    && commandArgs[0] === 'session'
    && commandArgs[1] === 'read'
    && commandArgs[2]
  ) {
    return {
      descriptorPath,
      kind: 'session-read',
      requestPath: `/__tessera/control/v1/sessions/${encodeURIComponent(commandArgs[2])}/read`,
    };
  }

  if (
    commandArgs.length >= 5
    && commandArgs[0] === 'session'
    && commandArgs[1] === 'wait'
    && commandArgs[2]
  ) {
    const wait = parseSessionWait(commandArgs.slice(3));
    return {
      descriptorPath,
      kind: 'session-wait',
      requestPath: `/__tessera/control/v1/sessions/${encodeURIComponent(commandArgs[2])}/wait`,
      requestBody: {
        condition: wait.condition,
        ...(wait.timeoutSeconds === undefined ? {} : { timeoutSeconds: wait.timeoutSeconds }),
      },
      waitTimeoutSeconds: wait.timeoutSeconds ?? 600,
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
        ...(launch.model === undefined ? {} : { model: launch.model }),
        ...(launch.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: launch.reasoningEffort }),
        ...(launch.serviceTier === undefined ? {} : { serviceTier: launch.serviceTier }),
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
        ...(creation.source.mode === 'branch-off' ? { branch: creation.branch } : {}),
        source: creation.source,
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

  throw new Error('Invalid Control command. Run tessera --help for usage.');
}

function parseProviderSkillSelection(args) {
  const providerIds = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--provider') {
      throw new Error(`Unknown provider skill option: ${args[index]}`);
    }
    const providerId = args[index + 1];
    if (!providerId || providerId.startsWith('-')) {
      throw new Error('--provider requires a provider ID.');
    }
    if (!PROVIDER_SKILL_IDS.includes(providerId)) {
      throw new Error(`Unsupported provider skill target: ${providerId}`);
    }
    if (!providerIds.includes(providerId)) providerIds.push(providerId);
    index += 1;
  }
  return providerIds;
}

function parseRequiredNamedValue(args, option, label) {
  if (args.length !== 2 || args[0] !== option || !args[1] || args[1].startsWith('-')) {
    throw new Error(`${option} requires exactly one ${label}.`);
  }
  return args[1];
}

function parseSessionWait(args) {
  let condition;
  let timeoutSeconds;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option !== '--for' && option !== '--timeout') {
      throw new Error(`Unknown Session wait option: ${option}`);
    }
    if (seen.has(option)) throw new Error(`${option} may be supplied only once.`);
    seen.add(option);
    const value = args[index + 1];
    if (!value || value.startsWith('-')) throw new Error(`${option} requires a value.`);
    index += 1;
    if (option === '--for') {
      if (!['running', 'turn-complete', 'input-required', 'runtime-exit'].includes(value)) {
        throw new Error('--for requires a supported Session condition.');
      }
      condition = value;
    } else {
      if (!/^\d+$/.test(value)) throw new Error('--timeout requires an integer number of seconds.');
      timeoutSeconds = Number(value);
      if (timeoutSeconds < 1 || timeoutSeconds > 3600) {
        throw new Error('--timeout must be from 1 to 3600 seconds.');
      }
    }
  }
  if (!condition) throw new Error('--for requires a supported Session condition.');
  return { condition, timeoutSeconds };
}

function parseSessionPrompt(args) {
  if (args.length !== 2 || !['--text', '--file'].includes(args[0])) {
    throw new Error('Exactly one of --text and --file is required.');
  }
  if (args[1] === undefined) throw new Error(`${args[0]} requires a value.`);
  return { kind: args[0] === '--text' ? 'text' : 'file', value: args[1] };
}

function parseSessionCreation(args) {
  const parsed = parseSessionOptions(args, {
    promptRequired: false,
    allowed: new Set([
      '--worktree', '--provider', '--title', '--model', '--effort', '--fast', '--no-fast',
    ]),
  });
  if (!parsed.worktreeId) throw new Error('--worktree requires a Worktree ID.');
  if (!parsed.provider) throw new Error('--provider requires a provider ID.');
  return {
    worktreeId: parsed.worktreeId,
    provider: parsed.provider,
    ...(parsed.title === undefined ? {} : { title: parsed.title }),
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    ...(parsed.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: parsed.reasoningEffort }),
    ...(parsed.serviceTier === undefined ? {} : { serviceTier: parsed.serviceTier }),
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
    '--worktree', '--provider', '--title', '--model', '--effort', '--fast', '--no-fast',
    '--prompt', '--prompt-file', '--no-prompt',
    '--allow-preparation-failure',
  ]);
  const parsed = {
    worktreeId: '',
    provider: '',
    title: undefined,
    model: undefined,
    reasoningEffort: undefined,
    serviceTier: undefined,
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
    if (arg === '--fast' || arg === '--no-fast') {
      if (parsed.serviceTier !== undefined) {
        throw new Error('Exactly one of --fast and --no-fast may be supplied.');
      }
      parsed.serviceTier = arg === '--fast' ? 'fast' : 'default';
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
    } else if (arg === '--model') {
      parsed.model = value;
    } else if (arg === '--effort') {
      parsed.reasoningEffort = value;
    }
  }
  if (options.promptRequired && !parsed.promptChoice) {
    throw new Error('Exactly one of --prompt, --prompt-file, and --no-prompt is required.');
  }
  return parsed;
}

async function materializePromptChoice(invocation, env) {
  if (invocation.sessionPromptChoice) {
    let text;
    try {
      text = invocation.sessionPromptChoice.kind === 'text'
        ? invocation.sessionPromptChoice.value
        : invocation.sessionPromptChoice.value === '-'
          ? await readStandardInput()
          : await fs.readFile(
              await resolveCallerFilePath(invocation.sessionPromptChoice.value, env),
              'utf8',
            );
    } catch {
      throw new ControlCliInputError(
        'INPUT_NOT_ACCEPTED',
        'The Session prompt input is unavailable.',
      );
    }
    if (!text.trim()) {
      throw new ControlCliInputError('INPUT_NOT_ACCEPTED', 'The Session prompt must not be empty.');
    }
    invocation.requestBody.text = text;
    delete invocation.sessionPromptChoice;
    return;
  }
  if (!invocation.promptChoice) return;
  if (invocation.promptChoice.kind === 'none') return;
  const initialPrompt = invocation.promptChoice.kind === 'text'
    ? invocation.promptChoice.value
    : invocation.promptChoice.value === '-'
      ? await readStandardInput()
      : await fs.readFile(
          await resolveCallerFilePath(invocation.promptChoice.value, env),
          'utf8',
        );
  if (Buffer.byteLength(initialPrompt, 'utf8') > MAX_INITIAL_PROMPT_BYTES) {
    throw new ControlCliInputError(
      'INITIAL_PROMPT_TOO_LARGE',
      `The initial prompt exceeds ${MAX_INITIAL_PROMPT_BYTES.toLocaleString('en-US')} UTF-8 bytes.`,
    );
  }
  invocation.requestBody.initialPrompt = initialPrompt;
  delete invocation.promptChoice;
}

export async function resolveCallerFilePath(filePath, env = process.env, options = {}) {
  const platform = options.platform ?? process.platform;
  if (
    platform !== 'win32'
    || env.TESSERA_AGENT_ENVIRONMENT?.trim().toLowerCase() !== 'wsl'
  ) {
    return filePath;
  }

  if (path.posix.isAbsolute(filePath)) {
    const translateWslPath = options.translateWslPath ?? translateWslPathForHost;
    const translated = await translateWslPath(
      filePath,
      env.TESSERA_CLI_WSL_DISTRO?.trim() || undefined,
    );
    if (!translated || !path.win32.isAbsolute(translated)) {
      throw new ControlCliInputError(
        'INPUT_NOT_ACCEPTED',
        'The caller file path is unavailable.',
      );
    }
    return translated;
  }

  if (path.win32.isAbsolute(filePath)) return filePath;
  const callerCwd = env.TESSERA_CLI_CWD?.trim();
  if (!callerCwd || !path.win32.isAbsolute(callerCwd)) {
    throw new ControlCliInputError(
      'INPUT_NOT_ACCEPTED',
      'The caller working directory is unavailable.',
    );
  }
  return path.win32.resolve(callerCwd, filePath);
}

async function translateWslPathForHost(filePath, distroName) {
  const args = [];
  if (distroName) args.push('-d', distroName);
  args.push('-e', 'wslpath', '-w', '--', filePath);
  const { stdout } = await execFileAsync('wsl.exe', args, {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  return stdout.trim();
}

async function readStandardInput() {
  process.stdin.setEncoding('utf8');
  let value = '';
  for await (const chunk of process.stdin) value += chunk;
  return value;
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
  let mode = 'branch-off';
  let modeSeen = false;
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
    if (!positionalOnly && arg === '--mode') {
      if (modeSeen) throw new Error('--mode may be supplied only once.');
      const value = args[index + 1];
      if (value !== 'branch-off' && value !== 'checkout-branch') {
        throw new Error('--mode requires branch-off or checkout-branch.');
      }
      mode = value;
      modeSeen = true;
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
  if (mode === 'branch-off' && (positionals.length !== 1 || !positionals[0])) {
    throw new Error('Exactly one Worktree start point is required.');
  }
  if (mode === 'checkout-branch' && positionals.length !== 0) {
    throw new Error('checkout-branch does not accept a Worktree start point.');
  }
  return {
    selector: current ? { kind: 'current' } : { kind: 'project', projectId },
    branch,
    source: mode === 'checkout-branch'
      ? { mode, branch }
      : { mode, baseRef: positionals[0] },
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
    if (isLiteralValueOption(arg)) {
      result.push(arg);
      if (index + 1 < partitioned.before.length) {
        result.push(partitioned.before[index + 1]);
        index += 1;
      }
      continue;
    }
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
    if (isLiteralValueOption(args[index])) {
      index += 1;
      continue;
    }
    if (args[index] === option) return true;
  }
  return false;
}

function validateHelpInvocation(argv) {
  const args = withoutDescriptorSelector(withoutHelpOptions(argv));
  if (args[0] !== 'session' || args[1] !== 'create') return;
  parseSessionOptions(args.slice(2), {
    promptRequired: false,
    allowed: new Set([
      '--worktree', '--provider', '--title', '--model', '--effort', '--fast', '--no-fast',
    ]),
  });
}

function withoutHelpOptions(argv) {
  const result = [];
  const partitioned = partitionAtOptionTerminator(argv);
  for (let index = 0; index < partitioned.before.length; index += 1) {
    const arg = partitioned.before[index];
    if (isLiteralValueOption(arg)) {
      result.push(arg);
      if (index + 1 < partitioned.before.length) {
        result.push(partitioned.before[index + 1]);
        index += 1;
      }
      continue;
    }
    if (arg === '--help' || arg === '-h') continue;
    result.push(arg);
  }
  if (partitioned.terminated) result.push('--', ...partitioned.after);
  return result;
}

function partitionAtOptionTerminator(argv) {
  let separatorIndex = -1;
  for (let index = 0; index < argv.length; index += 1) {
    if (isLiteralValueOption(argv[index])) {
      index += 1;
      continue;
    }
    if (argv[index] === '--') {
      separatorIndex = index;
      break;
    }
  }
  return separatorIndex === -1
    ? { before: argv, after: [], terminated: false }
    : {
        before: argv.slice(0, separatorIndex),
        after: argv.slice(separatorIndex + 1),
        terminated: true,
      };
}

function isLiteralValueOption(value) {
  return value === '--prompt'
    || value === '--prompt-file'
    || value === '--text'
    || value === '--file';
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
    copyCallerHeader(headers, 'x-tessera-control-authority', env.TESSERA_CONTROL_AUTHORITY);

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
      invocation.kind === 'session-wait'
        ? (invocation.waitTimeoutSeconds + 5) * 1_000
        : requestBody === null ? REQUEST_TIMEOUT_MS : MUTATION_REQUEST_TIMEOUT_MS,
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

const INVALID_SUCCESS_DATA = Symbol('invalid-success-data');

function validateSuccessData(kind, data) {
  if (kind === 'project-audit') {
    if (!isRecord(data) || !Array.isArray(data.records)) return INVALID_SUCCESS_DATA;
    const records = data.records.map(parsePublicControlAuditRecord);
    return records.some((record) => record === null)
      ? INVALID_SUCCESS_DATA
      : { records };
  }
  if (
    kind === 'provider-codex-lifecycle-status'
    || kind === 'provider-codex-lifecycle-install'
    || kind === 'provider-codex-lifecycle-update'
    || kind === 'provider-codex-lifecycle-remove'
  ) {
    return parseProviderIntegrationDecision(data) ?? INVALID_SUCCESS_DATA;
  }
  if (kind.startsWith('provider-skills-')) {
    return parseProviderSkillManagementResult(data) ?? INVALID_SUCCESS_DATA;
  }
  if (kind === 'session-list') {
    if (!isRecord(data) || !Array.isArray(data.sessions)) return INVALID_SUCCESS_DATA;
    const sessions = data.sessions.map(parsePublicSessionDto);
    return sessions.some((session) => session === null)
      ? INVALID_SUCCESS_DATA
      : { sessions };
  }
  if (kind === 'session-show' || kind === 'session-create') {
    return parsePublicSessionDto(data) ?? INVALID_SUCCESS_DATA;
  }
  if (kind === 'session-start' || kind === 'session-launch') {
    if (!isRecord(data) || !isNonEmptyString(data.terminalId)) return INVALID_SUCCESS_DATA;
    const session = parsePublicSessionDto(data.session);
    return session
      ? { session, terminalId: data.terminalId }
      : INVALID_SUCCESS_DATA;
  }
  if (
    kind === 'session-read'
    || kind === 'session-wait'
    || kind === 'session-prompt'
    || kind === 'session-send-keys'
    || kind === 'session-stop'
  ) {
    return parseSessionSnapshot(data) ?? INVALID_SUCCESS_DATA;
  }
  return data;
}

function parsePublicControlAuditRecord(value) {
  if (!isRecord(value) || !isRecord(value.target)) return null;
  if (
    !isNonEmptyString(value.id)
    || !isNonEmptyString(value.projectId)
    || !isNonEmptyString(value.sourceSessionId)
    || ![
      'worktree.create',
      'session.create',
      'session.start',
      'session.launch',
      'session.prompt',
      'session.send-keys',
      'session.stop',
    ].includes(value.operation)
    || !['project', 'worktree', 'session'].includes(value.target.kind)
    || !isNonEmptyString(value.target.id)
    || !isNonEmptyString(value.occurredAt)
    || !['pending', 'succeeded', 'failed'].includes(value.outcome)
    || !(value.failureCode === undefined || isNonEmptyString(value.failureCode))
  ) return null;
  return {
    id: value.id,
    projectId: value.projectId,
    sourceSessionId: value.sourceSessionId,
    operation: value.operation,
    target: { kind: value.target.kind, id: value.target.id },
    occurredAt: value.occurredAt,
    outcome: value.outcome,
    ...(value.failureCode === undefined ? {} : { failureCode: value.failureCode }),
  };
}

function parseProviderIntegrationDecision(value) {
  if (!isRecord(value) || !isRecord(value.providerHome) || !isRecord(value.health)) return null;
  if (
    value.providerHome.owner !== 'agent-environment'
    || !['native', 'wsl'].includes(value.providerHome.agentEnvironment)
    || !['healthy', 'degraded', 'blocked', 'unchecked'].includes(value.health.state)
  ) return null;
  const lifecycle = parseArtifactPolicy(value.lifecycle);
  const skill = parseArtifactPolicy(value.skill);
  if (!lifecycle || !skill) return null;
  if (value.guidance !== undefined) {
    if (
      !isRecord(value.guidance)
      || !isNonEmptyString(value.guidance.minimumVersion)
      || !isNonEmptyString(value.guidance.updateCommand)
      || !isNonEmptyString(value.guidance.message)
    ) return null;
  }
  return {
    providerHome: {
      owner: 'agent-environment',
      agentEnvironment: value.providerHome.agentEnvironment,
    },
    lifecycle,
    skill,
    health: { state: value.health.state },
    ...(value.guidance === undefined ? {} : { guidance: value.guidance }),
  };
}

function parseArtifactPolicy(value) {
  if (!isRecord(value)) return null;
  if (
    !['required', 'optional', 'not-applicable'].includes(value.requirement)
    || !['unchecked', 'ready', 'stale', 'absent', 'installed', 'conflict', 'unavailable', 'not-applicable'].includes(value.state)
    || !['unchecked', 'not-required', 'required', 'granted', 'revoked', 'declined'].includes(value.consent)
    || !['unchecked', 'not-required', 'trusted', 'untrusted', 'unavailable'].includes(value.trust)
    || !(value.installedVersion === undefined || isNonEmptyString(value.installedVersion))
    || !(value.currentVersion === undefined || isNonEmptyString(value.currentVersion))
    || (value.message !== undefined && typeof value.message !== 'string')
  ) return null;
  return {
    requirement: value.requirement,
    state: value.state,
    consent: value.consent,
    trust: value.trust,
    ...(value.installedVersion === undefined ? {} : { installedVersion: value.installedVersion }),
    ...(value.currentVersion === undefined ? {} : { currentVersion: value.currentVersion }),
    ...(value.message === undefined ? {} : { message: value.message }),
  };
}

function parseProviderSkillManagementResult(value) {
  if (
    !isRecord(value)
    || value.success !== true
    || !['install', 'status', 'update', 'remove'].includes(value.operation)
    || !['native', 'wsl'].includes(value.agentEnvironment)
    || !Array.isArray(value.providers)
  ) return null;
  const providers = value.providers.map((provider) => {
    if (
      !isRecord(provider)
      || !PROVIDER_SKILL_IDS.includes(provider.providerId)
      || typeof provider.detected !== 'boolean'
      || !['absent', 'ready', 'stale', 'conflict', 'unavailable'].includes(provider.state)
      || !['granted', 'revoked', 'not-granted'].includes(provider.consent)
      || !['none', 'tessera', 'user', 'unknown'].includes(provider.ownership)
    ) return null;
    return {
      providerId: provider.providerId,
      detected: provider.detected,
      state: provider.state,
      consent: provider.consent,
      ownership: provider.ownership,
    };
  });
  if (providers.some((provider) => provider === null)) return null;
  return {
    success: true,
    operation: value.operation,
    agentEnvironment: value.agentEnvironment,
    providers,
  };
}

function parsePublicSessionDto(value) {
  if (!isRecord(value)) return null;
  const fields = ['sessionId', 'worktreeId', 'projectId', 'title', 'provider', 'updatedAt'];
  if (!fields.every((field) => isNonEmptyString(value[field]))) return null;
  if (value.model !== undefined && !isNonEmptyString(value.model)) return null;
  if (value.reasoningEffort !== undefined && !isNonEmptyString(value.reasoningEffort)) return null;
  if (value.serviceTier !== undefined && !isNonEmptyString(value.serviceTier)) return null;
  return {
    ...Object.fromEntries(fields.map((field) => [field, value[field]])),
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: value.reasoningEffort }),
    ...(value.serviceTier === undefined ? {} : { serviceTier: value.serviceTier }),
  };
}

function parseSessionSnapshot(value) {
  if (!isRecord(value)) return null;
  const validNullableDimension = (dimension) => dimension === null
    || (Number.isInteger(dimension) && dimension > 0);
  const validRuntimeState = [
    'starting', 'idle', 'running', 'input-required', 'turn-complete', 'exited',
  ].includes(value.runtimeState);
  const dimensionsAreConsistent = (value.cols === null && value.rows === null)
    || (Number.isInteger(value.cols) && value.cols > 0
      && Number.isInteger(value.rows) && value.rows > 0);
  if (
    typeof value.screen !== 'string'
    || !validNullableDimension(value.cols)
    || !validNullableDimension(value.rows)
    || !dimensionsAreConsistent
    || typeof value.alternateScreen !== 'boolean'
    || !Number.isInteger(value.outputSequence)
    || value.outputSequence < 0
    || !(value.terminalId === null || isNonEmptyString(value.terminalId))
    || !validRuntimeState
    || !(value.stateAt === null || (Number.isFinite(value.stateAt) && value.stateAt >= 0))
    || !(value.lifecyclePreview === undefined || typeof value.lifecyclePreview === 'string')
  ) return null;
  return {
    screen: value.screen,
    cols: value.cols,
    rows: value.rows,
    alternateScreen: value.alternateScreen,
    outputSequence: value.outputSequence,
    terminalId: value.terminalId,
    runtimeState: value.runtimeState,
    stateAt: value.stateAt,
    ...(value.lifecyclePreview === undefined ? {} : { lifecyclePreview: value.lifecyclePreview }),
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
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
  if (
    kind === 'provider-codex-lifecycle-status'
    || kind === 'provider-codex-lifecycle-install'
    || kind === 'provider-codex-lifecycle-update'
    || kind === 'provider-codex-lifecycle-remove'
  ) {
    process.stdout.write(
      `Codex lifecycle: ${data.lifecycle.state}; trust: ${data.lifecycle.trust}; consent: ${data.lifecycle.consent}; health: ${data.health.state}\n`,
    );
    if (data.guidance?.message) process.stdout.write(`${data.guidance.message}\n`);
    return;
  }
  if (kind.startsWith('provider-skills-')) {
    for (const provider of data.providers) {
      process.stdout.write(
        `${provider.providerId}\t${provider.state}\t${provider.consent}\t${provider.ownership}\n`,
      );
    }
    return;
  }
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
  if (kind === 'project-audit') {
    for (const record of data.records) {
      process.stdout.write(
        `${record.occurredAt}\t${record.outcome}\t${record.operation}\t${record.target.kind}:${record.target.id}\t${record.sourceSessionId}${record.failureCode ? `\t${record.failureCode}` : ''}\n`,
      );
    }
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
    return;
  }
  if (
    kind === 'session-read'
    || kind === 'session-wait'
    || kind === 'session-prompt'
    || kind === 'session-send-keys'
    || kind === 'session-stop'
  ) {
    process.stdout.write(
      `${data.runtimeState}\t${data.terminalId ?? ''}\t${data.cols ?? ''}x${data.rows ?? ''}\tseq ${data.outputSequence}\n${data.screen}${data.screen ? '\n' : ''}`,
    );
  }
}

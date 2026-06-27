#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 32123;
const PORT_SCAN_LIMIT = 100;

function usage() {
  console.log(`Usage: tessera [--port PORT] [--host HOST]

Starts the local Tessera web UI server.

Options:
  -p, --port PORT  Preferred port. Defaults to ${DEFAULT_PORT}, then scans upward.
  --host HOST      Host interface to bind. Defaults to ${DEFAULT_HOST}.
  -h, --help       Show this help message.
  -v, --version    Show Tessera version.
`);
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    host: process.env.TESSERA_HOST || DEFAULT_HOST,
    port: process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    }

    if (arg === '-v' || arg === '--version') {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')
      );
      console.log(packageJson.version);
      process.exit(0);
    }

    if (arg === '-p' || arg === '--port') {
      const value = argv[index + 1];
      if (!value) fail(`${arg} requires a port`);
      options.port = Number(value);
      index += 1;
      continue;
    }

    if (arg.startsWith('--port=')) {
      options.port = Number(arg.slice('--port='.length));
      continue;
    }

    if (arg === '--host') {
      const value = argv[index + 1];
      if (!value) fail('--host requires a host');
      options.host = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--host=')) {
      options.host = arg.slice('--host='.length);
      continue;
    }

    fail(`unknown argument: ${arg}`);
  }

  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    fail('port must be an integer between 1 and 65535');
  }

  return options;
}

function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function isPortAvailable(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', () => {
      resolve(false);
    });

    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findPort(preferredPort, host) {
  for (let offset = 0; offset < PORT_SCAN_LIMIT; offset += 1) {
    const candidate = preferredPort + offset;
    if (candidate > 65535) break;
    if (await isPortAvailable(candidate, host)) {
      return candidate;
    }
  }

  fail(`no available port found from ${preferredPort} to ${preferredPort + PORT_SCAN_LIMIT - 1}`);
}

const root = packageRoot();
const options = parseArgs(process.argv.slice(2));
const port = await findPort(options.port, options.host);
const serverEntry = path.join(root, 'dist-server', 'server.js');

if (!fs.existsSync(serverEntry)) {
  fail('production server build is missing. Reinstall @horang-labs/tessera or publish with npm run npm:prepack first.');
}

process.env.NODE_ENV = 'production';
process.env.PORT = String(port);
process.env.TESSERA_HOST = options.host;
process.env.TESSERA_CLI = '1';
process.env.TESSERA_APP_ROOT = root;
process.env.TESSERA_CHANNEL = process.env.TESSERA_CHANNEL || 'npm';

await import(pathToFileURL(serverEntry).href);

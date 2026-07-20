const ENTER_ALTERNATE_SCREEN = '\x1b[?1049h';
const EXIT_ALTERNATE_SCREEN = '\x1b[?1049l';
const ENABLE_MOUSE_REPORTING = '\x1b[?1002h\x1b[?1006h';
const DISABLE_MOUSE_REPORTING = '\x1b[?1002l\x1b[?1006l';

let wheelUpCount = 0;
let wheelDownCount = 0;
let pendingInput = '';

function draw() {
  process.stdout.write(
    `\x1b[H\x1b[2J`
      + `TUI_WHEEL_UP:${wheelUpCount}\r\n`
      + `TUI_WHEEL_DOWN:${wheelDownCount}\r\n`
      + 'Press q to exit',
  );
}

function cleanup(exitCode = 0) {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(`${DISABLE_MOUSE_REPORTING}${EXIT_ALTERNATE_SCREEN}`);
  process.exit(exitCode);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error('tui-mouse-wheel-fixture requires a PTY');
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write(`${ENTER_ALTERNATE_SCREEN}${ENABLE_MOUSE_REPORTING}\x1b[?25l`);
draw();

process.stdin.on('data', (chunk) => {
  pendingInput += chunk.toString('utf8');
  if (pendingInput.includes('q') || pendingInput.includes('\x03')) cleanup();

  pendingInput = pendingInput.replace(
    /\x1b\[<(\d+);\d+;\d+[mM]/g,
    (_report, buttonCode) => {
      const code = Number(buttonCode);
      if (code === 64) wheelUpCount += 1;
      if (code === 65) wheelDownCount += 1;
      return '';
    },
  );
  draw();
});

process.on('SIGTERM', () => cleanup(0));

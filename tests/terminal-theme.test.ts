import assert from 'node:assert/strict';
import test from 'node:test';
import { getTerminalTheme } from '@/lib/terminal/terminal-theme';

test('terminal exposes the approved Lifted Neutral light palette', () => {
  assert.deepEqual(getTerminalTheme(false), {
    background: '#fafaf9',
    foreground: '#25282b',
    cursor: '#25282b',
    cursorAccent: '#fafaf9',
    selectionBackground: '#accef7',
    selectionForeground: '#25282b',
    black: '#ecece8',
    red: '#b83232',
    green: '#4b821f',
    yellow: '#806b00',
    blue: '#3465a4',
    magenta: '#75507b',
    cyan: '#05727e',
    white: '#6a6a6a',
    brightBlack: '#555753',
    brightRed: '#d44747',
    brightGreen: '#2f702c',
    brightYellow: '#695900',
    brightBlue: '#204a87',
    brightMagenta: '#976a92',
    brightCyan: '#034b50',
    brightWhite: '#3d3d3d',
  });
});

test('terminal exposes the approved Neutral Charcoal dark palette', () => {
  assert.deepEqual(getTerminalTheme(true), {
    background: '#161616',
    foreground: '#e3e9ed',
    cursor: '#e4edf2',
    cursorAccent: '#161616',
    selectionBackground: '#303030',
    selectionForeground: '#f4f8fa',
    black: '#141a1f',
    red: '#df797c',
    green: '#91c497',
    yellow: '#d7bc70',
    blue: '#80afd0',
    magenta: '#b5a0c8',
    cyan: '#72b9c1',
    white: '#c9d1d7',
    brightBlack: '#71818d',
    brightRed: '#ee898c',
    brightGreen: '#a1d4a7',
    brightYellow: '#e6cb80',
    brightBlue: '#90c0e1',
    brightMagenta: '#c6b0d9',
    brightCyan: '#82cad2',
    brightWhite: '#f3f7f9',
  });
});

#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const url = process.argv[2];
if (!url) {
  console.error('Usage: node scripts/start-casino-discovery-chrome.mjs <casino_url> [port]');
  process.exit(2);
}
const port = Number(process.argv[3] ?? process.env.CASINO_DISCOVERY_CDP_PORT ?? 9222);
const profileDir = path.resolve(process.env.CASINO_DISCOVERY_PROFILE_DIR ?? '.casino-discovery/browser-profile');
await mkdir(profileDir, { recursive: true });

const candidates = process.platform === 'darwin'
  ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  : process.platform === 'win32'
    ? [
        path.join(process.env.PROGRAMFILES ?? '', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

let executable;
for (const candidate of candidates) {
  try {
    await access(candidate);
    executable = candidate;
    break;
  } catch {}
}
if (!executable) {
  console.error('Google Chrome/Chromium executable not found. Launch it manually with --remote-debugging-port and a non-default --user-data-dir.');
  process.exit(1);
}

const child = spawn(executable, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  url,
], {
  detached: true,
  stdio: 'ignore',
});
child.unref();

const endpoint = `http://127.0.0.1:${port}`;
for (let attempt = 0; attempt < 50; attempt += 1) {
  try {
    const response = await fetch(`${endpoint}/json/version`);
    if (response.ok) {
      console.log(JSON.stringify({ endpoint, profileDir, url, status: 'ready_for_manual_login' }, null, 2));
      process.exit(0);
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 200));
}
console.error(`Chrome launched but CDP endpoint did not become reachable at ${endpoint}.`);
process.exit(1);

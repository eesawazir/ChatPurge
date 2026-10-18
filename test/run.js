#!/usr/bin/env node
// Browser tests for the content script. No dependencies: Node 18+ and a Chrome/Chromium binary.
//
//   node test/run.js            (set CHROME=/path/to/chrome if it is not on PATH;
//                                CHROME_NO_SANDBOX=1 if Chrome refuses to start, e.g. as root)
//
// Each fixture in test/fixtures is a static page with the sidebar markup of one site. It loads the
// real content.js and styles.css, stubs fetch/confirm, drives the UI and reports PASS/FAIL lines to
// this script (a POST to /__result after every check). Chrome runs headless against a local server.
// claude.ai is mapped to 127.0.0.1 because content.js picks its site config from the hostname.
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SOURCES = new Set(['content.js', 'styles.css', 'claude-bridge.js']);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const TIMEOUT_MS = 60000;
const FIXTURES = [
  // content.js treats every host except claude.ai as ChatGPT, and chatgpt.com itself is HSTS-preloaded
  // (Chrome would force https), so the ChatGPT fixture is served from localhost.
  { file: 'chatgpt.html', host: 'localhost' },
  { file: 'claude.html', host: 'claude.ai' },
];

function findChrome() {
  const candidates = [process.env.CHROME, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter(Boolean);
  for (const bin of candidates) {
    if (spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0) return bin;
  }
  console.error('No Chrome found. Set CHROME=/path/to/chrome.');
  process.exit(2);
}

let report = '';
let onReport = () => {};
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/__result') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { report = body; res.writeHead(204).end(); onReport(); });
    return;
  }
  const name = path.basename(new URL(req.url, 'http://x').pathname);
  const file = req.url.startsWith('/src/') && SOURCES.has(name) ? path.join(ROOT, name)
    : req.url.startsWith('/fixtures/') ? path.join(__dirname, 'fixtures', name) : null;
  if (!file || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' }).end(fs.readFileSync(file));
});

async function runFixture(chrome, port, { file, host }) {
  report = '';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chatpurge-test-'));
  const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', `--user-data-dir=${profile}`, '--no-first-run',
    // Chrome's sandbox stays on; only containers or root sessions need CHROME_NO_SANDBOX=1.
    ...(process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    `--host-resolver-rules=MAP ${host} 127.0.0.1`, `http://${host}:${port}/fixtures/${file}`,
  ], { stdio: 'ignore' });
  const exited = new Promise((r) => child.once('exit', r));
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, TIMEOUT_MS);
    onReport = () => { if (report.split('\n').includes('END')) { clearTimeout(timer); resolve(); } };
  });
  child.kill('SIGTERM'); // lets Chrome close its helper processes; they can still be writing to the profile for a moment
  const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(killer);
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    console.warn(`(could not remove the temporary profile ${profile})`);
  }

  const lines = report.split('\n').filter(Boolean);
  let failed = 0;
  console.log(`\n${file}`);
  for (const line of lines) {
    if (line === 'END') continue;
    console.log(`  ${line}`);
    if (line.startsWith('FAIL')) failed++;
  }
  if (!lines.includes('END')) {
    console.log('  FAIL the test did not finish; the last check above is as far as it got');
    failed++;
  }
  return failed;
}

server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  const chrome = findChrome();
  let failed = 0;
  for (const fixture of FIXTURES) failed += await runFixture(chrome, port, fixture);
  server.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
});

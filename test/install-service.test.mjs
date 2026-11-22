import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { servicePlist, LABEL } from '../scripts/install-service.mjs';

test('service preserves argument boundaries and escapes XML paths', () => {
  const plist = servicePlist({ directory: '/Users/A & B/Developer/Brave <MCP>', node: '/node path/node', home: '/Users/A & B' });
  assert.match(plist, /<string>\/node path\/node<\/string>/);
  assert.match(plist, /A &amp; B\/Developer\/Brave &lt;MCP&gt;\/cli.mjs/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>T3_BRAVE_PORT<\/key><string>9334<\/string>/);
  assert.ok(plist.includes(LABEL));
  assert.ok(!plist.includes('userdata'));
});

test('print generates a launch agent without performing installation', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/install-service.mjs', import.meta.url)), 'print', '--directory', '/nonexistent/read-only-example'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /\/nonexistent\/read-only-example\/cli.mjs/);
});

test('invalid commands are rejected before launchctl or filesystem mutations', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/install-service.mjs', import.meta.url)), 'unknown'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Expected install, uninstall, status, or print/);
});

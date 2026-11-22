#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, access, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const LABEL = 'local.t3-brave-mcp.bridge';
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

async function serviceNode() {
  // Homebrew can remove the versioned executable during an upgrade.
  const keg = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(process.execPath);
  if (!keg) return process.execPath;
  const stablePath = join(keg[1], 'opt', keg[2], 'bin', 'node');
  const stableTarget = await realpath(stablePath).catch(() => undefined);
  return stableTarget === process.execPath ? stablePath : process.execPath;
}

export function servicePlist({ directory, node = process.execPath, home = homedir() }) {
  const state = join(home, '.t3', 'brave-bridge');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(join(directory, 'cli.mjs'))}</string></array>
  <key>WorkingDirectory</key><string>${xml(directory)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>T3_BRAVE_STATE_DIR</key><string>${xml(state)}</string>
    <key>T3_BRAVE_PORT</key><string>9334</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(join(state, 'bridge.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(state, 'bridge-error.log'))}</string>
</dict></plist>
`;
}

const launchctl = (args, required = false) => {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  if (required && result.status !== 0) {
    throw new Error(`launchctl ${args[0]} failed: ${(result.stderr || result.error?.message || 'unknown error').trim()}`);
  }
  return result;
};

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { directory: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  const command = positionals[0] ?? 'status';
  if (values.help) {
    console.log('Usage: node scripts/install-service.mjs install|uninstall|status|print [--directory ~/Developer/t3-brave-mcp]');
    return;
  }
  if (positionals.length > 1 || !['install', 'uninstall', 'status', 'print'].includes(command)) throw new Error('Expected install, uninstall, status, or print. Use --help for usage.');
  const home = homedir();
  const directory = resolve(values.directory ?? join(home, 'Developer', 't3-brave-mcp'));
  const plistPath = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  if (command === 'print') { process.stdout.write(servicePlist({ directory, node: await serviceNode() })); return; }
  if (process.platform !== 'darwin') throw new Error('This helper installs a macOS user LaunchAgent.');
  const domain = `gui/${userInfo().uid}`;
  const service = `${domain}/${LABEL}`;
  if (command === 'status') {
    const installed = await access(plistPath).then(() => true, () => false);
    const result = launchctl(['print', service]);
    const state = /\bstate = (.+)/.exec(result.stdout ?? '')?.[1] ?? 'not loaded';
    console.log(JSON.stringify({ installed, state, plistPath }));
    return;
  }
  if (command === 'uninstall') {
    launchctl(['bootout', service]);
    await rm(plistPath, { force: true });
    console.log('Removed the Brave bridge login service. Pairing and browser data are preserved.');
    return;
  }
  await access(join(directory, 'cli.mjs'), constants.R_OK);
  await access(join(directory, 'node_modules', 'ws', 'package.json'), constants.R_OK);
  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(join(home, '.t3', 'brave-bridge'), { recursive: true, mode: 0o700 });
  const plist = servicePlist({ directory, node: await serviceNode() });
  const existing = await readFile(plistPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  launchctl(['bootout', service]);
  await writeFile(plistPath, plist, { mode: 0o600 });
  try {
    launchctl(['bootstrap', domain, plistPath], true);
    launchctl(['kickstart', service], true);
  } catch (error) {
    launchctl(['bootout', service]);
    if (existing === undefined) await rm(plistPath, { force: true });
    else { await writeFile(plistPath, existing, { mode: 0o600 }); launchctl(['bootstrap', domain, plistPath]); }
    throw error;
  }
  console.log(`Installed ${LABEL}. The bridge starts at login and restarts if it exits. Logs: ${join(home, '.t3', 'brave-bridge')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from './bridge.mjs';

const directory = process.env.T3_BRAVE_STATE_DIR ?? join(homedir(), '.t3', 'brave-bridge');
await mkdir(directory, { recursive: true, mode: 0o700 });
const tokenFile = join(directory, 'token');
let token;
try { token = (await readFile(tokenFile, 'utf8')).trim(); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  token = randomBytes(32).toString('hex');
  await writeFile(tokenFile, token + '\n', { flag: 'wx', mode: 0o600 });
}
await chmod(tokenFile, 0o600);

let seedAllowlist = [];
try {
  const parsed = JSON.parse(await readFile(join(directory, 'allowlist.json'), 'utf8'));
  if (Array.isArray(parsed)) seedAllowlist = parsed.filter(x => typeof x === 'string' && x.trim());
} catch {}

const bridge = await createBridge({ token, port: Number(process.env.T3_BRAVE_PORT ?? 9334), seedAllowlist });
await writeFile(join(directory, 'config.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${bridge.port}`, token }) + '\n', { mode: 0o600 });
await chmod(join(directory, 'config.json'), 0o600);
console.log(`Brave bridge listening on 127.0.0.1:${bridge.port}. Pairing token: ${tokenFile}`);
const stop = async () => { await bridge.close(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);

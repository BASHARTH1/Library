#!/usr/bin/env node
/**
 * One-command development startup:
 *   1. start the portable PostgreSQL cluster (idempotent)
 *   2. start the NestJS API on :3000
 *   3. start the Angular dev server on :4200
 *
 * Ctrl+C stops the API and web server. The database keeps running; stop it with
 * `npm run db:stop`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

console.log('▸ starting database …');
spawnSync(process.execPath, [resolve(ROOT, 'scripts', 'db.mjs'), 'start'], { stdio: 'inherit' });

const children = [];

function start(label, args) {
  const child = spawn(npm, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('exit', (code) => console.log(`▸ ${label} exited with code ${code}`));
  children.push(child);
  return child;
}

console.log('▸ starting API on http://localhost:3000 …');
start('api', ['run', 'api:dev']);

console.log('▸ starting web on http://localhost:4200 …');
start('web', ['run', 'web:dev']);

const shutdown = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

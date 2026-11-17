import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Prisma reads env("DATABASE_URL") during generate and validate.
// CI and fresh checkouts do not have a root .env, so fall back to the
// local placeholder. Generate does not open a connection.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function findRepoRoot(start) {
  let dir = start;
  for (;;) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function loadEnvFile(path, env) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}

const repoRoot = findRepoRoot(packageRoot);
const env = { ...process.env };
loadEnvFile(resolve(repoRoot, '.env'), env);
loadEnvFile(resolve(packageRoot, '.env'), env);
if (!env.DATABASE_URL) {
  env.DATABASE_URL = 'postgresql://geomix:geomix@localhost:5432/geomix?schema=public';
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node scripts/prisma-cli.mjs <prisma args...>');
  process.exit(1);
}

if (args.length === 1 && args[0] === 'generate') {
  try {
    const req = createRequire(resolve(packageRoot, 'package.json'));
    const clientEntry = req.resolve('@prisma/client');
    const generatedDefault = resolve(dirname(clientEntry), '../../.prisma/client/default.js');
    const schemaPath = resolve(packageRoot, 'prisma/schema.prisma');
    if (
      existsSync(generatedDefault) &&
      existsSync(schemaPath) &&
      statSync(generatedDefault).mtimeMs >= statSync(schemaPath).mtimeMs
    ) {
      process.exit(0);
    }
  } catch {
    // Fall through to full prisma generate.
  }
}

const bin = resolve(packageRoot, 'node_modules/.bin/prisma');
const child = spawn(bin, args, { cwd: packageRoot, env, stdio: 'inherit' });

child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

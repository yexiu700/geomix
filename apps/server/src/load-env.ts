import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

/** Load the repo-root .env when the process was started from apps/server or the repo root. */
export function loadRootEnv(): void {
  const candidates = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    loadDotenv({ path });
    return;
  }
}

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = resolve(process.cwd(), 'src/samples');

describe('sample service boundaries', () => {
  it('does not read chunks, run raw SQL, or charge points', () => {
    const service = readFileSync(resolve(here, 'samples.service.ts'), 'utf8');
    const controller = readFileSync(resolve(here, 'samples.controller.ts'), 'utf8');
    const combined = `${service}\n${controller}`;
    expect(combined).not.toMatch(
      /\$queryRaw|\$executeRaw|KnowledgeChunk|knowledgeChunk|BillingService|LlmService|reserve\(/,
    );
    expect(service).toContain('tenantId: this.tenantId()');
    expect(service).toContain('this.prisma.scoped.crudSample');
  });
});

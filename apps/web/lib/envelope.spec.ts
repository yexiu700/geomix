import { describe, expect, it } from 'vitest';
import {
  GatewayApiError,
  createEnvelopeUnwrapper,
  filenameFromContentDisposition,
  unwrapEnvelope,
} from './envelope';
import { COMPACT_SELECT_STYLE, NATIVE_SELECT_STYLE } from './select-styles';

class CustomModuleApiError extends GatewayApiError {}

describe('envelope helpers (#264)', () => {
  it('unwraps standard { code: 0, data } JSON envelopes', async () => {
    const res = new Response(JSON.stringify({ code: 0, msg: 'ok', data: { id: 'item_1' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    await expect(unwrapEnvelope<{ id: string }>(res)).resolves.toEqual({ id: 'item_1' });
  });

  it('preserves module subclass instanceof, name, status, and code on business errors', async () => {
    const unwrapCustom = createEnvelopeUnwrapper(CustomModuleApiError);
    const res = new Response(
      JSON.stringify({ code: 40012, msg: '配额不足，请联系管理员', data: null }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );

    await expect(unwrapCustom(res)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CustomModuleApiError &&
        err instanceof GatewayApiError &&
        err.name === 'CustomModuleApiError' &&
        err.status === 400 &&
        err.code === 40012 &&
        err.message === '配额不足，请联系管理员',
    );
  });

  it('rejects empty response bodies with readable Chinese message', async () => {
    const unwrapCustom = createEnvelopeUnwrapper(CustomModuleApiError);
    const res = new Response('', { status: 502 });

    await expect(unwrapCustom(res)).rejects.toEqual(
      new CustomModuleApiError(502, -1, '服务响应为空'),
    );
  });

  it('enforces requireData by default while allowing null data when requireData is false', async () => {
    const makeNullEnvelope = () =>
      new Response(JSON.stringify({ code: 0, msg: 'ok', data: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const strictUnwrap = createEnvelopeUnwrapper(CustomModuleApiError);
    const permissiveUnwrap = createEnvelopeUnwrapper(CustomModuleApiError, {
      requireData: false,
    });

    await expect(strictUnwrap(makeNullEnvelope())).rejects.toEqual(
      new CustomModuleApiError(200, 0, 'ok'),
    );
    await expect(permissiveUnwrap(makeNullEnvelope())).resolves.toBeNull();
  });

  it('translates non-JSON HTML gateway errors (413/502/504/500/403) without leaking SyntaxError', async () => {
    const unwrapCustom = createEnvelopeUnwrapper(CustomModuleApiError);

    const cases: Array<{ status: number; expectedFragment: string }> = [
      { status: 413, expectedFragment: '网关限制' },
      { status: 502, expectedFragment: '502' },
      { status: 504, expectedFragment: '服务响应超时，请稍后重试' },
      { status: 500, expectedFragment: 'HTTP 500' },
      { status: 403, expectedFragment: '异常响应' },
    ];

    for (const { status, expectedFragment } of cases) {
      const htmlRes = new Response(`<html><body><h1>${status}</h1></body></html>`, {
        status,
        headers: { 'content-type': 'text/html' },
      });
      await expect(unwrapCustom(htmlRes)).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof CustomModuleApiError &&
          err.status === status &&
          err.code === -1 &&
          err.message.includes(expectedFragment) &&
          !err.message.includes('Unexpected token'),
      );
    }
  });

  it('extracts filenames from Content-Disposition headers with safe fallbacks', () => {
    expect(
      filenameFromContentDisposition('attachment; filename="geomix-export.xlsx"', 'fallback.xlsx'),
    ).toBe('geomix-export.xlsx');
    expect(
      filenameFromContentDisposition('attachment; filename=report.csv; size=1024', 'fallback.csv'),
    ).toBe('report.csv');
    expect(filenameFromContentDisposition(null, 'fallback.csv')).toBe('fallback.csv');
    expect(filenameFromContentDisposition('inline', 'fallback.csv')).toBe('fallback.csv');
  });

  it('exports Sonar Ink native select styles in full-width and compact toolbar variants', () => {
    expect(NATIVE_SELECT_STYLE).toMatchObject({
      width: '100%',
      height: 32,
      backgroundColor: 'var(--gm-bg-elevated)',
      color: 'var(--gm-fg-1)',
    });
    expect(COMPACT_SELECT_STYLE).toMatchObject({
      maxWidth: '100%',
      height: 32,
      backgroundColor: 'var(--gm-bg-elevated)',
      color: 'var(--gm-fg-1)',
    });
    expect(COMPACT_SELECT_STYLE.width).toBeUndefined();
  });
});

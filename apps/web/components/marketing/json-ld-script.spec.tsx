// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonLdScript, formatJsonLdSafe } from './json-ld-script';

afterEach(() => {
  cleanup();
});

describe('JsonLdScript', () => {
  it('escapes <, >, &, U+2028, and U+2029 while preserving valid JSON.parse round-trip', () => {
    const payload = {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'GeoMix & Co </script><script>alert(1)</script>',
      notes: 'Line1\u2028Line2\u2029End',
    };

    const raw = formatJsonLdSafe(payload);
    expect(raw).not.toContain('</script>');
    expect(raw).not.toContain('<');
    expect(raw).not.toContain('>');
    expect(raw).not.toContain('&');
    expect(raw).not.toContain('\u2028');
    expect(raw).not.toContain('\u2029');
    expect(raw).toContain('\\u003c');
    expect(raw).toContain('\\u003e');
    expect(raw).toContain('\\u0026');
    expect(raw).toContain('\\u2028');
    expect(raw).toContain('\\u2029');

    expect(JSON.parse(raw)).toEqual(payload);

    const { container } = render(<JsonLdScript id="test-ld" data={payload} />);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).toBeTruthy();
    expect(script?.id).toBe('test-ld');
    expect(script?.innerHTML).not.toContain('</script>');
    expect(JSON.parse(script?.textContent ?? '{}')).toEqual(payload);
  });
});

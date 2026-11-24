import { serializeJsonLdSafe } from '@geomix/shared';

export type JsonLdData = Record<string, unknown>;

/**
 * Serializes JSON-LD safely for embedding inside `<script type="application/ld+json">`.
 * Wraps `@geomix/shared`'s `serializeJsonLdSafe` (escapes `<`, U+2028, U+2029)
 * and additionally escapes `>` and `&` while remaining 100% valid JSON.
 */
export function formatJsonLdSafe(data: JsonLdData): string {
  return serializeJsonLdSafe(data).replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

export function JsonLdScript({ data, id }: { data: JsonLdData; id?: string }) {
  return (
    <script
      id={id}
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: formatJsonLdSafe(data) }}
    />
  );
}

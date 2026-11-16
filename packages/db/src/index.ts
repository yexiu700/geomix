export const DB_PROVIDER = 'postgresql';
export const VECTOR_EXTENSION = 'vector';

export function isPostgresUrl(url: string): boolean {
  return /^postgres(ql)?:\/\//.test(url);
}

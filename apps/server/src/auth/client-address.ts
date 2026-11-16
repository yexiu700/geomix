/** 只用 TCP 对端地址。客户端自己写的转发头不能换桶。 */
export function clientAddress(request: unknown): string {
  if (!request || typeof request !== 'object') return 'unknown';
  const socket = (request as { socket?: { remoteAddress?: string | null } }).socket;
  return normalizeAddress(socket?.remoteAddress ?? '');
}

export function normalizeAddress(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('::ffff:')) return value.slice('::ffff:'.length);
  return value.length > 0 ? value : 'unknown';
}

import { buildLlmsTxt } from '../../components/marketing/llms-txt';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const body = buildLlmsTxt();
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}

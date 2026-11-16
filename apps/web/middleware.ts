import { NextResponse, type NextRequest } from 'next/server';
import { legacyPathname } from './lib/route-map';

export function middleware(request: NextRequest) {
  const target = legacyPathname(request.nextUrl.pathname);
  if (!target) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = target;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/user/:path*'],
};

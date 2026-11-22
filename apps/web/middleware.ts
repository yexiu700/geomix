import { NextResponse, type NextRequest } from 'next/server';
import { legacyAccountTab, legacyPathname } from './lib/route-map';

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const target = legacyPathname(pathname);
  if (!target) return NextResponse.next();
  const url = new URL(target, request.nextUrl.origin);
  url.search = request.nextUrl.search;
  const accountTab = legacyAccountTab(pathname);
  if (target === '/account' && accountTab && !url.searchParams.get('tab')) {
    url.searchParams.set('tab', accountTab);
  }
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    '/user/:path*',
    '/dashboard',
    '/dashboard/:path*',
    '/visibility/overview',
    '/visibility/overview/:path*',
    '/visibility/monitors',
    '/visibility/monitors/:path*',
    '/me/:path*',
  ],
};

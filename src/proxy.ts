import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const allowedOriginsEnv =
    process.env.CORS_ALLOWED_ORIGIN ||
    process.env.CORS_ALLOWED_ORIGINS ||
    process.env.ANIKOTO_API_CORS_ALLOWED_ORIGINS ||
    'http://localhost:3000,http://127.0.0.1:3000';

  const requestOrigin = request.headers.get('origin');
  const allowedOrigins = allowedOriginsEnv
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin && origin !== '*');
  const allowOrigin = requestOrigin && allowedOrigins.includes(requestOrigin) ? requestOrigin : null;

  if (requestOrigin && !allowOrigin) {
    return NextResponse.json(
      { ok: false, message: 'This browser origin is not allowed.' },
      { status: 403, headers: { 'Cache-Control': 'private, no-store', Vary: 'Origin' } },
    );
  }

  if (request.nextUrl.searchParams.get('refresh') === '1') {
    const secret = process.env.CACHE_REFRESH_SECRET;
    const supplied = request.headers.get('x-cache-refresh-token');
    if (!secret || supplied !== secret) {
      return NextResponse.json(
        { ok: false, message: 'Cache refresh is not authorized.' },
        {
          status: 403,
          headers: {
            ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {}),
            'Cache-Control': 'private, no-store',
            Vary: 'Origin',
          },
        },
      );
    }
  }

  // Handle preflight OPTIONS request
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 204,
      headers: {
        ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {}),
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers':
          'Accept, Content-Type, Range, X-Cache-Refresh-Token',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      },
    });
  }

  const response = NextResponse.next();
  if (allowOrigin) response.headers.set('Access-Control-Allow-Origin', allowOrigin);
  response.headers.set(
    'Access-Control-Allow-Methods',
    'GET, OPTIONS'
  );
  response.headers.set(
    'Access-Control-Allow-Headers',
    'Accept, Content-Type, Range, X-Cache-Refresh-Token'
  );
  response.headers.set('Vary', 'Origin');

  return response;
}

export const config = {
  matcher: '/api/:path*',
};

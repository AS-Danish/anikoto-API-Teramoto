import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const allowedOriginsEnv =
    process.env.CORS_ALLOWED_ORIGIN ||
    process.env.CORS_ALLOWED_ORIGINS ||
    process.env.ANIKOTO_API_CORS_ALLOWED_ORIGINS ||
    '*';

  const requestOrigin = request.headers.get('origin');

  let allowOrigin = '*';
  if (allowedOriginsEnv !== '*') {
    const allowedOrigins = allowedOriginsEnv.split(',').map((o) => o.trim());
    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
      allowOrigin = requestOrigin;
    } else if (allowedOrigins.length > 0) {
      allowOrigin = allowedOrigins[0];
    }
  }

  // Handle preflight OPTIONS request
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type, Authorization, X-Requested-With, Cache-Control, Pragma',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const response = NextResponse.next();
  response.headers.set('Access-Control-Allow-Origin', allowOrigin);
  response.headers.set(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, OPTIONS'
  );
  response.headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Requested-With, Cache-Control, Pragma'
  );

  return response;
}

export const config = {
  matcher: '/api/:path*',
};

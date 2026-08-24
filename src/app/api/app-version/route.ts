import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const latestVersion = process.env.ANDROID_LATEST_VERSION?.trim() || '1.0.0';
  const minimumVersion = process.env.ANDROID_MINIMUM_VERSION?.trim() || '1.0.0';
  const updateUrl = process.env.ANDROID_UPDATE_URL?.trim() || '';
  const message = process.env.ANDROID_UPDATE_MESSAGE?.trim()
    || 'A newer Luffy TV release is required for streaming. Update now to continue.';

  return NextResponse.json(
    { ok: true, data: { latestVersion, minimumVersion, updateUrl, message } },
    { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } },
  );
}

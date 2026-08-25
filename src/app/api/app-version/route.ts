import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function positiveInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function GET() {
  const version = process.env.ANDROID_VERSION?.trim() || '';
  const versionCode = positiveInteger(process.env.ANDROID_VERSION_CODE);
  const apkUrl = process.env.ANDROID_APK_URL?.trim() || '';
  const sha256 = process.env.ANDROID_APK_SHA256?.trim().toLowerCase() || '';
  const apkSize = positiveInteger(process.env.ANDROID_APK_SIZE);
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(apkUrl);
  } catch {
    parsedUrl = null;
  }

  if (
    !version ||
    !versionCode ||
    !apkSize ||
    !parsedUrl ||
    parsedUrl.protocol !== 'https:' ||
    !/^[a-f0-9]{64}$/.test(sha256)
  ) {
    return NextResponse.json(
      { ok: false, message: 'Android release manifest is not configured.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const changelog = (process.env.ANDROID_CHANGELOG || '')
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);

  return NextResponse.json(
    {
      ok: true,
      data: {
        version,
        versionCode,
        // Optional updates are intentionally unsupported: every newer build is
        // compulsory, so the minimum always advances with the published APK.
        minimumSupportedVersionCode: versionCode,
        apkUrl: parsedUrl.toString(),
        sha256,
        apkSize,
        mandatory: true,
        title: process.env.ANDROID_UPDATE_TITLE?.trim() || 'Luffy TV needs an update',
        message:
          process.env.ANDROID_UPDATE_MESSAGE?.trim() ||
          'Install the latest release to continue streaming.',
        changelog,
        publishedAt:
          process.env.ANDROID_PUBLISHED_AT?.trim() || new Date().toISOString(),
      },
    },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}

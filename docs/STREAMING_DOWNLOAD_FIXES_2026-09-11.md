# Streaming and download investigation — September 11, 2026

Changes are local and have not been deployed or released as an APK.

## App

- Startup no longer interprets every libmpv error event as a fatal source error. The readiness check still requires media progress, with a 45-second deadline instead of 20 seconds.
- Buffering recovery waits 45 seconds instead of reloading after 12 seconds. Recovery remains bounded to two attempts per episode and restores the current position.
- Three audio decoding errors within ten seconds trigger bounded recovery to another source of the same audio type/language. A single packet warning does not restart playback. Persistent failure without an alternate source is surfaced to the viewer.
- API transport errors (including DNS failures wrapped in HTTP ClientException) retry twice with backoff. HTTP failures and rate limits are not automatically retried by this new loop.
- Download duration uses the HLS playlist first, avoiding the remote FFprobe segment reads when playlist duration is available.
- Removed FFmpeg's exit-on-first-error option, allowing recoverable packet errors to continue. The existing saved-video duration and nonempty-file checks still reject truncated output.
- Removed MP4 faststart rewriting for offline files. This eliminates a full local rewrite after transfer reaches 99%; it does not implement partial-download resumption. A genuinely failed/incomplete transfer can still require the existing full retry.

## Website

- Media decoder recovery is bounded instead of resetting indefinitely.
- Network retries use backoff and the current playback position. Manifest failures reload the manifest; segment failures resume loading.
- Resume is applied on loaded metadata rather than manifest parsing, when duration may still be unavailable.
- Source fallback retains the sub/dub type. Pending recovery timers and metadata listeners are cleaned up.

## API

The Next.js fallback media proxy previously applied a 20-second AbortSignal to both headers and the entire streaming body. It now limits headers separately and times out inactive body reads after 30 seconds. Progressing media transfers can exceed that duration. Redirect bodies and cancelled downstream requests are cleaned up.

The live MHA sources inspected use the Cloudflare Worker, so this fallback-proxy bug alone does not establish the cause of the reported MHA failures. Existing Worker normalization and quality-filtering tests pass; the Worker was not modified.

## Validation

- Flutter: 50 tests passed; analyzer reports no issues.
- API: 38 tests passed, including progressing, stalled and cancelled media response cases; TypeScript passed.
- Existing Worker: 32 tests passed.
- Website: 15 tests passed; final production build and TypeScript passed.
- Live smoke: `node tests/mha-season2-smoke.mjs` checked `my-hero-academia-2-l3eyd`, episodes 21, 22 and 23. Concurrent beginning/middle/end segment requests succeeded for returned sources: 21 sub, 22 sub/dub, 23 sub. Playlist segment counts were 328, 364/366 and 320 respectively. Signed URLs were not persisted.

## Remaining release verification

Email excerpts are truncated, not full Crashlytics stacks. No Android device reproduction or native FFmpeg full-episode transfer was performed. Live smoke tests establish current source availability, not uninterrupted full playback or complete download success. Release the app/website/API changes and verify full playback while downloading the next episode on Android, especially on a slower connection. Upstream corruption, unavailable audio versions and sustained network outages can still fail and must remain visible.

## Proxy deployment

The Cloudflare media retry changes were deployed on September 11, 2026 to https://aonime-proxy.luffytv.workers.dev. Version: ad0d7c4f-f8f7-409f-ab90-a83e897f7838. Wrangler dry run passed. Post-deployment MHA season 2 segment checks passed for episode 21 sub, episode 22 sub/dub, and episode 23 sub/dub. App and website releases remain pending; the Next.js fallback proxy change is also still local.


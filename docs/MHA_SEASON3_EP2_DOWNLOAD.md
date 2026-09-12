# My Hero Academia Season 3, episode 2 download failure

Investigated and server correction deployed September 11, 2026.

## Reproduction

The supplied Android log reports FFmpeg return code -1094995529 after 292.917 seconds of a 1415.087-second source. The 503 appears during the subsequent retry, so it does not establish the cause of the first failure.

A full live download of the sub source (`my-hero-academia-3-iojeg`, episode 2) returned 340 segments. First pass: 145 segments ended partway through a TS packet; second pass: 154. FFmpeg on these saved files reproduced packet corruption, `Error parsing ADTS frame header`, and the same -1094995529 error during MP4 muxing. This reproduces the media failure independently of Android.

For one affected segment the proxy returned 1,026,307 bytes while a direct upstream read returned 2,912,372 bytes including the PNG wrapper. The proxy response had no Content-Length after normalization and the client accepted the short stream as complete. This establishes incomplete delivery, not the precise cause of the premature upstream/stream closure.

## Correction

The Worker now buffers and validates image-wrapped TS segments before forwarding them. Validation is bounded to 16 MiB per segment, verifies the adjusted upstream length when available, checks 188-byte packet alignment, and limits read inactivity to 15 seconds. Incomplete reads retry twice before returning an error; they cannot be served as successful truncated media. Other media retains streaming behavior.

Production Worker version: `66430733-6fdb-4871-a5d5-3a2f24d50880`.
Endpoint: https://aonime-proxy.luffytv.workers.dev

## Validation after deployment

- 43 Worker regression tests passed, including short segment retry and retry exhaustion.
- Wrangler deployment dry run passed.
- All 340 sub segments downloaded: 414,416,672 bytes, zero packet alignment anomalies.
- Complete MP4 remux succeeded with FFmpeg 7.1, exit 0 and no warnings/errors; the failing local fixture had reproduced the Android error with this same binary.
- MP4 duration: 23:35.16. Full AAC audio decode completed to 23:35.06, exit 0.

Reproduction command: `node tests/full-media-audit.mjs my-hero-academia-3-iojeg 2 sub`.
The opt-in tool saves local media under ignored `test/`; signed source URLs remain in memory.

No app release was performed. Android FFmpeg 8.1.2 still needs device testing against the corrected server. Buffered validation adds one segment transfer before delivery and intentionally fails oversized image-wrapped segments instead of allocating unbounded memory.

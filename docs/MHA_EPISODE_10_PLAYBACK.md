# My Hero Academia season 1, episode 10

Investigated September 7, 2026. Catalog slug: `my-hero-academia-kuzfp`.

Two failures affected the shared app/website playback path:

1. The production API had not received the existing MegaPlay extractor update.
   Episode 10's sub embed (`/stream/s-2/6219/sub`, player file `146530`)
   returned an `enc` envelope without `sources` from `getSources`.
   `getSourcesNew` returned playable media. The deployed Worker fallback could
   resolve it, but initial production API requests still exhausted providers.
   The existing, tested extractor update was deployed to the API.
2. The returned master advertised 1080p, 720p and 480p. Both lower-quality
   playlists returned HTTP 200, but their first video segments returned 404
   for both sub and dub. The 1080p segments returned real MPEG-TS data.
   The website reproduced a playback error despite six resolved sources,
   because adaptive quality selection could choose the missing renditions.

The Worker now checks the first media segment of up to six advertised quality
variants, with at most three concurrent checks and a shared three-second
deadline. It removes confirmed 404/410 variants when another variant is
reachable. Unknown/transient failures retain the original options. Masters
whose variants are all confirmed missing return an error. Media playlists,
captions and signed child URLs retain their existing handling. Every probe
uses the existing destination/redirect validation and cancels unused bodies.

Validation: 23 API regression tests, 17 Worker tests, TypeScript, production
API build, and Wrangler deployment dry run passed. The live patched Worker
returned only the working 1080p rendition for episode 10 sub and dub. The live
smoke check fetched the advertised playlists and video segments for episodes
10 and 11 with the website's CORS origin. Run it manually with
`node tests/mha-smoke.mjs 10` or `node tests/mha-smoke.mjs 11`.
The production website's episode 10 player was also verified progressing
past 35 seconds after deployment, where it previously exhausted all sources.

Production API deployment: `dpl_319ZXmygdPztgDDdCwv17Y8dgnmR`.
Production Worker version: `377dc720-fe00-4153-8873-3d4248a6fb0e`.
Both clients use this shared service; no APK or website rebuild is required.

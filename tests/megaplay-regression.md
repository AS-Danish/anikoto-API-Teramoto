# Recent MegaPlay uploads: One Piece 1177

Verified on 2026-09-06 using `one-piece-odmau`, episode `1177`.

The production API listed only Vidstream-2, whose embed was
`https://megaplay.buzz/stream/s-2/694644/sub` (player file ID `179446`).
The legacy `/stream/getSources` response contained `enc`, captions and skip
metadata, but no `sources`. Both the API extractor and Worker fallback
treated it as unavailable. `/stream/getSourcesNew` returned the normal
source object, including the video on `ncdn.imgnex.top` and English captions.

Both resolvers now make one bounded request to the newer endpoint when the
legacy response contains an encrypted envelope without sources. Existing
plain responses keep their original request path. The `s` server selector
is preserved. Worker destination validation and signed access remain enforced.

Validation: 36 Node regression tests, TypeScript, Next production build and
Wrangler dry run passed. The patched Node extractor resolved the live embed.
The deployed Worker restored the existing production API through its fallback:
`ok: true`, episode 1177, one source, one caption. Its signed master playlist,
quality playlist and a 3,009,880-byte MPEG-TS segment were fetched successfully.
This verifies source resolution and media transfer, not playback on a device
or completion of a full episode download.

Worker deployed version: `1c18f940-f2cd-49c4-9655-35212a677883`.
The separate Vercel API deployment was rejected as `Not authorized`; the
direct API extractor improvement remains local pending authorized deployment.
Production is restored through the deployed Worker fallback without an APK update.

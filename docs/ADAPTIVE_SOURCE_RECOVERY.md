# Automatic source recovery

Updated September 8, 2026 for the shared app/website API.

MegaPlay sources accept object, array, URL and JSON-encoded source schemas.
The resolver chooses the first safe media URL rather than trusting the first
array item. Unusable responses (including ciphertext and empty source arrays)
trigger one request to `getSourcesNew`. A retired legacy endpoint (404/410)
also triggers that fallback. Server selection, captions and skip metadata are
preserved. The signed Worker resolver applies the same policy.

MegaCloud supports ciphertext directly in `sources`, the older source-file
wrapper, and `enc`. Its existing decryption service receives the actual
ciphertext instead of indexing a string as an array. A failed decryption
refreshes the current key once and retries only if the key changed. Concurrent
key requests coalesce. Plain media is usable even if the provider incorrectly
sets its encrypted flag. JSON decoding handles formatted and escaped output.

These are bounded adapters for the supported providers, not a universal
decryptor. Unrecognized encryption or unavailable decryption services can
still require maintenance or an alternate source. Invalid/private destinations
are never treated as playable media, and no keys or ciphertext are logged by
the added recovery code.

Validation: 31 API and 21 Worker regression tests, TypeScript, API production
build, and Wrangler dry run passed. Live MHA episode 10 sub/dub playlists and
video segments were checked after deployment. Key rotation is tested with
controlled fixtures, not a forced rotation of the external provider.

API deployment: `dpl_4GSNyjf9qNHJ9GpJtyw8LRmryX3y`.
Worker version: `c72808d0-3688-481d-b33f-948c9dff6f51`.

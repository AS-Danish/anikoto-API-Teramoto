# Playback and download recovery

## Behavior

- `GET /api/watch/:slug?ep=1&recover=1` resolves sources again without reading
  the ordinary watch-result cache. No administrative refresh token is sent to
  the app. `refresh=1` remains restricted to administrators.
- Recovery requests for the same canonical episode share one request and a
  30-second result, including failures. Admission is capped at 60 new recovery
  operations per minute. This limit is shared when Upstash Redis is configured;
  without Redis it applies per server instance.
- Ordinary watch results are cached server-side for 60 seconds. Watch responses
  are not cached by browsers/CDNs, and failures cannot return stale watch data.
- Sources are checked through their configured media proxy where available.
  Checks read the playlist, a variant, and its first segment. HTTP failures,
  HTML, empty media, unsafe destinations, and timeouts reject the source. A
  failed primary provider allows the existing alternate providers to run.
- The Flutter app deduplicates sources within a playback attempt and permits
  one fresh recovery round. A renewed proxy signature can retry the same media
  resource in that round. An older request cannot overwrite recovered links.
- Download preparation tries matching audio sources and refreshes once when
  playlist loading fails. It does not switch the selected audio language.

## Diagnostics

Set `PLAYBACK_DIAGNOSTICS=true` on the backend to enable existing diagnostic
logging. Flutter debug builds log by default; release diagnostics use the
existing `--dart-define=PLAYBACK_DIAGNOSTICS=true` option.

Health events contain the request ID, server, audio type, HTTP status, media
hostname, failure category, and proxy lifetime. They do not contain full signed
URLs or signatures. The watch request/recovery event links the ID to the anime
slug and episode. Download playlist checks include the episode and HTTP status.

## Validation and rollout

Backend checks:

```text
node tests/playable-source.test.mjs
node tests/media-health.test.mjs
node tests/watch-recovery.test.mjs
node tests/watch-route.test.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

Flutter checks:

```text
flutter test test/watch_recovery_test.dart test/watch_source_test.dart test/api_anime_repository_test.dart
```

Deploy the backend before releasing the app that sends `recover=1`. Review the
other pre-existing uncommitted changes in both repositories before deployment.
Neither deployment nor an app release was performed during this work.

The read-only live smoke check on September 5, 2026 accepted the deployed API's
One Piece episode 1 sub and dub streams, including their first segments. They
used `cdn.imgnex.top`, whereas an earlier failed check used `cdn.kryntal.top`.
This establishes that the returned media host changed between checks; it does
not establish the exact cause of the earlier 403.

No Android device was attached. Native player and FFmpeg device testing remains
necessary before release. Validation of the first segment cannot guarantee that
every later segment stays available. Automatic recovery covers playback and
download preparation; it does not resume a partially failed FFmpeg transfer.
The existing providers may also be unavailable simultaneously, in which case
the app terminates recovery and offers a manual retry.

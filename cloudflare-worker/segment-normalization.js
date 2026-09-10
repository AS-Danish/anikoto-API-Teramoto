// Some image CDNs carry TS segments behind a PNG prefix. Inspect a bounded
// prefix only; preserve real images, encrypted segments and other containers.
export async function normalizeSegment(body) {
  if (!body) return { body, removedBytes: 0 };
  const reader = body.getReader();
  const prefix = new Uint8Array(64 * 1024);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  let length = 0;
  let remainder;
  let removedBytes = 0;
  let done = false;
  try {
    while (length < prefix.length) {
      const next = await reader.read();
      done = next.done;
      if (done) break;
      const count = Math.min(next.value.length, prefix.length - length);
      const previousLength = length;
      prefix.set(next.value.subarray(0, count), length);
      length += count;
      remainder = next.value.subarray(count);
      if (length < signature.length) continue;
      if (!signature.every((byte, index) => prefix[index] === byte)) break;
      // Require three consecutive 188-byte TS packet headers, including a
      // valid adaptation-field-control value, before discarding any bytes.
      for (let offset = Math.max(8, previousLength - 379); offset + 379 < length; offset++) {
        if ([0, 188, 376].every(delta =>
          prefix[offset + delta] === 0x47 && (prefix[offset + delta + 3] & 0x30) !== 0)) {
          removedBytes = offset;
          break;
        }
      }
      if (removedBytes) break;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  }
  let initial = prefix.slice(removedBytes, length);
  return {
    removedBytes,
    body: new ReadableStream({
      async pull(controller) {
        if (initial) {
          if (initial.length) controller.enqueue(initial);
          initial = null;
          return;
        }
        if (remainder?.length) {
          controller.enqueue(remainder);
          remainder = null;
          return;
        }
        if (done) { controller.close(); return; }
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel(reason) { return reader.cancel(reason); },
    }),
  };
}

// Image-wrapped TS must be complete before we advertise it as playable media.
// Its PNG header removal otherwise hides a truncated upstream Content-Length.
export async function bufferCompleteTs(body, expectedBytes, maximumBytes = 16 * 1024 * 1024) {
  if (!body) throw new Error('Missing media segment body');
  const reader = body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      let timer;
      const next = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Segment read timed out')), 15_000);
        }),
      ]).finally(() => clearTimeout(timer));
      if (next.done) break;
      length += next.value.length;
      if (length > maximumBytes) throw new Error('Media segment exceeds validation limit');
      chunks.push(next.value);
    }
    if (!length || length % 188 !== 0 ||
        (expectedBytes !== null && length !== expectedBytes)) {
      throw new Error('Incomplete media segment');
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    for (let i = 0; i < bytes.length; i += 188) {
      if (bytes[i] !== 0x47) throw new Error('Invalid TS packet alignment');
    }
    return bytes;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Keep a progressing media response alive; abort only when reads stop. */
export function withMediaIdleTimeout(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
  idleMs = 30_000,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(output) {
      const timer = setTimeout(() => {
        controller.abort(new Error('Upstream media read timed out.'));
        void reader.cancel().catch(() => undefined);
        output.error(new Error('Upstream media read timed out.'));
      }, idleMs);
      try {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) return;
        if (done) output.close();
        else output.enqueue(value);
      } catch (error) {
        output.error(error);
      } finally {
        clearTimeout(timer);
      }
    },
    async cancel(reason) {
      controller.abort(reason);
      await reader.cancel(reason);
    },
  });
}

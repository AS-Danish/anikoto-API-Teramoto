/** Start a second provider only when the preferred provider is slow.
 * Waves cap concurrent provider work at two. A rejected/empty response never wins.
 * Running losers retain their own network deadlines; unstarted waves are skipped.
 */
export async function hedgedPair<T>(
  first: () => Promise<T>, second: () => Promise<T>, delayMs = 1200,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let startedSecond = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const failed = (error: unknown) => {
      if (settled) return;
      if (++failures === 2) { settled = true; clearTimeout(timer); reject(error); }
      else startSecond();
    };
    const succeeded = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const startSecond = () => {
      if (settled || startedSecond) return;
      startedSecond = true;
      clearTimeout(timer);
      Promise.resolve().then(second).then(succeeded, failed);
    };
    timer = setTimeout(startSecond, delayMs);
    Promise.resolve().then(first).then(succeeded, failed);
  });
}

export async function withDeadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Video provider deadline exceeded')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

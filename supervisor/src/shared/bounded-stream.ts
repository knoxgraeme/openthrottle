// One reader loop for every hand-rolled ReadableStream consumer: lease the
// reader, feed chunks through a caller-supplied step, cancel early when the
// step asks (e.g. a byte budget was exceeded), and always release the lock.
// Cancellation rejections surface in the result rather than being thrown so
// each call site keeps its own policy for them (swallow vs propagate).

export type StreamReduction<T> =
  | { cancelled: false; value: T }
  | { cancelled: true; cancelError?: unknown };

export async function reduceStream<T>(
  stream: ReadableStream<Uint8Array>,
  initial: T,
  step: (accumulated: T, chunk: Uint8Array) => { next: T } | { cancel: true }
): Promise<StreamReduction<T>> {
  const reader = stream.getReader();
  let accumulated = initial;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const result = step(accumulated, value);
      if ("cancel" in result) {
        try {
          await reader.cancel();
        } catch (cancelError) {
          return { cancelled: true, cancelError };
        }
        return { cancelled: true };
      }
      accumulated = result.next;
    }
  } finally {
    reader.releaseLock();
  }
  return { cancelled: false, value: accumulated };
}

export type BoundedStreamBytes =
  | { exceeded: false; bytes: Uint8Array }
  | { exceeded: true; cancelError?: unknown };

/** Read a whole stream, cancelling and reporting overflow past maxBytes. */
export async function readStreamUpToByteLimit(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<BoundedStreamBytes> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reduction = await reduceStream<undefined>(stream, undefined, (_, chunk) => {
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) return { cancel: true };
    chunks.push(chunk);
    return { next: undefined };
  });
  if (reduction.cancelled) {
    return reduction.cancelError !== undefined
      ? { exceeded: true, cancelError: reduction.cancelError }
      : { exceeded: true };
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { exceeded: false, bytes };
}

export async function withLatencyBudget<T>(
  label: string,
  maxMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  const result = await fn();
  const elapsed = Date.now() - start;
  if (elapsed > maxMs) {
    throw new Error(`${label}: took ${elapsed} ms, budget was ${maxMs} ms`);
  }
  return result;
}

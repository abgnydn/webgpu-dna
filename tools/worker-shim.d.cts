export function runWorkerSync<T = unknown>(
  workerPath: string,
  payload: Record<string, unknown>,
  onMessage?: (data: T) => void,
  srcOverride?: string
): {
  getResult: () => T | null;
  getHandler: () => ((e: { data: Record<string, unknown> }) => void) | null;
};

/**
 * The long-lived module responses of this process (event streams): a
 * graceful stop ends them all first, so the HTTP drain is not held for
 * SHUTDOWN_GRACE_MS by responses that never finish on their own, and a
 * stopping server refuses new ones (`moduleStreamsEnding()`).
 *
 * Kept on globalThis: the server and a module may load separate copies of
 * this package (the dev server's Vite-loaded routes), and both must reach the
 * same registry.
 */
interface StreamRegistry {
  ending: boolean;
  enders: Set<() => void>;
}

const KEY = Symbol.for('drobek.moduleStreams');

function registry(): StreamRegistry {
  const g = globalThis as { [KEY]?: StreamRegistry };
  g[KEY] ??= { ending: false, enders: new Set() };
  return g[KEY];
}

/** Call `end` when the server stops; the returned function unregisters it. */
export function onModuleStreamsEnd(end: () => void): () => void {
  const r = registry();
  r.enders.add(end);
  return () => {
    r.enders.delete(end);
  };
}

/** True once the server began to stop: open no new long-lived response. */
export function moduleStreamsEnding(): boolean {
  return registry().ending;
}

/** End every registered stream and refuse new ones (the graceful stop). */
export function endModuleStreams(): void {
  const r = registry();
  r.ending = true;
  for (const end of [...r.enders]) {
    try {
      end();
    } catch {
      /* one stream's failure never stops the others from ending */
    }
  }
}

/** Tests: forget the stop (new streams open again) and every registration. */
export function resetModuleStreamsForTests(): void {
  const r = registry();
  r.ending = false;
  r.enders.clear();
}

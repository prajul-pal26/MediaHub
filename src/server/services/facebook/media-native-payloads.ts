import type { Page } from "playwright-core";

const MAX_NATIVE_JSON_BYTES = 20_000_000;
const cachedPayloads = new WeakMap<Page, Promise<unknown[]>>();

/**
 * A media page embeds the same large native JSON payload used for publication
 * time and engagement. Read/parse it once per stable page state, then request
 * a fresh snapshot only after an interaction that can hydrate new counters.
 */
export async function nativeMediaPayloads(page: Page, options: { refresh?: boolean } = {}): Promise<unknown[]> {
  if (!options.refresh) {
    const cached = cachedPayloads.get(page);
    if (cached) return cached;
  }
  const read = page.locator('script[type="application/json"]').allTextContents().then((texts) => {
    const payloads: unknown[] = [];
    let bytes = 0;
    for (const text of texts) {
      bytes += text.length;
      if (bytes > MAX_NATIVE_JSON_BYTES) break;
      try { payloads.push(JSON.parse(text)); } catch { /* Only parsed native data is evidence. */ }
    }
    return payloads;
  });
  if (!options.refresh) cachedPayloads.set(page, read);
  return read;
}

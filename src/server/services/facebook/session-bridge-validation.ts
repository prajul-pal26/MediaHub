import { fbNavigationHeaders } from './headers';

export type BridgeResult = 'fresh' | 'login_required' | 'account_mismatch' | 'error';
const allowed = new Set(['c_user', 'xs', 'datr', 'sb', 'fr', 'wd', 'dpr', 'locale', 'ps_l', 'ps_n']);

export function bridgeCookies(raw: string, expected: string): string | null {
  if (raw.length > 12000 || /[\r\n\x00]/.test(raw)) return null;
  const pairs = raw.split(';').map(p => p.trim());
  const seen = new Map<string, string>();
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i < 1) return null;
    const name = pair.slice(0, i), value = pair.slice(i + 1);
    if (!allowed.has(name) || seen.has(name) || !value || !/^[\x21-\x7e]+$/.test(value)) return null;
    seen.set(name, value);
  }
  if (seen.get('c_user') !== expected || !seen.get('xs')) return null;
  return pairs.join('; ');
}

// Validate identity from authenticated native bootstrap data, not the submitted
// c_user value or an arbitrary user ID appearing in the feed.
export function inspectBridgePage(html: string, expected: string): BridgeResult {
  const identities = [...html.matchAll(/"(?:CurrentUserInitialData|CurrentUser)"\s*,\s*\[\s*\]\s*,\s*(\{[^{}]{0,8000}\})/g)]
    .flatMap(m => { try { const d = JSON.parse(m[1]); return [String(d.USER_ID ?? d.ACCOUNT_ID ?? '')]; } catch { return []; } });
  const ids = [...new Set(identities.filter(Boolean))];
  if (ids.includes('0') || /<form[^>]*action=["'][^"']*\/login/i.test(html)) return 'login_required';
  if (ids.some(id => id !== expected)) return 'account_mismatch';
  const token = /"DTSGInitialData"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"[^"\s]+"/.test(html);
  return ids.length === 1 && ids[0] === expected && token ? 'fresh' : 'error';
}

export async function validateBridgeCookies(cookies: string, expected: string, fetcher: typeof fetch = fetch): Promise<BridgeResult> {
  try {
    // Do not follow redirects with session material, even to another FB host.
    const response = await fetcher('https://www.facebook.com/', {
      headers: fbNavigationHeaders(cookies), redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(25000),
    });
    const location = response.headers.get('location') ?? '';
    if (response.status >= 300 && response.status < 400) {
      const target = new URL(location, 'https://www.facebook.com/');
      return target.origin === 'https://www.facebook.com' && /^\/(login|checkpoint|recover|two_step_verification)(\/|\.|$)/.test(target.pathname) ? 'login_required' : 'error';
    }
    if (!response.ok || !response.body) return 'error';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 8 * 1024 * 1024) { await reader.cancel(); return 'error'; }
      chunks.push(value);
    }
    return inspectBridgePage(Buffer.concat(chunks).toString('utf8'), expected);
  } catch { return 'error'; } // Never put request headers, body or errors into logs.
}

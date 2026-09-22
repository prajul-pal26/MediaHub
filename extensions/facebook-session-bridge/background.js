const ENDPOINT = 'http://localhost:3010/api/facebook/session-bridge';
const ALARM = 'mediahub-facebook-sync';
const FACEBOOK = 'https://www.facebook.com/';
const COOKIE_NAMES = ['xs', 'datr', 'sb', 'fr', 'wd', 'dpr', 'locale', 'ps_l', 'ps_n'];
let running;
let demandRunning;
let cookieTimer;

const ready = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
async function config() { await ready; return (await chrome.storage.local.get('pairing')).pairing; }
async function status(state) {
  await chrome.storage.local.set({ status: { state, checkedAt: new Date().toISOString() } });
  await chrome.action.setBadgeText({ text: state === 'fresh' ? 'OK' : state === 'running' ? '…' : '!' });
  await chrome.action.setBadgeBackgroundColor({ color: state === 'fresh' ? '#187744' : '#885500' });
}
async function schedule() {
  if (await config()) {
    const alarm = await chrome.alarms.get(ALARM);
    if (alarm?.periodInMinutes !== 0.5) await chrome.alarms.create(ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
  } else await chrome.alarms.clear(ALARM);
}
async function send(pairing, body) {
  return fetch(ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pairing.token}` },
    body: JSON.stringify(body), credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(28000),
  });
}
async function collectCookies(expectedUser) {
  const account = await chrome.cookies.get({ url: FACEBOOK, name: 'c_user' });
  if (!account?.value) return { state: 'login_required' };
  if (account.value !== expectedUser) return { state: 'account_mismatch' };
  const parts = [`c_user=${account.value}`];
  for (const name of COOKIE_NAMES) {
    const cookie = await chrome.cookies.get({ url: FACEBOOK, name });
    if (name === 'xs' && !cookie?.value) return { state: 'login_required' };
    if (cookie?.value) parts.push(`${name}=${cookie.value}`);
  }
  const after = await chrome.cookies.get({ url: FACEBOOK, name: 'c_user' });
  if (after?.value !== account.value) return { state: 'account_mismatch' };
  return { cookies: parts.join('; ') };
}
async function syncOnce() {
  const pairing = await config();
  if (!pairing) return { state: 'stopped' };
  if (Date.parse(pairing.expiresAt) <= Date.now()) {
    await chrome.storage.local.remove('pairing'); await schedule(); await status('pairing_expired');
    return { state: 'pairing_expired' };
  }
  const dirtyVersion = (await chrome.storage.local.get('dirty')).dirty;
  await status('running');
  let state = 'error';
  try {
    let body;
    try { body = await collectCookies(pairing.expectedUser); } catch { body = { state: 'error' }; }
    if ((await config())?.token !== pairing.token) return { state: 'stopped' };
    const response = await send(pairing, body);
    if (response.status === 401) {
      state = 'unpaired';
      if ((await config())?.token === pairing.token) { await chrome.storage.local.remove('pairing'); await schedule(); }
    } else if (response.status === 409) state = 'busy';
    else if (response.ok) {
      const result = await response.json();
      if (['fresh', 'login_required', 'account_mismatch', 'error'].includes(result.status)) state = result.status;
    }
  } catch { state = 'app_unreachable'; }
  const current = await config();
  if (current?.token === pairing.token && ['fresh', 'login_required', 'account_mismatch', 'error'].includes(state)
    && (await chrome.storage.local.get('dirty')).dirty === dirtyVersion) await chrome.storage.local.remove('dirty');
  if (current?.token === pairing.token || (!current && state === 'unpaired')) await status(state);
  return { state };
}
function sync() {
  if (!running) running = syncOnce().finally(() => { running = undefined; });
  return running;
}
async function checkDemandOnce() {
  const pairing = await config();
  if (!pairing) return;
  if (Date.parse(pairing.expiresAt) <= Date.now()) { await sync(); return; }
  try {
    const response = await send(pairing, { state: 'demand' });
    if (response.status === 401) {
      if ((await config())?.token === pairing.token) { await chrome.storage.local.remove('pairing'); await schedule(); await status('unpaired'); }
      return;
    }
    if (!response.ok) { await status('app_unreachable'); return; }
    const result = await response.json();
    if ((await config())?.token !== pairing.token) return;
    const dirty = (await chrome.storage.local.get('dirty')).dirty;
    if (result.shouldSync || dirty) await sync();
  } catch { await status('app_unreachable'); }
}
function checkDemand() {
  if (!demandRunning) demandRunning = checkDemandOnce().finally(() => { demandRunning = undefined; });
  return demandRunning;
}
async function stop() {
  const pairing = await config();
  await chrome.storage.local.remove('pairing');
  await chrome.storage.local.remove('dirty');
  await schedule();
  let revoked = false;
  try { if (pairing) revoked = (await send(pairing, { state: 'stop' })).ok; } catch { /* Fixed safe result only. */ }
  await status('stopped');
  return { state: 'stopped', revoked };
}
function trustedPage(sender) {
  try {
    const url = new URL(sender.url);
    return !sender.tab?.incognito && (sender.frameId === undefined || sender.frameId === 0)
      && ['http://localhost:3010', 'https://localhost:3443'].includes(url.origin) && url.pathname === '/settings';
  } catch { return false; }
}
async function external(message, sender) {
  if (!trustedPage(sender)) return { state: 'forbidden' };
  if (message?.action === 'ping') return { state: 'available' };
  if (message?.action === 'pair') {
    const pairing = message.pairing;
    if (!pairing || !/^[a-f0-9]{64}$/.test(pairing.token) || !/^\d{1,40}$/.test(pairing.expectedUser)
      || !/^[a-f0-9-]{36}$/.test(pairing.sessionId) || !Number.isFinite(Date.parse(pairing.expiresAt))
      || Date.parse(pairing.expiresAt) <= Date.now()) return { state: 'invalid_pairing' };
    const old = await config();
    if (old && old.sessionId !== pairing.sessionId) return { state: 'already_paired' };
    await chrome.storage.local.set({ pairing: { token: pairing.token, expectedUser: pairing.expectedUser, sessionId: pairing.sessionId, expiresAt: pairing.expiresAt } });
    await schedule();
    if (running) await running;
    return sync();
  }
  if (['sync', 'stop'].includes(message?.action)) {
    const pairing = await config();
    if (pairing?.sessionId !== message.sessionId) return { state: 'unpaired' };
    return message.action === 'stop' ? stop() : sync();
  }
  return { state: 'invalid_request' };
}
chrome.runtime.onMessageExternal.addListener((message, sender, respond) => {
  external(message, sender).then(respond, () => respond({ state: 'error' }));
  return true;
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  const action = message?.action === 'stop' ? stop : async () => {
    const pairing = await config();
    const saved = (await chrome.storage.local.get('status')).status;
    return { expectedUser: pairing?.expectedUser, state: saved?.state ?? 'unpaired', checkedAt: saved?.checkedAt };
  };
  action().then(respond, () => respond({ state: 'error' }));
  return true;
});
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) void checkDemand().catch(() => status('error')); });
chrome.cookies.onChanged.addListener((change) => {
  if (!['c_user', 'xs'].includes(change.cookie.name) || !['.facebook.com', 'www.facebook.com', 'facebook.com'].includes(change.cookie.domain)
    || change.cookie.partitionKey) return;
  void config().then(async (pairing) => {
    if (!pairing) return;
    await chrome.storage.local.set({ dirty: Date.now() });
    clearTimeout(cookieTimer);
    cookieTimer = setTimeout(() => { void sync().catch(() => status('error')); }, 1000);
  });
});
chrome.runtime.onStartup.addListener(() => { void schedule().then(checkDemand); });
chrome.runtime.onInstalled.addListener(() => { void schedule(); });
void schedule();

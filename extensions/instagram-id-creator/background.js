const SIGNUP_URL = 'https://www.instagram.com/accounts/emailsignup/';
let signupTabId = null;
const pendingFillRequests = new Map();

function validPayload(value) {
  if (!value || typeof value !== 'object') return false;
  const fields = ['email', 'password', 'day', 'month', 'year', 'fullName', 'username'];
  return fields.every((field) => typeof value[field] === 'string' && value[field].trim().length > 0)
    && /^\S+@\S+\.\S+$/.test(value.email)
    && /^\d{1,2}$/.test(value.day)
    && /^\d{1,2}$/.test(value.month)
    && /^\d{4}$/.test(value.year);
}

function waitForSignupScript(tabId, payload) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => finish({ state: 'error', message: 'Instagram did not finish loading the sign-up page.' }), 18_000);
    let sent = false;

    async function tryFill(frameId) {
      if (sent) return;
      try {
        const reply = Number.isInteger(frameId)
          ? await chrome.tabs.sendMessage(tabId, { action: 'fill-signup', payload }, { frameId })
          : await chrome.tabs.sendMessage(tabId, { action: 'fill-signup', payload });
        if (reply?.state === 'filled' || reply?.state === 'error') {
          sent = true;
          finish(reply);
        }
      } catch {
        // The content script can take a moment to attach after the page becomes complete.
      }
    }

    function onUpdated(updatedTabId, change) {
      if (updatedTabId === tabId && (change.status === 'loading' || change.status === 'complete')) {
        // The content script runs at document_start, so begin immediately. The retry
        // covers a cold extension service worker without waiting for page idle.
        void tryFill();
        setTimeout(() => void tryFill(), 100);
        setTimeout(() => void tryFill(), 300);
      }
    }
    function finish(result) {
      clearTimeout(timeout);
      pendingFillRequests.delete(tabId);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(result);
    }
    pendingFillRequests.set(tabId, { tryFill });
    chrome.tabs.onUpdated.addListener(onUpdated);
    void tryFill();
  });
}

async function sendToSignupTab(action, payload) {
  if (!Number.isInteger(signupTabId)) {
    return { state: 'error', message: 'Open and fill Instagram first, then keep that Instagram tab open.' };
  }
  try {
    return await chrome.tabs.sendMessage(signupTabId, { action, payload });
  } catch {
    return { state: 'error', message: 'The Instagram sign-up tab is unavailable. Open and fill the form again.' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.action === 'signup-ready') {
    const request = sender.tab?.id ? pendingFillRequests.get(sender.tab.id) : null;
    if (request) void request.tryFill(sender.frameId);
    return false;
  }
  if (message?.action === 'submit-signup') {
    void sendToSignupTab('submit-signup').then(respond);
    return true;
  }
  if (message?.action === 'submit-otp') {
    const otp = message.payload?.otp;
    if (typeof otp !== 'string' || !otp.trim()) {
      respond({ state: 'error', message: 'Enter the verification code sent by Instagram.' });
      return false;
    }
    void sendToSignupTab('submit-otp', { otp: otp.trim() }).then(respond);
    return true;
  }
  if (message?.action !== 'fill-signup') return false;
  if (!validPayload(message.payload)) {
    respond({ state: 'error', message: 'The sign-up details are incomplete or invalid.' });
    return false;
  }

  // Navigate directly. The listener is registered before this call and the Instagram
  // content script starts at document_start, avoiding the former blank-tab round trip.
  // Instagram's live signup controls are throttled in a background tab. Open the
  // form in the foreground so its fields render and accept input reliably.
  chrome.tabs.create({ url: SIGNUP_URL, active: true })
    .then(async (tab) => {
      if (!Number.isInteger(tab.id)) return { state: 'error', message: 'Chrome did not return a usable Instagram tab.' };
      signupTabId = tab.id;
      return waitForSignupScript(tab.id, message.payload);
    })
    .then(respond, () => respond({ state: 'error', message: 'Chrome could not open Instagram.' }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === signupTabId) signupTabId = null;
  pendingFillRequests.delete(tabId);
});

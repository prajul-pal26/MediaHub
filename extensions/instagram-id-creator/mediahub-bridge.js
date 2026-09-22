// Runs only inside the local MediaHub page. It forwards a one-time, user-initiated
// fill request to the extension and never persists any part of the form.
window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const message = event.data;
  if (message?.source !== 'mediahub-instagram-id-creator' || !['fill-signup', 'submit-signup', 'submit-otp'].includes(message?.action)) return;

  // A page which was open while Chrome reloaded/disabled the extension can
  // retain an old content-script realm where the runtime API no longer exists.
  // Report that recoverable state instead of throwing before the UI gets a reply.
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.sendMessage) {
    window.postMessage({
      source: 'mediahub-instagram-id-creator',
      state: 'error',
      message: 'The Chrome extension was reloaded. Refresh this MediaHub page, then try again.',
    }, window.location.origin);
    return;
  }

  runtime.sendMessage({ action: message.action, payload: message.payload }, (reply) => {
    const error = globalThis.chrome?.runtime?.lastError;
    window.postMessage({
      source: 'mediahub-instagram-id-creator',
      state: error ? 'error' : (reply?.state ?? 'error'),
      message: error?.message || reply?.message,
    }, window.location.origin);
  });
});

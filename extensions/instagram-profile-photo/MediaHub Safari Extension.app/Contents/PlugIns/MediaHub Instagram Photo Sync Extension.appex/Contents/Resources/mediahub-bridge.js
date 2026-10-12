// MediaHub Bridge Script
// Injected into MediaHub dashboard pages to facilitate communication between the UI and extension.

(function () {
  const SOURCE_PAGE = "mediahub-instagram-photo-sync";
  const SOURCE_EXT = "mediahub-photo-sync-extension";

  // Notify page that extension bridge is active
  window.postMessage(
    {
      source: SOURCE_EXT,
      state: "extension-ready",
      version: "1.0.0",
    },
    window.location.origin
  );

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (message?.source !== SOURCE_PAGE) return;

    const runtime = globalThis.chrome?.runtime || globalThis.browser?.runtime;
    if (!runtime?.sendMessage) {
      window.postMessage(
        {
          source: SOURCE_EXT,
          state: "error",
          message: "Extension runtime disconnected. Please reload the extension and refresh.",
        },
        window.location.origin
      );
      return;
    }

    if (message.action === "ping") {
      window.postMessage(
        {
          source: SOURCE_EXT,
          state: "pong",
          version: "1.0.0",
        },
        window.location.origin
      );
      return;
    }

    if (message.action === "sync-photo") {
      runtime.sendMessage(
        {
          action: "sync-photo",
          payload: message.payload,
        },
        (response) => {
          const error = runtime.lastError;
          window.postMessage(
            {
              source: SOURCE_EXT,
              state: error ? "error" : response?.state || "success",
              message: error?.message || response?.message,
              data: response?.data,
            },
            window.location.origin
          );
        }
      );
    }
  });

  // Listen for background notifications (e.g. upload completed)
  const runtime = globalThis.chrome?.runtime || globalThis.browser?.runtime;
  if (runtime?.onMessage) {
    runtime.onMessage.addListener((msg) => {
      if (msg?.source === SOURCE_EXT) {
        window.postMessage(msg, window.location.origin);
      }
    });
  }
})();

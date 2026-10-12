// MediaHub Instagram Profile Photo Sync - Background Worker
const INSTA_EDIT_URL = "https://www.instagram.com/accounts/edit/";

const runtime = globalThis.chrome?.runtime || globalThis.browser?.runtime;
const storage = globalThis.chrome?.storage?.local || globalThis.browser?.storage?.local;
const tabs = globalThis.chrome?.tabs || globalThis.browser?.tabs;

runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "sync-photo") {
    handleSyncPhoto(message.payload)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ state: "error", message: err.message }));
    return true; // Keep message channel open for async response
  }

  if (message.action === "get-photo") {
    handleGetPhoto(message.username)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ state: "error", message: err.message }));
    return true;
  }

  if (message.action === "photo-upload-complete") {
    // 1. Directly notify MediaHub backend so database updates immediately
    const targetId = message.data?.profileId || message.data?.username;
    if (targetId) {
      const hosts = ["http://localhost:3010", "https://localhost:3443", "http://localhost:3000"];
      for (const host of hosts) {
        fetch(`${host}/api/trpc/instaProfilePhoto.setStatus`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: targetId,
            status: "synced",
          }),
        }).catch(() => {});
      }
    }

    // 2. Broadcast status to MediaHub tabs
    tabs.query({ url: ["https://localhost:3443/*", "http://localhost:3010/*", "http://localhost:3000/*"] }, (mhTabs) => {
      for (const t of mhTabs || []) {
        if (t.id) {
          tabs.sendMessage(t.id, {
            source: "mediahub-photo-sync-extension",
            state: "upload-complete",
            data: message.data,
          }).catch(() => {});
        }
      }
    });
    sendResponse({ ok: true });
    return true;
  }
});

async function handleGetPhoto(username) {
  if (!username) throw new Error("Username required");
  const hosts = ["http://localhost:3010", "https://localhost:3443", "http://localhost:3000"];
  for (const host of hosts) {
    try {
      const url = `${host}/api/trpc/instaProfilePhoto.getPhoto?input=${encodeURIComponent(JSON.stringify({ username }))}`;
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        const payload = json?.result?.data?.json || json?.result?.data;
        if (payload?.dataUrl || payload?.base64) {
          return { state: "success", payload };
        }
      }
    } catch {}
  }
  throw new Error(`Could not fetch photo payload for @${username}`);
}

async function handleSyncPhoto(payload) {
  if (!payload?.username || !payload?.dataUrl) {
    throw new Error("Invalid payload: username and dataUrl are required");
  }

  // Save latest pending photo in local storage
  if (storage) {
    await storage.set({ pendingPhoto: payload, autoUpload: true });
  }

  // Find existing Instagram edit tab or create a new one
  const existingTabs = await new Promise((resolve) => {
    tabs.query({ url: "*://*.instagram.com/accounts/edit*" }, (res) => resolve(res || []));
  });

  let targetTab = existingTabs[0];

  if (targetTab && targetTab.id) {
    // Focus existing tab
    await tabs.update(targetTab.id, { active: true });
    // Send upload instruction
    try {
      const response = await tabs.sendMessage(targetTab.id, {
        action: "upload-photo",
        payload,
      });
      return response || { state: "sent", message: "Sent upload instruction to Instagram tab" };
    } catch {
      // If content script wasn't attached yet, reload tab
      await tabs.reload(targetTab.id);
      return { state: "opening", message: "Reloading Instagram edit page with photo payload" };
    }
  } else {
    // Create new tab
    const newTab = await tabs.create({ url: INSTA_EDIT_URL, active: true });
    return {
      state: "opening",
      message: "Opening Instagram edit profile tab. The photo will upload once the page loads.",
      tabId: newTab.id,
    };
  }
}

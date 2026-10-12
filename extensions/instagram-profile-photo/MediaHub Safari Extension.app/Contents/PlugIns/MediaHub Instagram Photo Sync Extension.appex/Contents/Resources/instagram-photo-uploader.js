// MediaHub Instagram Profile Photo Uploader
// Runs on https://www.instagram.com/accounts/edit/*

(function () {
  const runtime = globalThis.chrome?.runtime || globalThis.browser?.runtime;
  const storage = globalThis.chrome?.storage?.local || globalThis.browser?.storage?.local;

  let currentUsername = "";
  let pendingPayload = null;
  let widgetContainer = null;

  // Listen for direct messages from background script
  if (runtime?.onMessage) {
    runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === "upload-photo") {
        pendingPayload = message.payload;
        updateWidgetUI();
        executePhotoUpload(pendingPayload)
          .then((res) => sendResponse({ state: "success", message: res }))
          .catch((err) => sendResponse({ state: "error", message: err.message }));
        return true;
      }
    });
  }

  // Detect username reliably from localStorage, DOM, or profile links
  function detectUsername() {
    // 1. Check one_tap_storage_version in localStorage (most reliable)
    try {
      const ot = JSON.parse(localStorage.getItem("one_tap_storage_version") || "{}");
      for (const [k, v] of Object.entries(ot)) {
        if (v?.username) return v.username;
      }
    } catch {}

    // 2. Check profile picture img alt (e.g. "apna_amrohaa's profile picture")
    const pImg = document.querySelector('img[alt*="profile picture"], img[alt*="Profile Picture"]');
    if (pImg?.alt) {
      const m = pImg.alt.match(/^([a-zA-Z0-9._]+)/);
      if (m && m[1] && !["add", "profile", "change"].includes(m[1].toLowerCase())) {
        return m[1];
      }
    }

    // 3. Check exact profile link
    const excluded = ["accounts", "explore", "reels", "direct", "stories", "emails", "settings", "language", "legal", "web"];
    const profileLinks = document.querySelectorAll('a[href^="/"]');
    for (const a of profileLinks) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
      if (m && m[1] && m[1].length > 2 && !excluded.includes(m[1].toLowerCase())) {
        return m[1];
      }
    }

    const input = document.querySelector('input[name="username"]');
    if (input && input.value) return input.value.trim();

    return "";
  }

  function base64ToBlob(dataUrl, defaultMime = "image/png") {
    const parts = dataUrl.split(",");
    const base64Str = parts.length > 1 ? parts[1] : parts[0];
    const mimeMatch = parts[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : defaultMime;
    const binary = atob(base64Str);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
  }

  function createWidget() {
    if (document.getElementById("mediahub-photo-widget")) return;

    widgetContainer = document.createElement("div");
    widgetContainer.id = "mediahub-photo-widget";
    widgetContainer.style.cssText = `
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 999999;
      background: #18181b;
      color: #fafafa;
      border: 1px solid #3f3f46;
      border-radius: 12px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 13px;
      width: 320px;
      overflow: hidden;
      transition: all 0.2s ease;
    `;

    document.body.appendChild(widgetContainer);
    updateWidgetUI();
  }

  function updateWidgetUI(statusMsg = "", isError = false, isSuccess = false) {
    if (!widgetContainer) return;

    const detected = detectUsername();
    if (detected) currentUsername = detected;

    const logoSlug = currentUsername.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const previewUrl = pendingPayload?.dataUrl || `https://localhost:3443/generated/instagram-district-logos/${logoSlug}.png`;

    widgetContainer.innerHTML = `
      <div style="padding: 12px 14px; background: #27272a; border-bottom: 1px solid #3f3f46; display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="width: 22px; height: 22px; border-radius: 6px; background: linear-gradient(135deg, #f4510b, #e11d48); display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 12px; color: #fff;">M</div>
          <span style="font-weight: 600; font-size: 13px; color: #f4f4f5;">MediaHub Photo Sync</span>
        </div>
        <button id="mh-close-widget" style="background: none; border: none; color: #a1a1aa; cursor: pointer; font-size: 16px; line-height: 1;">&times;</button>
      </div>

      <div style="padding: 14px;">
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
          <img id="mh-preview-img" src="${previewUrl}" style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover; border: 2px solid #52525b; background: #09090b;" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'%23888\\' stroke-width=\\'2\\'%3E%3Crect width=\\'18\\' height=\\'18\\' x=\\'3\\' y=\\'3\\' rx=\\'2\\'/%3E%3Ccircle cx=\\'9\\' cy=\\'9\\' r=\\'2\\'/%3E%3Cpath d=\\'m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21\\'/%3E%3C/svg%3E'" />
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 600; font-size: 13px; color: #fff; truncate; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
              @${currentUsername || "Detecting account..."}
            </div>
            <div style="font-size: 11px; color: #a1a1aa; margin-top: 2px;">
              ${logoSlug ? `${logoSlug}.png` : "Waiting for edit page"}
            </div>
          </div>
        </div>

        ${statusMsg ? `
          <div style="padding: 8px 10px; border-radius: 6px; font-size: 12px; margin-bottom: 12px; ${
            isError
              ? "background: #450a0a; color: #fca5a5; border: 1px solid #7f1d1d;"
              : isSuccess
              ? "background: #052e16; color: #86efac; border: 1px solid #14532d;"
              : "background: #182635; color: #93c5fd; border: 1px solid #1e3a8a;"
          }">
            ${statusMsg}
          </div>
        ` : ""}

        <div style="display: flex; gap: 8px;">
          <button id="mh-upload-btn" style="flex: 1; background: #2563eb; hover: #1d4ed8; color: #ffffff; border: none; padding: 8px 12px; border-radius: 6px; font-weight: 500; font-size: 12px; cursor: pointer; transition: background 0.15s ease;">
            Upload District Logo Now
          </button>
        </div>
      </div>
    `;

    const closeBtn = document.getElementById("mh-close-widget");
    if (closeBtn) {
      closeBtn.onclick = () => {
        widgetContainer.style.display = "none";
      };
    }

    const uploadBtn = document.getElementById("mh-upload-btn");
    if (uploadBtn) {
      uploadBtn.onclick = async () => {
        uploadBtn.disabled = true;
        uploadBtn.textContent = "Uploading...";
        try {
          await executePhotoUpload(pendingPayload);
        } catch (err) {
          uploadBtn.disabled = false;
          uploadBtn.textContent = "Try Again";
        }
      };
    }
  }

  async function executePhotoUpload(payload) {
    updateWidgetUI("Preparing photo payload...", false, false);

    const username = currentUsername || detectUsername();
    if (!username) {
      const err = "Could not detect active Instagram username on this page.";
      updateWidgetUI(err, true, false);
      throw new Error(err);
    }

    let dataUrl = payload?.dataUrl;
    let fileName = payload?.fileName || `${username.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`;

    // If payload not yet retrieved, ask background script to fetch from MediaHub backend
    if (!dataUrl && runtime?.sendMessage) {
      try {
        const bgRes = await new Promise((resolve, reject) => {
          runtime.sendMessage({ action: "get-photo", username }, (response) => {
            if (response?.payload?.dataUrl) resolve(response.payload);
            else reject(new Error(response?.message || "Could not retrieve photo"));
          });
        });
        if (bgRes?.dataUrl) {
          dataUrl = bgRes.dataUrl;
          if (bgRes.fileName) fileName = bgRes.fileName;
        }
      } catch (e) {
        console.warn("Could not get photo from background:", e);
      }
    }

    if (!dataUrl) {
      const err = `No logo found for @${username}. Make sure the district logo exists.`;
      updateWidgetUI(err, true, false);
      throw new Error(err);
    }

    // Convert dataUrl to Blob using atob (synchronous, never fails with WebKit 'Load failed')
    updateWidgetUI("Processing image file...", false, false);
    const blob = base64ToBlob(dataUrl, "image/png");
    const file = new File([blob], fileName, { type: "image/png" });

    // Step 1: Click "Change photo" / "Change profile photo" button to trigger Instagram modal
    updateWidgetUI("Opening Instagram photo selector...", false, false);
    const changeBtn = Array.from(document.querySelectorAll("div, button, span")).find(
      (e) => e.innerText === "Change photo" || e.innerText === "Change profile photo"
    );

    if (changeBtn) {
      changeBtn.click();
      await new Promise((r) => setTimeout(r, 400));
    }

    // Step 2: Find modal dialog's file input or any active file input on the page
    const dialog = document.querySelector('[role="dialog"]');
    const fileInput =
      dialog?.querySelector('input[type="file"]') ||
      Array.from(document.querySelectorAll('input[type="file"]')).pop();

    if (!fileInput) {
      const err = "Instagram file input not found on page.";
      updateWidgetUI(err, true, false);
      throw new Error(err);
    }

    // Step 3: Attach file and trigger change event
    updateWidgetUI("Uploading photo to Instagram...", false, false);
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;

    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    fileInput.dispatchEvent(new Event("input", { bubbles: true }));

    // Step 4: Wait for Instagram response
    await new Promise((r) => setTimeout(r, 1200));

    updateWidgetUI("✅ Profile photo uploaded successfully!", false, true);

    // Step 5: Notify background script
    if (runtime?.sendMessage) {
      runtime.sendMessage({
        action: "photo-upload-complete",
        data: {
          username,
          profileId: payload?.profileId,
          success: true,
        },
      }).catch(() => {});
    }

    return "Profile photo updated successfully!";
  }

  // Check stored pending photo on load
  if (storage) {
    storage.get(["pendingPhoto", "autoUpload"], (res) => {
      if (res?.pendingPhoto) {
        pendingPayload = res.pendingPhoto;
        createWidget();
        if (res.autoUpload) {
          setTimeout(() => {
            executePhotoUpload(pendingPayload)
              .then(() => {
                storage.remove(["pendingPhoto", "autoUpload"]);
              })
              .catch((err) => {
                console.error("Auto upload error:", err);
              });
          }, 800);
          return;
        }
      }
      createWidget();
    });
  } else {
    createWidget();
  }

  // Monitor DOM for username appearance on single-page-app navigation
  let attempts = 0;
  const poll = setInterval(() => {
    attempts++;
    const detected = detectUsername();
    if (detected && detected !== currentUsername) {
      currentUsername = detected;
      updateWidgetUI();
      clearInterval(poll);
    }
    if (attempts > 30) clearInterval(poll);
  }, 500);
})();

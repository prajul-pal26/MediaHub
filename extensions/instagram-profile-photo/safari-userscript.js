// ==UserScript==
// @name         MediaHub Instagram Profile Photo Sync (Safari)
// @namespace    https://mediahub.local/
// @version      1.1.0
// @description  Automatically sync official district profile logos on Instagram accounts/edit in Safari
// @match        https://www.instagram.com/accounts/edit/*
// @match        https://www.instagram.com/accounts/edit*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  function detectUsername() {
    try {
      const ot = JSON.parse(localStorage.getItem("one_tap_storage_version") || "{}");
      for (const [k, v] of Object.entries(ot)) {
        if (v?.username) return v.username;
      }
    } catch {}

    const pImg = document.querySelector('img[alt*="profile picture"], img[alt*="Profile Picture"]');
    if (pImg?.alt) {
      const m = pImg.alt.match(/^([a-zA-Z0-9._]+)/);
      if (m && m[1] && !["add", "profile", "change"].includes(m[1].toLowerCase())) {
        return m[1];
      }
    }

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
    if (document.getElementById("mediahub-safari-widget")) return;

    const widget = document.createElement("div");
    widget.id = "mediahub-safari-widget";
    widget.style.cssText = `
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

    const username = detectUsername();
    const logoSlug = username ? username.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "";
    const logoUrl = `https://localhost:3443/generated/instagram-district-logos/${logoSlug}.png`;

    widget.innerHTML = `
      <div style="padding: 12px 14px; background: #27272a; border-bottom: 1px solid #3f3f46; display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="width: 22px; height: 22px; border-radius: 6px; background: linear-gradient(135deg, #f4510b, #e11d48); display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 12px; color: #fff;">M</div>
          <span style="font-weight: 600; font-size: 13px; color: #f4f4f5;">MediaHub Photo Sync</span>
        </div>
        <button id="mh-safari-close" style="background: none; border: none; color: #a1a1aa; cursor: pointer; font-size: 16px; line-height: 1;">&times;</button>
      </div>

      <div style="padding: 14px;">
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
          <img id="mh-safari-img" src="${logoUrl}" style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover; border: 2px solid #52525b; background: #09090b;" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'%23888\\' stroke-width=\\'2\\'%3E%3Crect width=\\'18\\' height=\\'18\\' x=\\'3\\' y=\\'3\\' rx=\\'2\\'/%3E%3Ccircle cx=\\'9\\' cy=\\'9\\' r=\\'2\\'/%3E%3Cpath d=\\'m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21\\'/%3E%3C/svg%3E'" />
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 600; font-size: 13px; color: #fff; truncate; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
              @${username || "Detecting account..."}
            </div>
            <div style="font-size: 11px; color: #a1a1aa; margin-top: 2px;">
              ${logoSlug ? `${logoSlug}.png` : "Loading profile..."}
            </div>
          </div>
        </div>

        <div id="mh-safari-status" style="display: none; padding: 8px 10px; border-radius: 6px; font-size: 12px; margin-bottom: 12px;"></div>

        <button id="mh-safari-upload-btn" style="width: 100%; background: #2563eb; hover: #1d4ed8; color: #ffffff; border: none; padding: 8px 12px; border-radius: 6px; font-weight: 500; font-size: 12px; cursor: pointer; transition: background 0.15s ease;">
          Upload District Logo Now
        </button>
      </div>
    `;

    document.body.appendChild(widget);

    document.getElementById("mh-safari-close").onclick = () => widget.remove();

    const uploadBtn = document.getElementById("mh-safari-upload-btn");
    const statusDiv = document.getElementById("mh-safari-status");

    uploadBtn.onclick = async () => {
      uploadBtn.disabled = true;
      uploadBtn.textContent = "Uploading...";
      statusDiv.style.display = "block";
      statusDiv.style.background = "#182635";
      statusDiv.style.color = "#93c5fd";
      statusDiv.style.border = "1px solid #1e3a8a";
      statusDiv.textContent = "Fetching district logo from MediaHub...";

      try {
        let blob = null;
        let fileName = `${logoSlug}.png`;

        // Fetch payload from localhost
        const hosts = ["http://localhost:3010", "https://localhost:3443", "http://localhost:3000"];
        for (const h of hosts) {
          try {
            const res = await fetch(`${h}/api/trpc/instaProfilePhoto.getPhoto?input=${encodeURIComponent(JSON.stringify({ username }))}`);
            if (res.ok) {
              const json = await res.json();
              const payload = json?.result?.data?.json || json?.result?.data;
              if (payload?.dataUrl) {
                blob = base64ToBlob(payload.dataUrl, "image/png");
                if (payload.fileName) fileName = payload.fileName;
                break;
              }
            }
          } catch {}
        }

        if (!blob) {
          const directRes = await fetch(logoUrl);
          if (directRes.ok) {
            blob = await directRes.blob();
          }
        }

        if (!blob) throw new Error("Could not fetch logo image from MediaHub");

        statusDiv.textContent = "Opening photo selector...";
        const file = new File([blob], fileName, { type: "image/png" });

        const changeBtn = Array.from(document.querySelectorAll("div, button, span")).find(
          (e) => e.innerText === "Change photo" || e.innerText === "Change profile photo"
        );
        if (changeBtn) {
          changeBtn.click();
          await new Promise((r) => setTimeout(r, 400));
        }

        const dialog = document.querySelector('[role="dialog"]');
        const fileInput =
          dialog?.querySelector('input[type="file"]') ||
          Array.from(document.querySelectorAll('input[type="file"]')).pop();

        if (!fileInput) throw new Error("Instagram file input not found on page.");

        statusDiv.textContent = "Uploading to Instagram...";
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
        fileInput.dispatchEvent(new Event("input", { bubbles: true }));

        await new Promise((r) => setTimeout(r, 1200));

        statusDiv.style.background = "#052e16";
        statusDiv.style.color = "#86efac";
        statusDiv.style.border = "1px solid #14532d";
        statusDiv.textContent = "✅ Profile photo updated successfully!";
        uploadBtn.textContent = "Done";

        // Notify MediaHub backend
        for (const h of hosts) {
          fetch(`${h}/api/trpc/instaProfilePhoto.setStatus`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: username, status: "synced" })
          }).catch(() => {});
        }
      } catch (err) {
        statusDiv.style.background = "#450a0a";
        statusDiv.style.color = "#fca5a5";
        statusDiv.style.border = "1px solid #7f1d1d";
        statusDiv.textContent = `Error: ${err.message}`;
        uploadBtn.disabled = false;
        uploadBtn.textContent = "Try Again";
      }
    };
  }

  // Initialize
  setTimeout(() => {
    createWidget();
    if (
      window.location.search.includes("mediahub_auto=1") ||
      window.location.search.includes("auto_upload=1")
    ) {
      setTimeout(() => {
        const btn = document.getElementById("mh-safari-upload-btn");
        if (btn) btn.click();
      }, 600);
    }
  }, 1200);
})();

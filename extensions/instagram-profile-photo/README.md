# MediaHub Instagram Profile Photo Sync Extension

Uploads and syncs official district profile logos to Instagram accounts directly via `https://www.instagram.com/accounts/edit/`.

## How it works

1. It matches the logged-in Instagram profile (e.g. `@apnaa_sambhal`) with its official district logo (e.g. `apnaa-sambhal.png`) from Google Drive / MediaHub.
2. In the browser, on `https://www.instagram.com/accounts/edit/`, it provides an instant 1-click **"Upload District Logo Now"** floating button.
3. It uploads the image directly using Instagram's authenticated session API (`/api/v1/web/accounts/web_change_profile_picture/`) with fallback to the native file input, without any rate-limit or captcha triggers.

---

## Safari Setup Options

### Option 1: Safari Userscripts (Recommended for 75 Profiles)
1. Install **Userscripts** (Free open-source Safari Extension from the Mac App Store) or Tampermonkey for Safari.
2. Enable Userscripts in Safari Settings → Extensions.
3. Add `safari-userscript.js` from this folder to Userscripts.
4. Whenever you open `https://www.instagram.com/accounts/edit/` in ANY Safari profile, the floating "MediaHub Photo Sync" badge will appear with the matching district logo and a 1-click Upload button!

### Option 2: Run via Safari Web Inspector / Bookmarklet
1. In Safari, go to `https://www.instagram.com/accounts/edit/`.
2. Open Web Inspector (⌥ + ⌘ + I) → Console.
3. Paste the contents of `safari-userscript.js` and press Enter.

---

## Chrome / Chromium Setup

1. In Chrome, navigate to `chrome://extensions`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the `extensions/instagram-profile-photo` folder.
5. In MediaHub (`https://localhost:3443/insta-profile-photo`), click **Sync Photo** or open `https://www.instagram.com/accounts/edit/`.

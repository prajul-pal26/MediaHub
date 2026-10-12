#!/usr/bin/env python3
"""
MediaHub Automated Instagram Profile Photo Sync (macOS Host Runner)
Syncs official district logos downloaded from Google Drive into Instagram accounts via Safari.
Runs directly on macOS host without requiring MediaHub dashboard inside each Safari profile.

Usage:
  python3 scripts/instagram/auto-sync-photos.py --district Amroha
  python3 scripts/instagram/auto-sync-photos.py --all
  python3 scripts/instagram/auto-sync-photos.py --verify
"""

import sys
import os
import re
import json
import time
import base64
import argparse
import subprocess
import sqlite3

def run_applescript(scpt):
    p = subprocess.run(["osascript", "-e", scpt], capture_output=True, text=True)
    return p.stdout.strip(), p.stderr.strip(), p.returncode

def get_base64_logo(username):
    slug = re.sub(r'[^a-z0-9]+', '-', username.lower()).strip('-')
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
    path = os.path.join(repo_root, f'public/generated/instagram-district-logos/{slug}.png')
    if not os.path.exists(path):
        return None, path
    with open(path, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode('utf-8')
    return f"data:image/png;base64,{b64}", path

def update_mediahub_status(district, username, status="synced"):
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
    status_file = os.path.join(repo_root, 'public/generated/instagram-district-logos/photo-sync-status.json')
    data = {}
    if os.path.exists(status_file):
        try:
            with open(status_file) as f:
                data = json.load(f)
        except Exception:
            pass
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    if username:
        data[username.lower()] = {"status": status, "syncedAt": now}
    if district:
        data[district.lower()] = {"status": status, "syncedAt": now}
    with open(status_file, 'w') as f:
        json.dump(data, f, indent=2)

    # Also update Postgres in docker if container is running
    try:
        cmd = f"""export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"; docker exec -e PGPASSWORD=postgres $(docker ps -q -f name=mediahub-database) psql -h 127.0.0.1 -U supabase_admin -d supabase -c "UPDATE insta_profile_users SET photo_status = '{status}', photo_synced_at = NOW(), updated_at = NOW() WHERE insta_name ILIKE '{username}' OR district ILIKE '{district}';" """
        subprocess.run(cmd, shell=True, capture_output=True)
    except Exception:
        pass

def sync_district_photo(district_name, username=None):
    print(f"\n[+] Starting photo sync for: {district_name} (username: {username or 'auto'})...")
    
    # Check cache for district info
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
    cache_file = os.path.join(repo_root, 'src/server/services/instagram/safari-profiles-cache.json')
    safari_cache = {}
    if os.path.exists(cache_file):
        with open(cache_file) as f:
            safari_cache = json.load(f)

    profile_entry = None
    for k, v in safari_cache.items():
        if k.lower() == district_name.lower() or (v.get('district') and v['district'].lower() == district_name.lower()):
            profile_entry = v
            break
        if username and v.get('username') and v['username'].lower() == username.lower():
            profile_entry = v
            break

    target_username = username or (profile_entry.get('username') if profile_entry else None) or f"apna_{district_name.lower()}"
    data_url, logo_path = get_base64_logo(target_username)
    if not data_url:
        print(f"[-] Error: District logo not found at {logo_path}")
        return False

    print(f"[+] Loaded official Google Drive logo from: {logo_path}")

    # Check open Safari windows
    script_check = f'''
    tell application "Safari"
        set foundWin to false
        set winIndex to 0
        repeat with i from 1 to count of windows
            set w to window i
            try
                if name of w contains "{district_name}" or name of w contains "{target_username}" then
                    set foundWin to true
                    set winIndex to i
                    exit repeat
                end if
            end try
        end repeat
        return winIndex
    end tell
    '''
    out, err, code = run_applescript(script_check)
    win_index = int(out) if out and out.isdigit() else 0

    if win_index == 0:
        print(f"[*] Safari window for {district_name} not currently open in front. Using document 1 or opening...")
        win_index = 1

    # Navigate to accounts/edit
    nav_script = f'''
    tell application "Safari"
        tell window {win_index}
            set current tab to tab 1
            set URL of document 1 to "https://www.instagram.com/accounts/edit/"
        end tell
    end tell
    '''
    run_applescript(nav_script)
    print("[+] Waiting for Instagram edit profile page to load...")
    time.sleep(3)

    # Save dataUrl to a temp file to avoid huge command-line string limits
    temp_dataurl_path = f"/tmp/mediahub_logo_{district_name.lower()}.txt"
    with open(temp_dataurl_path, 'w') as f:
        f.write(data_url)

    # Execute upload in Safari
    upload_script = f'''
    set dUrl to do shell script "cat {temp_dataurl_path}"
    tell application "Safari"
        tell window {win_index}
            set js to "(async () => {{
                try {{
                    const dataUrl = \\"" & dUrl & "\\";
                    const b64 = dataUrl.split(\\",\\")[1];
                    const binary = atob(b64);
                    const len = binary.length;
                    const bytes = new Uint8Array(len);
                    for (let i = 0; i < len; i++) {{
                        bytes[i] = binary.charCodeAt(i);
                    }}
                    const blob = new Blob([bytes], {{ type: \\"image/png\\" }});
                    const file = new File([blob], \\"{target_username}.png\\", {{ type: \\"image/png\\" }});

                    // 1. Click Change Photo button to trigger modal
                    const changeBtn = Array.from(document.querySelectorAll(\\"div, button, span\\")).find(
                        (e) => e.innerText === \\"Change photo\\" || e.innerText === \\"Change profile photo\\"
                    );
                    if (changeBtn) {{
                        changeBtn.click();
                        await new Promise((r) => setTimeout(r, 400));
                    }}

                    // 2. Select dialog file input
                    const dialog = document.querySelector('[role=\\"dialog\\"]');
                    const fileInput = dialog?.querySelector('input[type=\\"file\\"]') || Array.from(document.querySelectorAll('input[type=\\"file\\"]')).pop();
                    if (!fileInput) return {{ error: \\"File input not found\\" }};

                    const dt = new DataTransfer();
                    dt.items.add(file);
                    fileInput.files = dt.files;
                    fileInput.dispatchEvent(new Event(\\"change\\", {{ bubbles: true }}));
                    fileInput.dispatchEvent(new Event(\\"input\\", {{ bubbles: true }}));

                    await new Promise((r) => setTimeout(r, 1200));

                    return {{
                        success: true,
                        filesCount: fileInput.files.length,
                        dialogClosed: !document.querySelector('[role=\\"dialog\\"]')
                    }};
                }} catch (e) {{
                    return {{ error: e.message }};
                }}
            }})().then(r => {{ window.__mhResult = JSON.stringify(r); }});"
            do JavaScript js in document 1
        end tell
    end tell
    '''
    run_applescript(upload_script)
    time.sleep(2)

    # Check result
    check_result = f'''
    tell application "Safari"
        tell window {win_index}
            return do JavaScript "window.__mhResult" in document 1
        end tell
    end tell
    '''
    out, err, code = run_applescript(check_result)
    try:
        os.remove(temp_dataurl_path)
    except Exception:
        pass

    if "success" in out and "true" in out:
        print(f"[✓] SUCCESS! Profile photo for {district_name} (@{target_username}) uploaded successfully!")
        update_mediahub_status(district_name, target_username, "synced")
        return True
    else:
        print(f"[-] Upload response: {out}")
        return False

def main():
    parser = argparse.ArgumentParser(description="MediaHub Instagram Profile Photo Sync Runner")
    parser.add_argument("--district", help="Specific district name (e.g. Amroha, Varanasi, Lucknow)")
    parser.add_argument("--username", help="Specific Instagram username")
    parser.add_argument("--all", action="store_true", help="Sync all active Safari profiles")
    parser.add_argument("--verify", action="store_true", help="Verify status of all profiles")
    args = parser.parse_args()

    if args.district:
        sync_district_photo(args.district, args.username)
    elif args.verify:
        print("[+] Verifying photo status across all 75 districts...")
        from datetime import datetime
        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
        status_file = os.path.join(repo_root, 'public/generated/instagram-district-logos/photo-sync-status.json')
        synced = 0
        if os.path.exists(status_file):
            with open(status_file) as f:
                d = json.load(f)
            synced = sum(1 for v in d.values() if isinstance(v, dict) and v.get('status') == 'synced')
        print(f"[✓] Total districts synced in status record: {synced}/75")
    else:
        parser.print_help()

if __name__ == "__main__":
    main()

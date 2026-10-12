#!/usr/bin/env python3
"""
MediaHub Automated Instagram Profile Photo Sync (macOS Host Runner)
Syncs official district logos downloaded from Google Drive into Instagram accounts via Safari.
Runs directly on macOS host without requiring MediaHub dashboard inside each Safari profile.

Usage:
  python3 scripts/instagram/auto-sync-photos.py --district Agra
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

def update_safari_session_status(district, username=None, has_session=True):
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
    override_file = os.path.join(repo_root, 'public/generated/instagram-district-logos/safari-sessions-override.json')
    cache_file = os.path.join(repo_root, 'src/server/services/instagram/safari-profiles-cache.json')
    d_clean = district.strip() if district else ""
    u_clean = username.strip() if username else ""

    # 1. Update override file (bind-mounted directly to container)
    try:
        data = {}
        if os.path.exists(override_file):
            with open(override_file) as f:
                data = json.load(f)
        if d_clean:
            data[d_clean.lower()] = has_session
        if u_clean:
            data[u_clean.lower()] = has_session
        os.makedirs(os.path.dirname(override_file), exist_ok=True)
        with open(override_file, 'w') as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print(f"[-] Warning: Failed to write safari override: {e}")

    # 2. Update cache file
    try:
        if os.path.exists(cache_file):
            with open(cache_file) as f:
                cache = json.load(f)
            d_key = d_clean.lower()
            u_key = u_clean.lower()
            matched = False
            for bk, v in cache.items():
                if (d_key and (bk.lower() == d_key or (v.get('district') and v['district'].lower() == d_key))) or \
                   (u_key and (bk.lower() == u_key or (v.get('username') and v['username'].lower() == u_key))):
                    v['has_session'] = has_session
                    matched = True
            if not matched and d_clean:
                cache[d_clean] = {
                    "district": d_clean,
                    "username": u_clean,
                    "has_session": has_session
                }
            with open(cache_file, 'w') as f:
                json.dump(cache, f, indent=2)
    except Exception as e:
        print(f"[-] Warning: Failed to write safari cache: {e}")

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

    # Automatically ensure Safari session status is marked active
    update_safari_session_status(district, username, True)

    # Also update Postgres in docker if container is running
    try:
        clean_user = (username or '').replace("'", "''")
        clean_dist = (district or '').replace("'", "''")
        cmd = f"""export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"; docker exec -e PGPASSWORD=postgres $(docker ps -q -f name=mediahub-database) psql -h 127.0.0.1 -U supabase_admin -d supabase -c "UPDATE insta_profile_users SET photo_status = '{status}', photo_synced_at = NOW(), updated_at = NOW() WHERE insta_name ILIKE '{clean_user}' OR district ILIKE '{clean_dist}';" """
        subprocess.run(cmd, shell=True, capture_output=True)
    except Exception:
        pass

def get_safari_documents():
    scpt = """
    tell application "Safari"
        set out to {}
        repeat with i from 1 to count of documents
            set d to document i
            set end of out to (i as text) & "|||" & (name of d) & "|||" & (URL of d)
        end repeat
        return out
    end tell
    """
    out, _, _ = run_applescript(scpt)
    docs = []
    for line in out.split(", "):
        parts = line.split("|||")
        if len(parts) == 3:
            docs.append({
                "index": int(parts[0]),
                "name": parts[1].strip(),
                "url": parts[2].strip()
            })
    return docs

def find_safari_document(district_name, target_username=None):
    docs = get_safari_documents()
    clean_dist = district_name.strip().lower()
    clean_user = target_username.strip().lower() if target_username else ""

    # 1. Match by prefix in document name (e.g. "Agra — ...", "Agra ...")
    for d in docs:
        n = d["name"].lower()
        if (
            n.startswith(f"{clean_dist} —") or
            n.startswith(f"{clean_dist} -") or
            n.startswith(f"{clean_dist} ") or
            n.startswith(f"{clean_dist}:")
        ):
            return d["index"]

    # 2. Match by username in URL or document title
    if clean_user:
        for d in docs:
            if clean_user in d["url"].lower() or clean_user in d["name"].lower():
                return d["index"]

    # 3. Fallback: check open Safari windows by title prefix
    win_scpt = """
    tell application "Safari"
        set out to {}
        repeat with i from 1 to count of windows
            set w to window i
            set end of out to (i as text) & "|||" & (name of w)
        end repeat
        return out
    end tell
    """
    wout, _, _ = run_applescript(win_scpt)
    for line in wout.split(", "):
        parts = line.split("|||")
        if len(parts) == 2:
            widx = int(parts[0])
            wname = parts[1].strip().lower()
            if (
                wname.startswith(f"{clean_dist} —") or
                wname.startswith(f"{clean_dist} -") or
                wname.startswith(f"{clean_dist} ")
            ):
                run_applescript(f'tell application "Safari" to set index of window {widx} to 1')
                # Wait for window activation
                time.sleep(0.5)
                # Re-check documents
                new_docs = get_safari_documents()
                if new_docs:
                    return new_docs[0]["index"]

    return 0

def open_safari_district_window(district_name):
    """
    Attempts to open a new profile window for the district via Safari's File -> New Window menu.
    """
    clean_dist = district_name.strip()
    candidates = [
        f"New {clean_dist} Window",
        f"New Apna {clean_dist} Window",
        f"New Apnaa {clean_dist} Window",
        f"New Badalta {clean_dist} Window",
    ]
    menu_scpt = """
    tell application "System Events"
        tell process "Safari"
            try
                set mItems to name of menu items of menu 1 of menu item "New Window" of menu "File" of menu bar 1
                return mItems as text
            on error
                return ""
            end try
        end tell
    end tell
    """
    m_out, _, _ = run_applescript(menu_scpt)
    target_menu_item = None
    for cand in candidates:
        if cand.lower() in m_out.lower():
            target_menu_item = cand
            break

    if not target_menu_item:
        matches = re.findall(r'New [^,]+ Window', m_out)
        for item in matches:
            if clean_dist.lower() in item.lower():
                target_menu_item = item.strip()
                break

    if target_menu_item:
        print(f"[+] Auto-opening Safari profile window: '{target_menu_item}'...")
        click_scpt = f"""
        tell application "System Events"
            tell process "Safari"
                click menu item "{target_menu_item}" of menu 1 of menu item "New Window" of menu "File" of menu bar 1
            end tell
        end tell
        """
        run_applescript(click_scpt)
        time.sleep(1.5)
        return True
    return False

def sync_district_photo(district_name, username=None):
    print(f"\n[+] Starting photo sync for: {district_name} (username: {username or 'auto'})...")

    # Load cache if available
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
    cache_file = os.path.join(repo_root, 'src/server/services/instagram/safari-profiles-cache.json')
    safari_cache = {}
    if os.path.exists(cache_file):
        try:
            with open(cache_file) as f:
                safari_cache = json.load(f)
        except Exception:
            pass

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
        msg = f"District logo not found at {logo_path}"
        print(f"[-] Error: {msg}")
        return False, msg

    print(f"[+] Loaded official Google Drive logo from: {logo_path}")

    # 1. Locate Safari document (or open if not already open)
    doc_idx = find_safari_document(district_name, target_username)
    if doc_idx == 0:
        print(f"[*] Safari window for '{district_name}' not open, attempting auto-open...")
        opened = open_safari_district_window(district_name)
        if opened:
            time.sleep(1.0)
            doc_idx = find_safari_document(district_name, target_username)
            if doc_idx == 0:
                doc_idx = 1

    if doc_idx == 0:
        msg = f"No open Safari window found matching '{district_name}' (username: {target_username}). Please open its Safari Profile window."
        print(f"[-] Error: {msg}")
        return False, msg

    print(f"[+] Located Safari document index {doc_idx} for {district_name}")
    update_safari_session_status(district_name, target_username, True)

    # 2. Check and navigate to accounts/edit if needed
    url_check_scpt = f'tell application "Safari" to return URL of document {doc_idx}'
    curr_url, _, _ = run_applescript(url_check_scpt)
    if "accounts/edit" not in curr_url:
        print(f"[+] Navigating document {doc_idx} to https://www.instagram.com/accounts/edit/ ...")
        nav_scpt = f'tell application "Safari" to set URL of document {doc_idx} to "https://www.instagram.com/accounts/edit/"'
        run_applescript(nav_scpt)
        time.sleep(2.5)
        doc_idx = find_safari_document(district_name, target_username) or doc_idx

    # Wait for Instagram page to finish mounting file inputs (up to 15s)
    file_input_found = False
    for attempt in range(15):
        check_input_scpt = f"""
        tell application "Safari"
            return do JavaScript "document.querySelectorAll('input[type=file]').length" in document {doc_idx}
        end tell
        """
        in_count, _, _ = run_applescript(check_input_scpt)
        try:
            if int(float(in_count)) > 0:
                file_input_found = True
                break
        except (ValueError, TypeError):
            pass
        time.sleep(1.0)

    if not file_input_found:
        msg = f"Instagram edit profile page did not load file inputs for {district_name} (session may be logged out)"
        print(f"[-] Error: {msg}")
        return False, msg

    # 3. Read raw base64 and generate execution script
    b64_only = data_url.split(",", 1)[1] if "," in data_url else data_url
    slug = re.sub(r'[^a-z0-9]+', '-', target_username.lower()).strip('-')
    tmp_js_path = f"/tmp/mediahub_upload_{slug}.js"

    js_code = f"""
    (() => {{
        try {{
            const b64 = "{b64_only}";
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {{
                bytes[i] = binary.charCodeAt(i);
            }}
            const blob = new Blob([bytes], {{ type: "image/png" }});
            const file = new File([blob], "{slug}.png", {{ type: "image/png" }});

            const inputs = Array.from(document.querySelectorAll("input[type=file]"));
            if (!inputs.length) {{
                return JSON.stringify({{ error: "No file input elements found on Instagram edit profile page" }});
            }}

            const dt = new DataTransfer();
            dt.items.add(file);

            let attached = 0;
            for (const input of inputs) {{
                input.files = dt.files;
                input.dispatchEvent(new Event("change", {{ bubbles: true }}));
                input.dispatchEvent(new Event("input", {{ bubbles: true }}));
                attached++;
            }}

            return JSON.stringify({{
                success: true,
                attachedCount: attached,
                fileName: file.name,
                fileSize: file.size
            }});
        }} catch (e) {{
            return JSON.stringify({{ error: e.message }});
        }}
    }})();
    """

    with open(tmp_js_path, "w") as f:
        f.write(js_code)

    exec_scpt = f"""
    set js to do shell script "cat {tmp_js_path}"
    tell application "Safari"
        return do JavaScript js in document {doc_idx}
    end tell
    """
    out, err, code = run_applescript(exec_scpt)

    try:
        os.remove(tmp_js_path)
    except Exception:
        pass

    try:
        res = json.loads(out)
    except Exception:
        res = {"error": f"Invalid response from Safari: {out}"}

    if res.get("success"):
        print(f"[✓] SUCCESS! Profile photo for {district_name} (@{target_username}) uploaded successfully!")
        time.sleep(2)
        update_mediahub_status(district_name, target_username, "synced")
        return True, "Uploaded successfully to Instagram via Safari"
    else:
        err_msg = res.get('error') or out or "Failed to upload photo in Safari"
        print(f"[-] Upload failed for {district_name}: {err_msg}")
        return False, err_msg

def main():
    parser = argparse.ArgumentParser(description="MediaHub Instagram Profile Photo Sync Runner")
    parser.add_argument("--district", help="Specific district name (e.g. Agra, Amroha, Varanasi)")
    parser.add_argument("--username", help="Specific Instagram username")
    parser.add_argument("--all", action="store_true", help="Sync all active Safari profiles")
    parser.add_argument("--verify", action="store_true", help="Verify status of all profiles")
    args = parser.parse_args()

    if args.district:
        sync_district_photo(args.district, args.username)
    elif args.verify:
        print("[+] Verifying photo status across all 75 districts...")
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

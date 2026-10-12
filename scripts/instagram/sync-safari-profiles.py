#!/usr/bin/env python3
"""
Sync Safari Profiles and active Instagram sessions from macOS Safari into MediaHub cache.
Reads SafariTabs.db and WebKit WebsiteDataStore binarycookies for all 75 district profiles.
"""
import sqlite3
import os
import glob
import json
import struct

def parse_binary_cookies(cookie_file):
    if not os.path.exists(cookie_file):
        return {}
    try:
        with open(cookie_file, 'rb') as f:
            data = f.read()
        if len(data) < 8 or data[:4] != b'cook':
            return {}
        num_pages = struct.unpack('>I', data[4:8])[0]
        page_sizes = [struct.unpack('>I', data[8+i*4:12+i*4])[0] for i in range(num_pages)]
        pos = 8 + num_pages * 4
        cookies = {}
        for p_size in page_sizes:
            p_data = data[pos:pos+p_size]
            pos += p_size
            if p_data[:4] != b'\x00\x00\x01\x00':
                continue
            num_cookies = struct.unpack('<I', p_data[4:8])[0]
            offsets = [struct.unpack('<I', p_data[8+i*4:12+i*4])[0] for i in range(num_cookies)]
            for off in offsets:
                c_data = p_data[off:]
                url_off, = struct.unpack('<I', c_data[16:20])
                name_off, = struct.unpack('<I', c_data[20:24])
                val_off, = struct.unpack('<I', c_data[28:32])
                def get_str(start):
                    end = c_data.find(b'\x00', start)
                    return c_data[start:end].decode('utf-8', 'ignore')
                domain = get_str(url_off)
                if 'instagram' in domain:
                    name = get_str(name_off)
                    val = get_str(val_off)
                    cookies[name] = val
        return cookies
    except Exception:
        return {}

def main():
    db_path = os.path.expanduser('~/Library/Containers/com.apple.Safari/Data/Library/Safari/SafariTabs.db')
    if not os.path.exists(db_path):
        print(f"SafariTabs.db not found at {db_path}. This script must be run on macOS host.")
        return

    conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
    cur = conn.cursor()
    cur.execute('SELECT title, external_uuid FROM bookmarks WHERE subtype = 2 AND title IS NOT NULL AND length(title) > 0')
    rows = cur.fetchall()
    conn.close()

    safari_base = os.path.expanduser('~/Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteDataStore')

    profiles_map = {}
    for title, uuid in rows:
        store_dir = os.path.join(safari_base, uuid.lower())
        cookie_file = os.path.join(store_dir, 'Cookies', 'Cookies.binarycookies')
        has_store = os.path.exists(store_dir)
        cookies = parse_binary_cookies(cookie_file) if has_store else {}
        has_session = 'sessionid' in cookies
        
        username = None
        profile_pic = None
        ls_files = glob.glob(os.path.join(store_dir, 'Origins/**/LocalStorage/localstorage.sqlite3'), recursive=True)
        for ls in ls_files:
            try:
                ls_conn = sqlite3.connect(f'file:{ls}?mode=ro', uri=True)
                ls_cur = ls_conn.cursor()
                ls_cur.execute("SELECT value FROM ItemTable WHERE key = 'one_tap_storage_version'")
                ls_row = ls_cur.fetchone()
                if ls_row:
                    val = ls_row[0].decode('utf-16le', 'ignore') if isinstance(ls_row[0], bytes) else str(ls_row[0])
                    ot_data = json.loads(val)
                    for uid, info in ot_data.items():
                        if info.get('username'):
                            username = info.get('username')
                            profile_pic = info.get('profilePicUrl')
                ls_conn.close()
            except Exception:
                pass

        profiles_map[title] = {
            'district': title,
            'uuid': uuid,
            'has_store': has_store,
            'has_session': has_session,
            'username': username,
            'profile_pic_url': profile_pic,
            'ds_user_id': cookies.get('ds_user_id')
        }

    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(script_dir, '../..'))
    out_file = os.path.join(repo_root, 'src/server/services/instagram/safari-profiles-cache.json')
    
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(profiles_map, f, indent=2, ensure_ascii=False)

    total = len(profiles_map)
    active = sum(1 for p in profiles_map.values() if p['has_session'])
    print(f"Scanned {total} Safari profiles. Active Instagram sessions: {active}/{total}.")
    print(f"Updated cache at {out_file}")

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
MediaHub Safari Host Bridge Server
Runs locally on macOS host (port 3012) to allow Chrome to trigger Safari automation directly.
"""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import json
import os
import re
import sys
import time
import threading

# Add script directory to sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from auto_sync_photos import sync_district_photo, update_mediahub_status, update_safari_session_status, run_applescript

SYNC_LOCK = threading.Lock()

def scan_open_safari_sessions():
    """
    Scans currently open Safari documents & windows and marks matching districts as active.
    """
    scpt = """
    tell application "Safari"
        set out to {}
        repeat with i from 1 to count of documents
            set d to document i
            set end of out to (name of d) & "|||" & (URL of d)
        end repeat
        return out
    end tell
    """
    out, _, _ = run_applescript(scpt)
    detected = []
    if out:
        for item in out.split(", "):
            parts = item.split("|||")
            if len(parts) >= 2:
                title = parts[0].strip()
                url = parts[1].strip()
                m = re.match(r"^([A-Za-z\s]+?)\s*[-—]", title)
                if m:
                    dist = m.group(1).strip()
                    if dist and dist.lower() not in ["untitled", "favorites", "start page", "start", "empty"]:
                        update_safari_session_status(dist, None, True)
                        detected.append(dist)
    return list(set(detected))

def background_session_scanner():
    while True:
        try:
            scan_open_safari_sessions()
        except Exception:
            pass
        time.sleep(15)

class BridgeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _set_headers(self, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Connection", "close")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_OPTIONS(self):
        self._set_headers(204)

    def do_GET(self):
        if self.path == "/health":
            self._set_headers(200)
            self.wfile.write(json.dumps({"status": "ok", "service": "safari-host-bridge"}).encode())
        elif self.path == "/scan-sessions":
            detected = scan_open_safari_sessions()
            self._set_headers(200)
            self.wfile.write(json.dumps({"status": "ok", "detected": detected}).encode())
        else:
            self._set_headers(404)
            self.wfile.write(json.dumps({"error": "Not found"}).encode())

    def do_POST(self):
        content_len = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_len) if content_len > 0 else b"{}"
        try:
            data = json.loads(body.decode("utf-8"))
        except Exception:
            data = {}

        if self.path == "/sync-photo":
            district = data.get("district")
            username = data.get("username")
            if not district and not username:
                self._set_headers(400)
                self.wfile.write(json.dumps({"error": "district or username required"}).encode())
                return

            print(f"[Bridge] Queued sync request for district={district}, username={username}")
            with SYNC_LOCK:
                print(f"[Bridge] Executing sync for district={district}, username={username}...")
                res = sync_district_photo(district, username)
                if isinstance(res, tuple):
                    ok, msg = res
                else:
                    ok = bool(res)
                    msg = "Uploaded successfully to Instagram via Safari" if ok else "Failed to upload"
                
                # Whenever a sync runs on a district/user, ensure session is active in MediaHub
                if ok:
                    update_safari_session_status(district, username, True)

            try:
                self._set_headers(200)
                self.wfile.write(json.dumps({
                    "success": ok,
                    "district": district,
                    "username": username,
                    "message": msg
                }).encode())
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass

        elif self.path == "/scan-sessions":
            detected = scan_open_safari_sessions()
            self._set_headers(200)
            self.wfile.write(json.dumps({"status": "ok", "detected": detected}).encode())

        else:
            self._set_headers(404)
            self.wfile.write(json.dumps({"error": "Not found"}).encode())

    def log_message(self, format, *args):
        # Clean logging
        sys.stderr.write(f"[SafariBridge] {format % args}\n")

def run(port=3012):
    # Scan open Safari sessions immediately on launch
    try:
        detected = scan_open_safari_sessions()
        print(f"[+] Initial scan detected active Safari sessions: {detected}")
    except Exception as e:
        print(f"[-] Initial session scan warning: {e}")

    # Start background auto-scanner
    scanner_thread = threading.Thread(target=background_session_scanner, daemon=True)
    scanner_thread.start()

    server_address = ('', port)
    httpd = ThreadingHTTPServer(server_address, BridgeHandler)
    httpd.daemon_threads = True
    print(f"[+] Safari Host Bridge Server running on http://localhost:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3012
    run(port)

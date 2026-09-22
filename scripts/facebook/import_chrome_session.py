"""Import one explicitly selected Chrome account's Facebook session locally.

Reads only Facebook authentication cookies, validates in isolated Selenium
Chrome, then uses MediaHub's existing authenticated/encrypted session endpoints.
Never dump exceptions, browser HTML, cookies, or driver logs: they contain secrets.
"""

import argparse
import contextlib
import fcntl
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import time
from urllib.parse import urlparse

ORIGIN = "http://localhost:3010"
CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
CHROME_ROOT = Path.home() / "Library/Application Support/Google/Chrome"
COOKIE_NAMES = ("c_user", "xs", "datr", "sb", "fr")
COOKIE_HOSTS = (".facebook.com", "facebook.com", "www.facebook.com")


class ImportFailure(Exception):
    """Only fixed, secret-free messages may be exposed to the CLI."""


def chrome_profile(root: Path, account: str) -> Path:
    state = json.loads((root / "Local State").read_text())
    matches = [root / name for name, info in state.get("profile", {}).get("info_cache", {}).items()
               if info.get("user_name", "").casefold() == account.casefold()]
    if len(matches) != 1:
        raise ImportFailure("Chrome account is missing or ambiguous; specify its exact signed-in email.")
    profile = matches[0].resolve()
    if profile.parent != root.resolve() or not profile.is_dir():
        raise ImportFailure("Chrome profile is not a valid local profile directory.")
    return profile


def cookie_bundle(cookies: list[dict]) -> str:
    values = {}
    now = time.time()
    for cookie in cookies:
        if cookie.get("domain") not in COOKIE_HOSTS or cookie.get("path", "/") != "/":
            continue
        name, value = cookie.get("name"), cookie.get("value", "")
        if name not in COOKIE_NAMES or not value or (cookie.get("expiry") and cookie["expiry"] <= now):
            continue
        if re.search(r"[\x00-\x20\x7f;]", value):
            raise ImportFailure("Facebook cookie format is invalid; sign in again in the selected Chrome profile.")
        if name in values and values[name] != value:
            raise ImportFailure("Facebook has conflicting login cookies; refresh its page in the selected profile.")
        values[name] = value
    if not re.fullmatch(r"[0-9]+", values.get("c_user", "")) or not values.get("xs"):
        raise ImportFailure("Selected Chrome profile has no usable Facebook login. Sign in there first.")
    return "; ".join(f"{name}={values[name]}" for name in COOKIE_NAMES if name in values)


def read_facebook_cookies(profile: Path) -> list[dict]:
    import browser_cookie3

    cookie_file = next((p for p in [profile / "Network/Cookies", profile / "Cookies"] if p.is_file()), None)
    if cookie_file is None:
        raise ImportFailure("Selected Chrome profile has no cookie database.")
    try:
        # A domain/name-scoped snapshot avoids copying the user's entire database.
        # Chrome stays open. Plaintext values, if any, are kept only in memory.
        with contextlib.closing(sqlite3.connect(cookie_file.as_uri() + "?mode=ro", uri=True, timeout=5)) as source:
            rows = source.execute(
                "SELECT host_key,path,is_secure,expires_utc,name,value,encrypted_value,is_httponly "
                "FROM cookies WHERE host_key IN (?,?,?) AND name IN (?,?,?,?,?) AND path='/'",
                (*COOKIE_HOSTS, *COOKIE_NAMES),
            ).fetchall()
            version = source.execute("SELECT value FROM meta WHERE key='version'").fetchone()
        if not rows:
            raise ImportFailure("No Facebook login cookies found in the selected Chrome profile.")
        plain = []
        with tempfile.TemporaryDirectory(prefix="mediahub-fb-cookies-") as temporary:
            scoped_file = Path(temporary) / "Cookies"
            with contextlib.closing(sqlite3.connect(scoped_file)) as scoped:
                scoped.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
                scoped.execute("INSERT INTO meta VALUES ('version',?)", (version[0] if version else "0",))
                scoped.execute("CREATE TABLE cookies (host_key TEXT,path TEXT,is_secure INTEGER,expires_utc INTEGER,"
                               "name TEXT,value TEXT,encrypted_value BLOB,is_httponly INTEGER)")
                for host, path, secure, expires, name, value, encrypted, http_only in rows:
                    if value:
                        plain.append({"domain": host, "path": path, "secure": bool(secure), "name": name,
                                      "value": value, "httpOnly": bool(http_only),
                                      **({"expiry": int(expires / 1_000_000 - 11644473600)} if expires else {})})
                    else:
                        scoped.execute("INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?)",
                                       (host, path, secure, expires, name, "", encrypted, http_only))
                scoped.commit()
            jar = browser_cookie3.chrome(cookie_file=str(scoped_file), domain_name="facebook.com")
            cookies = plain + [{"domain": c.domain, "path": c.path, "secure": bool(c.secure), "name": c.name,
                                "value": c.value, "httpOnly": c.has_nonstandard_attr("HTTPOnly"),
                                **({"expiry": int(c.expires)} if c.expires else {})} for c in jar]
        cookie_bundle(cookies)
        return cookies
    except ImportFailure:
        raise
    except Exception:
        raise ImportFailure("Could not read Facebook cookies. Allow macOS Chrome Safe Storage access if prompted; "
                            "otherwise use MediaHub Settings to paste the session.") from None


def validate_in_chrome(cookies: list[dict]) -> str:
    from selenium import webdriver
    from selenium.webdriver.chrome.service import Service
    from selenium.webdriver.support.ui import WebDriverWait

    expected = re.search(r"c_user=([0-9]+)", cookie_bundle(cookies)).group(1)
    if not CHROME.is_file():
        raise ImportFailure("Google Chrome is not installed in Applications.")
    driver = None
    stage = "starting Chrome"
    os.environ.setdefault("SE_AVOID_STATS", "true")
    os.environ.setdefault("SE_TIMEOUT", "45")
    try:
        with tempfile.TemporaryDirectory(prefix="mediahub-fb-verify-") as temporary:
            options = webdriver.ChromeOptions()
            options.binary_location = str(CHROME)
            options.add_argument(f"--user-data-dir={temporary}")
            options.add_argument("--no-first-run")
            options.add_argument("--no-default-browser-check")
            options.add_argument("--disable-background-networking")
            options.add_argument("--incognito")
            options.page_load_strategy = "eager"
            try:
                driver = webdriver.Chrome(options=options, service=Service(log_output=os.devnull))
                driver.set_page_load_timeout(25)
                stage = "opening Facebook"
                driver.get("https://www.facebook.com/robots.txt")
                stage = "loading the Facebook session"
                for cookie in cookies:
                    if cookie.get("expiry") and cookie["expiry"] <= time.time():
                        continue
                    driver.add_cookie(cookie)
                stage = "checking the Facebook login"
                driver.get("https://www.facebook.com/")

                def logged_in(browser):
                    path = urlparse(browser.current_url).path.lower()
                    if any(part in path for part in ("/login", "/checkpoint", "/two_step_verification")):
                        raise ImportFailure("Facebook requires login or verification in Chrome; no saved session was changed.")
                    # Authentication evidence must identify this account, not just an existing cookie.
                    return browser.execute_script("""
                      const id = arguments[0];
                      const pattern = new RegExp('"(?:USER_ID|ACCOUNT_ID)"\\\\s*:\\\\s*"' + id + '"');
                      return Array.from(document.scripts).some(s => pattern.test(s.textContent || ''));
                    """, expected)

                WebDriverWait(driver, 20, poll_frequency=0.5).until(logged_in)
                refreshed = cookie_bundle(driver.get_cookies())
                if re.search(r"c_user=([0-9]+)", refreshed).group(1) != expected:
                    raise ImportFailure("Facebook changed account during validation; no saved session was changed.")
                return refreshed
            finally:
                if driver:
                    with contextlib.suppress(Exception):
                        driver.quit()
    except ImportFailure:
        raise
    except Exception as error:
        # Exception messages may include cookies/page contents. Only the class and fixed stage are safe.
        raise ImportFailure(f"Selenium failed while {stage} ({type(error).__name__}). "
                            "No saved session was changed.") from None


class MediaHub:
    def __init__(self):
        import requests
        self.http = requests.Session()
        self.http.trust_env = False  # Never send local auth/session data through an environment proxy.

    def sign_in_local_demo(self):
        response = self.http.get(ORIGIN + "/api/studio-enter?next=/settings", timeout=15, allow_redirects=False)
        if response.status_code != 303 or response.headers.get("Location") != "/settings":
            raise ImportFailure("Local MediaHub studio sign-in failed; check the app on port 3010.")

    def rpc(self, method: str, data=None, *, write=False):
        url = ORIGIN + "/api/trpc/fbSession." + method
        envelope = {"json": data}
        response = (self.http.post(url, json=envelope, timeout=25, allow_redirects=False) if write else
                    self.http.get(url, params={"input": json.dumps(envelope)}, timeout=15, allow_redirects=False))
        if response.status_code != 200:
            raise ImportFailure("MediaHub rejected the session request. Check app authentication, then retry.")
        payload = response.json()
        if "error" in payload:
            raise ImportFailure("MediaHub could not save the Facebook session; retry from Settings.")
        return payload["result"]["data"]["json"]

    def save(self, bundle: str):
        user = re.search(r"c_user=([0-9]+)", bundle).group(1)
        sessions = self.rpc("listFbSessions")
        matching = next((s for s in sessions if s["c_user"] == user), None)
        # Keep unrelated accounts untouched. The existing app chooses the newest active row.
        newest_active = next((s for s in sessions if s["status"] == "active"), None)
        if matching and newest_active and newest_active["c_user"] != user and newest_active["created_at"] > matching["created_at"]:
            raise ImportFailure("A newer, different Facebook account is active in MediaHub. Select the intended account in Settings first.")
        if matching:
            self.rpc("refreshFbSession", {"id": matching["id"], "cookies": bundle}, write=True)
            saved_id = matching["id"]
        else:
            saved = self.rpc("saveFbSession", {"cookies": bundle, "label": "Chrome Facebook session"}, write=True)
            saved_id = saved["id"]
        # Readback verifies the protected write without another Facebook scrape or secret read.
        after = self.rpc("listFbSessions")
        saved = next((s for s in after if s["id"] == saved_id and s["c_user"] == user and s["status"] == "active"), None)
        if not saved:
            raise ImportFailure("MediaHub save could not be confirmed. Check Settings before retrying.")
        return "refreshed" if matching else "created"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chrome-account", required=True, help="Exact signed-in Chrome profile email")
    parser.add_argument("--local-demo", action="store_true", required=True,
                        help="Use this project's existing local studio sign-in on localhost:3010")
    args = parser.parse_args()
    os.umask(0o077)
    logging.disable(logging.CRITICAL)
    try:
        if sys.platform != "darwin":
            raise ImportFailure("This helper supports local macOS Google Chrome only.")
        cache = Path.home() / ".cache/mediahub"
        cache.mkdir(parents=True, exist_ok=True)
        with (cache / "facebook-session-import.lock").open("w") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ImportFailure("Another Facebook session import is already running.") from None
            profile = chrome_profile(CHROME_ROOT, args.chrome_account)
            hub = MediaHub()
            hub.sign_in_local_demo()
            hub.rpc("listFbSessions")
            print("Selected Chrome profile found; reading Facebook login only.", flush=True)
            cookies = read_facebook_cookies(profile)
            print("Facebook cookies loaded. Verifying login in a temporary Selenium Chrome window.", flush=True)
            bundle = validate_in_chrome(cookies)
            print("Facebook login verified. Saving the session to local MediaHub.", flush=True)
            result = hub.save(bundle)
            print(f"Facebook session {result} and confirmed active in MediaHub on port 3010.", flush=True)
    except ImportFailure as error:
        print(str(error), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Import cancelled.", file=sys.stderr)
        return 130
    except Exception:
        print("Import failed; check local MediaHub and Chrome access. No credentials were logged.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

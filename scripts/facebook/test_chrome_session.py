"""Focused offline checks; no Chrome, Facebook, database, or Google Sheet calls."""
import json
from pathlib import Path
import tempfile
import time
import unittest
from import_chrome_session import ImportFailure, MediaHub, chrome_profile, cookie_bundle


def cookie(name, value, **extra):
    return {"domain": ".facebook.com", "path": "/", "name": name, "value": value, **extra}


def row(identity="123", **extra):
    return {"id": "existing-row", "c_user": identity, "status": "dead", "created_at": "2026-01-01", **extra}


class FakeHub(MediaHub):
    def __init__(self, sessions):
        self.sessions = sessions
        self.writes = []

    def rpc(self, method, data=None, *, write=False):
        if method == "listFbSessions":
            return self.sessions
        self.writes.append((method, data))
        if method == "refreshFbSession":
            next(s for s in self.sessions if s["id"] == data["id"])["status"] = "active"
            return {"ok": True}
        created = row(status="active")
        self.sessions.append(created)
        return created


class ChromeSessionTest(unittest.TestCase):
    def test_exact_profile_and_no_fallback_to_other_accounts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "Default").mkdir()
            state = {"profile": {"info_cache": {"Default": {"user_name": "example@example.test"}}}}
            (root / "Local State").write_text(json.dumps(state))
            self.assertEqual(chrome_profile(root, "EXAMPLE@example.test"), (root / "Default").resolve())
            with self.assertRaises(ImportFailure):
                chrome_profile(root, "different@example.test")
            state["profile"]["info_cache"]["Profile 1"] = {"user_name": "example@example.test"}
            (root / "Local State").write_text(json.dumps(state))
            with self.assertRaises(ImportFailure):
                chrome_profile(root, "example@example.test")

    def test_only_facebook_auth_cookies_are_serialized(self):
        cookies = [cookie("c_user", "123"), cookie("xs", "synthetic"),
                   cookie("c_user", "999", domain="evilfacebook.com"), cookie("unrelated", "not-exported"),
                   cookie("fr", "old", expiry=time.time() - 1)]
        self.assertEqual(cookie_bundle(cookies), "c_user=123; xs=synthetic")

    def test_expired_or_missing_login_is_rejected(self):
        for cookies in [[cookie("c_user", "123")], [cookie("c_user", "123"), cookie("xs", "old", expiry=1)]]:
            with self.assertRaises(ImportFailure):
                cookie_bundle(cookies)

    def test_conflicting_sessions_and_header_injection_are_rejected(self):
        for extra in [cookie("xs", "different"), cookie("xs", "value;injected=true")]:
            with self.assertRaises(ImportFailure):
                cookie_bundle([cookie("c_user", "123"), cookie("xs", "synthetic"), extra])

    def test_refresh_same_account_in_place_on_repeated_runs(self):
        hub = FakeHub([row()])
        for _ in range(2):
            self.assertEqual(hub.save("c_user=123; xs=synthetic"), "refreshed")
        self.assertEqual(len(hub.sessions), 1)
        self.assertTrue(all(method == "refreshFbSession" for method, _ in hub.writes))

    def test_new_account_created_once(self):
        hub = FakeHub([])
        self.assertEqual(hub.save("c_user=123; xs=synthetic"), "created")
        self.assertEqual(hub.save("c_user=123; xs=synthetic"), "refreshed")
        self.assertEqual(len(hub.sessions), 1)

    def test_different_newer_active_account_is_not_overwritten(self):
        hub = FakeHub([row("999", id="other-row", status="active", created_at="2026-02-01"), row()])
        with self.assertRaises(ImportFailure):
            hub.save("c_user=123; xs=synthetic")
        self.assertEqual(hub.writes, [])


if __name__ == "__main__":
    unittest.main()

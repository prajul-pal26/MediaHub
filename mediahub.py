#!/usr/bin/env python3
"""
mediahub.py — standalone Instagram hashtag / post / comment fetcher.

Self-contained and dependency-free (Python 3.8+, standard library only).
Copy this single file anywhere and it works; nothing here imports from the
MediaHub project.

    from mediahub import MediaHub

    hub = MediaHub(session_id="YOUR_SESSIONID_COOKIE")
    items = hub.fetch_hashtag("schoolthikkaro")     # every post AND reel
    print(items[0]["location"]["name"], items[0]["caption"])

No filtering is applied anywhere: posts and reels are always returned together,
in the order Instagram serves them. Sort or filter downstream if you want to.

--------------------------------------------------------------------------
ENDPOINT NOTES (hard-won; change these carefully)
--------------------------------------------------------------------------
1. The comments endpoint only returns JSON when the request carries an
   Instagram ANDROID app User-Agent. With a desktop browser UA the very same
   URL returns HTTP 200 with the web app's HTML shell instead — a silent
   failure that looks like "no comments". Everything else wants the DESKTOP UA.

2. Comment pagination cursor `next_min_id` is an OBJECT, not a string:
       {"cached_comments_cursor": "...", "bifilter_token": "..."}
   It must be JSON-encoded and sent back as `min_id`.

3. Keep paging while `has_more_comments` OR `has_more_headload_comments` is
   true. Instagram routinely sets the first to false while the second is true,
   so testing only the first stops after one page.

4. Media endpoints key off a numeric media_id, not the shortcode in the URL.
   The shortcode is that id base64-encoded over a URL-safe alphabet, so it can
   be decoded locally without an extra request (see shortcode_to_media_id).

5. Instagram's reported comment_count includes replies. Fetching only
   top-level comments will always undershoot it; set with_replies=True to
   reconcile. Some residual gap always remains — deleted, hidden and
   spam-filtered comments are counted but never served.

--------------------------------------------------------------------------
Scraping Instagram is against its Terms of Service and can get an account
restricted. Use a throwaway account's session, not a personal one.
--------------------------------------------------------------------------
"""

from __future__ import annotations

import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

__all__ = ["fetch", "fetch_to_file", "MediaHub", "Config", "SESSION_ID",
           "InstagramError", "AuthError", "RateLimitError"]

# ===========================================================================
#  CONFIG — set this once, then never touch the rest of the file.
# ===========================================================================
#
#  Paste your Instagram `sessionid` cookie between the quotes below.
#
#  How to get it: log into Instagram in a browser (USE A THROWAWAY ACCOUNT),
#  press F12 -> Application -> Cookies -> https://www.instagram.com, then copy
#  the `sessionid` value.
#
#  Either format works:
#      SESSION_ID = "12345678%3AAbCdEf...%3A24%3AAY..."               # just the value
#      SESSION_ID = "sessionid=12345...; csrftoken=abc; ds_user_id=1" # whole cookie string
#
#  The full cookie string is better — it carries csrftoken, which makes the
#  requests look like a real browser. A bare sessionid still works.
#
#  This cookie IS a full login to that account. Don't commit it to git.
#
SESSION_ID = "64691889273%3AAH6gBCijutFvJZ%3A7%3AAYjVlkNXO8P9fVX3lVQzCZpeoanA6_xYOlCTdAJbLg"

#  How many posts a single fetch() returns, and how many comments per post.
DEFAULT_POST_LIMIT = 50
DEFAULT_COMMENTS_PER_POST = 500
# ===========================================================================


IG_APP_ID = "936619743392459"

DESKTOP_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
# Load-bearing for the comments endpoint only — see note 1 in the module docstring.
ANDROID_UA = (
    "Instagram 269.0.0.18.75 Android (26/8.0.0; 480dpi; 1080x1920; "
    "Xiaomi; MI 5s; capricorn; qcom; en_US)"
)

SHORTCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
HASHTAG_RE = re.compile(r"#[\wऀ-ॿ]+", re.UNICODE)


class InstagramError(RuntimeError):
    """Any failure talking to Instagram."""


class AuthError(InstagramError):
    """The session is missing, expired, or checkpointed."""


class RateLimitError(InstagramError):
    """Instagram asked us to slow down."""


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
@dataclass
class Config:
    """
    Everything tunable in one place.

    session_id is the only required value. Paste either a bare `sessionid`
    cookie value or a full `k=v; k=v` cookie string copied from the browser —
    both are accepted. A full string is preferred: it usually carries
    `csrftoken` and `ds_user_id`, and sending all three looks far more like a
    real browser than a lone sessionid.

    Get it from: log into Instagram -> F12 -> Application -> Cookies ->
    instagram.com -> copy `sessionid` (or the whole cookie string).
    """

    session_id: str = ""

    # Pacing. Instagram tolerates roughly this; raise if you start seeing 429s.
    request_delay: float = 1.0          # between ordinary requests
    comment_page_delay: float = 0.4     # between comment pages
    timeout: int = 25                   # per-request socket timeout, seconds

    # Retry/backoff for rate limits.
    max_retries: int = 4
    backoff_factor: float = 3.0
    max_backoff: float = 60.0

    # Optional http(s) proxy, e.g. "http://user:pass@host:port".
    # Use a RESIDENTIAL proxy if any: datacenter IPs are blocked outright.
    proxy: Optional[str] = None

    # Set False only if your environment has a broken CA bundle.
    verify_ssl: bool = True

    def validate(self) -> None:
        if not self.session_id or not self.session_id.strip():
            raise AuthError(
                "No session_id configured. Set Config.session_id to your Instagram "
                "`sessionid` cookie (or a full cookie string)."
            )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def shortcode_to_media_id(shortcode: str) -> str:
    """'DcC-6etJ6zD' -> '3964007319622626499'. Pure local decode, no request."""
    value = 0
    for ch in shortcode:
        idx = SHORTCODE_ALPHABET.find(ch)
        if idx < 0:
            raise ValueError(f"Unexpected character {ch!r} in shortcode {shortcode!r}")
        value = value * 64 + idx
    return str(value)


def shortcode_from_url(url_or_code: str) -> str:
    """Accept a full post/reel URL or a bare shortcode."""
    m = re.search(r"instagram\.com/(?:reel|reels|p|tv)/([A-Za-z0-9_-]+)", url_or_code)
    return m.group(1) if m else url_or_code.strip().strip("/")


def _iso(ts: Any) -> Optional[str]:
    """Unix seconds -> ISO 8601 UTC."""
    try:
        n = int(ts)
    except (TypeError, ValueError):
        return None
    if n <= 0:
        return None
    return datetime.fromtimestamp(n, tz=timezone.utc).isoformat()


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _num(value: Any) -> Optional[float]:
    return value if isinstance(value, (int, float)) else None


# ---------------------------------------------------------------------------
# MediaHub
# ---------------------------------------------------------------------------
class MediaHub:
    """
    Instagram reader.

        hub = MediaHub(session_id="...")
        hub.fetch_hashtag("lucknow")        -> List[dict]  (posts AND reels)
        hub.fetch_post(url)                 -> dict
        hub.fetch_comments(url)             -> List[dict]
        hub.fetch_hashtag_with_comments(t)  -> List[dict]  (comments embedded)
        hub.fetch_profile("username")       -> dict
    """

    def __init__(self, session_id: str = "", config: Optional[Config] = None, **kwargs: Any):
        # Either pass a Config, or just the session id plus overrides.
        # With neither, fall back to the SESSION_ID set at the top of this file.
        self.config = config or Config(session_id=session_id or SESSION_ID, **kwargs)
        if session_id and not self.config.session_id:
            self.config.session_id = session_id
        if not self.config.session_id:
            self.config.session_id = SESSION_ID
        self.config.validate()

        self.cookie, self.csrftoken = self._normalize_session(self.config.session_id)
        self._opener = self._build_opener()

    # -- session / transport ------------------------------------------------
    @staticmethod
    def _normalize_session(raw: str) -> "tuple[str, Optional[str]]":
        """
        Accept a bare sessionid or a full cookie string; return (cookie, csrftoken).

        Instagram encodes the user id in the sessionid's first segment, so
        ds_user_id can be backfilled when only the bare value is supplied.
        Sending sessionid alone is a strong bot signal.
        """
        s = raw.strip()
        looks_like_cookie_string = "=" in s and (";" in s or s.startswith("sessionid="))

        if looks_like_cookie_string:
            cookie = re.sub(r"\s*;\s*", "; ", s).strip()
            csrf_m = re.search(r"csrftoken=([^;]+)", cookie)
            if "ds_user_id=" not in cookie:
                sess_m = re.search(r"sessionid=([^;]+)", cookie)
                if sess_m:
                    uid = urllib.parse.unquote(sess_m.group(1)).split("%3A")[0].split(":")[0]
                    if uid.isdigit():
                        cookie += f"; ds_user_id={uid}"
            return cookie, (csrf_m.group(1) if csrf_m else None)

        cookie = f"sessionid={s}"
        uid = urllib.parse.unquote(s).split("%3A")[0].split(":")[0]
        if uid.isdigit():
            cookie += f"; ds_user_id={uid}"
        return cookie, None

    def _build_opener(self) -> urllib.request.OpenerDirector:
        handlers: List[urllib.request.BaseHandler] = []
        if self.config.proxy:
            handlers.append(urllib.request.ProxyHandler(
                {"http": self.config.proxy, "https": self.config.proxy}
            ))
        if not self.config.verify_ssl:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            handlers.append(urllib.request.HTTPSHandler(context=ctx))
        return urllib.request.build_opener(*handlers)

    def _headers(self, android: bool = False) -> Dict[str, str]:
        headers = {
            "User-Agent": ANDROID_UA if android else DESKTOP_UA,
            "X-IG-App-ID": IG_APP_ID,
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.instagram.com/",
            "Cookie": self.cookie,
        }
        if self.csrftoken:
            headers["X-CSRFToken"] = self.csrftoken
        if not android:
            headers["X-Requested-With"] = "XMLHttpRequest"
        return headers

    def _get_json(self, url: str, android: bool = False) -> Dict[str, Any]:
        """GET with retry/backoff. Raises AuthError / RateLimitError as apt."""
        backoff = self.config.comment_page_delay or 1.0
        last_error: Optional[str] = None

        for attempt in range(self.config.max_retries):
            req = urllib.request.Request(url, headers=self._headers(android=android))
            try:
                with self._opener.open(req, timeout=self.config.timeout) as resp:
                    body = resp.read().decode("utf-8", errors="replace")
                    status = resp.status
            except urllib.error.HTTPError as e:
                status = e.code
                body = e.read().decode("utf-8", errors="replace")
            except urllib.error.URLError as e:
                last_error = f"network error: {e.reason}"
                time.sleep(min(backoff, self.config.max_backoff))
                backoff *= self.config.backoff_factor
                continue

            if status in (401, 403):
                raise AuthError(f"Instagram rejected the session (HTTP {status}).")
            if status == 429:
                time.sleep(min(backoff, self.config.max_backoff))
                backoff *= self.config.backoff_factor
                last_error = "rate limited (429)"
                continue

            # The desktop-UA-on-comments failure mode: HTML instead of JSON.
            if body.lstrip().startswith("<"):
                raise InstagramError(
                    "Instagram returned HTML instead of JSON. For the comments "
                    "endpoint this means the Android User-Agent was not sent."
                )

            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                last_error = f"malformed JSON (HTTP {status})"
                time.sleep(min(backoff, self.config.max_backoff))
                backoff *= self.config.backoff_factor
                continue

            message = str(data.get("message", "")).lower()
            if data.get("require_login") or message == "login_required":
                raise AuthError("Instagram requires login — the session is dead.")
            if "wait" in message or "try again" in message:
                time.sleep(min(backoff, self.config.max_backoff))
                backoff *= self.config.backoff_factor
                last_error = f"throttled: {message}"
                continue
            return data

        raise RateLimitError(last_error or "request failed after retries")

    # -- mapping ------------------------------------------------------------
    @staticmethod
    def _map_location(raw: Any) -> Optional[Dict[str, Any]]:
        """Geotag, when the poster attached one. Only a minority of posts do."""
        if not isinstance(raw, dict) or not raw.get("name"):
            return None
        lat, lng = _num(raw.get("lat")), _num(raw.get("lng"))
        maps_url = (
            f"https://www.google.com/maps/search/?api=1&query={lat},{lng}"
            if lat is not None and lng is not None else None
        )
        return {
            "id": str(raw["pk"]) if raw.get("pk") is not None else None,
            "name": raw.get("name"),
            "short_name": raw.get("short_name"),
            "address": raw.get("address") or None,
            "city": raw.get("city") or None,
            "lat": lat,
            "lng": lng,
            "facebook_places_id": (
                str(raw["facebook_places_id"]) if raw.get("facebook_places_id") is not None else None
            ),
            "google_maps_url": maps_url,
        }

    @staticmethod
    def _best_image(node: Dict[str, Any]) -> Optional[str]:
        candidates = (node.get("image_versions2") or {}).get("candidates") or []
        return candidates[0].get("url") if candidates else None

    @staticmethod
    def _best_video(node: Dict[str, Any]) -> Optional[str]:
        versions = node.get("video_versions") or []
        return versions[0].get("url") if versions else None

    def _map_media(self, node: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Raw media node -> flat dict. Posts and reels alike; nothing filtered."""
        media_id = str(node.get("pk") or node.get("id") or "")
        if not media_id:
            return None

        media_type = node.get("media_type")
        is_reel = node.get("product_type") == "clips"
        kind = (
            "carousel" if media_type == 8
            else "reel" if is_reel
            else "video" if media_type == 2
            else "post"
        )

        code = node.get("code") or ""
        caption = ((node.get("caption") or {}) or {}).get("text") or ""
        user = node.get("user") or node.get("owner") or {}

        carousel = [
            {
                "display_url": self._best_image(child),
                "video_url": self._best_video(child),
                "is_video": child.get("media_type") == 2,
            }
            for child in (node.get("carousel_media") or [])
        ]

        views = (
            node.get("play_count")
            if isinstance(node.get("play_count"), int)
            else node.get("view_count")
            if isinstance(node.get("view_count"), int)
            else node.get("ig_play_count")
            if isinstance(node.get("ig_play_count"), int)
            else None
        )

        return {
            "id": media_id,
            "shortcode": code,
            "url": f"https://www.instagram.com/{'reel' if is_reel else 'p'}/{code}/" if code else None,
            "kind": kind,
            "is_video": media_type == 2 or is_reel,

            # Media
            "display_url": self._best_image(node) or (carousel[0]["display_url"] if carousel else None),
            "thumbnail_url": self._best_image(node),
            "video_url": self._best_video(node),
            "carousel": carousel,
            "carousel_count": len(carousel),

            # Engagement
            "likes": _int(node.get("like_count")),
            "comments": _int(node.get("comment_count")),
            "views": views,

            # Content
            "caption": caption,
            "hashtags": HASHTAG_RE.findall(caption),
            "taken_at": node.get("taken_at"),
            "taken_at_iso": _iso(node.get("taken_at")),

            # Author
            "owner_username": user.get("username"),
            "owner_full_name": user.get("full_name"),
            "owner_id": str(user["pk"]) if user.get("pk") is not None else None,
            "owner_is_verified": bool(user.get("is_verified")),
            "owner_profile_pic": user.get("profile_pic_url"),

            # Geotag
            "location": self._map_location(node.get("location")),
        }

    @staticmethod
    def _map_comment(raw: Dict[str, Any], depth: int = 0, parent_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        cid = str(raw.get("pk") or raw.get("id") or "")
        if not cid:
            return None
        user = raw.get("user") or {}
        created = raw.get("created_at") or raw.get("created_at_utc")
        return {
            "id": cid,
            "text": raw.get("text") or "",
            "created_at": created,
            "created_at_iso": _iso(created),
            "likes": _int(raw.get("comment_like_count") or raw.get("like_count")),
            "depth": depth,
            "parent_id": parent_id,
            "reply_count": _int(raw.get("child_comment_count")),
            "username": user.get("username"),
            "full_name": user.get("full_name"),
            "user_id": str(user["pk"]) if user.get("pk") is not None else None,
            "is_verified": bool(user.get("is_verified")),
            "profile_url": f"https://www.instagram.com/{user['username']}/" if user.get("username") else None,
            "replies": [],
        }

    # -- public API ---------------------------------------------------------
    def fetch_hashtag(self, tag: str, limit: int = 50) -> List[Dict[str, Any]]:
        """
        Every post AND reel Instagram returns for a hashtag.

        No sorting, no type filter — the caller decides what to do with them.
        `limit` only caps the list length; it is not a filter.
        """
        clean = tag.strip().lstrip("#").lower()
        if not clean:
            raise ValueError("empty hashtag")

        url = (
            "https://www.instagram.com/api/v1/tags/web_info/?tag_name="
            + urllib.parse.quote(clean)
        )
        data = self._get_json(url)

        # Instagram splits results across 'top' and 'recent' sections; both are
        # collected so nothing is silently dropped.
        nodes: List[Dict[str, Any]] = []
        for bucket in ("top", "recent"):
            for section in ((data.get("data") or {}).get(bucket) or {}).get("sections") or []:
                for entry in ((section.get("layout_content") or {}).get("medias") or []):
                    media = entry.get("media")
                    if media:
                        nodes.append(media)

        out: List[Dict[str, Any]] = []
        seen = set()
        for node in nodes:
            item = self._map_media(node)
            if not item or item["id"] in seen:
                continue
            seen.add(item["id"])
            item["source_hashtag"] = clean
            out.append(item)
            if len(out) >= limit:
                break
        return out

    def fetch_post(self, url_or_shortcode: str) -> Dict[str, Any]:
        """Full detail for a single post or reel."""
        shortcode = shortcode_from_url(url_or_shortcode)
        media_id = shortcode_to_media_id(shortcode)
        data = self._get_json(f"https://www.instagram.com/api/v1/media/{media_id}/info/", android=True)
        items = data.get("items") or []
        if not items:
            raise InstagramError(f"No media returned for {shortcode}")
        mapped = self._map_media(items[0])
        if not mapped:
            raise InstagramError(f"Could not parse media {shortcode}")
        return mapped

    def fetch_comments(
        self,
        url_or_shortcode: str,
        max_comments: int = 1000,
        with_replies: bool = True,
    ) -> List[Dict[str, Any]]:
        """
        All reachable comments, replies threaded under their parents.

        Instagram's comment_count includes replies, so with_replies=True is
        needed for the totals to line up. A residual gap always remains:
        deleted/hidden/spam-filtered comments are counted but never served.
        """
        shortcode = shortcode_from_url(url_or_shortcode)
        media_id = shortcode_to_media_id(shortcode)

        comments: List[Dict[str, Any]] = []
        seen = set()
        pending_parents: List[str] = []
        min_id: Optional[str] = None
        guard = 0

        while len(comments) < max_comments and guard < 400:
            guard += 1
            params = {"can_support_threading": "true", "permalink_enabled": "false"}
            if min_id:
                params["min_id"] = min_id
            url = (
                f"https://www.instagram.com/api/v1/media/{media_id}/comments/?"
                + urllib.parse.urlencode(params)
            )
            # Android UA is mandatory here — see note 1 in the module docstring.
            data = self._get_json(url, android=True)

            batch = data.get("comments") or []
            added = 0
            for raw in batch:
                mapped = self._map_comment(raw, depth=0)
                if not mapped or mapped["id"] in seen:
                    continue
                seen.add(mapped["id"])
                comments.append(mapped)
                added += 1
                if with_replies and mapped["reply_count"] > 0:
                    pending_parents.append(mapped["id"])
                if len(comments) >= max_comments:
                    break

            # Both flags matter: has_more_comments is often false while
            # has_more_headload_comments is true.
            has_more = bool(data.get("has_more_comments")) or bool(data.get("has_more_headload_comments"))
            raw_cursor = data.get("next_min_id") or data.get("next_max_id")
            # The cursor is an OBJECT and must be sent back JSON-encoded.
            cursor = (
                raw_cursor if isinstance(raw_cursor, str)
                else json.dumps(raw_cursor, separators=(",", ":")) if raw_cursor is not None
                else None
            )
            if not has_more or not cursor or cursor == min_id or added == 0:
                break
            min_id = cursor
            time.sleep(self.config.comment_page_delay)

        if with_replies and pending_parents:
            by_id = {c["id"]: c for c in comments}
            for parent_id in pending_parents:
                if len(comments) >= max_comments:
                    break
                try:
                    replies = self._fetch_child_comments(media_id, parent_id)
                except InstagramError:
                    continue  # one unreachable thread must not sink the post
                parent = by_id.get(parent_id)
                for reply in replies:
                    if reply["id"] in seen:
                        continue
                    seen.add(reply["id"])
                    if parent is not None:
                        parent["replies"].append(reply)
                time.sleep(self.config.comment_page_delay)

        return comments

    def _fetch_child_comments(self, media_id: str, parent_id: str, max_replies: int = 200) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        seen = set()
        cursor: Optional[str] = None
        guard = 0
        while len(out) < max_replies and guard < 25:
            guard += 1
            url = f"https://www.instagram.com/api/v1/media/{media_id}/comments/{parent_id}/child_comments/"
            if cursor:
                url += "?" + urllib.parse.urlencode({"max_id": cursor})
            data = self._get_json(url, android=True)
            batch = data.get("child_comments") or data.get("comments") or []
            added = 0
            for raw in batch:
                mapped = self._map_comment(raw, depth=1, parent_id=parent_id)
                if not mapped or mapped["id"] in seen:
                    continue
                seen.add(mapped["id"])
                out.append(mapped)
                added += 1
            has_more = bool(data.get("has_more_head_child_comments")) or bool(
                data.get("has_more_tail_child_comments")
            )
            nxt = data.get("next_max_id") or data.get("next_min_id")
            nxt = nxt if isinstance(nxt, str) else (json.dumps(nxt, separators=(",", ":")) if nxt else None)
            if not has_more or not nxt or nxt == cursor or added == 0:
                break
            cursor = nxt
            time.sleep(self.config.comment_page_delay)
        return out

    def fetch_hashtag_with_comments(
        self,
        tag: str,
        limit: int = 20,
        max_comments_per_post: int = 500,
        with_replies: bool = True,
    ) -> List[Dict[str, Any]]:
        """fetch_hashtag() plus every post's comments embedded under 'comments_data'."""
        items = self.fetch_hashtag(tag, limit=limit)
        for item in items:
            if not item.get("shortcode"):
                item["comments_data"] = []
                continue
            try:
                item["comments_data"] = self.fetch_comments(
                    item["shortcode"],
                    max_comments=max_comments_per_post,
                    with_replies=with_replies,
                )
            except InstagramError as exc:
                item["comments_data"] = []
                item["comments_error"] = str(exc)
            time.sleep(self.config.request_delay)
        return items

    def fetch_profile(self, username: str) -> Dict[str, Any]:
        """Public profile details for an account."""
        clean = username.strip().lstrip("@")
        url = (
            "https://www.instagram.com/api/v1/users/web_profile_info/?username="
            + urllib.parse.quote(clean)
        )
        user = ((self._get_json(url).get("data") or {}).get("user")) or {}
        if not user:
            raise InstagramError(f"No profile data for @{clean}")
        return {
            "id": user.get("id"),
            "username": user.get("username"),
            "full_name": user.get("full_name"),
            "biography": user.get("biography"),
            "profile_pic": user.get("profile_pic_url_hd") or user.get("profile_pic_url"),
            "external_url": user.get("external_url"),
            "is_private": bool(user.get("is_private")),
            "is_verified": bool(user.get("is_verified")),
            "followers": _int((user.get("edge_followed_by") or {}).get("count")),
            "following": _int((user.get("edge_follow") or {}).get("count")),
            "posts_count": _int((user.get("edge_owner_to_timeline_media") or {}).get("count")),
        }

    # -- convenience --------------------------------------------------------
    @staticmethod
    def to_json(data: Any, path: Optional[str] = None, indent: int = 2) -> str:
        """Serialize results; also writes to `path` when given."""
        text = json.dumps(data, ensure_ascii=False, indent=indent)
        if path:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(text)
        return text


# ---------------------------------------------------------------------------
# THE ONE FUNCTION
# ---------------------------------------------------------------------------
def fetch(
    hashtag: str,
    limit: int = DEFAULT_POST_LIMIT,
    with_comments: bool = True,
    comments_per_post: int = DEFAULT_COMMENTS_PER_POST,
) -> List[Dict[str, Any]]:
    """
    Everything for a hashtag, in one call.

        from mediahub import fetch
        data = fetch("schoolthikkaro")

    Returns a list of dicts — posts AND reels together, unfiltered and in the
    order Instagram serves them. Each dict carries the media URLs, thumbnail,
    caption, hashtags, engagement counts, author, geotag, and (unless
    with_comments=False) every reachable comment with replies threaded under
    its parent.

    Set with_comments=False for a much faster metadata-only pass; comments cost
    roughly one request per 15 of them.

    Requires SESSION_ID to be set at the top of this file.
    """
    hub = MediaHub()
    if with_comments:
        return hub.fetch_hashtag_with_comments(
            hashtag, limit=limit, max_comments_per_post=comments_per_post
        )
    return hub.fetch_hashtag(hashtag, limit=limit)


def fetch_to_file(hashtag: str, path: str = "instagram_data.json", **kwargs: Any) -> str:
    """fetch(), written straight to a JSON file. Returns the path."""
    MediaHub.to_json(fetch(hashtag, **kwargs), path=path)
    return path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _cli(argv: List[str]) -> int:
    usage = """
mediahub.py — Instagram hashtag / post / comment fetcher

Usage:
  python mediahub.py hashtag <tag> [limit]              posts + reels for a hashtag
  python mediahub.py hashtag-full <tag> [limit]         ...with all comments embedded
  python mediahub.py post <url|shortcode>               one post/reel in full
  python mediahub.py comments <url|shortcode> [max]     all comments for a post
  python mediahub.py profile <username>                 profile details

Session (either one):
  Easiest: set SESSION_ID at the top of this file. Or:
  export IG_SESSION_ID="your_sessionid_cookie"
  python mediahub.py --session "sessionid=...; csrftoken=..." hashtag lucknow

Output is JSON on stdout, so it pipes:
  python mediahub.py hashtag lucknow 50 > out.json
""".strip()

    args = list(argv)
    session = ""
    if "--session" in args:
        i = args.index("--session")
        session = args[i + 1] if i + 1 < len(args) else ""
        del args[i:i + 2]

    if not args or args[0] in ("-h", "--help", "help"):
        print(usage)
        return 0

    import os
    session = session or os.environ.get("IG_SESSION_ID", "") or SESSION_ID
    if not session:
        print("ERROR: no session. Set IG_SESSION_ID or pass --session.\n", file=sys.stderr)
        print(usage, file=sys.stderr)
        return 2

    command, rest = args[0], args[1:]
    try:
        hub = MediaHub(session_id=session)
        if command == "hashtag":
            result: Any = hub.fetch_hashtag(rest[0], limit=int(rest[1]) if len(rest) > 1 else 50)
        elif command == "hashtag-full":
            result = hub.fetch_hashtag_with_comments(rest[0], limit=int(rest[1]) if len(rest) > 1 else 20)
        elif command == "post":
            result = hub.fetch_post(rest[0])
        elif command == "comments":
            result = hub.fetch_comments(rest[0], max_comments=int(rest[1]) if len(rest) > 1 else 1000)
        elif command == "profile":
            result = hub.fetch_profile(rest[0])
        else:
            print(f"Unknown command: {command}\n", file=sys.stderr)
            print(usage, file=sys.stderr)
            return 2
    except IndexError:
        print("ERROR: missing argument.\n", file=sys.stderr)
        print(usage, file=sys.stderr)
        return 2
    except InstagramError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print(MediaHub.to_json(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli(sys.argv[1:]))

# Import Facebook login from local Chrome

Run this from the MediaHub directory on macOS, with the app already running on
port 3010. Select the exact email shown in Chrome's profile chooser:

```sh
npm run fb:session:chrome -- --chrome-account pranjulpal04@gmail.com --local-demo
```

The helper finds that profile, reads only `c_user`, `xs`, `datr`, `sb`, and `fr`
from Facebook's root-domain cookies, and verifies the account in a temporary
Selenium-controlled Chrome window. It refreshes the existing MediaHub session
for the same Facebook account, or creates one if absent. Re-running the command
refreshes the same row instead of creating duplicates. A lock prevents concurrent
helper runs. Verification failure leaves saved sessions untouched.

This is a **host command**, not a scheduled background service. Run it again
after Facebook changes/expires the session. A Docker container cannot access the
host's Chrome profile or macOS Keychain. The command installs its pinned Python
dependencies under `~/.cache/mediahub/`, outside the repository and app image.
It does not restart the app or run a scraper/export/Google Sheet test.

`--local-demo` explicitly uses this project's existing `/api/studio-enter` local
studio login. All save requests go to authenticated, organization-scoped tRPC
endpoints at `http://localhost:3010`, which encrypt cookies at rest. This helper
is not intended for hosted deployment or non-demo authentication. Redirects and
environment proxies are disabled for these local requests.

The user's normal Chrome windows stay open. Neither Chrome's full profile nor
other sites' cookies are copied. Only selected encrypted Facebook cookie records
are temporarily staged in a private directory; decrypted values stay in memory.
The validation browser is isolated/incognito, closes on completion, and its
temporary directory is removed. Driver logs, cookie values and page HTML are
never printed. If macOS requests Chrome Safe Storage access, use the normal OS
permission prompt; no browser or Keychain protections are disabled.

Chrome no longer permits remote debugging against its default data directory.
Selenium therefore validates the imported cookies in a separate temporary
profile, instead of attempting to attach to or restart the user's normal profile.
See [Chrome's remote-debugging change](https://developer.chrome.com/blog/remote-debugging-port),
[Selenium cookie support](https://www.selenium.dev/documentation/webdriver/interactions/cookies/),
and the [browser-cookie3 project](https://github.com/borisbabic/browser_cookie3).

Focused offline checks:

```sh
python3 -m unittest discover -s scripts/facebook -p test_chrome_session.py
```

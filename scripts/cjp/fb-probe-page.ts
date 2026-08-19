/** What does the browser actually land on for the MLA's Facebook URL? */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import { withFacebookContext } from "../../src/server/services/facebook/browser-pool";
import { normalizeCookies } from "../../src/server/services/facebook/scraper-types";

const TARGET = process.argv[2] || "https://www.facebook.com/officeumaralikhan";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function main() {
  const { data } = await db
    .from("fb_sessions")
    .select("cookie_encrypted")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { cookie } = normalizeCookies(decrypt(data!.cookie_encrypted));

  await withFacebookContext(cookie, async (ctx) => {
    const page = await ctx.newPage();
    await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(6000);

    console.log(`requested : ${TARGET}`);
    console.log(`landed on : ${page.url()}`);
    console.log(`title     : ${await page.title()}`);

    const info = (await page.evaluate(`(function () {
      var body = (document.body && document.body.innerText) || '';
      var h1 = document.querySelector('h1');
      var articles = document.querySelectorAll('[role="article"]');
      // Which account do the post permalinks actually belong to?
      var owners = {};
      Array.prototype.forEach.call(document.querySelectorAll('a[href*="/posts/"]'), function (a) {
        var m = /facebook\\.com\\/([A-Za-z0-9.]+)\\/posts\\//.exec(a.href);
        if (m) owners[m[1]] = (owners[m[1]] || 0) + 1;
      });
      return {
        bodyLen: body.length,
        heading: h1 ? h1.innerText.trim().slice(0, 80) : null,
        articleCount: articles.length,
        postLinkOwners: owners,
        notFound: /isn't available|content isn't available|page isn't available/i.test(body),
        loginWall: /log in|log into facebook/i.test(body.slice(0, 400)),
        firstText: body.replace(/\\s+/g, ' ').slice(0, 220),
      };
    })()`)) as any;

    console.log(`body length     : ${info.bodyLen}`);
    console.log(`h1              : ${info.heading}`);
    console.log(`role=article    : ${info.articleCount}`);
    console.log(`post-link owners: ${JSON.stringify(info.postLinkOwners)}`);
    console.log(`"not available" : ${info.notFound}`);
    console.log(`login wall      : ${info.loginWall}`);
    console.log(`\nfirst text: ${info.firstText}`);
  });
}

main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });

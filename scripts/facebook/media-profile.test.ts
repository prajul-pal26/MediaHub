import { strict as assert } from "node:assert";
import { test } from "node:test";
import { profileDetails } from "../../src/server/services/facebook/media-profile";

test("public owner contact labels populate once without inferring missing fields from reviews", () => {
  const result = profileDetails({
    lines: ["Contact info", "Phone", "+91 80000 00000", "Email", "office@example.org", "Reviews", "Email", "unrelated@example.net"],
    links: [{ text: "20K followers", href: "https://www.facebook.com/example/followers/" }, { text: "example", href: "https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.instagram.com%2Fexample%3Ffbclid%3Dtracking" }],
  });
  assert.equal(result.email, "office@example.org");
  assert.equal(result.phone, "+91 80000 00000");
  assert.equal(result.instagram, "https://www.instagram.com/example");
  assert.equal(result.followers, 20000);
  assert.equal(result.twitter, null);
  assert.equal(result.website, null);
});

test("external contact routes preserve actual public links and reject social-host lookalikes", () => {
  const result = profileDetails({ lines: [], links: [
    { text: "Email", href: "mailto:office@example.org" },
    { text: "Phone", href: "tel:+918000000000" },
    { text: "Website", href: "https://office.example.org/contact?fbclid=tracking" },
    { text: "X", href: "https://x.com/example" },
    { text: "Not Instagram", href: "https://instagram.com.example.org/profile" },
  ] });
  assert.equal(result.website, "https://office.example.org/contact");
  assert.equal(result.twitter, "https://x.com/example");
  assert.equal(result.instagram, null);
  assert.equal(result.email, "office@example.org");
});

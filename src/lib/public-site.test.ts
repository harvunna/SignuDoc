import assert from "node:assert/strict";
import test from "node:test";

import {
  PRIVATE_PATHS,
  PUBLIC_PAGES,
  isPublicSite,
  publicSiteOrigin,
} from "./public-site.ts";

test("the public site is off unless asked for", () => {
  assert.equal(isPublicSite({}), false);
  assert.equal(isPublicSite({ SIGNLY_PUBLIC_SITE: "no" }), false);
  assert.equal(isPublicSite({ SIGNLY_PUBLIC_SITE: "true" }), true);
  assert.equal(isPublicSite({ SIGNLY_PUBLIC_SITE: "1" }), true);
  assert.equal(isPublicSite({ SIGNLY_PUBLIC_SITE: " TRUE " }), true);
});

test("the origin comes from APP_URL, without a path", () => {
  assert.equal(
    publicSiteOrigin({ APP_URL: "https://esign.example.com/dashboard" }),
    "https://esign.example.com",
  );
  assert.equal(publicSiteOrigin({ APP_URL: "not a url" }), undefined);
});

test("a public page is never also a private path", () => {
  for (const page of PUBLIC_PAGES) {
    assert.ok(
      !PRIVATE_PATHS.some(
        (path) => page.path !== "/" && page.path.startsWith(path),
      ),
      page.path,
    );
  }
});

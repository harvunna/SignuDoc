import assert from "node:assert/strict";
import { test } from "node:test";

import { safePostSignInPath } from "./auth/next-path.ts";
import {
  buildRedirect,
  isValidCodeChallenge,
  isValidCodeVerifier,
  parseRedirectUris,
  pkceChallengeFor,
  redirectUriMatches,
  verifyPkce,
} from "./oauth-authorization.ts";

test("PKCE matches the example in RFC 7636 appendix B", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  assert.equal(pkceChallengeFor(verifier), challenge);
  assert.ok(verifyPkce(verifier, challenge));
  assert.equal(verifyPkce(`${verifier}x`, challenge), false);
  assert.equal(verifyPkce(verifier, "A".repeat(43)), false);
});

test("a verifier and a challenge have the lengths and characters the RFC sets", () => {
  assert.ok(isValidCodeVerifier("a".repeat(43)));
  assert.ok(isValidCodeVerifier("a".repeat(128)));
  assert.equal(isValidCodeVerifier("a".repeat(42)), false);
  assert.equal(isValidCodeVerifier("a".repeat(129)), false);
  assert.equal(isValidCodeVerifier(`${"a".repeat(42)}!`), false);
  assert.ok(isValidCodeChallenge("A".repeat(43)));
  assert.equal(isValidCodeChallenge("A".repeat(44)), false);
  assert.equal(isValidCodeChallenge(`${"A".repeat(42)}=`), false);
});

test("only safe redirect addresses can be registered", () => {
  assert.deepEqual(
    parseRedirectUris([
      "https://app.example.com/cb",
      " http://localhost:3000/cb ",
      "http://127.0.0.1/cb",
      "com.example.app:/oauth",
      "https://app.example.com/cb",
    ]),
    [
      "https://app.example.com/cb",
      "http://localhost:3000/cb",
      "http://127.0.0.1/cb",
      "com.example.app:/oauth",
    ],
  );
  assert.deepEqual(parseRedirectUris([]), []);

  for (const bad of [
    "http://app.example.com/cb",
    "https://app.example.com/cb#frag",
    "https://user:pass@app.example.com/cb",
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///etc/passwd",
    "not a url",
    "",
  ]) {
    assert.equal(parseRedirectUris([bad]), null, bad);
  }

  assert.equal(parseRedirectUris("https://app.example.com"), null);
  assert.equal(parseRedirectUris([7]), null);
  assert.equal(
    parseRedirectUris(
      Array.from({ length: 6 }, (_, i) => `https://a${String(i)}.example.com`),
    ),
    null,
  );
});

test("redirect addresses match exactly, except the port of a loopback address", () => {
  const registered = ["https://app.example.com/cb", "http://127.0.0.1/cb"];

  assert.ok(redirectUriMatches(registered, "https://app.example.com/cb"));
  assert.equal(
    redirectUriMatches(registered, "https://app.example.com/cb/"),
    false,
  );
  assert.equal(
    redirectUriMatches(registered, "https://app.example.com/cb?x=1"),
    false,
  );
  assert.equal(
    redirectUriMatches(registered, "https://evil.example.com/cb"),
    false,
  );
  assert.ok(redirectUriMatches(registered, "http://127.0.0.1:53124/cb"));
  assert.equal(
    redirectUriMatches(registered, "http://127.0.0.1:53124/x"),
    false,
  );
  assert.equal(
    redirectUriMatches(registered, "http://localhost:53124/cb"),
    false,
  );
  assert.equal(
    redirectUriMatches(
      ["https://app.example.com/cb"],
      "http://app.example.com/cb",
    ),
    false,
  );
});

test("the redirect back carries the answer and keeps the address's own query", () => {
  assert.equal(
    buildRedirect("https://app.example.com/cb?tenant=7", {
      code: "abc",
      state: "xyz 1",
    }),
    "https://app.example.com/cb?tenant=7&code=abc&state=xyz+1",
  );
  assert.equal(
    buildRedirect("https://app.example.com/cb", {
      error: "access_denied",
      state: null,
    }),
    "https://app.example.com/cb?error=access_denied",
  );
});

test("sign-in goes back only to the consent screen", () => {
  assert.equal(
    safePostSignInPath("/oauth/authorize?client_id=gcmc_1&state=a"),
    "/oauth/authorize?client_id=gcmc_1&state=a",
  );
  assert.equal(safePostSignInPath("/oauth/authorize"), "/oauth/authorize");
  assert.equal(safePostSignInPath("/oauth/authorizeevil"), null);
  assert.equal(safePostSignInPath("https://evil.example.com/"), null);
  assert.equal(safePostSignInPath("//evil.example.com"), null);
  assert.equal(safePostSignInPath("/dashboard"), null);
  assert.equal(safePostSignInPath("/oauth/authorize?x=\\evil"), null);
  assert.equal(safePostSignInPath(undefined), null);
});

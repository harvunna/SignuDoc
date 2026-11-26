import assert from "node:assert/strict";
import { test } from "node:test";

import {
  generateOAuthClientId,
  generateOAuthClientSecret,
  generateOAuthToken,
  hashOAuthSecret,
  looksLikeOAuthToken,
  parseOAuthClientName,
  resolveTokenScope,
} from "./oauth.ts";

test("new credentials have their prefixes and 128 or 256 bits of randomness", () => {
  assert.match(generateOAuthClientId(), /^gcmc_[A-Za-z0-9_-]{22}$/);
  assert.match(generateOAuthClientSecret(), /^gcms_[A-Za-z0-9_-]{43}$/);

  const token = generateOAuthToken();

  assert.match(token, /^sdo_[A-Za-z0-9_-]{43}$/);
  assert.ok(looksLikeOAuthToken(token));
  assert.notEqual(generateOAuthToken(), token);
});

test("only the shape of our tokens is looked up", () => {
  assert.equal(looksLikeOAuthToken("sdo_short"), false);
  assert.equal(looksLikeOAuthToken(`sdk_${"a".repeat(43)}`), false);
  assert.equal(looksLikeOAuthToken(`sdo_${"a".repeat(43)}!`), false);
});

test("secrets are hashed with SHA-256 in hex", () => {
  assert.equal(
    hashOAuthSecret("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("a token's scope defaults to the client's and never exceeds it", () => {
  assert.equal(resolveTokenScope(undefined, "write"), "write");
  assert.equal(resolveTokenScope(null, "read"), "read");
  assert.equal(resolveTokenScope("", "read"), "read");
  assert.equal(resolveTokenScope("read", "write"), "read");
  assert.equal(resolveTokenScope("write", "write"), "write");
  assert.equal(resolveTokenScope("read write", "write"), "write");
  assert.equal(resolveTokenScope("write", "read"), null);
  assert.equal(resolveTokenScope("admin", "write"), null);
  assert.equal(resolveTokenScope("read admin", "write"), null);
});

test("a client name is trimmed and limited to 80 characters", () => {
  assert.equal(parseOAuthClientName("  Billing   app "), "Billing app");
  assert.equal(parseOAuthClientName(""), null);
  assert.equal(parseOAuthClientName("a".repeat(81)), null);
  assert.equal(parseOAuthClientName(7), null);
});

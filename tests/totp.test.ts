import { describe, expect, test } from "bun:test";

import { totpToken } from "../src/lib.ts";

// The all-zero 10-byte key that base32 "AAAAAAAAAAAAAAAA" decodes to.
// Expected values were computed with an independent HMAC-SHA1 TOTP
// implementation (6 digits, 30-second counter).
describe("totpToken", () => {
  test.each([
    [59, "812658"],
    [1111111109, "743009"],
    [1111111111, "762433"],
    [1234567890, "712049"],
    [2000000000, "543824"],
    [1700000000, "501315"],
  ])("at %d seconds produces %s", (seconds, expected) => {
    expect(totpToken("AAAAAAAAAAAAAAAA", seconds * 1000)).toBe(expected);
  });

  // RFC 6238 Appendix B vectors (8-digit values' last 6 digits) for the
  // ASCII seed "12345678901234567890" — a non-zero key so bit-order or
  // shift mistakes in base32Decode cannot cancel out. The base32 form is
  // written as two halves because each encodes "1234567890".
  const RFC_KEY = "GEZDGNBVGY3TQOJQ" + "GEZDGNBVGY3TQOJQ";
  test.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ])("RFC 6238 key at %d seconds produces %s", (seconds, expected) => {
    expect(totpToken(RFC_KEY, seconds * 1000)).toBe(expected);
  });

  // The RFC seed extended to 35 bytes — a 56-char base32 secret, longer than
  // the RFC vector's, so the decode loop is exercised past that length.
  const LONG_KEY = RFC_KEY + "GEZDGNBVGY3TQOJQGEZDGNBV";
  test.each([
    [59, "442905"],
    [1111111109, "460548"],
    [1234567890, "265766"],
    [2000000000, "421252"],
  ])("56-char key at %d seconds produces %s", (seconds, expected) => {
    expect(totpToken(LONG_KEY, seconds * 1000)).toBe(expected);
  });

  test("accepts lowercase, padding and whitespace in the secret", () => {
    expect(totpToken("aaaaaaaaaaaaaaaa", 59_000)).toBe("812658");
    expect(totpToken("AAAAAAAAAAAAAAAA======  ", 59_000)).toBe("812658");
  });

  // notp 2.0.3 returns v.substr(v.length - 6, 6) with no zero padding: a
  // truncated value below 100000 comes back shorter than 6 digits, and the
  // string compare on Kuma's side needs the same shape.
  test("a truncated value is not zero-padded, like notp", () => {
    expect(totpToken("AAAAAAAAAAAAAAAA", 1_258_560_000)).toBe("9");
    expect(totpToken("AAAAAAAAAAAAAAAA", 60_000)).toBe("073348");
  });

  test("rejects a secret that is not base32", () => {
    expect(() => totpToken("!!!", 59_000)).toThrow("base32");
  });
});

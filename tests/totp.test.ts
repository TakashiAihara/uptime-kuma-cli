import { describe, expect, test } from "bun:test";
import { totpToken } from "../src/lib.ts";

// Expected values were computed with an independent HMAC-SHA1 TOTP
// implementation (6 digits, 30-second counter) for the all-zero 10-byte key
// that base32 "AAAAAAAAAAAAAAAA" decodes to.
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

  test("accepts lowercase, padding and whitespace in the secret", () => {
    expect(totpToken("aaaaaaaaaaaaaaaa", 59_000)).toBe("812658");
    expect(totpToken("AAAAAAAAAAAAAAAA======  ", 59_000)).toBe("812658");
  });

  test("rejects a secret that is not base32", () => {
    expect(() => totpToken("!!!", 59_000)).toThrow("base32");
  });
});

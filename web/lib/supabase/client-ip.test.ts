import { describe, expect, it } from "vitest";
import { clientIp } from "./client-ip";

describe("clientIp", () => {
  it("takes the first value of x-vercel-forwarded-for", () =>
    expect(clientIp(new Headers({ "x-vercel-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7"));
  it("accepts IPv6", () =>
    expect(clientIp(new Headers({ "x-vercel-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1"));
  it.each([
    [{}],
    [{ "x-forwarded-for": "203.0.113.7" }],
    [{ "x-real-ip": "203.0.113.7" }],
    [{ "x-vercel-forwarded-for": "not-an-ip" }],
    [{ "x-vercel-forwarded-for": "" }],
  ])("returns null for %j", (h) => expect(clientIp(new Headers(h))).toBeNull());
});

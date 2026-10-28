import { isIP } from "node:net";

/**
 * The person's IP, from Vercel's own header only. Vercel sets
 * x-vercel-forwarded-for itself; anything else the person sends could be forged.
 */
export function clientIp(headers: Headers): string | null {
  const first = headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ?? "";
  return isIP(first) ? first : null;
}

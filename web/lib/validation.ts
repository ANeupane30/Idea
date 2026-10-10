import { z } from "zod";

export type ActionResult = { ok: true } | { ok: false; error: string };

export const GENERIC_ERROR = "Something went wrong. Please try again.";
export const PASSWORD_TOO_SHORT = "Password must be at least 8 characters.";

export const credentialsSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  password: z.string().min(8, PASSWORD_TOO_SHORT),
});

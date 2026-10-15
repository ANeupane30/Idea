"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { credentialsSchema, GENERIC_ERROR, type ActionResult } from "@/lib/validation";

const RATE_LIMITED = "Too many attempts. Please wait a minute and try again.";

function parseCredentials(formData: FormData) {
  return credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
}

export async function signUp(formData: FormData): Promise<ActionResult> {
  const parsed = parseCredentials(formData);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? GENERIC_ERROR };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user?.is_anonymous) {
    // Convert the guest in place: same user id, so their goal and map stay theirs.
    // With email confirmations off, one call sets both and clears is_anonymous.
    const { data, error } = await supabase.auth.updateUser(parsed.data);
    if (error) return signUpError(error);
    // Only happens if email confirmations are switched on: the email waits for confirmation.
    if (data.user?.is_anonymous || data.user?.new_email) {
      return { ok: false, error: "Check your email to confirm your account, then sign in." };
    }
    redirect("/goals");
  }

  const { data, error } = await supabase.auth.signUp(parsed.data);
  if (error) return signUpError(error);
  // Only happens if email confirmations are switched on.
  if (!data.session) {
    return { ok: false, error: "Check your email to confirm your account, then sign in." };
  }
  redirect("/goals");
}

function signUpError(error: { code?: string; status?: number }): ActionResult {
  if (error.code === "user_already_exists" || error.code === "email_exists") {
    return { ok: false, error: "An account with this email already exists. Try signing in." };
  }
  if (error.code === "over_request_rate_limit" || error.status === 429) {
    return { ok: false, error: RATE_LIMITED };
  }
  if (error.code === "weak_password") {
    return { ok: false, error: "Choose a stronger password." };
  }
  return { ok: false, error: GENERIC_ERROR };
}

export async function signIn(formData: FormData): Promise<ActionResult> {
  const parsed = parseCredentials(formData);
  if (!parsed.success) {
    // Don't reveal password rules at sign-in; invalid input is just a failed sign-in.
    return { ok: false, error: "Email or password is incorrect." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    if (error.code === "invalid_credentials") {
      return { ok: false, error: "Email or password is incorrect." };
    }
    if (error.code === "over_request_rate_limit" || error.status === 429) {
      return { ok: false, error: RATE_LIMITED };
    }
    return { ok: false, error: GENERIC_ERROR };
  }
  redirect("/goals");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  // The proxy gives the next request a fresh guest session.
  redirect("/");
}

import { Suspense } from "react";
import { connection } from "next/server";
import { AuthForm } from "@/components/auth-form";
import { createClient } from "@/lib/supabase/server";
import { signIn } from "../actions";

/** Warns a guest who has a goal that signing in switches account and leaves it behind. */
async function GuestGoalWarning() {
  await connection();
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user?.is_anonymous) return null;
  const { data: goal } = await supabase.from("goals").select("id").limit(1).maybeSingle();
  if (!goal) return null;
  return (
    <p className="rounded-xl bg-partial px-4 py-3 text-body-m text-on-partial">
      Signing in to another account won&apos;t keep your guest goal.
    </p>
  );
}

export default function SignInPage() {
  return (
    <AuthForm
      mode="sign-in"
      action={signIn}
      notice={
        <Suspense fallback={null}>
          <GuestGoalWarning />
        </Suspense>
      }
    />
  );
}

"use client";

import Link from "next/link";
import { useActionState } from "react";
import { button, field } from "@/components/ui/buttons";
import type { ActionResult } from "@/lib/validation";

type Props = {
  mode: "sign-in" | "sign-up";
  action: (formData: FormData) => Promise<ActionResult>;
  /** Shown under the heading, e.g. a warning for guests. */
  notice?: React.ReactNode;
};

const LABEL = "flex flex-col gap-1.5 text-label-l text-on-surface-variant";

export function AuthForm({ mode, action, notice }: Props) {
  const isSignUp = mode === "sign-up";
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    (_prev, formData) => action(formData),
    null,
  );

  return (
      <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-4 py-10">
        <h1 className="text-headline-m text-on-surface">{isSignUp ? "Create your account" : "Sign in"}</h1>
        {notice}
        <form action={formAction} className="flex flex-col gap-4">
          <label className={LABEL}>
            Email
            <input name="email" type="email" autoComplete="email" required className={field()} />
          </label>
          <label className={LABEL}>
            Password
            <input
              name="password"
              type="password"
              autoComplete={isSignUp ? "new-password" : "current-password"}
              required
              className={field()}
            />
          </label>
          <div role="alert" className="min-h-5 text-body-m text-on-negative">
            {state && !state.ok ? state.error : null}
          </div>
          <button type="submit" disabled={pending} className={button("filled")}>
            {isSignUp ? "Sign up" : "Sign in"}
          </button>
        </form>
        <p className="text-body-m text-on-surface-variant">
          {isSignUp ? (
            <>
              Already have an account?{" "}
              <Link href="/sign-in" className="text-primary underline underline-offset-2">
                Sign in
              </Link>
            </>
          ) : (
            <>
              New here?{" "}
              <Link href="/sign-up" className="text-primary underline underline-offset-2">
                Create an account
              </Link>
            </>
          )}
        </p>
      </main>
  );
}

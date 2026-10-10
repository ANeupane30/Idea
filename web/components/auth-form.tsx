"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { ActionResult } from "@/lib/validation";

type Props = {
  mode: "sign-in" | "sign-up";
  action: (formData: FormData) => Promise<ActionResult>;
};

export function AuthForm({ mode, action }: Props) {
  const isSignUp = mode === "sign-up";
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    (_prev, formData) => action(formData),
    null,
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">{isSignUp ? "Create your account" : "Sign in"}</h1>
      <form action={formAction} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            className="rounded border border-zinc-400 px-3 py-2 text-base"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            name="password"
            type="password"
            autoComplete={isSignUp ? "new-password" : "current-password"}
            required
            className="rounded border border-zinc-400 px-3 py-2 text-base"
          />
        </label>
        <div role="alert" className="min-h-5 text-sm text-red-700">
          {state && !state.ok ? state.error : null}
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-zinc-900 px-4 py-2 text-white disabled:opacity-60"
        >
          {isSignUp ? "Sign up" : "Sign in"}
        </button>
      </form>
      <p className="text-sm">
        {isSignUp ? (
          <>
            Already have an account?{" "}
            <Link href="/sign-in" className="underline">
              Sign in
            </Link>
          </>
        ) : (
          <>
            New here?{" "}
            <Link href="/sign-up" className="underline">
              Create an account
            </Link>
          </>
        )}
      </p>
    </main>
  );
}

import Link from "next/link";
import { GUEST_GOAL_LIMIT } from "@/lib/validation";

/** A form's error line. The guest goal limit links to sign-up. */
export function FormError({ error, className = "" }: { error: string | null; className?: string }) {
  return (
    <div role="alert" className={`text-sm text-red-700 dark:text-red-400 ${className}`}>
      {error === GUEST_GOAL_LIMIT ? (
        <>
          <Link href="/sign-up" className="font-semibold underline underline-offset-2">
            Sign up free
          </Link>
          {GUEST_GOAL_LIMIT.slice("Sign up free".length)}
        </>
      ) : (
        error
      )}
    </div>
  );
}

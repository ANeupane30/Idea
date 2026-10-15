import Link from "next/link";

const SIGN_UP_PREFIX = "Sign up free";

/** A form's error line. Guest-limit messages ("Sign up free …") link to sign-up. */
export function FormError({ error, className = "" }: { error: string | null; className?: string }) {
  return (
    <div role="alert" className={`text-sm text-red-700 dark:text-red-400 ${className}`}>
      {error?.startsWith(SIGN_UP_PREFIX) ? (
        <>
          <Link href="/sign-up" className="font-semibold underline underline-offset-2">
            {SIGN_UP_PREFIX}
          </Link>
          {error.slice(SIGN_UP_PREFIX.length)}
        </>
      ) : (
        error
      )}
    </div>
  );
}

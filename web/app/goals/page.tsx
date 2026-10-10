import { signOut } from "../(auth)/actions";

// Placeholder; replaced in Task 7.
export default function GoalsPage() {
  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold">Your goals</h1>
      <form action={signOut} className="mt-6">
        <button type="submit" className="rounded border border-zinc-400 px-4 py-2">
          Sign out
        </button>
      </form>
    </main>
  );
}

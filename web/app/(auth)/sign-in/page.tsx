import { AuthForm } from "@/components/auth-form";
import { signIn } from "../actions";

export default function SignInPage() {
  return <AuthForm mode="sign-in" action={signIn} />;
}

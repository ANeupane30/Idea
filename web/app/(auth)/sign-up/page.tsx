import { AuthForm } from "@/components/auth-form";
import { signUp } from "../actions";

export default function SignUpPage() {
  return <AuthForm mode="sign-up" action={signUp} />;
}

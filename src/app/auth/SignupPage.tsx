import { Link } from "react-router";
import { SignupForm } from "wasp/client/auth";
import { AuthLayout } from "./AuthLayout";

export function SignupPage() {
  return (
    <AuthLayout>
      {/* Email/password only — no extra signup fields in v1. */}
      <SignupForm />
      <br />
      <span className="text-sm font-medium text-neutral-900">
        Already have an account?{" "}
        <Link to="/login" className="font-semibold underline">
          Go to login
        </Link>
        .
      </span>
    </AuthLayout>
  );
}

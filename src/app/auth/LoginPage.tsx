import { Link } from "react-router"
import { FieldDescription } from "../../components/ui/field"
import { AuthLayout } from "./AuthLayout"
import { EmailAuthForm } from "./EmailAuthForm"

export function LoginPage() {
  return (
    <AuthLayout
      title="Welcome back"
      description="Sign in to your Dotflowy outline"
    >
      <EmailAuthForm mode="login" />
      <FieldDescription>
        Don&apos;t have an account yet? <Link to="/signup">Sign up</Link>.
      </FieldDescription>
      <FieldDescription>
        Forgot your password?{" "}
        <Link to="/request-password-reset">Reset it</Link>.
      </FieldDescription>
    </AuthLayout>
  )
}

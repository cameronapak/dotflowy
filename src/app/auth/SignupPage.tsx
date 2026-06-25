import { Link } from "react-router"
import { FieldDescription } from "../../components/ui/field"
import { AuthLayout } from "./AuthLayout"
import { EmailAuthForm } from "./EmailAuthForm"

export function SignupPage() {
  return (
    <AuthLayout
      title="Create an account"
      description="Email and password — your outline stays private to you"
    >
      <EmailAuthForm mode="signup" />
      <FieldDescription>
        Already have an account? <Link to="/login">Log in</Link>.
      </FieldDescription>
    </AuthLayout>
  )
}

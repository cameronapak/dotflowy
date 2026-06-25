import { Link } from "react-router"
import { FieldDescription } from "../../components/ui/field"
import { AuthLayout } from "./AuthLayout"
import { ForgotPasswordForm } from "./ForgotPasswordForm"

export function RequestPasswordResetPage() {
  return (
    <AuthLayout
      title="Reset your password"
      description="We'll email you a link to choose a new password"
    >
      <ForgotPasswordForm />
      <FieldDescription>
        Remember your password? <Link to="/login">Back to login</Link>.
      </FieldDescription>
    </AuthLayout>
  )
}

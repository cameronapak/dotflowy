import { Link } from "react-router"
import { FieldDescription } from "../../components/ui/field"
import { AuthLayout } from "./AuthLayout"
import { ResetPasswordForm } from "./ResetPasswordForm"

export function PasswordResetPage() {
  return (
    <AuthLayout
      title="Choose a new password"
      description="Enter and confirm your new password below"
    >
      <ResetPasswordForm />
      <FieldDescription>
        Done? <Link to="/login">Go to login</Link>.
      </FieldDescription>
    </AuthLayout>
  )
}

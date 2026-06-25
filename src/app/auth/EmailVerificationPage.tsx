import { Link } from "react-router"
import { FieldDescription } from "../../components/ui/field"
import { AuthLayout } from "./AuthLayout"
import { VerifyEmailForm } from "./VerifyEmailForm"

export function EmailVerificationPage() {
  return (
    <AuthLayout
      title="Verify your email"
      description="Confirming your address…"
    >
      <VerifyEmailForm />
      <FieldDescription>
        <Link to="/login">Go to login</Link>.
      </FieldDescription>
    </AuthLayout>
  )
}

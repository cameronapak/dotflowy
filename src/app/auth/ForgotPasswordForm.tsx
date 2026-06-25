import { useState, type FormEvent } from "react"
import { requestPasswordReset } from "wasp/client/auth"
import { Button } from "../../components/ui/button"
import { Input } from "../../components/ui/input"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "../../components/ui/field"

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    setIsLoading(true)
    try {
      await requestPasswordReset({ email })
      setSuccess("Check your email for a password reset link.")
      setEmail("")
    } catch {
      setError("Could not send a password reset email. Please try again.")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            disabled={isLoading}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={!!error}
          />
        </Field>
        {error && <FieldError>{error}</FieldError>}
        {success && <FieldDescription>{success}</FieldDescription>}
        <Button type="submit" className="w-full" disabled={isLoading}>
          {isLoading ? "Sending…" : "Send password reset email"}
        </Button>
      </FieldGroup>
    </form>
  )
}

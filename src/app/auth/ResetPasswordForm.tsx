import { useState, type FormEvent } from "react"
import { useLocation } from "react-router"
import { resetPassword } from "wasp/client/auth"
import { Button } from "../../components/ui/button"
import { Input } from "../../components/ui/input"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "../../components/ui/field"

export function ResetPasswordForm() {
  const location = useLocation()
  const token = new URLSearchParams(location.search).get("token")
  const [password, setPassword] = useState("")
  const [passwordConfirmation, setPasswordConfirmation] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const passwordMismatch =
    !!passwordConfirmation && password !== passwordConfirmation
  const fieldError = passwordMismatch ? "Passwords don't match." : null
  const formError = error && !passwordMismatch ? error : null

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    if (!token) {
      setError(
        "The token is missing from the URL. Please check the link you received in your email.",
      )
      return
    }
    if (passwordMismatch) {
      setError("Passwords don't match.")
      return
    }

    setIsLoading(true)
    try {
      await resetPassword({ password, token })
      setSuccess("Your password has been reset.")
      setPassword("")
      setPasswordConfirmation("")
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Something went wrong"
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="password">New password</FieldLabel>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            disabled={isLoading}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={passwordMismatch}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="password-confirmation">
            Confirm new password
          </FieldLabel>
          <Input
            id="password-confirmation"
            type="password"
            autoComplete="new-password"
            required
            disabled={isLoading}
            value={passwordConfirmation}
            onChange={(e) => setPasswordConfirmation(e.target.value)}
            aria-invalid={passwordMismatch}
          />
        </Field>
        {fieldError && <FieldError>{fieldError}</FieldError>}
        {formError && <FieldError>{formError}</FieldError>}
        {success && <FieldDescription>{success}</FieldDescription>}
        <Button type="submit" className="w-full" disabled={isLoading}>
          {isLoading ? "Resetting…" : "Reset password"}
        </Button>
      </FieldGroup>
    </form>
  )
}

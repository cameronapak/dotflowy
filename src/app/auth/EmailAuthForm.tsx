import { useState, type FormEvent } from "react"
import { useNavigate } from "react-router"
import { login, signup } from "wasp/client/auth"
import { Button } from "../../components/ui/button"
import { Input } from "../../components/ui/input"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "../../components/ui/field"

type Mode = "login" | "signup"

export function EmailAuthForm({ mode }: { mode: Mode }) {
  const navigate = useNavigate()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const isLogin = mode === "login"
  const submitLabel = isLogin ? "Log in" : "Sign up"
  const pendingLabel = isLogin ? "Logging in…" : "Signing up…"

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    setIsLoading(true)
    try {
      if (isLogin) {
        await login({ email, password })
        navigate("/")
      } else {
        await signup({ email, password })
        setSuccess(
          "You've signed up successfully! Check your email for the confirmation link.",
        )
        setEmail("")
        setPassword("")
      }
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
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            type="password"
            autoComplete={isLogin ? "current-password" : "new-password"}
            required
            disabled={isLoading}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!error}
          />
        </Field>
        {error && <FieldError>{error}</FieldError>}
        {success && <FieldDescription>{success}</FieldDescription>}
        <Button type="submit" className="w-full" disabled={isLoading}>
          {isLoading ? pendingLabel : submitLabel}
        </Button>
      </FieldGroup>
    </form>
  )
}

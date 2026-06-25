import { useEffect, useRef, useState } from "react"
import { useLocation } from "react-router"
import { verifyEmail } from "wasp/client/auth"
import { Skeleton } from "../../components/ui/skeleton"
import { FieldDescription, FieldError } from "../../components/ui/field"

export function VerifyEmailForm() {
  const location = useLocation()
  const token = new URLSearchParams(location.search).get("token")
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const startedForToken = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    if (startedForToken.current === token) return
    startedForToken.current = token

    async function run() {
      if (!token) {
        setError(
          "The token is missing from the URL. Please check the link you received in your email.",
        )
        setIsLoading(false)
        return
      }
      try {
        await verifyEmail({ token })
        setSuccess("Your email has been verified. You can now log in.")
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Something went wrong"
        setError(message)
      } finally {
        setIsLoading(false)
      }
    }

    void run()
  }, [token])

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    )
  }

  if (error) return <FieldError>{error}</FieldError>
  if (success) return <FieldDescription>{success}</FieldDescription>
  return null
}

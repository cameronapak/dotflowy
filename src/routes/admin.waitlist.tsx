import { useEffect, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Button } from '../components/ui/button'
import { buttonVariants } from '../components/ui/button-variants'

/**
 * Admin-only waitlist view. The REAL gate is server-side: GET /api/waitlist
 * requires a session whose email is on the Worker's ADMIN_EMAILS allowlist and
 * 404s otherwise — this page is just a renderer, so a non-admin who guesses
 * the URL sees the same "Not found" a bad route would give. Deliberately
 * unlinked from the app chrome.
 */

interface WaitlistEntry {
  email: string
  source: string
  createdAt: number
}

export const Route = createFileRoute('/admin/waitlist')({
  component: AdminWaitlist,
})

function AdminWaitlist() {
  const [entries, setEntries] = useState<WaitlistEntry[]>([])
  const [state, setState] = useState<'loading' | 'denied' | 'ready'>('loading')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/waitlist').then(
      async (res) => {
        if (cancelled) return
        if (!res.ok) {
          setState('denied')
          return
        }
        const data = (await res.json()) as { entries: WaitlistEntry[] }
        if (cancelled) return
        setEntries(data.entries)
        setState('ready')
      },
      () => {
        if (!cancelled) setState('denied')
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  if (state === 'loading') return null

  if (state === 'denied') {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background p-6">
        <p className="text-sm text-muted-foreground">Not found.</p>
      </main>
    )
  }

  async function copyEmails() {
    await navigator.clipboard.writeText(entries.map((e) => e.email).join('\n'))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <main className="mx-auto min-h-dvh w-full max-w-2xl bg-background p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Waitlist</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {entries.length === 1 ? '1 person' : `${entries.length} people`} waiting for an invite
          </p>
        </div>
        <div className="flex items-center gap-2">
          {entries.length > 0 && (
            <Button variant="outline" size="sm" onClick={copyEmails}>
              {copied ? 'Copied' : 'Copy emails'}
            </Button>
          )}
          <Link to="/" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            Back to outline
          </Link>
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nobody yet. Share the waitlist link.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Email</th>
              <th className="py-2 pr-4 font-medium">Source</th>
              <th className="py-2 font-medium">Joined</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.email} className="border-b border-border/50">
                <td className="py-2 pr-4">{entry.email}</td>
                <td className="py-2 pr-4 text-muted-foreground">{entry.source}</td>
                <td className="py-2 text-muted-foreground">
                  {new Date(entry.createdAt).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}

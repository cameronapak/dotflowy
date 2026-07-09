/// <reference types="@cloudflare/workers-types" />

/**
 * BSB chapter fetch for the passage-edit popover mini-reader.
 *
 * Upstream: free public-domain BSB via helloao
 * (`GET https://bible.helloao.org/api/BSB/{book}/{chapter}.json`).
 * The Worker is the only network hop so we can:
 *   - keep the client same-origin (session cookie rides for free)
 *   - Cache API across users (scripture is public; 30-day TTL)
 *   - never accept a free-form URL (book/chapter are validated in core)
 *
 * Failures collapse to `null` at the route — the popover keeps editing
 * references without BSB text (graceful degrade).
 */

import {
  type BsbBookCode,
  type BsbVerse,
  extractBsbVerses,
} from './bible-bsb-core'

export type { BsbBookCode, BsbVerse }
export { parseBsbBook, parseBsbChapter } from './bible-bsb-core'

const TIMEOUT_MS = 5_000
const CACHE_TTL_S = 60 * 60 * 24 * 30 // 30 days — BSB text doesn't change
const USER_AGENT = 'dotflowy-bot/1.0 (+https://app.dotflowy.com)'
// Generous for a chapter JSON (Psalm 119 with helloao formatting is well under
// this) while bounding what an off-course upstream can make us buffer.
const MAX_BYTES = 1024 * 1024

function upstreamUrl(book: BsbBookCode, chapter: number): string {
  return `https://bible.helloao.org/api/BSB/${book}/${chapter}.json`
}

/** Synthetic same-shape Request used as the Cache API key. */
function cacheKey(book: BsbBookCode, chapter: number): Request {
  return new Request(
    `https://bible-bsb-cache.dotflowy.invalid/${book}/${chapter}`,
  )
}

export type BsbChapterPayload = {
  book: BsbBookCode
  chapter: number
  verses: BsbVerse[]
}

/**
 * Fetch one BSB chapter as a compact verse list, or null on any failure
 * (network, timeout, non-200, empty/malformed body).
 */
export async function fetchBsbChapter(
  book: BsbBookCode,
  chapter: number,
): Promise<BsbChapterPayload | null> {
  const key = cacheKey(book, chapter)
  try {
    const cache = caches.default
    const hit = await cache.match(key)
    if (hit) {
      const body = (await hit.json()) as BsbChapterPayload
      if (body && Array.isArray(body.verses)) return body
    }
  } catch {
    // Cache API unavailable (local tests / misconfig) — fall through to fetch.
  }

  try {
    const res = await fetch(upstreamUrl(book, chapter), {
      method: 'GET',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // The host is fixed and shouldn't redirect; if it starts to, fail closed
      // rather than fetch (and cache cross-user) whatever it points at —
      // the unfurl hardening posture (ADR 0016).
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
    })
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('json')) return null
    const raw = await readJsonCapped(res, MAX_BYTES)
    const verses = extractBsbVerses(raw)
    if (verses.length === 0) return null
    const payload: BsbChapterPayload = { book, chapter, verses }

    try {
      const cache = caches.default
      await cache.put(
        key,
        new Response(JSON.stringify(payload), {
          headers: {
            'content-type': 'application/json',
            'cache-control': `public, max-age=${CACHE_TTL_S}`,
          },
        }),
      )
    } catch {
      // Non-fatal: serve the payload even if we couldn't cache it.
    }
    return payload
  } catch {
    return null
  }
}

/** Read at most `maxBytes` of the body and JSON-parse it; null when the body
 *  is missing, over the cap, or malformed. Bounds what a misbehaving upstream
 *  can make us buffer (res.json() reads without limit). */
async function readJsonCapped(
  res: Response,
  maxBytes: number,
): Promise<unknown> {
  const reader = res.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    buf.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(buf))
  } catch {
    return null
  }
}

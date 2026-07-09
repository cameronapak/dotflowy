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

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(upstreamUrl(book, chapter), {
      method: 'GET',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
    })
    if (!res.ok) return null
    const raw: unknown = await res.json()
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
  } finally {
    clearTimeout(timer)
  }
}

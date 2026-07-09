/**
 * Pure helpers for the BSB chapter proxy (`GET /api/bible/bsb`).
 * No Workers globals — unit-tested under `bun test`.
 *
 * Book codes are USFM/OSIS (same set grab-bcv + helloao use: JHN, 1CO, SNG…).
 * The Worker only accepts a known code so a session can't turn the route into
 * an open proxy against arbitrary helloao paths.
 */

/** Canonical 66-book OSIS/USFM codes, matching grab-bcv + helloao BSB. */
export const BSB_BOOK_CODES = [
  'GEN',
  'EXO',
  'LEV',
  'NUM',
  'DEU',
  'JOS',
  'JDG',
  'RUT',
  '1SA',
  '2SA',
  '1KI',
  '2KI',
  '1CH',
  '2CH',
  'EZR',
  'NEH',
  'EST',
  'JOB',
  'PSA',
  'PRO',
  'ECC',
  'SNG',
  'ISA',
  'JER',
  'LAM',
  'EZK',
  'DAN',
  'HOS',
  'JOL',
  'AMO',
  'OBA',
  'JON',
  'MIC',
  'NAM',
  'HAB',
  'ZEP',
  'HAG',
  'ZEC',
  'MAL',
  'MAT',
  'MRK',
  'LUK',
  'JHN',
  'ACT',
  'ROM',
  '1CO',
  '2CO',
  'GAL',
  'EPH',
  'PHP',
  'COL',
  '1TH',
  '2TH',
  '1TI',
  '2TI',
  'TIT',
  'PHM',
  'HEB',
  'JAS',
  '1PE',
  '2PE',
  '1JN',
  '2JN',
  '3JN',
  'JUD',
  'REV',
] as const

export type BsbBookCode = (typeof BSB_BOOK_CODES)[number]

const BOOK_SET = new Set<string>(BSB_BOOK_CODES)

/** True iff `raw` is a known OSIS/USFM book code (case-insensitive). */
export function parseBsbBook(raw: string | null): BsbBookCode | null {
  if (!raw) return null
  const code = raw.trim().toUpperCase()
  return BOOK_SET.has(code) ? (code as BsbBookCode) : null
}

/**
 * Parse a chapter query param. Chapters are 1-based positive integers; we only
 * bound the absurd range (helloao 404s anything past the book's max).
 */
export function parseBsbChapter(raw: string | null): number | null {
  if (!raw) return null
  if (!/^\d{1,3}$/.test(raw)) return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 200) return null
  return n
}

/** One verse as the API returns it to the client. */
export type BsbVerse = { n: number; t: string }

/**
 * Flatten one helloao verse `content` array into plain text (drop footnotes,
 * line-break markers, and inline headings).
 */
export function flattenVerseContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const part of content) {
    if (typeof part === 'string') {
      out += part
      continue
    }
    if (part && typeof part === 'object') {
      const obj = part as Record<string, unknown>
      if (typeof obj.text === 'string') out += obj.text
      // noteId / lineBreak / heading: skip
    }
  }
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * Pull ordered verses from a helloao chapter JSON body. Tolerates missing
 * fields (returns []) so a malformed upstream response never 500s the route.
 */
export function extractBsbVerses(body: unknown): BsbVerse[] {
  if (!body || typeof body !== 'object') return []
  const chapter = (body as { chapter?: unknown }).chapter
  if (!chapter || typeof chapter !== 'object') return []
  const content = (chapter as { content?: unknown }).content
  if (!Array.isArray(content)) return []

  const verses: BsbVerse[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const row = item as { type?: unknown; number?: unknown; content?: unknown }
    if (row.type !== 'verse') continue
    if (typeof row.number !== 'number' || !Number.isFinite(row.number)) continue
    const t = flattenVerseContent(row.content)
    if (!t) continue
    verses.push({ n: row.number, t })
  }
  return verses
}

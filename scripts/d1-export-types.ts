/** Wire format for Phase 4 D1 → Postgres migration (PRD US-5). */

export type D1NodeRow = {
  id: string
  owner: string
  parentId: string | null
  prevSiblingId: string | null
  text: string
  isTask: number
  completed: number
  collapsed: number
  bookmarkedAt: number | null
  createdAt: number
  updatedAt: number
}

export type D1TagColorRow = { tag: string; color: string }

export type D1DailyRow = { key: string; nodeId: string }

export type D1OwnerExport = {
  nodes: D1NodeRow[]
  tagColors: D1TagColorRow[]
  dailyIndex: D1DailyRow[]
}

/** JSON file written by `scripts/export-d1.sh`, read by `scripts/import-d1-export.ts`. */
export type D1ExportFile = {
  version: 1
  exportedAt: string
  databaseId: string
  owners: Record<string, D1OwnerExport>
}

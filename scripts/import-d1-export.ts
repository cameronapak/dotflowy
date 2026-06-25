#!/usr/bin/env bun
/**
 * Import a D1 JSON export (scripts/export-d1.sh) into a Wasp User's Postgres
 * silo (PRD Phase 4 / US-5). Dev-only — not exposed in the app UI.
 *
 * Usage:
 *   wasp compile
 *   bun scripts/import-d1-export.ts --file backups/d1-export.json --user-email you@example.com
 *
 * Options:
 *   --file <path>        D1 export JSON (required)
 *   --owner <legacy>     Legacy D1 owner key (default: "owner", else first in file)
 *   --user-id <uuid>     Target Wasp User.id (or use --user-email)
 *   --user-email <email> Look up User by signup email
 *   --force              Replace existing data for that user (destructive)
 */
import * as errore from 'errore'
import { readFileSync } from 'node:fs'
import { PrismaClient } from '@prisma/client'
import type {
  D1ExportFile,
  D1NodeRow,
  D1OwnerExport,
} from './d1-export-types'

type CliArgs = {
  file: string
  owner: string | null
  userId: string | null
  userEmail: string | null
  force: boolean
}

function parseArgs(argv: string[]): CliArgs | Error {
  let file: string | null = null
  let owner: string | null = null
  let userId: string | null = null
  let userEmail: string | null = null
  let force = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--force') {
      force = true
      continue
    }
    const next = argv[i + 1]
    if (arg === '--file' && next) {
      file = next
      i++
      continue
    }
    if (arg === '--owner' && next) {
      owner = next
      i++
      continue
    }
    if (arg === '--user-id' && next) {
      userId = next
      i++
      continue
    }
    if (arg === '--user-email' && next) {
      userEmail = next
      i++
      continue
    }
    if (arg === '--help' || arg === '-h') return new Error('help')
  }

  if (!file) return new Error('Missing --file <path>')
  if (!userId && !userEmail) return new Error('Pass --user-id or --user-email')
  if (userId && userEmail) return new Error('Pass only one of --user-id or --user-email')
  return { file, owner, userId, userEmail, force }
}

function printHelp(): void {
  console.log(`Usage:
  bun scripts/import-d1-export.ts --file backups/d1-export.json --user-email you@example.com [--owner owner] [--force]

Requires DATABASE_URL (from .env.server) and \`wasp compile\` first.`)
}

function loadExport(path: string): D1ExportFile | Error {
  const raw = errore.try(() => readFileSync(path, 'utf8'))
  if (raw instanceof Error) return raw
  const parsed = errore.try(() => JSON.parse(raw) as D1ExportFile)
  if (parsed instanceof Error) return parsed
  if (parsed.version !== 1 || !parsed.owners) return new Error('Invalid export file')
  return parsed
}

function pickOwner(exportFile: D1ExportFile, ownerArg: string | null): string | Error {
  const keys = Object.keys(exportFile.owners)
  if (keys.length === 0) return new Error('Export has no owners')
  if (ownerArg) {
    if (!exportFile.owners[ownerArg]) return new Error(`Owner "${ownerArg}" not in export`)
    return ownerArg
  }
  if (exportFile.owners.owner) return 'owner'
  return keys[0]!
}

async function resolveUserId(
  prisma: PrismaClient,
  userId: string | null,
  userEmail: string | null,
): Promise<string | Error> {
  if (userId) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
    if (!user) return new Error(`User id not found: ${userId}`)
    return user.id
  }
  const email = userEmail!.toLowerCase()
  const identity = await prisma.authIdentity.findFirst({
    where: { providerName: 'email', providerUserId: email },
    include: { auth: { include: { user: true } } },
  })
  if (!identity?.auth?.user) return new Error(`No Wasp user for email: ${email}`)
  return identity.auth.user.id
}

function nodeRowToCreate(row: D1NodeRow, userId: string) {
  return {
    id: row.id,
    userId,
    parentId: row.parentId,
    prevSiblingId: row.prevSiblingId,
    text: row.text,
    isTask: !!row.isTask,
    completed: !!row.completed,
    collapsed: !!row.collapsed,
    bookmarkedAt: row.bookmarkedAt == null ? null : new Date(row.bookmarkedAt),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  }
}

async function importOwnerData(
  prisma: PrismaClient,
  userId: string,
  data: D1OwnerExport,
  force: boolean,
): Promise<Error | { nodes: number; tagColors: number; dailyIndex: number }> {
  const existingNodes = await prisma.node.count({ where: { userId } })
  if (existingNodes > 0 && !force) {
    return new Error(
      `User already has ${existingNodes} node(s). Re-run with --force to replace.`,
    )
  }

  await prisma.$transaction(async (tx) => {
    if (force) {
      await tx.dailyIndexEntry.deleteMany({ where: { userId } })
      await tx.tagColor.deleteMany({ where: { userId } })
      await tx.node.deleteMany({ where: { userId } })
    }

    if (data.nodes.length) {
      await tx.node.createMany({ data: data.nodes.map((n) => nodeRowToCreate(n, userId)) })
    }
    if (data.tagColors.length) {
      await tx.tagColor.createMany({
        data: data.tagColors.map((r) => ({
          userId,
          tag: r.tag,
          color: r.color,
          updatedAt: new Date(),
        })),
      })
    }
    if (data.dailyIndex.length) {
      await tx.dailyIndexEntry.createMany({
        data: data.dailyIndex.map((r) => ({
          userId,
          key: r.key,
          nodeId: r.nodeId,
        })),
      })
    }
  })

  return {
    nodes: data.nodes.length,
    tagColors: data.tagColors.length,
    dailyIndex: data.dailyIndex.length,
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args instanceof Error) {
    if (args.message === 'help') printHelp()
    else console.error(args.message)
    process.exit(args.message === 'help' ? 0 : 1)
  }

  const exportFile = loadExport(args.file)
  if (exportFile instanceof Error) {
    console.error(`Failed to read export: ${exportFile.message}`)
    process.exit(1)
  }

  const owner = pickOwner(exportFile, args.owner)
  if (owner instanceof Error) {
    console.error(owner.message)
    process.exit(1)
  }

  const data = exportFile.owners[owner]
  if (!data) {
    console.error(`Missing owner payload: ${owner}`)
    process.exit(1)
  }

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set (copy .env.server.example → .env.server)')
    process.exit(1)
  }

  const prisma = new PrismaClient()
  try {
    const userId = await resolveUserId(prisma, args.userId, args.userEmail)
    if (userId instanceof Error) {
      console.error(userId.message)
      process.exit(1)
    }

    const result = await importOwnerData(prisma, userId, data, args.force)
    if (result instanceof Error) {
      console.error(result.message)
      process.exit(1)
    }

    console.log(
      `Imported owner "${owner}" → user ${userId}: ` +
        `${result.nodes} nodes, ${result.tagColors} tag colors, ${result.dailyIndex} daily index rows`,
    )
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

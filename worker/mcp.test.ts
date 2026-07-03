/**
 * The MCP endpoint (worker/mcp.ts + worker/mcp-tools.ts) against an in-memory
 * `OutlineStore` fake — the same seam the DO stub satisfies in production.
 * Unit-tested here because the whole surface is request/response-pure below
 * auth: JSON-RPC dispatch, the Effect-Schema tool-input gate (ADR 0014 — the
 * published schema and the enforcing decoder are one value), and the tool
 * handlers' plan->applyBatch flow. e2e can't reach any of it (`seedOutline`
 * mocks the Worker, and MCP has no browser caller).
 */

import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { makeNode } from '../src/data/tree'
import { handleMcp } from './mcp'
import type { OutlineStore } from './mcp-tools'
import type { ChangeOp, Node } from '../src/data/wire-schema'

// --- In-memory store fake -----------------------------------------------------

interface FakeStore {
  store: OutlineStore
  nodes: Map<string, Node>
  kv: Map<string, { key: string; nodeId: string }>
  batches: ChangeOp[][]
}

function makeStore(seed: Node[] = [], kvRows: Array<{ key: string; nodeId: string }> = []): FakeStore {
  const nodes = new Map(seed.map((n) => [n.id, n]))
  const kv = new Map(kvRows.map((r) => [r.key, r]))
  const batches: ChangeOp[][] = []
  const store: OutlineStore = {
    getNodes: () => [...nodes.values()],
    applyBatch: (ops) => {
      batches.push([...ops])
      for (const op of ops) {
        if (op.op === 'delete') nodes.delete(op.key)
        else nodes.set(op.value.id, op.value)
      }
      return batches.length
    },
    getKv: (collection) => (collection === 'daily-index' ? [...kv.values()] : []),
    getOrCreateKv: (collection, key, value) => {
      if (collection !== 'daily-index') throw new Error(`unexpected kv collection ${collection}`)
      const existing = kv.get(key)
      if (existing) return existing
      kv.set(key, value as { key: string; nodeId: string })
      return value
    },
  }
  return { store, nodes, kv, batches }
}

// --- Request plumbing -----------------------------------------------------------

// Each test request is its own stateless HTTP exchange, so a fixed id is fine.
async function rpc(
  store: OutlineStore,
  method: string,
  params?: unknown,
  id: number | null = 1,
  // The provenance stamp the Worker resolves from the bearer token in prod; a
  // fixed harness name here so the stamping assertions have something to check.
  origin: string | null = 'TestAgent',
) {
  const body: Record<string, unknown> = { jsonrpc: '2.0', method }
  if (id !== null) body['id'] = id
  if (params !== undefined) body['params'] = params
  const request = new Request('http://test/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return Effect.runPromise(handleMcp(request, store, origin))
}

async function callTool(store: OutlineStore, name: string, args: unknown) {
  const res = await rpc(store, 'tools/call', { name, arguments: args })
  const json = (await res.json()) as {
    result?: { content: Array<{ type: string; text: string }>; isError?: boolean }
    error?: { code: number; message: string }
  }
  return json
}

function toolText(json: Awaited<ReturnType<typeof callTool>>): string {
  return json.result?.content[0]?.text ?? ''
}

/** a -> b (top level), a1 under a. */
function fixture(): Node[] {
  return [
    makeNode({ id: 'a', text: 'alpha' }),
    makeNode({ id: 'b', text: 'bravo', prevSiblingId: 'a' }),
    makeNode({ id: 'a1', text: 'alpha one', parentId: 'a' }),
  ]
}

// --- Protocol level -------------------------------------------------------------

describe('MCP transport', () => {
  test('initialize echoes a supported protocol version and advertises tools', async () => {
    const { store } = makeStore()
    const res = await rpc(store, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })
    const json = (await res.json()) as any
    expect(json.result.protocolVersion).toBe('2025-03-26')
    expect(json.result.capabilities.tools).toBeDefined()
    expect(json.result.serverInfo.name).toBe('dotflowy')
  })

  test('an unknown requested protocol version is countered with the latest', async () => {
    const { store } = makeStore()
    const json = (await (await rpc(store, 'initialize', { protocolVersion: '1999-01-01' })).json()) as any
    expect(json.result.protocolVersion).toBe('2025-06-18')
  })

  test('notifications get 202 and no body', async () => {
    const { store } = makeStore()
    const res = await rpc(store, 'notifications/initialized', undefined, null)
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
  })

  test('ping pongs', async () => {
    const { store } = makeStore()
    const json = (await (await rpc(store, 'ping')).json()) as any
    expect(json.result).toEqual({})
  })

  test('tools/list publishes JSON Schema derived from the Effect Schema inputs', async () => {
    const { store } = makeStore()
    const json = (await (await rpc(store, 'tools/list')).json()) as any
    const names = json.result.tools.map((t: any) => t.name)
    expect(names).toEqual([
      'get_outline',
      'search_nodes',
      'add_node',
      'update_node',
      'delete_node',
      'add_to_today',
      'mirror_node',
      'mirror_to_today',
    ])
    const addNode = json.result.tools.find((t: any) => t.name === 'add_node')
    expect(addNode.inputSchema.type).toBe('object')
    expect(addNode.inputSchema.required).toEqual(['text'])
    expect(addNode.annotations.readOnlyHint).toBe(false)
    const getOutline = json.result.tools.find((t: any) => t.name === 'get_outline')
    expect(getOutline.annotations.readOnlyHint).toBe(true)
  })

  test('unknown method is -32601, unknown tool and bad args are -32602', async () => {
    const { store } = makeStore()
    expect(((await (await rpc(store, 'resources/list')).json()) as any).error.code).toBe(-32601)
    expect((await callTool(store, 'not_a_tool', {})).error?.code).toBe(-32602)
    expect((await callTool(store, 'add_node', { text: 42 })).error?.code).toBe(-32602)
  })

  test('malformed JSON is -32700 and a batch array is -32600', async () => {
    const { store } = makeStore()
    const bad = await Effect.runPromise(
      handleMcp(new Request('http://test/api/mcp', { method: 'POST', body: '{nope' }), store, null),
    )
    expect(((await bad.json()) as any).error.code).toBe(-32700)

    const batch = await Effect.runPromise(
      handleMcp(
        new Request('http://test/api/mcp', { method: 'POST', body: '[]' }),
        store,
        null,
      ),
    )
    expect(((await batch.json()) as any).error.code).toBe(-32600)
  })

  test('GET is declined with 405 (stateless: no server stream)', async () => {
    const { store } = makeStore()
    const res = await Effect.runPromise(
      handleMcp(new Request('http://test/api/mcp', { method: 'GET' }), store, null),
    )
    expect(res.status).toBe(405)
  })
})

// --- Tools over the fake store ----------------------------------------------------

describe('MCP tools', () => {
  test('get_outline renders lines with ids; search_nodes finds by substring', async () => {
    const { store } = makeStore(fixture())
    const outline = toolText(await callTool(store, 'get_outline', {}))
    expect(outline).toContain('- alpha (id: a)')
    expect(outline).toContain('  - alpha one (id: a1)')

    const hits = toolText(await callTool(store, 'search_nodes', { query: 'one' }))
    expect(hits).toContain('(id: a1)')
    expect(hits).toContain('in: alpha')
  })

  test('add_node writes one atomic batch and reports the new id', async () => {
    const fake = makeStore(fixture())
    const json = await callTool(fake.store, 'add_node', { text: 'new bullet', parentId: 'a' })
    expect(json.result?.isError).toBeUndefined()
    expect(fake.batches).toHaveLength(1)
    const insert = fake.batches[0]!.find((op) => op.op === 'insert')
    expect(insert && insert.op === 'insert' && insert.value.parentId).toBe('a')
    // Provenance: the resolved harness name is stamped onto the created node, so
    // the editor can mark an agent's edit apart from the user's own (write-once).
    expect(insert && insert.op === 'insert' && insert.value.origin).toBe('TestAgent')
    expect(toolText(json)).toContain('Added "new bullet"')
  })

  test('update_node edits fields; delete_node cascades', async () => {
    const fake = makeStore(fixture())
    await callTool(fake.store, 'update_node', { nodeId: 'a1', completed: true })
    expect(fake.nodes.get('a1')?.completed).toBe(true)

    const json = await callTool(fake.store, 'delete_node', { nodeId: 'a' })
    expect(toolText(json)).toContain('Deleted 2 node(s)')
    expect(fake.nodes.has('a')).toBe(false)
    expect(fake.nodes.has('a1')).toBe(false)
    expect(fake.nodes.get('b')?.prevSiblingId).toBeNull()
  })

  test('update_node with no fields is a tool error, not a crash', async () => {
    const { store } = makeStore(fixture())
    const json = await callTool(store, 'update_node', { nodeId: 'a1' })
    expect(json.result?.isError).toBe(true)
    expect(toolText(json)).toContain('nothing to change')
  })

  test('add_to_today creates the Daily container, the day, and the entry on first use', async () => {
    const fake = makeStore(fixture())
    const json = await callTool(fake.store, 'add_to_today', {
      text: 'captured',
      date: '2026-07-03',
    })
    expect(json.result?.isError).toBeUndefined()
    expect(fake.kv.get('container')).toBeDefined()
    expect(fake.kv.get('2026-07-03')).toBeDefined()
    const containerId = fake.kv.get('container')!.nodeId
    const dayId = fake.kv.get('2026-07-03')!.nodeId
    expect(fake.nodes.get(containerId)?.text).toBe('Daily')
    expect(fake.nodes.get(dayId)?.parentId).toBe(containerId)
    const entry = [...fake.nodes.values()].find((n) => n.text === 'captured')
    expect(entry?.parentId).toBe(dayId)
    // One structural mutation = ONE batch (ADR 0009).
    expect(fake.batches).toHaveLength(1)
  })

  test('add_to_today reuses an existing day (the kv claim is authoritative)', async () => {
    const fake = makeStore(fixture())
    await callTool(fake.store, 'add_to_today', { text: 'first', date: '2026-07-03' })
    const dayId = fake.kv.get('2026-07-03')!.nodeId
    await callTool(fake.store, 'add_to_today', { text: 'second', date: '2026-07-03' })
    expect(fake.kv.get('2026-07-03')!.nodeId).toBe(dayId)
    const entries = [...fake.nodes.values()].filter((n) => n.parentId === dayId)
    expect(entries.map((n) => n.text).sort()).toEqual(['first', 'second'])
    // "second" chains after "first".
    const second = entries.find((n) => n.text === 'second')!
    const first = entries.find((n) => n.text === 'first')!
    expect(second.prevSiblingId).toBe(first.id)
  })

  test('add_to_today rejects a malformed date', async () => {
    const { store } = makeStore(fixture())
    const json = await callTool(store, 'add_to_today', { text: 'x', date: '07/03/2026' })
    expect(json.result?.isError).toBe(true)
    expect(toolText(json)).toContain('YYYY-MM-DD')
  })

  test('mirror_node mirrors with a live pointer; mirror cycle is refused', async () => {
    const fake = makeStore(fixture())
    const json = await callTool(fake.store, 'mirror_node', { nodeId: 'a1', parentId: 'b' })
    expect(json.result?.isError).toBeUndefined()
    const mirror = [...fake.nodes.values()].find((n) => n.mirrorOf === 'a1')
    expect(mirror?.parentId).toBe('b')

    const cycle = await callTool(fake.store, 'mirror_node', { nodeId: 'a', parentId: 'a1' })
    expect(cycle.result?.isError).toBe(true)
    expect(toolText(cycle)).toContain('cycle')
  })

  test('mirror_to_today mirrors onto the day note', async () => {
    const fake = makeStore(fixture())
    const json = await callTool(fake.store, 'mirror_to_today', { nodeId: 'a1', date: '2026-07-03' })
    expect(json.result?.isError).toBeUndefined()
    const dayId = fake.kv.get('2026-07-03')!.nodeId
    const mirror = [...fake.nodes.values()].find((n) => n.mirrorOf === 'a1')
    expect(mirror?.parentId).toBe(dayId)
    expect(toolText(json)).toContain('Friday, July 3, 2026')
  })

  test('the daily container is protected from delete, blanking, and completing', async () => {
    const fake = makeStore(fixture())
    await callTool(fake.store, 'add_to_today', { text: 'x', date: '2026-07-03' })
    const containerId = fake.kv.get('container')!.nodeId

    const del = await callTool(fake.store, 'delete_node', { nodeId: containerId })
    expect(del.result?.isError).toBe(true)
    expect(fake.nodes.has(containerId)).toBe(true)

    const blank = await callTool(fake.store, 'update_node', { nodeId: containerId, text: '  ' })
    expect(blank.result?.isError).toBe(true)
    expect(fake.nodes.get(containerId)?.text).toBe('Daily')

    const complete = await callTool(fake.store, 'update_node', {
      nodeId: containerId,
      completed: true,
    })
    expect(complete.result?.isError).toBe(true)

    // Collapse is a position-local field and stays allowed.
    const collapse = await callTool(fake.store, 'update_node', {
      nodeId: containerId,
      collapsed: true,
    })
    expect(collapse.result?.isError).toBeUndefined()
  })

  test('deleting an ancestor of surviving mirrors is refused (ADR 0022 v1 protects)', async () => {
    const fake = makeStore([
      ...fixture(),
      makeNode({ id: 'm', text: 'alpha one', mirrorOf: 'a1', prevSiblingId: 'b' }),
    ])
    const json = await callTool(fake.store, 'delete_node', { nodeId: 'a' })
    expect(json.result?.isError).toBe(true)
    expect(toolText(json)).toContain('orphan')
    expect(fake.nodes.has('a')).toBe(true)
  })

  test('a tool-level failure surfaces as isError, never a protocol error', async () => {
    const { store } = makeStore(fixture())
    const json = await callTool(store, 'delete_node', { nodeId: 'ghost' })
    expect(json.error).toBeUndefined()
    expect(json.result?.isError).toBe(true)
    expect(toolText(json)).toContain('not found')
  })

  test('a store fault becomes -32603 without leaking internals', async () => {
    const broken: OutlineStore = {
      getNodes: () => {
        throw new Error('secret D1 connection string')
      },
      applyBatch: () => 0,
      getKv: () => [],
      getOrCreateKv: () => ({}),
    }
    const json = await callTool(broken, 'get_outline', {})
    expect(json.error?.code).toBe(-32603)
    expect(JSON.stringify(json)).not.toContain('secret')
  })
})

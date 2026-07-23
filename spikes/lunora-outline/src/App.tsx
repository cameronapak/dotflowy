import { useMutator } from "@lunora/react";
import { useLiveQuery } from "@tanstack/react-db";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";

import { authClient } from "./auth-client.js";
import { createOutlineStore, type NodeRow } from "./outline-store.js";
import {
  bridgeOrderedChildren,
  bridgeTreeIndex,
  seedEmptyOutline,
  shouldSeedOutline,
  type OutlineNode,
} from "./outline/index.js";
import { useLunoraClient } from "./use-lunora-client.js";

function newId(): string {
  return crypto.randomUUID();
}

function AuthGate({ children }: { children: (userId: string) => ReactNode }) {
  const session = authClient.useSession();
  const [email, setEmail] = useState("spike@dotflowy.local");
  const [password, setPassword] = useState("spike-dev-password");
  const [name, setName] = useState("Spike");
  const [error, setError] = useState<string | null>(null);

  if (session.isPending) {
    return <main style={page}>Loading session…</main>;
  }

  const userId = session.data?.user?.id;
  if (userId) {
    return <>{children(userId)}</>;
  }

  const onSignIn = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const result = await authClient.signIn.email({ email, password });
    if (result.error) setError(result.error.message ?? "sign-in failed");
  };

  const onSignUp = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const result = await authClient.signUp.email({ email, password, name });
    if (result.error) setError(result.error.message ?? "sign-up failed");
  };

  return (
    <main style={page}>
      <h1>Lunora outline spike</h1>
      <p style={{ color: "#666", maxWidth: 480 }}>
        Sign up once, then open a second tab signed in as the same user to prove
        live sync. Hard reload should restore the outline from the shape. An
        empty outline seeds a few demo bullets once.
      </p>
      <form onSubmit={onSignIn} style={form}>
        <h2>Sign in</h2>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email"
          type="email"
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password"
          type="password"
        />
        <button type="submit">Sign in</button>
      </form>
      <form onSubmit={onSignUp} style={form}>
        <h2>Or sign up</h2>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="name"
        />
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email"
          type="email"
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password"
          type="password"
        />
        <button type="submit">Sign up</button>
      </form>
      {error ? <p style={{ color: "crimson" }}>{error}</p> : null}
    </main>
  );
}

function OutlineApp({ userId }: { userId: string }) {
  const client = useLunoraClient();
  const store = useMemo(
    () => createOutlineStore(client, userId),
    [client, userId],
  );

  const {
    data: rows,
    isLoading,
    status,
  } = useLiveQuery((q) => q.from({ n: store.collection }));

  const list = (rows as NodeRow[] | undefined) ?? [];
  const nodeCount = list.length;

  // ADR 0004 seam: Lunora rows → TreeIndex (feed tree-store later).
  const tree = useMemo(
    () => bridgeTreeIndex((rows as NodeRow[] | undefined) ?? []),
    [rows],
  );
  const orderedTop = useMemo(() => bridgeOrderedChildren(tree, null), [tree]);

  const { mutate: insertSibling } = useMutator(store.mutators.insertSibling);
  const { mutate: indent } = useMutator(store.mutators.indent);
  const { mutate: outdent } = useMutator(store.mutators.outdent);
  const { mutate: removeNode } = useMutator(store.mutators.removeNode);
  const { mutate: setText } = useMutator(store.mutators.setText);

  const [draft, setDraft] = useState("");
  const [afterId, setAfterId] = useState<string | null>(null);
  const seedStarted = useRef(false);

  const isReady = !isLoading && status === "ready";

  useEffect(() => {
    if (seedStarted.current) return;
    if (!shouldSeedOutline({ isReady, nodeCount })) return;
    seedStarted.current = true;
    void seedEmptyOutline({
      userId,
      insertSibling: (args) => insertSibling(args),
      newId,
    }).catch((err) => {
      seedStarted.current = false;
      console.error("seedEmptyOutline failed", err);
    });
  }, [isReady, nodeCount, userId, insertSibling]);

  const addBullet = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim() || "untitled";
    const now = Date.now();
    const id = newId();
    setDraft("");
    await insertSibling({
      id,
      userId,
      parentId: null,
      afterId,
      text,
      createdAt: now,
      updatedAt: now,
    });
    setAfterId(id);
  };

  const renderRow = (node: OutlineNode, depth: number) => {
    const kids = bridgeOrderedChildren(tree, node.id);
    return (
      <li key={node.id} style={{ listStyle: "none", marginLeft: depth * 16 }}>
        <div style={row}>
          <input
            value={node.text}
            onChange={(e) => {
              const text = e.target.value;
              void setText({
                id: node.id,
                userId,
                text,
                updatedAt: Date.now(),
              });
            }}
            style={{ flex: 1, font: "inherit", padding: 4 }}
          />
          <button
            type="button"
            title="Insert sibling below"
            onClick={() => setAfterId(node.id)}
          >
            +after
          </button>
          <button
            type="button"
            onClick={() =>
              void indent({ id: node.id, userId, updatedAt: Date.now() })
            }
          >
            indent
          </button>
          <button
            type="button"
            onClick={() =>
              void outdent({ id: node.id, userId, updatedAt: Date.now() })
            }
          >
            outdent
          </button>
          <button
            type="button"
            onClick={() =>
              void removeNode({ id: node.id, userId, updatedAt: Date.now() })
            }
          >
            delete
          </button>
        </div>
        {kids.length > 0 ? (
          <ul style={{ margin: 0, padding: 0 }}>
            {kids.map((child) => renderRow(child, depth + 1))}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <main style={page}>
      <header style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Outline spike</h1>
        <span style={{ color: "#666", fontSize: 12 }}>user {userId}</span>
        <button
          type="button"
          style={{ marginLeft: "auto" }}
          onClick={() => void authClient.signOut()}
        >
          Sign out
        </button>
      </header>
      <p style={{ color: "#666", fontSize: 13 }}>
        Insert after: <code>{afterId ?? "(head)"}</code> · open a second tab to
        watch live sync
        {isLoading ? " · loading…" : null}
      </p>
      <form onSubmit={addBullet} style={{ display: "flex", gap: 8 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="New bullet text"
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit">Insert</button>
        <button type="button" onClick={() => setAfterId(null)}>
          Insert at head
        </button>
      </form>
      <ul style={{ marginTop: 16, padding: 0 }}>
        {orderedTop.map((n) => renderRow(n, 0))}
      </ul>
      {isLoading ? (
        <p style={{ color: "#999" }}>Loading outline…</p>
      ) : orderedTop.length === 0 ? (
        <p style={{ color: "#999" }}>Seeding demo bullets…</p>
      ) : null}
    </main>
  );
}

export default function App() {
  return <AuthGate>{(userId) => <OutlineApp userId={userId} />}</AuthGate>;
}

const page: CSSProperties = {
  maxWidth: 720,
  margin: "2rem auto",
  padding: 16,
  fontFamily: "system-ui, sans-serif",
};

const form: CSSProperties = {
  display: "grid",
  gap: 8,
  maxWidth: 320,
  marginBottom: 16,
};

const row: CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  padding: "4px 0",
};

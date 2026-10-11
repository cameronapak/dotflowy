// The fixture routes in capture-real-worker.ts accept this body. It lives on
// its own so capture-real.test.ts can import it without typechecking the
// whole Worker graph.
export type FixtureInput = {
  userId: string;
  password?: string;
  name?: string;
  expiry?: "never" | "30d" | "90d" | "1y";
  expiresAt?: number | null;
  attemptId?: string;
  date?: string;
  text?: string;
  fingerprint?: string;
  limit?: number | null;
  nodeId?: string;
  updatedText?: string;
  expected?: string;
  id?: string;
  sessionCreatedAt?: number;
  authorization?: string;
  now?: number;
  manageMethod?: "GET" | "POST" | "DELETE";
  manageBody?: unknown;
  origin?: string;
};

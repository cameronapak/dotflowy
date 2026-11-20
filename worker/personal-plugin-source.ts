// Version storage for personal plugins: one Cloudflare Artifacts repo per
// plugin, `<doName>.<pluginId>`, holding `plugin.json` (ADR 0095). Every save
// is a commit, so history is never trimmed and an active version can't be
// evicted. The binding reads history and files; writes go through
// isomorphic-git with an in-memory filesystem, because the binding has no
// write method.
//
// Concurrency: a push is a compare-and-swap on the branch. Two saves that
// start from the same head can't both land; the loser gets `conflict` and the
// agent retries against the new head.

import { Schema } from "effect";

export const DEFINITION_PATH = "plugin.json";

export interface SourceVersion {
  version: string;
  note: string;
  createdAt: string;
}

export type CommitResult =
  | { ok: true; version: string }
  | { ok: false; conflict: true; head: string | null };

/** Where definitions and their history live. Artifacts in production; an
 *  in-memory fake in tests. */
export interface PluginSource {
  /** Commit `content` on top of the repo's head, creating the repo on first
   *  save. With `base`, refuse unless the head is still `base`. */
  commit(
    repo: string,
    content: string,
    note: string,
    base?: string,
  ): Promise<CommitResult>;
  /** Newest first. Empty when the repo does not exist. */
  history(repo: string, limit?: number): Promise<SourceVersion[]>;
  /** The definition JSON at a version, or null. */
  read(repo: string, version: string): Promise<string | null>;
  /** Delete the repo and its whole history. */
  remove(repo: string): Promise<void>;
}

const BRANCH = "main";
const AUTHOR = {
  name: "Dotflowy personal plugins",
  email: "plugins@dotflowy.com",
};

const isNotFound = Schema.is(
  Schema.Struct({ code: Schema.Literal("NOT_FOUND") }),
);

export function artifactsSource(artifacts: Artifacts): PluginSource {
  /** A short-lived write token for one repo, created or fetched. */
  const writable = async (repo: string) => {
    try {
      using handle = await artifacts.get(repo);
      const info = await handle.info();
      const token = await handle.createToken("write", 300);
      return { remote: info.remote, token: token.plaintext, created: false };
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const created = await artifacts.create(repo, {
        description: "Dotflowy personal plugin",
        setDefaultBranch: BRANCH,
      });
      return { remote: created.remote, token: created.token, created: true };
    }
  };

  return {
    async commit(repo, content, note, base) {
      // Loaded only to save: it is large, and page loads never need it.
      const [{ default: git }, { default: http }] = await Promise.all([
        import("isomorphic-git"),
        import("isomorphic-git/http/web"),
      ]);
      const { remote, token, created } = await writable(repo);
      // Tokens carry `?expires=`; Git basic auth takes only the secret.
      const onAuth = () => ({ username: "x", password: token.split("?")[0]! });
      let fs = new MemoryFS();
      const dir = "/plugin";
      let head: string | null = null;
      if (!created) {
        try {
          await git.clone({
            fs,
            http,
            dir,
            url: remote,
            ref: BRANCH,
            singleBranch: true,
            depth: 1,
            noCheckout: true,
            onAuth,
          });
          head = await git.resolveRef({ fs, dir, ref: BRANCH });
        } catch {
          // An empty repo has no branch to clone yet. Start clean: a failed
          // clone can leave a half-made .git behind.
          head = null;
          fs = new MemoryFS();
        }
      }
      if (base !== undefined && base !== head)
        return { ok: false, conflict: true, head };
      if (head === null) await git.init({ fs, dir, defaultBranch: BRANCH });
      await fs.promises.writeFile(`${dir}/${DEFINITION_PATH}`, content);
      await git.add({ fs, dir, filepath: DEFINITION_PATH });
      const version = await git.commit({
        fs,
        dir,
        message: note || "Update plugin",
        author: AUTHOR,
      });
      try {
        const push = await git.push({
          fs,
          http,
          dir,
          url: remote,
          ref: BRANCH,
          onAuth,
        });
        if (!push.ok) return { ok: false, conflict: true, head };
      } catch (error) {
        // The branch moved: another save landed first. The server refuses
        // the ref update (GitPushError), or the client sees a
        // non-fast-forward (PushRejectedError).
        if (
          error instanceof Error &&
          (error.name === "GitPushError" || error.name === "PushRejectedError")
        )
          return { ok: false, conflict: true, head };
        throw error;
      }
      return { ok: true, version };
    },

    async history(repo, limit = 50) {
      try {
        using handle = await artifacts.get(repo);
        const log = await handle.log({ ref: BRANCH, limit });
        return log.map((c) => ({
          version: c.hash,
          note: c.message.trim(),
          createdAt: new Date(c.committedAt * 1000).toISOString(),
        }));
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
    },

    async read(repo, version) {
      try {
        using handle = await artifacts.get(repo);
        const file = await handle.readFile({
          ref: version,
          path: DEFINITION_PATH,
        });
        return file ? await file.text() : null;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async remove(repo) {
      await artifacts.delete(repo);
    },
  };
}

// --- In-memory filesystem for isomorphic-git ---------------------------------
// Adapted from Cloudflare's Artifacts isomorphic-git example.

type Entry =
  | { kind: "dir"; children: Set<string>; mtimeMs: number }
  | { kind: "file"; data: Uint8Array; mtimeMs: number };

class MemoryStats {
  constructor(private entry: Entry) {}
  get size() {
    return this.entry.kind === "file" ? this.entry.data.byteLength : 0;
  }
  get mtimeMs() {
    return this.entry.mtimeMs;
  }
  get ctimeMs() {
    return this.entry.mtimeMs;
  }
  get mode() {
    return this.entry.kind === "file" ? 0o100644 : 0o040000;
  }
  isFile() {
    return this.entry.kind === "file";
  }
  isDirectory() {
    return this.entry.kind === "dir";
  }
  isSymbolicLink() {
    return false;
  }
}

const fsError = (code: string, path: string) =>
  Object.assign(new Error(`${code}: ${path}`), { code });

class MemoryFS {
  private entries = new Map<string, Entry>([
    ["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }],
  ]);
  promises = {
    readFile: this.readFile.bind(this),
    writeFile: this.writeFile.bind(this),
    unlink: this.unlink.bind(this),
    readdir: this.readdir.bind(this),
    mkdir: this.mkdir.bind(this),
    rmdir: this.rmdir.bind(this),
    stat: this.stat.bind(this),
    lstat: this.stat.bind(this),
    // isomorphic-git binds these; a plugin repo never holds links.
    readlink: async (path: string) => {
      throw fsError("ENOENT", path);
    },
    symlink: async (_target: string, path: string) => {
      throw fsError("ENOTSUP", path);
    },
  };

  private normalize(input: string) {
    const parts: string[] = [];
    for (const part of input.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return `/${parts.join("/")}`;
  }
  private parent(path: string) {
    const parts = this.normalize(path).split("/").filter(Boolean);
    parts.pop();
    return `/${parts.join("/")}`;
  }
  private base(path: string) {
    return this.normalize(path).split("/").filter(Boolean).pop() ?? "";
  }
  private entry(path: string) {
    const entry = this.entries.get(this.normalize(path));
    if (!entry) throw fsError("ENOENT", path);
    return entry;
  }
  private dir(path: string) {
    const entry = this.entry(path);
    if (entry.kind !== "dir") throw fsError("ENOTDIR", path);
    return entry;
  }

  async mkdir(path: string, options?: { recursive?: boolean }) {
    const target = this.normalize(path);
    if (target === "/" || this.entries.has(target)) return;
    const parent = this.parent(target);
    if (!this.entries.has(parent)) {
      if (!(options instanceof Object && options.recursive))
        throw fsError("ENOENT", parent);
      await this.mkdir(parent, { recursive: true });
    }
    this.entries.set(target, {
      kind: "dir",
      children: new Set(),
      mtimeMs: Date.now(),
    });
    this.dir(parent).children.add(this.base(target));
  }
  async writeFile(path: string, data: string | Uint8Array) {
    const target = this.normalize(path);
    await this.mkdir(this.parent(target), { recursive: true });
    this.entries.set(target, {
      kind: "file",
      data: data instanceof Uint8Array ? data : new TextEncoder().encode(data),
      mtimeMs: Date.now(),
    });
    this.dir(this.parent(target)).children.add(this.base(target));
  }
  async readFile(path: string, options?: string | { encoding?: string }) {
    const entry = this.entry(path);
    if (entry.kind !== "file") throw fsError("EISDIR", path);
    const encoding = options instanceof Object ? options.encoding : options;
    return encoding ? new TextDecoder().decode(entry.data) : entry.data;
  }
  async readdir(path: string) {
    return [...this.dir(path).children].sort();
  }
  async unlink(path: string) {
    const target = this.normalize(path);
    if (this.entry(target).kind !== "file") throw fsError("EISDIR", path);
    this.entries.delete(target);
    this.dir(this.parent(target)).children.delete(this.base(target));
  }
  async rmdir(path: string) {
    const target = this.normalize(path);
    if (this.dir(target).children.size) throw fsError("ENOTEMPTY", path);
    this.entries.delete(target);
    this.dir(this.parent(target)).children.delete(this.base(target));
  }
  async stat(path: string) {
    return new MemoryStats(this.entry(path));
  }
}

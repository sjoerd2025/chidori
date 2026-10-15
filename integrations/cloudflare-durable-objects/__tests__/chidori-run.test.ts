import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import worker, { ChidoriRun, constantTimeEqual, etag, type Env } from "../src/index.js";

/** In-memory SQLite storage mock matching Cloudflare DurableObjectStorage.sql interface. */
class MockSqlStorage {
  private records = new Map<number, { seq: number; pos: number; data: string }>();
  private blobs = new Map<string, ArrayBuffer>();
  private registry = new Map<string, string>();
  private runs = new Set<string>();

  readonly sql = {
    exec: (query: string, ...params: unknown[]) => {
      const q = query.trim().replace(/\s+/g, " ");

      // DDL: CREATE TABLE IF NOT EXISTS
      if (q.startsWith("CREATE TABLE")) {
        return { toArray: () => [], one: () => ({}) };
      }

      // RECORDS
      if (q.startsWith("SELECT MAX(pos) AS m FROM records")) {
        let maxPos: number | null = null;
        for (const r of this.records.values()) {
          if (maxPos === null || r.pos > maxPos) maxPos = r.pos;
        }
        return {
          toArray: () => [{ m: maxPos }],
          one: () => ({ m: maxPos }),
        };
      }

      if (q.startsWith("SELECT data FROM records ORDER BY pos, seq")) {
        const sorted = Array.from(this.records.values()).sort((a, b) => {
          if (a.pos !== b.pos) return a.pos - b.pos;
          return a.seq - b.seq;
        });
        const rows = sorted.map((r) => ({ data: r.data }));
        return {
          toArray: () => rows,
          one: () => rows[0] ?? {},
        };
      }

      if (q.startsWith("INSERT INTO records (seq, pos, data)")) {
        const [seq, pos, data] = params as [number, number, string];
        this.records.set(seq, { seq, pos, data });
        return { toArray: () => [], one: () => ({}) };
      }

      if (q.startsWith("DELETE FROM records")) {
        this.records.clear();
        return { toArray: () => [], one: () => ({}) };
      }

      // BLOBS
      if (q.startsWith("SELECT key FROM blobs ORDER BY key")) {
        const keys = Array.from(this.blobs.keys()).sort().map((k) => ({ key: k }));
        return {
          toArray: () => keys,
          one: () => keys[0] ?? {},
        };
      }

      if (q.startsWith("SELECT data FROM blobs WHERE key = ?")) {
        const [key] = params as [string];
        const data = this.blobs.get(key);
        const rows = data !== undefined ? [{ data }] : [];
        return {
          toArray: () => rows,
          one: () => rows[0] ?? {},
        };
      }

      if (q.startsWith("INSERT INTO blobs (key, data)")) {
        const [key, data] = params as [string, ArrayBuffer];
        this.blobs.set(key, data);
        return { toArray: () => [], one: () => ({}) };
      }

      if (q.startsWith("DELETE FROM blobs WHERE key = ?")) {
        const [key] = params as [string];
        this.blobs.delete(key);
        return { toArray: () => [], one: () => ({}) };
      }

      // RUNS
      if (q.startsWith("SELECT run_id FROM runs ORDER BY run_id")) {
        const runs = Array.from(this.runs).sort().map((r) => ({ run_id: r }));
        return {
          toArray: () => runs,
          one: () => runs[0] ?? {},
        };
      }

      if (q.startsWith("INSERT OR IGNORE INTO runs (run_id) VALUES (?)")) {
        const [runId] = params as [string];
        this.runs.add(runId);
        return { toArray: () => [], one: () => ({}) };
      }

      // REGISTRY
      if (q.startsWith("SELECT data FROM registry ORDER BY name")) {
        const sorted = Array.from(this.registry.keys()).sort().map((name) => ({
          data: this.registry.get(name)!,
        }));
        return {
          toArray: () => sorted,
          one: () => sorted[0] ?? {},
        };
      }

      if (q.startsWith("SELECT data FROM registry WHERE name = ?")) {
        const [name] = params as [string];
        const data = this.registry.get(name);
        const rows = data !== undefined ? [{ data }] : [];
        return {
          toArray: () => rows,
          one: () => rows[0] ?? {},
        };
      }

      if (q.startsWith("INSERT INTO registry (name, data)")) {
        const [name, data] = params as [string, string];
        this.registry.set(name, data);
        return { toArray: () => [], one: () => ({}) };
      }

      throw new Error(`Unhandled query in MockSqlStorage: ${query}`);
    },
  };
}

function createMockState(): { state: DurableObjectState; storage: MockSqlStorage } {
  const storage = new MockSqlStorage();
  const state = {
    storage: storage as unknown as DurableObjectStorage,
  } as DurableObjectState;
  return { state, storage };
}

describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("secret-token-123", "secret-token-123")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("returns false for different tokens of matching or different length", () => {
    expect(constantTimeEqual("secret-token-123", "secret-token-124")).toBe(false);
    expect(constantTimeEqual("secret-token-123", "secret-token")).toBe(false);
    expect(constantTimeEqual("", "a")).toBe(false);
  });
});

describe("etag", () => {
  it("computes a deterministic SHA-256 quoted hex digest", async () => {
    const bytes = new TextEncoder().encode("hello world").buffer;
    const tag = await etag(bytes);
    expect(tag).toBe('"b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"');
  });
});

describe("ChidoriRun records journal", () => {
  let chidori: ChidoriRun;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const { state } = createMockState();
    chidori = new ChidoriRun(state);
    logSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("returns 404 for empty journal", async () => {
    const res = await chidori.fetch(new Request("http://do/records"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("no journal");
  });

  it("appends records and retrieves them ordered by pos and seq", async () => {
    const r1 = await chidori.fetch(
      new Request("http://do/records", {
        method: "POST",
        body: JSON.stringify({ seq: 10, payload: "call-1" }),
      }),
    );
    expect(r1.status).toBe(200);

    const r2 = await chidori.fetch(
      new Request("http://do/records", {
        method: "POST",
        body: JSON.stringify({ seq: 20, payload: "call-2" }),
      }),
    );
    expect(r2.status).toBe(200);

    const getRes = await chidori.fetch(new Request("http://do/records"));
    expect(getRes.status).toBe(200);
    const records = await getRes.json();
    expect(records).toEqual([
      { seq: 10, payload: "call-1" },
      { seq: 20, payload: "call-2" },
    ]);

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "run.record.appended", seq: 10 }),
    );
  });

  it("atomically replaces the journal with PUT", async () => {
    await chidori.fetch(
      new Request("http://do/records", {
        method: "POST",
        body: JSON.stringify({ seq: 1, payload: "old" }),
      }),
    );

    const putRes = await chidori.fetch(
      new Request("http://do/records", {
        method: "PUT",
        body: JSON.stringify([
          { seq: 100, payload: "new-1" },
          { seq: 101, payload: "new-2" },
        ]),
      }),
    );
    expect(putRes.status).toBe(200);

    const getRes = await chidori.fetch(new Request("http://do/records"));
    const records = await getRes.json();
    expect(records).toHaveLength(2);
    expect(records[0].seq).toBe(100);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "run.journal.replaced", count: 2 }),
    );
  });
});

describe("ChidoriRun blobs and conditional CAS leases", () => {
  let chidori: ChidoriRun;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const { state } = createMockState();
    chidori = new ChidoriRun(state);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("handles blob CRUD operations", async () => {
    const key = "lease";
    const data = new TextEncoder().encode("node-123");

    // Put blob
    const putRes = await chidori.fetch(
      new Request(`http://do/blobs/${key}`, { method: "PUT", body: data }),
    );
    expect(putRes.status).toBe(200);

    // Get blob
    const getRes = await chidori.fetch(new Request(`http://do/blobs/${key}`));
    expect(getRes.status).toBe(200);
    const readBytes = new Uint8Array(await getRes.arrayBuffer());
    expect(new TextDecoder().decode(readBytes)).toBe("node-123");

    // List blobs
    const listRes = await chidori.fetch(new Request("http://do/blobs"));
    expect(await listRes.json()).toEqual(["lease"]);

    // Delete blob
    const delRes = await chidori.fetch(
      new Request(`http://do/blobs/${key}`, { method: "DELETE" }),
    );
    expect(delRes.status).toBe(200);

    // 404 after delete
    const getDeleted = await chidori.fetch(new Request(`http://do/blobs/${key}`));
    expect(getDeleted.status).toBe(404);
  });

  it("enforces If-None-Match: * for mutual exclusion / lease creation", async () => {
    const key = "active_lease";
    const data = new TextEncoder().encode("owner-1");

    // First write with If-None-Match: * succeeds
    const firstPut = await chidori.fetch(
      new Request(`http://do/blobs/${key}`, {
        method: "PUT",
        headers: { "if-none-match": "*" },
        body: data,
      }),
    );
    expect(firstPut.status).toBe(200);

    // Second write with If-None-Match: * fails with 412 Precondition Failed
    const secondPut = await chidori.fetch(
      new Request(`http://do/blobs/${key}`, {
        method: "PUT",
        headers: { "if-none-match": "*" },
        body: new TextEncoder().encode("owner-2"),
      }),
    );
    expect(secondPut.status).toBe(412);
    expect(await secondPut.text()).toBe("precondition failed");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "run.blob.precondition_failed", key, status: 412 }),
    );
  });

  it("enforces If-Match: <etag> for compare-and-swap updates", async () => {
    const key = "state";
    const v1 = new TextEncoder().encode("v1");
    const v1Etag = await etag(v1.buffer);

    await chidori.fetch(
      new Request(`http://do/blobs/${key}`, { method: "PUT", body: v1 }),
    );

    // Write with mismatched ETag fails with 412
    const failPut = await chidori.fetch(
      new Request(`http://do/blobs/${key}`, {
        method: "PUT",
        headers: { "if-match": '"deadbeef"' },
        body: new TextEncoder().encode("v2-failed"),
      }),
    );
    expect(failPut.status).toBe(412);

    // Write with matching ETag succeeds
    const v2 = new TextEncoder().encode("v2");
    const okPut = await chidori.fetch(
      new Request(`http://do/blobs/${key}`, {
        method: "PUT",
        headers: { "if-match": v1Etag },
        body: v2,
      }),
    );
    expect(okPut.status).toBe(200);
  });
});

describe("ChidoriRun singleton index and registry", () => {
  let chidori: ChidoriRun;

  beforeEach(() => {
    const { state } = createMockState();
    chidori = new ChidoriRun(state);
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers and lists runs in index", async () => {
    await chidori.fetch(
      new Request("http://do/index/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: "run-abc" }),
      }),
    );
    await chidori.fetch(
      new Request("http://do/index/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: "run-xyz" }),
      }),
    );

    const listRes = await chidori.fetch(new Request("http://do/index/runs"));
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual(["run-abc", "run-xyz"]);
  });

  it("stores and fetches detached agent registry definitions", async () => {
    const agentDef = { name: "researcher", model: "claude-3-7-sonnet" };
    const putRes = await chidori.fetch(
      new Request("http://do/index/registry/researcher", {
        method: "PUT",
        body: JSON.stringify(agentDef),
      }),
    );
    expect(putRes.status).toBe(200);

    const getRes = await chidori.fetch(new Request("http://do/index/registry/researcher"));
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual(agentDef);

    const listRes = await chidori.fetch(new Request("http://do/index/registry"));
    expect(await listRes.json()).toEqual([agentDef]);
  });
});

describe("Chidori Worker authentication & routing", () => {
  const instances = new Map<string, ChidoriRun>();

  const getOrCreateDO = (name: string): ChidoriRun => {
    let instance = instances.get(name);
    if (!instance) {
      const { state } = createMockState();
      instance = new ChidoriRun(state);
      instances.set(name, instance);
    }
    return instance;
  };

  const mockEnv: Env = {
    RUN: {
      idFromName(name: string) {
        return { toString: () => name } as unknown as DurableObjectId;
      },
      get(id: DurableObjectId) {
        const name = id.toString();
        const instance = getOrCreateDO(name);
        return {
          fetch: (req: Request) => instance.fetch(req),
        } as unknown as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace,
    CHIDORI_RUN_STORE_TOKEN: "valid-bearer-token",
  };

  beforeEach(() => {
    instances.clear();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects unauthorized requests when token is configured", async () => {
    const unauthReq = new Request("http://worker/runs");
    const res = await worker.fetch(unauthReq, mockEnv);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("unauthorized");

    const badAuthReq = new Request("http://worker/runs", {
      headers: { authorization: "Bearer invalid" },
    });
    const res2 = await worker.fetch(badAuthReq, mockEnv);
    expect(res2.status).toBe(401);
  });

  it("allows requests with valid bearer token and routes to run instance", async () => {
    const headers = {
      authorization: "Bearer valid-bearer-token",
      "content-type": "application/json",
    };

    // Append record to run-101
    const postRes = await worker.fetch(
      new Request("http://worker/runs/run-101/records", {
        method: "POST",
        headers,
        body: JSON.stringify({ seq: 1, step: "init" }),
      }),
    );
    expect(postRes.status).toBe(200);

    // Verify run-101 was automatically registered in @index
    const runsRes = await worker.fetch(new Request("http://worker/runs", { headers }));
    expect(runsRes.status).toBe(200);
    expect(await runsRes.json()).toEqual(["run-101"]);

    // Read back records
    const readRes = await worker.fetch(
      new Request("http://worker/runs/run-101/records", { headers }),
    );
    expect(readRes.status).toBe(200);
    expect(await readRes.json()).toEqual([{ seq: 1, step: "init" }]);
  });
});

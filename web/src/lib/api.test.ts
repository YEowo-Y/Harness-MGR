import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchStatus, fetchCommand, writeCommand, ApiError } from "@/lib/api";

/*
 * Tests for the REAL api module — no vi.mock("@/lib/api").
 * Global fetch is stubbed via vi.stubGlobal so we control every response
 * without a real network.
 */

/** Build a minimal Response-like object that satisfies getJson and writeCommand. */
function fakeResponse(opts: {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}) {
  return opts;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

// ── 1. fetchStatus ────────────────────────────────────────────────────────────

describe("fetchStatus", () => {
  it("calls fetch with /api/status and accept:application/json when no target is given", async () => {
    const payload = { version: "1.0.0", target: "claude", configDir: "/home/.claude", targets: ["claude"], writeKinds: [], removeKinds: [], diagnostics: [] };
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ ok: true, status: 200, statusText: "OK", json: async () => payload }),
    );

    await fetchStatus();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/status");
    expect((init.headers as Record<string, string>)["accept"]).toBe("application/json");
  });

  it("appends ?target=codex when target is 'codex'", async () => {
    const payload = { version: "1.0.0", target: "codex", configDir: "/home/.codex", targets: ["codex"], writeKinds: [], removeKinds: [], diagnostics: [] };
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ ok: true, status: 200, statusText: "OK", json: async () => payload }),
    );

    await fetchStatus("codex");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/status?target=codex");
  });

  it("returns the parsed JSON body", async () => {
    const payload = { version: "2.3.4", target: "claude", configDir: "/c/Users/claude", targets: ["claude", "codex"], writeKinds: ["plugin"], removeKinds: [], diagnostics: [] };
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ ok: true, status: 200, statusText: "OK", json: async () => payload }),
    );

    const result = await fetchStatus();

    expect(result).toEqual(payload);
  });
});

// ── 2. fetchCommand ───────────────────────────────────────────────────────────

describe("fetchCommand", () => {
  it("builds the correct URL with multiple params", async () => {
    const envelope = { command: "inventory", result: { counts: {} }, diagnostics: [] };
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ ok: true, status: 200, statusText: "OK", json: async () => envelope }),
    );

    await fetchCommand("inventory", { target: "claude", type: "skill" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    // URLSearchParams can order keys either way; check both parts
    expect(url).toMatch(/^\/api\/command\/inventory\?/);
    expect(url).toContain("target=claude");
    expect(url).toContain("type=skill");
  });

  it("percent-encodes the command so ':' becomes %3A", async () => {
    const envelope = { command: "config:show-effective", result: {}, diagnostics: [] };
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ ok: true, status: 200, statusText: "OK", json: async () => envelope }),
    );

    await fetchCommand("config:show-effective");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/command/config%3Ashow-effective");
  });

  it("omits the '?' when params is empty", async () => {
    const envelope = { command: "conflicts", result: { conflicts: [], dispositions: [] }, diagnostics: [] };
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ ok: true, status: 200, statusText: "OK", json: async () => envelope }),
    );

    await fetchCommand("conflicts");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("?");
    expect(url).toBe("/api/command/conflicts");
  });

  it("returns the parsed envelope", async () => {
    const envelope = { command: "inventory", result: { counts: { skills: 10 } }, diagnostics: [] };
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ ok: true, status: 200, statusText: "OK", json: async () => envelope }),
    );

    const result = await fetchCommand("inventory");

    expect(result).toEqual(envelope);
  });
});

// ── 3. error path (getJson) ───────────────────────────────────────────────────

describe("error handling in getJson", () => {
  it("throws ApiError with the json message and status when response is not ok", async () => {
    const notOk = () =>
      fakeResponse({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        json: async () => ({ message: "forbidden-host" }),
      });

    // Assert on the rejection directly rather than via a try/catch: if the call
    // ever stopped throwing, a catch body's asserts would simply be skipped and
    // the test would pass silently. Each matcher re-issues the call, so the
    // one-shot mock is re-armed before each.
    fetchMock.mockResolvedValueOnce(notOk());
    await expect(fetchStatus()).rejects.toThrow("forbidden-host"); // message

    fetchMock.mockResolvedValueOnce(notOk());
    await expect(fetchStatus()).rejects.toBeInstanceOf(ApiError); // type

    fetchMock.mockResolvedValueOnce(notOk());
    await expect(fetchStatus()).rejects.toMatchObject({ status: 403 }); // status
  });

  it("falls back to '{status} {statusText}' when json() itself throws", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        json: async () => { throw new Error("not json"); },
      }),
    );

    await expect(fetchStatus()).rejects.toThrow("403 Forbidden");
  });
});

// ── 4. writeCommand — happy path ──────────────────────────────────────────────

describe("writeCommand", () => {
  const writeBody = { target: "claude" as const, type: "plugin", name: "x", apply: false };

  it("POSTs to /api/write/<verb> with the required headers and serialised body", async () => {
    const envelope = {
      command: "disable",
      apply: false,
      code: 0,
      result: { status: "dry-run", ok: true, dryRun: true, kind: "plugin", name: "x", target: "claude", diff: null, alreadyInState: false, applied: false, snapshotId: null },
      diagnostics: [],
    };
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ ok: true, status: 200, statusText: "OK", json: async () => envelope }),
    );

    await writeCommand("disable", writeBody);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/write/disable");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-claude-mgr-write"]).toBe("1");
    expect(headers["content-type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify(writeBody));
  });

  it("returns the envelope when a 'result' field is present", async () => {
    const envelope = {
      command: "disable",
      apply: false,
      code: 0,
      result: { status: "dry-run", ok: true, dryRun: true, kind: "plugin", name: "x", target: "claude", diff: null, alreadyInState: false, applied: false, snapshotId: null },
      diagnostics: [],
    };
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ ok: true, status: 200, statusText: "OK", json: async () => envelope }),
    );

    const result = await writeCommand("disable", writeBody);

    expect(result).toEqual(envelope);
  });

  // ── 5. verb encoding ────────────────────────────────────────────────────────

  it("percent-encodes ':' in verb so skill:visibility routes correctly", async () => {
    const envelope = {
      command: "skill:visibility",
      apply: false,
      code: 0,
      result: { status: "dry-run", ok: true, dryRun: true, kind: "skill", name: "x", target: "claude", diff: null, alreadyInState: false, applied: false, snapshotId: null },
      diagnostics: [],
    };
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ ok: true, status: 200, statusText: "OK", json: async () => envelope }),
    );

    await writeCommand("skill:visibility", { target: "claude", type: "skill", name: "x", apply: false });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/write/skill%3Avisibility");
  });

  // ── 6. guard envelope (no result field) ────────────────────────────────────

  it("throws ApiError when the json has no 'result' field (guard envelope)", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ error: "command-not-allowed" }),
      }),
    );

    await expect(writeCommand("disable", writeBody)).rejects.toBeInstanceOf(ApiError);
  });

  // ── 7. writeCommand json parse failure ──────────────────────────────────────

  it("throws ApiError with '{status} {statusText}' when res.json() rejects", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => { throw new Error("malformed"); },
      }),
    );

    await expect(writeCommand("disable", writeBody)).rejects.toThrow("200 OK");
  });
});

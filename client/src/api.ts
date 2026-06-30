// ============================================================
// API client for backend communication
// ============================================================
import type { SessionSummary, SessionDetail, ModelInfo, ProviderConfig, CustomProviderConfig, RawSessionEntry } from "./types";

const BASE = "/api";

// ---- Debug logger ----
export type LogEntry = {
  id: number;
  time: string;
  method: string;
  url: string;
  reqBody?: string;
  status?: number;
  resBody?: string;
  error?: string;
  duration: number;
};

let logId = 0;
const logListeners: Array<(entry: LogEntry) => void> = [];
const logHistory: LogEntry[] = [];

export function onLog(fn: (entry: LogEntry) => void) {
  logListeners.push(fn);
  // replay existing logs
  for (const e of logHistory) fn(e);
}

export function offLog(fn: (entry: LogEntry) => void) {
  const i = logListeners.indexOf(fn);
  if (i >= 0) logListeners.splice(i, 1);
}

export function clearLogs() { logHistory.length = 0; }

function emitLog(entry: LogEntry) {
  logHistory.push(entry);
  for (const fn of logListeners) fn(entry);
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const id = ++logId;
  const start = performance.now();
  const method = options?.method || "GET";
  const reqBody = options?.body as string | undefined;
  const entry: LogEntry = { id, time: new Date().toLocaleTimeString(), method, url, reqBody, duration: 0 };

  try {
    const res = await fetch(`${BASE}${url}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const text = await res.text();
    entry.status = res.status;
    entry.resBody = text.slice(0, 2000);
    entry.duration = Math.round(performance.now() - start);
    emitLog(entry);

    let json: any;
    try { json = JSON.parse(text); } catch {
      throw new Error(`Invalid JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (!json.success) throw new Error(json.error || `Request failed (HTTP ${res.status})`);
    return json.data as T;
  } catch (e: any) {
    if (e.name === "TypeError" && e.message.includes("fetch")) {
      entry.error = "Network error - is the server running?";
    } else {
      entry.error = e.message || String(e);
    }
    entry.duration = Math.round(performance.now() - start);
    emitLog(entry);
    throw e;
  }
}

export const api = {
  // Providers
  getProviders: () => request<{ builtin: ProviderConfig[]; custom: CustomProviderConfig[] }>("/providers"),

  setBuiltinKey: (provider: string, key: string) =>
    request("/providers/builtin", { method: "POST", body: JSON.stringify({ provider, key }) }),

  removeBuiltinKey: (provider: string) =>
    request(`/providers/builtin/${provider}`, { method: "DELETE" }),

  upsertCustomProvider: (config: { id: string; baseUrl: string; apiType: string; apiKey: string; models?: { id: string }[] }) =>
    request<{ savedModels: { id: string; name?: string }[]; scanned: boolean; scanError?: string }>("/providers/custom", { method: "POST", body: JSON.stringify(config) }),

  removeCustomProvider: (id: string) =>
    request(`/providers/custom/${id}`, { method: "DELETE" }),

  scanModels: (baseUrl: string, apiKey: string) =>
    request<{ id: string }[]>("/providers/scan", { method: "POST", body: JSON.stringify({ baseUrl, apiKey }) }),

  // Auth (legacy - kept for compatibility)
  setApiKey: (provider: string, key: string, persist: boolean) =>
    request("/auth/keys", { method: "POST", body: JSON.stringify({ provider, key, persist }) }),

  getApiKeys: () => request<Record<string, string>>("/auth/keys"),

  // Models
  getModels: () => request<ModelInfo[]>("/models"),

  // Sessions
  listSessions: (cwd?: string) =>
    request<SessionSummary[]>(`/sessions${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`),

  listPiHistory: () =>
    request<SessionSummary[]>("/sessions/history"),

  createSession: (name: string, cwd?: string) =>
    request<SessionSummary>("/sessions", { method: "POST", body: JSON.stringify({ name, cwd }) }),

  continueSession: (filePath: string) =>
    request<SessionSummary>("/sessions/continue", { method: "POST", body: JSON.stringify({ filePath }) }),

  getSessionDetail: (id: string) =>
    request<SessionDetail>(`/sessions/${encodeURIComponent(id)}`),

  navigateTree: (id: string, targetId: string) =>
    request<SessionDetail>(`/sessions/${encodeURIComponent(id)}/navigate`, { method: "POST", body: JSON.stringify({ targetId }) }),

  editMessage: (id: string, entryId: string, newContent: string) =>
    request<SessionDetail>(`/sessions/${encodeURIComponent(id)}/edit`, { method: "POST", body: JSON.stringify({ entryId, newContent }) }),

  renameSession: (id: string, name: string) =>
    request<void>("/sessions/rename", { method: "PUT", body: JSON.stringify({ id, name }) }),

  deleteSession: (id: string) =>
    request<void>("/sessions/delete", { method: "DELETE", body: JSON.stringify({ id }) }),

  reconstructSession: (filePath: string) =>
    request<SessionSummary>("/sessions/reconstruct", { method: "POST", body: JSON.stringify({ filePath }) }),

  importFromPath: (filePath: string) =>
    request<SessionSummary>("/sessions/import", { method: "POST", body: JSON.stringify({ filePath }) }),

  getSessionFull: (id: string) =>
    request<RawSessionEntry[]>(`/sessions/${encodeURIComponent(id)}/full`),
};

// ============================================================
// Pi Service — wraps Pi SDK for session management
// ============================================================
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import type { ModelInfo, StreamEvent, TreeNode, ThinkingLevel, SessionSummary, SessionDetail, ProviderConfig, CustomProviderConfig, ContentBlock } from "../shared/types.js";

// ---------- directory for custom auth/models ----------
const CONFIG_DIR = path.join(process.cwd(), ".pi-web");
const AUTH_FILE = path.join(CONFIG_DIR, "auth.json");
const MODELS_FILE = path.join(CONFIG_DIR, "models.json");

// ---------- init ----------
fs.mkdirSync(CONFIG_DIR, { recursive: true });

const authStorage = AuthStorage.create(AUTH_FILE);
const modelRegistry = ModelRegistry.create(authStorage, MODELS_FILE);

// ---------- built-in providers (from pi docs) ----------
const BUILTIN_PROVIDERS: { id: string; name: string; envVar: string; apiType: string }[] = [
  { id: "anthropic", name: "Anthropic", envVar: "ANTHROPIC_API_KEY", apiType: "anthropic-messages" },
  { id: "openai", name: "OpenAI", envVar: "OPENAI_API_KEY", apiType: "openai-completions" },
  { id: "deepseek", name: "DeepSeek", envVar: "DEEPSEEK_API_KEY", apiType: "openai-completions" },
  { id: "google", name: "Google Gemini", envVar: "GEMINI_API_KEY", apiType: "google-generative-ai" },
  { id: "mistral", name: "Mistral", envVar: "MISTRAL_API_KEY", apiType: "openai-completions" },
  { id: "groq", name: "Groq", envVar: "GROQ_API_KEY", apiType: "openai-completions" },
  { id: "xai", name: "xAI", envVar: "XAI_API_KEY", apiType: "openai-completions" },
  { id: "openrouter", name: "OpenRouter", envVar: "OPENROUTER_API_KEY", apiType: "openai-completions" },
  { id: "zai", name: "Z.AI", envVar: "ZAI_API_KEY", apiType: "openai-completions" },
  { id: "cerebras", name: "Cerebras", envVar: "CEREBRAS_API_KEY", apiType: "openai-completions" },
  { id: "fireworks", name: "Fireworks", envVar: "FIREWORKS_API_KEY", apiType: "openai-completions" },
  { id: "together", name: "Together AI", envVar: "TOGETHER_API_KEY", apiType: "openai-completions" },
  { id: "nvidia", name: "NVIDIA NIM", envVar: "NVIDIA_API_KEY", apiType: "openai-completions" },
  { id: "kimi-coding", name: "Kimi For Coding", envVar: "KIMI_API_KEY", apiType: "openai-completions" },
  { id: "minimax", name: "MiniMax", envVar: "MINIMAX_API_KEY", apiType: "openai-completions" },
  { id: "huggingface", name: "Hugging Face", envVar: "HF_TOKEN", apiType: "openai-completions" },
];

// ---------- active sessions in memory ----------
const sessions = new Map<string, AgentSession>();
const sessionMeta = new Map<string, { name: string; cwd: string; filePath: string }>();

// ---------- helpers ----------
function treeNodeFromEntry(entry: any): TreeNode | null {
  // Handle system entries — keep in tree for parentId linking but render as empty-content assistant nodes
  if (entry.type !== "message") {
    // model_change, thinking_level_change, compaction etc — needed for tree structure
    if (entry.type === "model_change") {
      return {
        id: entry.id, parentId: entry.parentId ?? null, role: "assistant", content: "",
        timestamp: entry.timestamp || Date.now(), children: [],
        label: `${entry.provider}/${entry.modelId}`,
      } as TreeNode;
    }
    if (entry.type === "thinking_level_change") {
      return {
        id: entry.id, parentId: entry.parentId ?? null, role: "assistant", content: "",
        timestamp: entry.timestamp || Date.now(), children: [],
        label: `🧠 ${entry.thinkingLevel}`,
      } as TreeNode;
    }
    if (entry.type === "compaction") {
      return {
        id: entry.id, parentId: entry.parentId ?? null, role: "assistant", content: "",
        timestamp: entry.timestamp || Date.now(), children: [],
        label: `📦 ${entry.tokensBefore} tokens`,
      } as TreeNode;
    }
    if (entry.type === "session_info" || entry.type === "branch_summary" || entry.type === "label" || entry.type === "custom_message" || entry.type === "custom") {
      return {
        id: entry.id, parentId: entry.parentId ?? null, role: "assistant", content: "",
        timestamp: entry.timestamp || Date.now(), children: [],
      } as TreeNode;
    }
    // Other unknown types (e.g. session header): skip
    return null;
  }

  let role: "user" | "assistant" | "tool" = "user";
  let toolName: string | undefined;
  let toolError = false;
  let isThinking = false;
  let agentRole: "main" | "architect" | "worker" | "subagent" = "main";
  let agentName: string | undefined;
  let isSubagentCall = false;
  let subagentTask: string | undefined;

  const msgRole = entry.message?.role;
  if (msgRole === "assistant") {
    role = "assistant";
    // Don't override role to "tool" — an assistant message may contain
    // both text and toolCall blocks; contentBlocks handles the rendering.
    // Extract toolName from the first tool call for display in the header.
    const blocks = entry.message?.content;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block?.type === "toolCall" || block?.type === "tool_use") {
          if (!toolName) toolName = block.name;
        }
        if (block?.type === "thinking" || block?.isThinking) {
          isThinking = true;
        }
      }
    } else if (blocks?.type === "toolCall" || blocks?.type === "tool_use") {
      toolName = blocks.name;
    }
    if (entry.message?.isError || entry.isError) {
      toolError = true;
    }
  } else if (msgRole === "toolResult") {
    role = "tool";
    toolName = entry.message?.toolName || "工具";
    toolError = entry.message?.isError || false;
  } else if (msgRole === "user") {
    role = "user";
  }

  // Extract content blocks for structured rendering
  const contentBlocks = extractContentBlocks(entry);

  // Detect subagent calls
  // For assistant messages: check if any tool_use block is a "subagent" call
  for (const block of contentBlocks) {
    if (block.type === "tool_call" && block.toolName === "subagent") {
      isSubagentCall = true;
      subagentTask = block.arguments?.task || undefined;
      agentRole = "main"; // main process initiated this call
      break;
    }
  }

  // For tool result messages: check if they are from a subagent
  // Look for subagent indicators in tool result content
  if (role === "tool" && contentBlocks.length > 0) {
    for (const block of contentBlocks) {
      if (block.type === "tool_result") {
        // Check if the parent entry was a subagent call
        // (handled in buildSessionDetail where we can look up parent)
        break;
      }
    }
  }

  const content = extractContent(entry);
  return {
    id: entry.id,
    parentId: entry.parentId ?? null,
    role,
    content,
    toolName,
    toolError,
    isThinking,
    timestamp: entry.timestamp || Date.now(),
    children: [],
    label: entry.label,
    agentRole,
    agentName,
    isSubagentCall,
    subagentTask,
    contentBlocks,
  };
}

function extractContent(entry: any): string {
  const msg = entry.message;
  if (!msg) return "";
  if (typeof msg === "string") return msg;
  const blocks = msg.content;
  if (!blocks) return "";
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return JSON.stringify(blocks);

  return blocks
    .map((b: any) => {
      if (typeof b === "string") return b;
      if (b.type === "text" || b.type === "thinking") return b.text ?? "";
      if (b.type === "tool_use" || b.type === "toolCall") return `[Tool: ${b.name}(${JSON.stringify(b.input || b.arguments)})]`;
      if (b.type === "tool_result") {
        const t = b.content ?? "";
        return typeof t === "string" ? t : JSON.stringify(t);
      }
      return "";
    })
    .join("\n");
}

function extractContentBlocks(entry: any): ContentBlock[] {
  const msg = entry.message;
  if (!msg) return [];
  const blocks = msg.content;
  if (!blocks) return [];
  if (typeof blocks === "string") return [{ type: "text", text: blocks }];
  if (!Array.isArray(blocks)) return [{ type: "text", text: JSON.stringify(blocks) }];

  return blocks.map((b: any): ContentBlock => {
    if (typeof b === "string") return { type: "text", text: b };
    
    // text block
    if (b.type === "text") return { type: "text", text: b.text ?? "" };
    
    // thinking block
    if (b.type === "thinking") return { type: "thinking", text: b.thinking ?? b.text ?? "" };
    
    // tool_use / toolCall block — the model calling a tool
    if (b.type === "tool_use" || b.type === "toolCall") {
      return {
        type: "tool_call",
        toolName: b.name,
        toolCallId: b.id,
        // pi SDK uses "input", JSONL uses "arguments"
        arguments: b.input || b.arguments,
      };
    }
    
    // tool_result block
    if (b.type === "tool_result" || b.type === "toolResult") {
      const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
      return {
        type: "tool_result",
        text,
        toolCallId: b.tool_use_id || b.toolCallId,
        isError: b.is_error || b.isError || false,
      };
    }
    
    return { type: "text", text: JSON.stringify(b) };
  });
}

async function buildSessionDetail(sm: SessionManager, meta: { name: string; cwd: string; filePath: string }, leafIdOverride?: string): Promise<SessionDetail> {
  const entries = sm.getEntries();
  const leafId = leafIdOverride || sm.getLeafId();
  const leaf = entries.find((e: any) => e.id === leafId) || sm.getLeafEntry();

  const nodes = entries
    .map(treeNodeFromEntry)
    .filter((n: TreeNode | null): n is TreeNode => n !== null);

  // build children relationships
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  // Also create synthetic nodes for non-message parents that have children in the tree.
  // This ensures branch navigation works even when parent is a system/session entry.
  const entriesById = new Map(entries.map((e: any) => [e.id, e]));
  const syntheticParents = new Set<string>();
  for (const node of nodes) {
    if (node.parentId) {
      if (nodeMap.has(node.parentId)) {
        nodeMap.get(node.parentId)!.children.push(node.id);
      } else if (entriesById.has(node.parentId) && !syntheticParents.has(node.parentId)) {
        // Create a synthetic system node for the non-message parent
        const parentEntry = entriesById.get(node.parentId)!;
        // Build a readable label from the first child's content
        const firstChildContent = node.content.slice(0, 30);
        const label = parentEntry.message
          ? (extractContent(parentEntry) || firstChildContent || "(对话起点)")
          : (firstChildContent || "(对话起点)");
        const synthetic: TreeNode = {
          id: parentEntry.id,
          parentId: parentEntry.parentId ?? null,
          role: "assistant",  // don't show as "you"
          content: "",  // don't show content in chat flow
          timestamp: parentEntry.timestamp || Date.now(),
          children: [node.id],
          isThinking: false,
          label: "branch_root",  // mark as synthetic for frontend
        };
        nodes.push(synthetic);
        nodeMap.set(synthetic.id, synthetic);
        syntheticParents.add(synthetic.id);
      }
    }
  }

  // Propagate subagent info: if a node's parent is a subagent call (isSubagentCall=true),
  // mark this node as agentRole="subagent"
  for (const node of nodes) {
    if (node.parentId && nodeMap.has(node.parentId)) {
      const parent = nodeMap.get(node.parentId)!;
      if (parent.isSubagentCall) {
        node.agentRole = "subagent";
      }
    }
  }

  // Propagate fork info: nodes that have a branch_root parent with siblings
  // get forkGroup/forkSiblings so frontend can show branch buttons on the
  // actual message rather than on the hidden synthetic node.
  for (const node of nodes) {
    if (node.parentId) {
      const parent = nodeMap.get(node.parentId);
      if (parent && parent.label === "branch_root" && parent.children.length > 1) {
        (node as any).forkGroup = parent.id;
        (node as any).forkSiblings = parent.children.filter(c => c !== node.id);
      }
    }
  }

  // Compute active path by walking up from leaf via parentId
  // but only include nodes that are in the tree (non-message entries are filtered out)
  const activePath: string[] = [];
  const byId = new Map(entries.map((e: any) => [e.id, e]));
  let current: string | null = leafId;
  while (current) {
    if (nodeMap.has(current)) {
      activePath.unshift(current);
    }
    const entry = byId.get(current);
    current = entry?.parentId ?? null;
  }

  return {
    id: meta.filePath,
    name: meta.name,
    filePath: meta.filePath,
    tree: nodes,
    activePath,
    leafId: leaf?.id ?? "",
  };
}

// ---------- helpers ----------
/** Decode Pi session dir name to a filesystem path.
 *  Pi encodes: --F--pi-project--sub-- → F:/pi-project/sub */
function decodePiSessionDir(dirName: string): string {
  let inner = dirName;
  if (inner.startsWith("--")) inner = inner.slice(2);
  if (inner.endsWith("--")) inner = inner.slice(0, -2);
  const segments = inner.split("--");
  if (segments.length >= 2 && /^[a-zA-Z]$/.test(segments[0])) {
    return segments[0] + ":/" + segments.slice(1).join("/");
  }
  return segments.join("/");
}

// ---------- service api ----------
export async function initPiService() {
  // prime auth storage
  await authStorage.ready;
  await modelRegistry.ready;
  console.log("[pi-service] Initialized");
}

// ---- Provider management ----

/** Load current models.json custom providers */
function loadModelsJson(): any {
  try {
    if (fs.existsSync(MODELS_FILE)) {
      return JSON.parse(fs.readFileSync(MODELS_FILE, "utf-8"));
    }
  } catch { /* ignore parse errors */ }
  return {};
}

/** Save models.json */
function saveModelsJson(data: any): void {
  fs.mkdirSync(path.dirname(MODELS_FILE), { recursive: true });
  fs.writeFileSync(MODELS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

/** List all built-in providers with key status */
export function getBuiltinProviders(): ProviderConfig[] {
  return BUILTIN_PROVIDERS.map(p => {
    const hasRuntime = authStorage.hasAuth(p.id);
    const envVal = process.env[p.envVar] || "";
    const hasKey = hasRuntime || !!envVal;
    return {
      id: p.id,
      name: p.name,
      envVar: p.envVar,
      apiType: p.apiType,
      hasKey,
      keyPreview: envVal ? (envVal.slice(0, 8) + "..." + envVal.slice(-4)) : (hasRuntime ? "(session)" : ""),
      isCustom: false,
    };
  });
}

/** List custom providers from models.json */
export function getCustomProviders(): CustomProviderConfig[] {
  const config = loadModelsJson();
  const providers = config.providers || {};
  return Object.entries(providers).map(([id, p]: [string, any]) => ({
    id,
    name: id,
    baseUrl: p.baseUrl || "",
    apiType: p.api || "openai-completions",
    hasKey: true,
    isCustom: true,
    models: (p.models || []).map((m: any) => m.id),
  }));
}

/** Add or update a custom provider */
export async function upsertCustomProvider(config: {
  id: string;
  baseUrl: string;
  apiType: string;
  apiKey: string;
  models?: { id: string; name?: string }[];
}): Promise<{ savedModels: { id: string; name?: string }[]; scanned: boolean; scanError?: string }> {
  const data = loadModelsJson();
  if (!data.providers) data.providers = {};

  // For updates: keep existing apiKey if the special sentinel is passed
  let apiKey = config.apiKey;
  if (apiKey === "__KEEP_EXISTING__") {
    const existing = data.providers[config.id];
    if (existing?.apiKey) {
      apiKey = existing.apiKey;
    } else {
      // Try auth storage for a saved key
      const storedKey = await authStorage.getApiKey(config.id);
      apiKey = storedKey || "";
    }
  }

  let models = config.models || [];
  let scanned = false;
  let scanError: string | undefined;

  // Auto-scan models from endpoint if none provided
  if (models.length === 0) {
    try {
      models = await scanModelsFromEndpoint(config.baseUrl, apiKey);
      scanned = true;
    } catch (err: any) {
      scanError = err.message || String(err);
      // If scanning fails, try a minimal fallback: use the provider name as a default model
      // This at least lets users try the provider, and they can manually add models later
      models = [{ id: "default" }];
    }
  }

  const savedModels = models.map((m: any) => ({
    id: m.id,
    ...(m.name ? { name: m.name } : {}),
  }));

  data.providers[config.id] = {
    baseUrl: config.baseUrl,
    api: config.apiType,
    apiKey,
    models: savedModels,
  };

  saveModelsJson(data);
  // Also set runtime API key so auth check passes
  authStorage.setRuntimeApiKey(config.id, apiKey);
  // Refresh model registry to pick up new provider
  modelRegistry.refresh();

  return { savedModels, scanned, scanError };
}

/** Remove a custom provider */
export function removeCustomProvider(id: string): void {
  const data = loadModelsJson();
  if (data.providers && data.providers[id]) {
    delete data.providers[id];
    saveModelsJson(data);
  }
  modelRegistry.refresh();
}

/** Attempt to fetch models from an OpenAI-compatible /v1/models endpoint */
export async function scanModelsFromEndpoint(baseUrl: string, apiKey: string): Promise<{ id: string }[]> {
  const url = baseUrl.replace(/\/+$/, "") + "/v1/models";
  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  const json = await res.json();
  const models: { id: string }[] = [];
  if (json.data && Array.isArray(json.data)) {
    for (const m of json.data) {
      if (m.id) models.push({ id: m.id });
    }
  }
  if (models.length === 0) {
    throw new Error("No models found in response");
  }
  return models;
}

// ---- API keys ----
export function setApiKey(provider: string, key: string, persist: boolean) {
  if (persist) {
    authStorage.set(provider, { type: "api_key", key });
  } else {
    authStorage.setRuntimeApiKey(provider, key);
  }
  // Refresh so getAvailable() picks up newly configured providers
  modelRegistry.refresh();
}

export function getApiKeys(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const p of BUILTIN_PROVIDERS) {
    const envVal = process.env[p.envVar] || "";
    const hasRuntime = authStorage.hasAuth(p.id);
    if (envVal) result[p.id] = envVal.slice(0, 8) + "..." + envVal.slice(-4);
    else if (hasRuntime) result[p.id] = "(session)";
  }
  return result;
}

/** Remove a provider API key (built-in or custom) */
export function removeProviderKey(provider: string): void {
  authStorage.remove(provider);
  modelRegistry.refresh();
}

// ---- models ----
export async function getAvailableModels(): Promise<ModelInfo[]> {
  await modelRegistry.ready;
  const available = modelRegistry.getAvailable();
  const result = available.map((m: any) => ({
    provider: m.provider,
    modelId: m.id,
    displayName: m.name || `${m.provider}/${m.id}`,
    thinkingLevels: m.thinkingLevels || ["off", "low", "medium", "high"],
  }));

  // Fallback: if a custom provider has auth configured but no models (empty models array),
  // auto-repair models.json and return at least a default model so users can use it.
  const customProviders = getCustomProviders();
  const resultProviders = new Set(result.map(m => m.provider));
  for (const cp of customProviders) {
    if (!resultProviders.has(cp.id) && cp.models.length === 0) {
      // Auto-repair: add a default model to models.json
      const data = loadModelsJson();
      if (data.providers && data.providers[cp.id] && data.providers[cp.id].models.length === 0) {
        data.providers[cp.id].models = [{ id: "default" }];
        saveModelsJson(data);
        modelRegistry.refresh();
      }
      result.push({
        provider: cp.id,
        modelId: "default",
        displayName: `${cp.id}/default`,
        thinkingLevels: ["off", "low", "medium", "high"],
      });
    }
  }

  return result;
}

// ---- sessions ----
export async function createSession(name: string, cwd: string): Promise<SessionSummary> {
  const sessionManager = SessionManager.create(cwd);
  const effectiveCwd = cwd || process.cwd();
  const agentDir = process.env.PI_CODING_AGENT_DIR ||
    path.join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent");
  const resourceLoader = new DefaultResourceLoader({
    cwd: effectiveCwd,
    agentDir,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    sessionManager,
    authStorage,
    modelRegistry,
    cwd: effectiveCwd,
    resourceLoader,
  });

  const filePath = session.sessionFile!;
  const meta = { name: name || `Session ${filePath.split("/").pop()?.replace(".jsonl", "") || ""}`, cwd, filePath };

  sessions.set(filePath, session);
  sessionMeta.set(filePath, meta);

  return {
    id: filePath,
    name: meta.name,
    filePath,
    cwd,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 0,
  };
}

export async function continueSession(filePath: string): Promise<SessionSummary | null> {
  try {
    const sm = SessionManager.open(filePath);
    const entries = sm.getEntries();
    const name = extractContent(entries[0]).slice(0, 60) || path.basename(filePath, ".jsonl");

    // Extract cwd from multiple sources:
    // 1. Session header cwd (most accurate)
    // 2. Session file path (pi encodes cwd in directory name: --F--pi-project-- → F:/pi-project)
    // 3. Web UI session meta (stored on creation)
    // 4. Fallback to process.cwd()
    let cwd = process.cwd();
    try {
      const header = sm.getHeader();
      if (header && (header as any).cwd && (header as any).cwd !== process.cwd()) {
        cwd = (header as any).cwd;
      }
    } catch {}

    // If header cwd looks like the Web UI server's cwd (potentially buggy),
    // derive the real cwd from the session file path directory name.
    // Pi encodes cwd in the parent dir name: --F--pi-project--sub-- → F:/pi-project/sub/
    {
      const parentDir = path.basename(path.dirname(filePath));
      const decoded = decodePiSessionDir(parentDir);
      if (decoded && fs.existsSync(decoded)) {
        cwd = decoded;
      }
    }

    console.log("[pi-service] continueSession cwd:", cwd, "file:", filePath);

    const agentDir = process.env.PI_CODING_AGENT_DIR ||
      path.join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent");
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      sessionManager: sm,
      authStorage,
      modelRegistry,
      cwd,
      resourceLoader,
    });

    const id = session.sessionId;
    const meta = { name, cwd, filePath };

    sessions.set(filePath, session);
    sessionMeta.set(filePath, meta);

    return {
      id: filePath,
      name: meta.name,
      filePath,
      cwd: meta.cwd,
      createdAt: entries[0]?.timestamp || Date.now(),
      updatedAt: Date.now(),
      messageCount: entries.length,
    };
  } catch (err) {
    console.error("[pi-service] continueSession error:", err);
    return null;
  }
}

export async function navigateTree(sessionId: string, targetId: string): Promise<SessionDetail | null> {
  const session = sessions.get(sessionId);
  const meta = sessionMeta.get(sessionId);
  if (!session || !meta) return null;

  const result = await session.navigateTree(targetId);
  console.log("[navigateTree]", { targetId: targetId.slice(0,8), cancelled: result.cancelled, editorText: result.editorText?.slice(0,30) });

  // Use runtime SM for correct activePath/leaf
  // Use runtime SM — navigateTree already updated it with the new active path
  const runtimeSm = session.sessionManager;
  return buildSessionDetail(runtimeSm, meta);
}

export async function getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
  // Try in-memory AgentSession first
  const session = sessions.get(sessionId);
  const meta = sessionMeta.get(sessionId);
  if (session && meta) {
    const sm = SessionManager.open(meta.filePath);
    return buildSessionDetail(sm, meta);
  }

  // Fallback: read directly from JSONL file (server restart, no AgentSession)
  try {
    if (!fs.existsSync(sessionId)) return null;
    const fileSm = SessionManager.open(sessionId);
    const entries = fileSm.getEntries();
    if (entries.length === 0) return null;
    const name = extractContent(entries[0]).slice(0, 60) || path.basename(sessionId, ".jsonl");
    const cwd = decodeCwdFromPath(sessionId);
    const fileMeta = { name, cwd, filePath: sessionId };
    // Store meta so prompt/continue can pick it up later
    sessionMeta.set(sessionId, fileMeta);
    return buildSessionDetail(fileSm, fileMeta);
  } catch {
    return null;
  }
}

function decodeCwdFromPath(filePath: string): string {
  const parentDir = path.basename(path.dirname(filePath));
  const decoded = decodePiSessionDir(parentDir);
  if (decoded && fs.existsSync(decoded)) return decoded;
  return process.cwd();
}

export async function listSessions(directory?: string): Promise<SessionSummary[]> {
  const dir = directory || process.cwd();
  try {
    const files = await SessionManager.list(dir);
    return files.map((f: any) => ({
      id: f.path,
      name: f.name || path.basename(f.path, ".jsonl"),
      filePath: f.path,
      cwd: dir,
      createdAt: f.createdAt || 0,
      updatedAt: f.updatedAt || 0,
      messageCount: f.messageCount || 0,
    }));
  } catch {
    return [];
  }
}

/** List sessions from pi's default session directories (~/.pi/agent/sessions/) */
export async function listPiHistorySessions(): Promise<SessionSummary[]> {
  // On Windows, HOME may not be set; use USERPROFILE. Also try HOMEDRIVE+HOMEPATH combo.
  const homeDir = process.env.HOME
    || process.env.USERPROFILE
    || (process.env.HOMEDRIVE && process.env.HOMEPATH ? process.env.HOMEDRIVE + process.env.HOMEPATH : "")
    || process.cwd();
  // Also try PI_CODING_AGENT_DIR as an override
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(homeDir, ".pi", "agent");
  const piSessionsDir = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(agentDir, "sessions");
  const result: SessionSummary[] = [];
  console.log("[pi-service] Looking for pi sessions in:", piSessionsDir);

  try {
    if (!fs.existsSync(piSessionsDir)) {
      console.log("[pi-service] Sessions directory not found:", piSessionsDir);
      return [];
    }

    // Walk all project subdirectories
    const projectDirs = fs.readdirSync(piSessionsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const pDir of projectDirs) {
      const projectPath = path.join(piSessionsDir, pDir.name);
      try {
        const files = fs.readdirSync(projectPath)
          .filter(f => f.endsWith(".jsonl"));

        for (const file of files) {
          const filePath = path.join(projectPath, file);
          try {
            const stat = fs.statSync(filePath);
            // Extract display name: decode the project dir name (--F--pi-web-architect-- → F:/pi-web-architect)
            const cwdHint = decodePiSessionDir(pDir.name);
            const fileName = path.basename(file, ".jsonl");
            const name = `${cwdHint} — ${fileName.slice(0, 26)}`;

            // Quick count of lines (approximate message count)
            let msgCount = 0;
            try {
              const content = fs.readFileSync(filePath, "utf-8");
              const lines = content.split("\n").filter(l => l.trim());
              msgCount = Math.max(0, lines.length - 1); // subtract header line
            } catch {}

            result.push({
              id: filePath,
              name,
              filePath,
              cwd: cwdHint,
              createdAt: stat.birthtimeMs,
              updatedAt: stat.mtimeMs,
              messageCount: msgCount,
            });
          } catch { /* skip unreadable files */ }
        }
      } catch { /* skip unreadable dirs */ }
    }
  } catch {}

  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---- prompt (streaming) ----
export interface PromptConfig {
  sessionId: string;
  message: string;
  model?: string;
  provider?: string;
  thinkingLevel?: ThinkingLevel;
}

export async function promptSession(
  config: PromptConfig,
  onEvent: (event: StreamEvent) => void
): Promise<void> {
  const session = sessions.get(config.sessionId);
  if (!session) {
    onEvent({ type: "error", error: "Session not found" });
    return;
  }

  // set model if specified
  if (config.model && config.provider) {
    const model = modelRegistry.find(config.provider, config.model);
    if (model) {
      await session.setModel(model);
    }
  }

  if (config.thinkingLevel) {
    session.setThinkingLevel(config.thinkingLevel);
  }

  let currentMessageId: string | undefined;

  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "message_start":
        currentMessageId = randomUUID();
        onEvent({ type: "message_start", messageId: currentMessageId });
        break;

      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          onEvent({ type: "text_delta", delta: event.assistantMessageEvent.delta, messageId: currentMessageId });
        } else if (event.assistantMessageEvent.type === "thinking_delta") {
          onEvent({ type: "thinking_delta", delta: event.assistantMessageEvent.delta, messageId: currentMessageId });
        }
        break;

      case "tool_execution_start":
        onEvent({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName });
        break;

      case "tool_execution_update":
        onEvent({ type: "tool_update", toolCallId: event.toolCallId, toolOutput: event.output });
        break;

      case "tool_execution_end":
        onEvent({ type: "tool_end", toolCallId: event.toolCallId, toolError: event.isError });
        break;

      case "turn_end":
        onEvent({ type: "turn_end", messageId: currentMessageId });
        break;

      case "message_end":
        onEvent({ type: "message_end", messageId: currentMessageId });
        break;

      case "agent_end":
        onEvent({ type: "message_end", messageId: currentMessageId });
        break;
    }
  });

  try {
    await session.prompt(config.message);
  } catch (err: any) {
    onEvent({ type: "error", error: err.message || String(err) });
  } finally {
    unsubscribe();
  }
}

// ---- abort ----
export async function abortSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (session) {
    await session.abort();
  }
}

// ---- message editing ----
export async function editMessage(sessionId: string, entryId: string, newContent: string): Promise<void> {
  const meta = sessionMeta.get(sessionId);
  if (!meta || !newContent) return;

  try {
    // Read all lines from the JSONL file (async to avoid blocking event loop)
    const content = await fs.promises.readFile(meta.filePath, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());
    const updatedLines: string[] = [];
    let found = false;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.id === entryId) {
          found = true;
          // Update the message content
          if (entry.message) {
            if (typeof entry.message === "string") {
              entry.message = newContent;
            } else if (entry.message.content) {
              if (typeof entry.message.content === "string") {
                entry.message.content = newContent;
              } else if (Array.isArray(entry.message.content)) {
                // Replace text blocks with the new content
                const textBlock = entry.message.content.find((b: any) => b.type === "text");
                if (textBlock) {
                  textBlock.text = newContent;
                } else {
                  entry.message.content = [{ type: "text", text: newContent }];
                }
              }
            }
          }
        }
        updatedLines.push(JSON.stringify(entry));
      } catch {
        // Keep malformed lines as-is
        updatedLines.push(line);
      }
    }
    if (!found) return;
    await fs.promises.writeFile(meta.filePath, updatedLines.join("\n") + "\n", "utf-8");

    // Dispose old session and reconstruct from updated file (Bug fix: avoid state inconsistency
    // between in-memory session tree (navigateTree) and the rewritten JSONL file)
    const oldSession = sessions.get(sessionId);
    if (oldSession) {
      oldSession.dispose();
      sessions.delete(sessionId);
    }
    await reconstructSession(meta.filePath);
  } catch (err) {
    console.error("[pi-service] editMessage: failed to update entry content", err);
  }
}

// ---- reconstruct (rebuild after server restart) ----
export async function reconstructSession(filePath: string): Promise<SessionSummary | null> {
  // Already loaded
  const existing = sessions.get(filePath);
  if (existing) {
    const meta = sessionMeta.get(filePath);
    if (meta) {
      const sm = meta.filePath ? SessionManager.open(meta.filePath) : null;
      const entries = sm?.getEntries() ?? [];
      return {
        id: filePath,
        name: meta.name,
        filePath,
        cwd: meta.cwd,
        createdAt: entries[0]?.timestamp || Date.now(),
        updatedAt: Date.now(),
        messageCount: entries.length,
      };
    }
  }

  // Not loaded — reconstruct from file
  try {
    if (!fs.existsSync(filePath)) return null;

    const sm = SessionManager.open(filePath);
    const entries = sm.getEntries();
    if (entries.length === 0) return null;

    const name = extractContent(entries[0]).slice(0, 60) || path.basename(filePath, ".jsonl");

    // Extract cwd from the session header
    let sessionCwd = process.cwd();
    try {
      const header = sm.getHeader();
      if (header && (header as any).cwd) sessionCwd = (header as any).cwd;
    } catch {}

    // Always try to derive cwd from session file path directory name
    // if the header cwd looks like the Web UI server cwd.
    {
      const parentDir = path.basename(path.dirname(filePath));
      const decoded = decodePiSessionDir(parentDir);
      if (decoded && fs.existsSync(decoded)) {
        sessionCwd = decoded;
      }
    }

    const agentDir = process.env.PI_CODING_AGENT_DIR ||
      path.join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent");
    const resourceLoader = new DefaultResourceLoader({
      cwd: sessionCwd,
      agentDir,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      sessionManager: sm,
      authStorage,
      modelRegistry,
      cwd: sessionCwd,
      resourceLoader,
    });

    const meta = { name, cwd: sessionCwd, filePath };
    sessions.set(filePath, session);
    sessionMeta.set(filePath, meta);

    return {
      id: filePath,
      name: meta.name,
      filePath,
      cwd: meta.cwd,
      createdAt: entries[0]?.timestamp || Date.now(),
      updatedAt: Date.now(),
      messageCount: entries.length,
    };
  } catch (err) {
    console.error("[pi-service] reconstructSession error:", err);
    return null;
  }
}

// ---- get full session entries (raw, unfiltered) ----
export function getSessionFull(sessionId: string): any[] | null {
  const meta = sessionMeta.get(sessionId);
  if (!meta) return null;

  try {
    const sm = SessionManager.open(meta.filePath);
    return sm.getEntries();
  } catch (err) {
    console.error("[pi-service] getSessionFull error:", err);
    return null;
  }
}

// ---- rename session ----
export function renameSession(sessionId: string, newName: string): boolean {
  const meta = sessionMeta.get(sessionId);
  if (!meta) return false;
  sessionMeta.set(sessionId, { ...meta, name: newName });
  return true;
}

// ---- dispose session ----
export function disposeSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  const meta = sessionMeta.get(sessionId);
  if (session) {
    session.dispose();
  }
  sessions.delete(sessionId);
  sessionMeta.delete(sessionId);
  // Also delete the physical session file
  if (meta?.filePath) {
    try {
      if (fs.existsSync(meta.filePath)) {
        fs.unlinkSync(meta.filePath);
        console.log("[pi-service] Deleted session file:", meta.filePath);
      }
    } catch (err) {
      console.error("[pi-service] Failed to delete session file:", err);
    }
  }
}

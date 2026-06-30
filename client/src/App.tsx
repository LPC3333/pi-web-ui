// ============================================================
// Main App — session list, chat view, tree panel
// ============================================================
import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { io, Socket } from "socket.io-client";
import { api } from "./api";
import { onLog, offLog, clearLogs, type LogEntry } from "./api";
import type { SessionSummary, SessionDetail, TreeNode, ModelInfo, ThinkingLevel, StreamEvent, ProviderConfig, CustomProviderConfig } from "./types";
import "./index.css";

// ---- Helper: format timestamp ----
function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// ---- Helper: truncate ----
function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ==================== APP ====================

export default function App() {
  // ---- socket ----
  const socketRef = useRef<Socket | null>(null);
  const streamingMsgIdRef = useRef<string | null>(null);

  // ---- state ----
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [nodeMap, setNodeMap] = useState<Map<string, TreeNode>>(new Map());
  const [activePathIds, setActivePathIds] = useState<Set<string>>(new Set());
  const [displayOrder, setDisplayOrder] = useState<string[]>([]);  // ordered display node IDs

  // streaming
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);
  const [toolCalls, setToolCalls] = useState<Map<string, { name: string; output: string; error: boolean }>>(new Map());

  // models
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("off");
  const [configuredProviders, setConfiguredProviders] = useState<string[]>([]);

  // UI
  const [showSettings, setShowSettings] = useState(false);
  const [showTree, setShowTree] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [inputText, setInputText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [errors, setErrors] = useState<{ id: number; text: string }[]>([]);
  const errorIdRef = useRef(0);

  // session rename/delete
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);

  // import pi history
  const [showImportHistory, setShowImportHistory] = useState(false);
  const [historySessions, setHistorySessions] = useState<SessionSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [fileDropActive, setFileDropActive] = useState(false);
  const [manualPath, setManualPath] = useState("");

  // new session dialog
  const [showNewSessionDialog, setShowNewSessionDialog] = useState(false);
  const [newSessionName, setNewSessionName] = useState("");
  const [newSessionCwd, setNewSessionCwd] = useState("");

  // cwd presets (saved in localStorage)
  interface CwdPreset { name: string; path: string }
  const [cwdPresets, setCwdPresets] = useState<CwdPreset[]>(() => {
    try {
      const stored = localStorage.getItem("pi-web-cwd-presets");
      return stored ? JSON.parse(stored) : [];
    } catch { return []; }
  });
  const [defaultCwd, setDefaultCwd] = useState<string>(() => {
    try {
      return localStorage.getItem("pi-web-default-cwd") || "";
    } catch { return ""; }
  });

  function saveCwdPresets(presets: CwdPreset[]) {
    setCwdPresets(presets);
    try { localStorage.setItem("pi-web-cwd-presets", JSON.stringify(presets)); } catch {}
  }

  function addCwdPreset(cwd: string) {
    const cleaned = cwd.trim().replace(/\\/g, "/");
    if (!cleaned) return;
    // Auto-generate name from last path segment
    const autoName = cleaned.split("/").pop() || cleaned;
    // Only add if path is new
    if (cwdPresets.some(p => p.path === cleaned)) return;
    const next = [{ name: autoName, path: cleaned }, ...cwdPresets].slice(0, 20);
    saveCwdPresets(next);
  }

  function removeCwdPreset(path: string) {
    saveCwdPresets(cwdPresets.filter(p => p.path !== path));
  }

  function renameCwdPreset(path: string, newName: string) {
    saveCwdPresets(cwdPresets.map(p => p.path === path ? { ...p, name: newName } : p));
  }

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  function showError(text: string) {
    const id = ++errorIdRef.current;
    setErrors(prev => [...prev, { id, text }]);
    // auto-dismiss after 15 seconds
    setTimeout(() => {
      setErrors(prev => prev.filter(e => e.id !== id));
    }, 15000);
  }

  function dismissError(id: number) {
    setErrors(prev => prev.filter(e => e.id !== id));
  }

  // ---- init ----
  useEffect(() => {
    loadSessions();
    loadModels();

    const socket = io({ transports: ["websocket", "polling"] });
    socketRef.current = socket;

    onLog(handleLog);

    socket.on("stream", (event: StreamEvent) => {
      handleStreamEvent(event);
    });

    socket.on("aborted", () => {
      setIsStreaming(false);
      setStreamingText("");
      setStreamingThinking("");
      setStreamingMsgId(null);
      setToolCalls(new Map());
      streamingMsgIdRef.current = null;
    });

    socket.on("session_updated", (detail: SessionDetail) => {
      setSessionDetail(detail);
      // Use requestAnimationFrame to avoid blocking during streaming
      requestAnimationFrame(() => buildNodeState(detail));
      setIsStreaming(false);
      setStreamingText("");
      setStreamingThinking("");
      setStreamingMsgId(null);
      setToolCalls(new Map());
      streamingMsgIdRef.current = null;
    });

    socket.on("error", (err: { error: string }) => {
      showError(err.error);
      setIsStreaming(false);
    });

    return () => {
      offLog(handleLog);
      socket.disconnect();
    };
  }, []);

  /** Handle WebSocket streaming events from the server */
  function handleStreamEvent(event: StreamEvent) {
    switch (event.type) {
      case "message_start":
        setStreamingMsgId(event.messageId ?? null);
        streamingMsgIdRef.current = event.messageId ?? null;
        break;

      case "text_delta":
        if (event.messageId === streamingMsgIdRef.current || !streamingMsgIdRef.current) {
          setStreamingText(prev => prev + (event.delta || ""));
        }
        break;

      case "thinking_delta":
        if (event.messageId === streamingMsgIdRef.current || !streamingMsgIdRef.current) {
          setStreamingThinking(prev => prev + (event.delta || ""));
        }
        break;

      case "tool_start":
        if (event.toolCallId) {
          setToolCalls(prev => {
            const next = new Map(prev);
            next.set(event.toolCallId!, { name: event.toolName || "未知", output: "", error: false });
            return next;
          });
        }
        break;

      case "tool_update":
        if (event.toolCallId) {
          setToolCalls(prev => {
            const next = new Map(prev);
            const existing = next.get(event.toolCallId!);
            if (existing) {
              next.set(event.toolCallId!, { ...existing, output: (existing.output || "") + (event.toolOutput || "") });
            }
            return next;
          });
        }
        break;

      case "tool_end":
        if (event.toolCallId) {
          setToolCalls(prev => {
            const next = new Map(prev);
            const existing = next.get(event.toolCallId!);
            if (existing) {
              next.set(event.toolCallId!, { ...existing, error: event.toolError || false });
            }
            return next;
          });
        }
        break;

      case "error":
        showError(event.error || "未知错误");
        setIsStreaming(false);
        setStreamingText("");
        setStreamingThinking("");
        setStreamingMsgId(null);
        setToolCalls(new Map());
        streamingMsgIdRef.current = null;
        break;

      case "turn_end":
      case "message_end":
        // session_updated will handle final state
        break;
    }
  }

  function handleLog(entry: LogEntry) {
    setLogs(prev => [...prev, entry]);
  }

  // ---- auto-scroll ----
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [streamingText, streamingThinking, toolCalls, sessionDetail]);

  // ---- load data ----
  async function loadSessions() {
    try {
      const list = await api.listSessions();
      // deduplicate by id (filePath) and filter out entries with 0 messages if older entries exist
      const seen = new Map<string, SessionSummary>();
      for (const s of list) {
        const existing = seen.get(s.id);
        if (!existing || s.messageCount > existing.messageCount) {
          seen.set(s.id, s);
        }
      }
      setSessions([...seen.values()].sort((a, b) => b.updatedAt - a.updatedAt));
    } catch (e: any) {
      console.error("Failed to load sessions:", e);
    }
  }

  async function loadModels() {
    try {
      const m = await api.getModels();
      setModels(m);
      // Get unique providers from models
      const providers = [...new Set(m.map(x => x.provider))];
      setConfiguredProviders(providers);
      if (providers.length > 0 && !provider) {
        setProvider(providers[0]);
      }
    } catch (e: any) {
      console.error("Failed to load models:", e);
    }
  }

  function handleProviderChange(p: string) {
    setProvider(p);
    // Auto-select first model for this provider
    const providerModels = models.filter(m => m.provider === p);
    if (providerModels.length > 0) {
      setModelId(providerModels[0].modelId);
    }
  }

  function refreshModels() {
    loadModels();
  }

  function buildNodeState(detail: SessionDetail) {
    if (!detail || !detail.tree) return;
    const tree = detail.tree;
    if (tree.length > 10000) return;

    // ============================================================
    // Build a clean display tree from Pi SDK's raw tree.
    //
    // Pi SDK provides forkGroup / forkSiblings for branch siblings.
    //
    // Two-level grouping per forkGroup:
    //   1. Same-content user nodes are merged (combine children).
    //   2. After dedup, mark non-activePath variants as merged;
    //      store forkSiblings on the active one for ForkSwitcher.
    // ============================================================

    const activePathSet = new Set(detail.activePath);
    const map = new Map<string, TreeNode>();

    // ---- Clone all nodes (skip synthetic branch_root) ----
    for (const node of tree) {
      if (node.label === "branch_root") continue;
      map.set(node.id, { ...node, children: [...node.children] });
    }

    // ---- Group by forkGroup ----
    const forkGroups = new Map<string, string[]>();
    for (const node of tree) {
      if (node.forkGroup) {
        if (!forkGroups.has(node.forkGroup)) forkGroups.set(node.forkGroup, []);
        forkGroups.get(node.forkGroup)!.push(node.id);
      }
    }

    const mergedIds = new Set<string>();

    for (const [, ids] of forkGroups) {
      if (ids.length <= 1) continue;

      // ---- Step A: dedup same-content user nodes, combine children ----
      const byContent = new Map<string, string[]>();
      for (const id of ids) {
        const n = map.get(id);
        if (!n) continue;
        const key = n.role === "user" ? n.content : "";
        if (!byContent.has(key)) byContent.set(key, []);
        byContent.get(key)!.push(id);
      }

      const surviving: string[] = [];

      for (const [, cids] of byContent) {
        // Pick primary (prefer activePath)
        let primaryId = "";
        for (const id of cids) {
          if (activePathSet.has(id)) { primaryId = id; break; }
        }
        if (!primaryId) primaryId = cids[0];

        const primary = map.get(primaryId)!;
        surviving.push(primaryId);

        // Merge same-content nodes: combine their children (assistant replies)
        for (const id of cids) {
          if (id === primaryId) continue;
          mergedIds.add(id);
          const merged = map.get(id);
          if (!merged) continue;
          for (const cid of merged.children) {
            if (!primary.children.includes(cid)) {
              primary.children.push(cid);
            }
          }
        }
      }

      // ---- Step B: after dedup, mark non-activePath survivors as merged ----
      if (surviving.length > 1) {
        let activeId = "";
        for (const id of surviving) {
          if (activePathSet.has(id)) { activeId = id; break; }
        }
        if (!activeId) activeId = surviving[0];

        const activePrimary = map.get(activeId)!;
        const others = surviving.filter(id => id !== activeId);
        for (const id of others) mergedIds.add(id);

        (activePrimary as any).forkSiblings = others;
      }
    }

    // ---- Cleanup: remove all merged nodes from parent children ----
    for (const id of mergedIds) {
      const n = map.get(id);
      if (!n || !n.parentId) continue;
      const parent = map.get(n.parentId);
      if (parent) {
        parent.children = parent.children.filter(c => c !== id);
      }
    }

    // ---- Build activePathIds ----
    const pathSet = new Set<string>();
    for (const id of detail.activePath) {
      if (mergedIds.has(id)) continue;
      if (map.has(id)) pathSet.add(id);
    }

    // ---- Build display order: flat time-sorted list (skip tree traversal) ----
    const order: string[] = [];
    const sortedNodes = [...map.values()]
      .filter(n => n.label !== "branch_root" && !mergedIds.has(n.id))
      .sort((a, b) => a.timestamp - b.timestamp);
    for (const node of sortedNodes) {
      if (node.role === "assistant" && !node.content && !(node as any)._inlineTools && !(node.contentBlocks && node.contentBlocks.length > 0)) continue;
      order.push(node.id);
    }

    setNodeMap(map);
    setActivePathIds(pathSet);
    setDisplayOrder(order);
  }

  // ---- session actions ----
  function handleStartRename(sessionId: string, currentName: string, e: React.MouseEvent) {
    e.stopPropagation();
    setRenameTarget({ id: sessionId, name: currentName });
    setRenameInput(currentName);
  }

  async function handleSubmitRename() {
    if (!renameTarget || !renameInput.trim()) return;
    try {
      await api.renameSession(renameTarget.id, renameInput.trim());
      setSessions(prev => prev.map(s =>
        s.id === renameTarget.id ? { ...s, name: renameInput.trim() } : s
      ));
      if (activeSessionId === renameTarget.id) {
        setSessionDetail(prev => prev ? { ...prev, name: renameInput.trim() } : null);
      }
      setRenameTarget(null);
    } catch (e: any) {
      showError(e.message);
    }
  }

  function handleCancelRename(e?: React.MouseEvent) {
    e?.stopPropagation();
    setRenameTarget(null);
  }

  function handleStartDelete(session: SessionSummary, e: React.MouseEvent) {
    e.stopPropagation();
    setDeleteTarget(session);
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    try {
      await api.deleteSession(deleteTarget.id);
      setSessions(prev => prev.filter(s => s.id !== deleteTarget.id));
      if (activeSessionId === deleteTarget.id) {
        setActiveSessionId(null);
        setSessionDetail(null);
      }
      setDeleteTarget(null);
    } catch (e: any) {
      showError(e.message);
    }
  }

  function handleCancelDelete() {
    setDeleteTarget(null);
  }

  // ---- regenerate assistant reply ----
  async function handleRegenerate(assistantNodeId: string) {
    if (!activeSessionId || isStreaming) return;
    const assistantNode = nodeMap.get(assistantNodeId);
    if (!assistantNode || !assistantNode.parentId) return;
    const parentNode = nodeMap.get(assistantNode.parentId);
    if (!parentNode || parentNode.role !== "user") return;

    try {
      const detail = await api.navigateTree(activeSessionId, parentNode.id);
      setSessionDetail(detail);
      buildNodeState(detail);

      setIsStreaming(true);
      setStreamingText("");
      setStreamingThinking("");
      setToolCalls(new Map());

      socketRef.current?.emit("prompt", {
        sessionId: activeSessionId,
        message: parentNode.content,
        model: modelId,
        provider,
        thinkingLevel,
      });
    } catch (e: any) {
      showError(e.message);
    }
  }

  async function handleNewSession() {
    setShowNewSessionDialog(true);
    setNewSessionName("");
    setNewSessionCwd(defaultCwd);
  }

  async function handleCreateSessionWithCwd() {
    setShowNewSessionDialog(false);
    const cwd = newSessionCwd.trim() || undefined;
    const name = newSessionName.trim() || (cwd ? cwd.replace(/\\/g, "/").split("/").pop() || cwd : "新会话");
    // Save cwd as preset if it's new
    if (cwd) {
      addCwdPreset(cwd);
      setDefaultCwd(cwd);
      try { localStorage.setItem("pi-web-default-cwd", cwd); } catch {}
    }
    try {
      const s = await api.createSession(name, cwd);
      setSessions(prev => {
        const filtered = prev.filter(x => x.id !== s.id);
        return [s, ...filtered];
      });
      setActiveSessionId(s.id);
      // Reset all display state so old messages don't linger
      setSessionDetail(null);
      setNodeMap(new Map());
      setActivePathIds(new Set());
      setDisplayOrder([]);
      setStreamingText("");
      setStreamingThinking("");
      setStreamingMsgId(null);
      setToolCalls(new Map());
    } catch (e: any) {
      showError(e.message);
    }
  }

  async function handleOpenImportHistory() {
    setShowImportHistory(true);
    setHistoryLoading(true);
    setHistorySessions([]);
    try {
      const list = await api.listPiHistory();
      setHistorySessions(list);
    } catch (e: any) {
      showError("无法加载 pi 终端历史: " + (e.message || String(e)));
    } finally {
      setHistoryLoading(false);
    }
  }

  async function handleImportSession(item: SessionSummary) {
    await doImport(item.filePath);
  }

  async function doImport(filePath: string) {
    try {
      const s = await api.importFromPath(filePath);
      // Add to sessions list if not already there
      setSessions(prev => {
        const filtered = prev.filter(x => x.id !== s.id);
        return [s, ...filtered];
      });
      // Load the detail
      const detail = await api.getSessionDetail(s.id);
      setActiveSessionId(s.id);
      setSessionDetail(detail);
      buildNodeState(detail);
      setShowImportHistory(false);
    } catch (e: any) {
      showError("导入失败: " + (e.message || String(e)));
    }
  }

  async function handleManualImport() {
    const p = manualPath.trim();
    if (!p) return;
    await doImport(p);
    setManualPath("");
  }

  // Drag-and-drop handler for file drop
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDropActive(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDropActive(false);
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDropActive(false);

    // Try to get file path from the drop event
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        // On some systems (Windows Electron-like), the path property is available
        const filePath = (file as any).path;
        if (filePath && filePath.endsWith(".jsonl")) {
          await doImport(filePath);
          return;
        }
        // If name ends with .jsonl, try to construct path from the file name
        // Since browsers don't expose full path for security, fall back to name hint
        if (file.name.endsWith(".jsonl")) {
          showError(
            "浏览器安全限制，无法从拖拽获取文件路径。\n" +
            "请在下方输入框中粘贴 .jsonl 文件的完整路径，或点击列表中的历史会话。"
          );
          return;
        }
      }
    }

    // Try text drop (file path as text)
    const text = e.dataTransfer.getData("text/plain");
    if (text) {
      const trimmed = text.trim();
      if (trimmed.endsWith(".jsonl")) {
        await doImport(trimmed);
        return;
      }
      // Maybe it's a directory path - show error
      showError("请拖入 .jsonl 文件，或粘贴 .jsonl 文件的完整路径到输入框中。");
      return;
    }
  }

  async function handleContinueSession(session: SessionSummary) {
    // If already on this session, just reload detail without re-creating
    if (activeSessionId === session.filePath) {
      try {
        const detail = await api.getSessionDetail(session.filePath);
        if (detail) {
          setSessionDetail(detail);
          buildNodeState(detail);
        } else {
          showError("会话文件无法读取，可能已移动或损坏");
        }
      } catch (e: any) {
        showError(e.message);
      }
      return;
    }
    try {
      const s = await api.continueSession(session.filePath);
      if (!s) throw new Error("无法连接会话");
      setSessions(prev => {
        const filtered = prev.filter(x => x.id !== s.id);
        return [s, ...filtered];
      });
      const detail = await api.getSessionDetail(s.id);
      setActiveSessionId(s.id);
      setSessionDetail(detail);
      buildNodeState(detail);
    } catch (_e: any) {
      // Fallback: try file-level read without AgentSession
      try {
        const detail = await api.getSessionDetail(session.filePath);
        if (detail) {
          setActiveSessionId(session.filePath);
          setSessionDetail(detail);
          buildNodeState(detail);
          return;
        }
      } catch {}
      showError("无法加载会话: " + (_e.message || "未知错误"));
    }
  }

  // ---- send message ----
  async function handleSend() {
    const text = inputText.trim();
    if (!text || !activeSessionId || isStreaming) return;

    setInputText("");
    setIsStreaming(true);
    setStreamingText("");
    setStreamingThinking("");
    setToolCalls(new Map());

    socketRef.current?.emit("prompt", {
      sessionId: activeSessionId,
      message: text,
      model: modelId,
      provider,
      thinkingLevel,
    });
  }

  function handleAbort() {
    if (!activeSessionId) return;
    socketRef.current?.emit("abort", { sessionId: activeSessionId });
    // Clean up streaming state immediately (don't wait for server response)
    setIsStreaming(false);
    setStreamingText("");
    setStreamingThinking("");
    setStreamingMsgId(null);
    setToolCalls(new Map());
    streamingMsgIdRef.current = null;
  }

  // ---- tree navigation ----
  async function handleNavigateTree(targetId: string) {
    if (!activeSessionId) return;
    try {
      const detail = await api.navigateTree(activeSessionId, targetId);
      setSessionDetail(detail);
      buildNodeState(detail);
      setStreamingText("");
      setStreamingThinking("");
    } catch (e: any) {
      showError(e.message);
    }
  }

  // ---- edit message ----

  function startEdit(nodeId: string, content: string) {
    setEditingId(nodeId);
    setEditText(content);
  }

  async function submitEdit() {
    if (!editingId || !activeSessionId) return;
    const newText = editText;
    try {
      // 1. Navigate tree to the edited message position
      await api.editMessage(activeSessionId, editingId, newText);

      // 2. Refresh the detail so the tree shows the fork point
      const detail = await api.getSessionDetail(activeSessionId);
      setSessionDetail(detail);
      buildNodeState(detail);

      // 3. Clean up edit state
      setEditingId(null);
      setEditText("");

      // 4. Automatically send the edited text as a new prompt via WebSocket
      setIsStreaming(true);
      setStreamingText("");
      setStreamingThinking("");
      setToolCalls(new Map());

      socketRef.current?.emit("prompt", {
        sessionId: activeSessionId,
        message: newText,
        model: modelId,
        provider,
        thinkingLevel,
      });
    } catch (e: any) {
      showError(e.message);
      // Clean up edit state on error (Bug fix: prevent stuck editing state)
      setEditingId(null);
      setEditText("");
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setEditText("");
  }

  // ---- file drag & drop into input area ----
  function handleFileDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    // Only highlight if files are being dragged
    if (e.dataTransfer.types.includes("Files")) {
      setFileDropActive(true);
    }
  }

  function handleFileDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setFileDropActive(false);
  }

  async function handleFileDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setFileDropActive(false);

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) {
      // Try text drop (file path as text) — useful for pasting paths
      const text = e.dataTransfer.getData("text/plain");
      if (text) {
        const paths = text.split("\n").map(p => p.trim()).filter(Boolean);
        const refs = paths.map(p => {
          const clean = p.replace(/^["']|["']$/g, "");
          return clean.startsWith("@") ? clean : `@ ${clean}`;
        }).join(" ");
        setInputText(prev => prev ? `${prev} ${refs}` : refs);
      }
      return;
    }

    // Check total size — warn if large
    const totalSize = [...files].reduce((sum, f) => sum + f.size, 0);
    const MAX_SIZE = 50 * 1024 * 1024; // 50MB

    if (totalSize > MAX_SIZE) {
      showError(
        `文件过大 (${(totalSize / 1024 / 1024).toFixed(1)}MB)。` +
        `大文件建议直接在输入框中粘贴文件路径：先复制路径（文件管理器地址栏），再粘贴到输入框。`
      );
      return;
    }

    // Upload files to server, get back server-side paths
    try {
      const formData = new FormData();
      for (let i = 0; i < files.length; i++) {
        formData.append("files", files[i]);
      }

      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const json = await res.json();

      if (json.success && json.data?.paths) {
        const refs = json.data.paths.map((p: string) => `@ ${p}`).join(" ");
        setInputText(prev => prev ? `${prev} ${refs}` : refs);
      } else {
        showError("文件上传失败: " + (json.error || "未知错误"));
      }
    } catch (err: any) {
      showError("文件上传失败: " + (err.message || "网络错误"));
    }
  }

  // ---- get nodes on active path for display ----
  // Group consecutive tool messages into a collapsible block
  function getDisplayNodes(): TreeNode[] {
    const raw: TreeNode[] = [];
    for (const id of displayOrder) {
      const node = nodeMap.get(id);
      if (node && node.label !== "branch_root") {
        // Skip system placeholder nodes (empty content, no inline tools, not user)
        const hasInlineTools = !!(node as any)._inlineTools;
        if (node.content || hasInlineTools || node.role === "user" || (node.contentBlocks && node.contentBlocks.length > 0)) {
          raw.push(node);
        }
      }
    }
    // Plan A: inline tool results into the previous assistant message
    // Also collapse consecutive non-user messages into a single block
    const merged: TreeNode[] = [];
    let toolBuffer: TreeNode[] = [];

    function attachTools(target: TreeNode) {
      if (toolBuffer.length === 0) return;
      (target as any)._inlineTools = (target as any)._inlineTools
        ? [...(target as any)._inlineTools, ...toolBuffer]
        : toolBuffer;
      toolBuffer = [];
    }

    for (const node of raw) {
      if (node.role === "tool") {
        toolBuffer.push(node);
      } else {
        if (toolBuffer.length > 0 && merged.length > 0 && merged[merged.length - 1].role === "assistant") {
          attachTools(merged[merged.length - 1]);
        } else if (toolBuffer.length > 0) {
          toolBuffer = []; // orphan tools — discard
        }
        merged.push(node);
      }
    }
    if (toolBuffer.length > 0 && merged.length > 0 && merged[merged.length - 1].role === "assistant") {
      attachTools(merged[merged.length - 1]);
    }
    return merged;
  }

  // ---- render ----
  const rawDisplayNodes = useMemo(() => getDisplayNodes(), [nodeMap, displayOrder, activePathIds]);
  // Cap visible nodes for performance
  const MAX_VISIBLE = 100;
  const displayNodes = rawDisplayNodes.length > MAX_VISIBLE
    ? rawDisplayNodes.slice(-MAX_VISIBLE)
    : rawDisplayNodes;
  const currentModels = models.filter(m => m.provider === provider);

  return (
    <div className="app">
      {/* ====== SIDEBAR ====== */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <h2>Pi Web UI</h2>
          <button className="btn btn-primary" onClick={handleNewSession}>+ 新建会话</button>
        </div>
        <div className="session-list">
          {sessions.map(s => (
            <div
              key={s.id}
              className={`session-item ${s.id === activeSessionId ? "active" : ""}`}
              onClick={() => handleContinueSession(s)}
              title={s.name}
            >
              <div className="session-name">
                {renameTarget?.id === s.id ? (
                  <span className="rename-inline" onClick={e => e.stopPropagation()}>
                    <input
                      value={renameInput}
                      onChange={e => setRenameInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") { e.preventDefault(); handleSubmitRename(); }
                        if (e.key === "Escape") handleCancelRename();
                      }}
                      autoFocus
                    />
                    <button className="btn btn-primary btn-xs" onClick={handleSubmitRename} title="确认">✓</button>
                    <button className="btn btn-ghost btn-xs" onClick={handleCancelRename} title="取消">✕</button>
                  </span>
                ) : (
                  trunc(s.name, 40)
                )}
              </div>
              <div className="session-meta">{fmtTime(s.updatedAt)} · {s.messageCount} msgs</div>
              <div className="session-actions">
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={e => handleStartRename(s.id, s.name, e)}
                  title="重命名"
                >✏️</button>
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={e => handleStartDelete(s, e)}
                  title="删除"
                >🗑</button>
              </div>
            </div>
          ))}
          {sessions.length === 0 && (
            <div className="empty">暂无会话，点击「+ 新建会话」开始</div>
          )}
        </div>
        <div className="sidebar-footer">
          <button className="btn btn-ghost" onClick={handleOpenImportHistory}>📥 导入历史</button>
          <button className="btn btn-ghost" onClick={() => setShowSettings(true)}>⚙ 设置</button>
          <button className="btn btn-ghost" onClick={() => setShowTree(!showTree)}>
            {showTree ? "隐藏对话树" : "🌳 对话树"}
          </button>
          <button className="btn btn-ghost" onClick={() => { setShowDebug(!showDebug); if (!showDebug) setLogs([]); }}>
            🐛 调试
          </button>
        </div>
      </aside>

      {/* ====== MAIN ====== */}
      <main className="main">
        {/* Model bar */}
        <div className="model-bar">
          {configuredProviders.length === 0 ? (
            <span className="model-bar-hint">⚙ 请先<button className="btn btn-ghost btn-sm" onClick={() => setShowSettings(true)}>配置提供商</button>以开始使用</span>
          ) : (
            <>
              <select value={provider} onChange={e => handleProviderChange(e.target.value)}>
                {configuredProviders.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <select value={modelId} onChange={e => setModelId(e.target.value)}>
                {currentModels.map(m => (
                  <option key={m.modelId} value={m.modelId}>{m.modelId}</option>
                ))}
                {currentModels.length === 0 && <option value="">暂无模型</option>}
              </select>
              <select value={thinkingLevel} onChange={e => setThinkingLevel(e.target.value as ThinkingLevel)}>
                <option value="off">不思考</option>
                <option value="low">轻度思考</option>
                <option value="medium">中度思考</option>
                <option value="high">深度思考</option>
                <option value="xhigh">极致思考</option>
              </select>
            </>
          )}
          <button className="btn btn-ghost btn-sm" onClick={refreshModels} title="刷新模型列表">🔄</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowSettings(true)}>⚙</button>
        </div>

        {/* Error toasts */}
        {errors.length > 0 && (
          <div className="error-toasts">
            {errors.map(e => (
              <div key={e.id} className="error-toast">
                <span className="error-toast-text">⚠ {e.text}</span>
                <button className="error-toast-close" onClick={() => dismissError(e.id)}>✕</button>
              </div>
            ))}
          </div>
        )}

        {/* Messages */}
        <div className="messages">
          {!activeSessionId && (
            <div className="welcome">
              <h1>Pi Web UI</h1>
              <p>选择一个会话或新建一个开始对话</p>
              <button className="btn btn-primary btn-lg" onClick={handleNewSession}>开始新对话</button>
            </div>
          )}

          {activeSessionId && displayNodes.length === 0 && !isStreaming && (
            <div className="welcome">
              <h3>新会话</h3>
              <p>发送消息开始对话</p>
            </div>
          )}

          {/* Display messages on active path */}
          {displayNodes.map(node => (
            <MessageBubble
              key={node.id}
              node={node}
              isActive={activePathIds.has(node.id)}
              activePathIds={activePathIds}
              nodeMap={nodeMap}
              onNavigate={handleNavigateTree}
              onEdit={node.role === "user" ? startEdit : undefined}
              onRegenerate={handleRegenerate}
              isEditing={editingId === node.id}
              editText={editText}
              onEditChange={setEditText}
              onEditSubmit={submitEdit}
              onEditCancel={cancelEdit}
            />
          ))}

          {/* Streaming message */}
          {isStreaming && streamingMsgId && (
            <div className="message streaming">
              {/* Thinking */}
              {streamingThinking && (
                <div className="thinking-block">
                  <div className="thinking-header">💭 思考中...</div>
                  <pre className="thinking-content">{streamingThinking}</pre>
                </div>
              )}

              {/* Tool calls in progress */}
              {[...toolCalls.entries()].map(([id, tc]) => (
                <div key={id} className={`tool-call ${tc.error ? "tool-error" : ""}`}>
                  <div className="tool-name">🔧 {tc.name}</div>
                  {tc.output && <pre className="tool-output">{trunc(tc.output, 2000)}</pre>}
                  {!tc.output && <div className="tool-pending">执行中...</div>}
                </div>
              ))}

              {/* Text output */}
              {streamingText && (
                <div className="assistant-content">
                  <MarkdownText text={streamingText} />
                </div>
              )}

              {/* Streaming indicator */}
              {!streamingText && toolCalls.size === 0 && !streamingThinking && (
                <div className="typing-indicator">
                  <span className="dot">●</span>
                  <span className="dot">●</span>
                  <span className="dot">●</span>
                </div>
              )}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        {activeSessionId && (
          <ChatInput
            isStreaming={isStreaming}
            editingId={editingId}
            inputText={inputText}
            setInputText={setInputText}
            inputRef={inputRef as React.RefObject<HTMLTextAreaElement>}
            fileDropActive={fileDropActive}
            onFileDragOver={handleFileDragOver}
            onFileDragLeave={handleFileDragLeave}
            onFileDrop={handleFileDrop}
            onSend={editingId ? submitEdit : handleSend}
            onAbort={handleAbort}
            onCancelEdit={cancelEdit}
          />
        )}
      </main>

      {/* ====== TREE PANEL ====== */}
      {showTree && activeSessionId && sessionDetail && (
        <aside className="tree-panel">
          <h3>对话树</h3>
          <TreeView
            nodeMap={nodeMap}
            activePathIds={activePathIds}
            onNavigate={handleNavigateTree}
          />
        </aside>
      )}

      {/* ====== NEW SESSION DIALOG ====== */}
      {showNewSessionDialog && (
        <div className="modal-overlay" onClick={() => setShowNewSessionDialog(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>新建会话</h2>
              <button className="btn btn-ghost" onClick={() => setShowNewSessionDialog(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="custom-form-grid">
                <label>会话名称</label>
                <input
                  type="text"
                  value={newSessionName}
                  onChange={e => setNewSessionName(e.target.value)}
                  placeholder="可选，默认使用项目目录名"
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === "Enter") { e.preventDefault(); handleCreateSessionWithCwd(); }
                  }}
                />
                <label>工作目录 (cwd)</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    type="text"
                    value={newSessionCwd}
                    onChange={e => setNewSessionCwd(e.target.value)}
                    placeholder="留空使用服务器默认目录"
                    style={{ flex: 1 }}
                    onKeyDown={e => {
                      if (e.key === "Enter") { e.preventDefault(); handleCreateSessionWithCwd(); }
                    }}
                  />
                </div>
                {cwdPresets.length > 0 && (
                  <>
                    <label>已保存的预设</label>
                    <div className="cwd-presets">
                      {cwdPresets.map(p => (
                        <PresetChip
                          key={p.path}
                          preset={p}
                          isActive={newSessionCwd === p.path}
                          onSelect={() => setNewSessionCwd(p.path)}
                          onRename={(name) => renameCwdPreset(p.path, name)}
                          onRemove={() => removeCwdPreset(p.path)}
                        />
                      ))}
                    </div>
                  </>
                )}
                <label></label>
                <span className="settings-desc" style={{ marginTop: -4 }}>
                  设置工作目录后，pi 会自动加载该目录的 <code>.pi/agents/</code>、<code>AGENTS.md</code> 等上下文，
                  从而使用项目专属的子代理（如 architect / worker）。
                </span>
              </div>
              <div className="custom-form-actions" style={{ marginTop: 16 }}>
                <button className="btn btn-primary" onClick={handleCreateSessionWithCwd}>创建</button>
                <button className="btn btn-ghost" onClick={() => setShowNewSessionDialog(false)}>取消</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ====== DELETE CONFIRMATION ====== */}
      {deleteTarget && (
        <div className="modal-overlay" onClick={handleCancelDelete}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>删除会话</h2>
              <button className="btn btn-ghost" onClick={handleCancelDelete}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{ marginBottom: 16, color: "var(--text-secondary)", lineHeight: 1.6 }}>
                确定要删除会话 <strong style={{ color: "var(--text-primary)" }}>{deleteTarget.name}</strong> 吗？
                <br />此操作将删除会话文件且不可恢复。
              </p>
              <div className="custom-form-actions">
                <button className="btn btn-danger" onClick={handleConfirmDelete}>删除</button>
                <button className="btn btn-ghost" onClick={handleCancelDelete}>取消</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ====== IMPORT HISTORY MODAL ====== */}
      {showImportHistory && (
        <div className="modal-overlay" onClick={() => setShowImportHistory(false)}>
          <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>导入 Pi 终端历史</h2>
              <button className="btn btn-ghost" onClick={() => setShowImportHistory(false)}>✕</button>
            </div>
            <div className="modal-body">
              {/* Drag-and-drop zone */}
              <div
                className={`drop-zone ${dropActive ? "drop-active" : ""}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <div className="drop-zone-content">
                  <span style={{ fontSize: 32 }}>📂</span>
                  <p>拖拽 .jsonl 文件到此处导入</p>
                  <p className="drop-zone-hint">或将文件路径粘贴到下方输入框</p>
                </div>
              </div>

              {/* Manual path input */}
              <div className="manual-import-row">
                <input
                  type="text"
                  value={manualPath}
                  onChange={e => setManualPath(e.target.value)}
                  placeholder="粘贴 .jsonl 文件的完整路径，例如 C:\\Users\\...\\sessions\\...\\xxx.jsonl"
                  onKeyDown={e => {
                    if (e.key === "Enter") { e.preventDefault(); handleManualImport(); }
                  }}
                />
                <button className="btn btn-primary btn-sm" onClick={handleManualImport} disabled={!manualPath.trim()}>
                  导入
                </button>
              </div>

              <div style={{ margin: "12px 0 8px", borderTop: "1px solid var(--border)" }} />

              <p className="settings-desc" style={{ marginBottom: 16 }}>
                或从 <code>~/.pi/agent/sessions/</code> 浏览历史会话：
              </p>

              {historyLoading ? (
                <div style={{ padding: 24, textAlign: "center", color: "var(--text-secondary)" }}>
                  正在扫描历史会话...
                </div>
              ) : historySessions.length === 0 ? (
                <div className="empty" style={{ padding: 24 }}>
                  未自动发现 Pi 历史会话。<br />
                  <small>请使用上方拖拽或路径输入方式导入 .jsonl 文件。</small>
                </div>
              ) : (
                <div className="history-list">
                  {historySessions.map(item => (
                    <div
                      key={item.id}
                      className="history-item"
                      onClick={() => handleImportSession(item)}
                    >
                      <div className="history-name">{item.name}</div>
                      <div className="history-meta">
                        {item.cwd && <span className="history-cwd">📁 {item.cwd}</span>}
                        <span>{fmtTime(item.updatedAt)}</span>
                        <span>{item.messageCount} 条消息</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ====== SETTINGS MODAL ====== */}
      {showSettings && (
        <SettingsDialog
          onClose={() => setShowSettings(false)}
          onUpdated={loadModels}
        />
      )}

      {/* ====== DEBUG PANEL ====== */}
      {showDebug && (
        <DebugPanel logs={logs} onClear={() => { setLogs([]); clearLogs(); }} onClose={() => setShowDebug(false)} />
      )}
    </div>
  );
}

// ==================== FORK SWITCHER (same-content user variants) ====================

// ==================== AGENT LABEL ====================

function AgentLabel({ agentRole, agentName, isSubagentCall, subagentTask }: {
  agentRole?: string;
  agentName?: string;
  isSubagentCall?: boolean;
  subagentTask?: string;
}) {
  const config: Record<string, { emoji: string; label: string; color: string }> = {
    architect: { emoji: "🏛️", label: "Architect", color: "#4a9eff" },
    worker: { emoji: "🔧", label: "Worker", color: "#4ade80" },
    subagent: { emoji: "🤖", label: agentName || "Subagent", color: "#a78bfa" },
    main: { emoji: "", label: "", color: "" },
  };
  
  const info = config[agentRole || "main"] || config.main;
  if (!agentRole || agentRole === "main") {
    if (isSubagentCall) {
      return (
        <span className="agent-badge subagent-call" style={{ borderColor: "#a78bfa" }}>
          📤 调用子代理: {subagentTask ? truncate(subagentTask, 40) : "处理中"}
        </span>
      );
    }
    return null;
  }
  
  return (
    <span className="agent-badge" style={{ borderColor: info.color, color: info.color }}>
      {info.emoji} {info.label}
    </span>
  );
}

// ==================== CONTENT BLOCK VIEW ====================

function ContentBlockView({ block }: { block: { type: string; text?: string; toolName?: string; toolCallId?: string; arguments?: Record<string, any>; isError?: boolean } }) {
  switch (block.type) {
    case "tool_call":
      return (
        <div className="block-tool-call">
          <span className="block-tool-icon">🔧</span>
          <span className="block-tool-name">{block.toolName || "未知工具"}</span>
          {block.arguments && Object.keys(block.arguments).length > 0 && (
            <details className="block-tool-args">
              <summary>参数</summary>
              <pre>{JSON.stringify(block.arguments, null, 2)}</pre>
            </details>
          )}
        </div>
      );
    case "tool_result":
      return (
        <details className="block-tool-result">
          <summary>{block.isError ? "❌" : "✅"} 工具结果 {(block.text || "").slice(0, 80)}...</summary>
          <pre>{block.text}</pre>
        </details>
      );
    case "thinking":
      return (
        <details className="block-thinking">
          <summary>💭 思考过程</summary>
          <pre>{block.text}</pre>
        </details>
      );
    case "text":
    default:
      return <MarkdownText text={block.text || ""} />;
  }
}

// ==================== PRESET CHIP ====================

function PresetChip({
  preset, isActive, onSelect, onRename, onRemove
}: {
  preset: { name: string; path: string };
  isActive: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState(preset.name);

  if (editing) {
    return (
      <div className="preset-chip preset-chip-editing">
        <input
          type="text"
          value={editVal}
          onChange={e => setEditVal(e.target.value)}
          className="preset-edit-input"
          autoFocus
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.preventDefault();
              const trimmed = editVal.trim();
              if (trimmed) onRename(trimmed);
              setEditing(false);
            }
            if (e.key === "Escape") { setEditing(false); setEditVal(preset.name); }
          }}
          onBlur={() => {
            const trimmed = editVal.trim();
            if (trimmed && trimmed !== preset.name) onRename(trimmed);
            setEditing(false);
          }}
        />
      </div>
    );
  }

  return (
    <button
      className={`preset-chip ${isActive ? "preset-chip-active" : ""}`}
      onClick={onSelect}
      title={preset.path}
    >
      <span
        className="preset-name editable"
        onDoubleClick={e => { e.stopPropagation(); setEditing(true); setEditVal(preset.name); }}
      >{preset.name}</span>
      <span className="preset-path">{preset.path}</span>
      <span
        className="preset-remove"
        onClick={e => { e.stopPropagation(); onRemove(); }}
      >✕</span>
    </button>
  );
}

// ==================== INLINE TOOLS ====================

function InlineTools({ tools }: { tools: TreeNode[] }) {
  const [expanded, setExpanded] = useState(false);
  const toolNames = [...new Set(tools.map(t => t.toolName || ""))].filter(Boolean).join(", ");
  const errorCount = tools.filter(t => t.toolError).length;

  return (
    <div className="inline-tools">
      <div className="inline-tools-header" onClick={() => setExpanded(!expanded)}>
        <span className="inline-tools-arrow">{expanded ? "▼" : "▶"}</span>
        <span className="inline-tools-label">
          🔧 {tools.length} 个工具结果
          {toolNames ? ` (${toolNames})` : ""}
          {errorCount > 0 ? ` ${errorCount} ❌` : ""}
        </span>
      </div>
      {expanded && (
        <div className="inline-tools-body">
          {tools.map((t) => (
            <div key={t.id} className={`inline-tool-result ${t.toolError ? "tool-error" : ""}`}>
              <div className="inline-tool-name">{t.toolName || "工具"}{t.toolError ? " ❌" : ""}</div>
              <pre>{trunc(t.content, 2000)}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
// ==================== CHAT INPUT ====================

const ChatInput = memo(function ChatInput({
  isStreaming, editingId, inputText, setInputText, inputRef,
  fileDropActive, onFileDragOver, onFileDragLeave, onFileDrop,
  onSend, onAbort, onCancelEdit,
}: {
  isStreaming: boolean;
  editingId: string | null;
  inputText: string;
  setInputText: (v: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  fileDropActive: boolean;
  onFileDragOver: (e: React.DragEvent) => void;
  onFileDragLeave: (e: React.DragEvent) => void;
  onFileDrop: (e: React.DragEvent) => void;
  onSend: () => void;
  onAbort: () => void;
  onCancelEdit: () => void;
}) {
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }, [onSend]);

  return (
    <div
      className={`input-area ${fileDropActive ? "file-drop-active" : ""}`}
      onDragOver={onFileDragOver}
      onDragLeave={onFileDragLeave}
      onDrop={onFileDrop}
    >
      {fileDropActive && (
        <div className="file-drop-overlay">
          <span style={{ fontSize: 36 }}>📎</span>
          <p>释放以引用文件</p>
        </div>
      )}
      {editingId && (
        <div className="edit-bar">
          <span>正在编辑消息</span>
          <button className="btn btn-ghost btn-sm" onClick={onCancelEdit}>取消</button>
        </div>
      )}
      <div className="input-row">
        <textarea
          ref={inputRef}
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={editingId ? "编辑后按 Enter 提交" : "输入消息或拖拽文件... (Enter 发送，Shift+Enter 换行)"}
          rows={2}
          disabled={isStreaming}
        />
        {isStreaming ? (
          <button className="btn btn-danger" onClick={onAbort}>停止</button>
        ) : (
          <button className="btn btn-primary" onClick={onSend} disabled={!inputText.trim()}>发送</button>
        )}
      </div>
    </div>
  );
});


// ==================== FORK SWITCHER (same-content user variants) ====================

function ForkSwitcher({
  node, nodeMap, activePathIds, onNavigate
}: {
  node: TreeNode;
  nodeMap: Map<string, TreeNode>;
  activePathIds: Set<string>;
  onNavigate: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const variantIds = [node.id, ...(node.forkSiblings || [])];
  const variantNodes = variantIds.map(id => nodeMap.get(id)).filter(Boolean) as TreeNode[];

  if (variantNodes.length <= 1) return null;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const activeVariant = variantNodes.find(v => activePathIds.has(v.id)) ?? variantNodes[0];
  const activeLabel = (activeVariant.content || "").slice(0, 50) || activeVariant.id.slice(0, 8);

  const handleSelect = (branch: TreeNode) => {
    setOpen(false);
    // Navigate to the deepest leaf of this branch (like ChildBranchSwitcher)
    let navTarget = branch.id;
    let current: TreeNode | undefined = branch;
    while (current.children && current.children.length > 0) {
      navTarget = current.children[current.children.length - 1];
      const next = nodeMap.get(navTarget);
      if (!next) break;
      current = next;
    }
    onNavigate(navTarget);
  };

  return (
    <div className="branch-switcher" ref={ref}>
      <span className="branch-label">📝 {variantNodes.length} 个消息版本</span>
      <button className="branch-trigger" onClick={() => setOpen(!open)}>
        <span className="branch-current">{activeLabel}</span>
        <span className="branch-arrow">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="branch-dropdown">
          {variantNodes.map(v => {
            const isActive = activeVariant?.id === v.id;
            const label = (v.content || "").slice(0, 50) || v.id.slice(0, 8);
            return (
              <button
                key={v.id}
                className={`branch-dropdown-item ${isActive ? "branch-active-item" : ""}`}
                onClick={() => handleSelect(v)}
              >
                {isActive ? "● " : "○ "}{label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ==================== CHILD BRANCH SWITCHER (assistant reply variants) ====================

function ChildBranchSwitcher({
  node, nodeMap, activePathIds, onNavigate
}: {
  node: TreeNode;
  nodeMap: Map<string, TreeNode>;
  activePathIds: Set<string>;
  onNavigate: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const childNodes = node.children.map(cid => nodeMap.get(cid)).filter(Boolean) as TreeNode[];
  if (childNodes.length <= 1) return null;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const activeBranch = childNodes.find(c =>
    activePathIds.has(c.id) || c.children.some(cid => activePathIds.has(cid))
  ) ?? childNodes[0];

  const activeLabel = (activeBranch.content || "").slice(0, 60) || activeBranch.id.slice(0, 8);

  const handleSelect = (branch: TreeNode) => {
    setOpen(false);
    let navTarget = branch.id;
    let current: TreeNode | undefined = branch;
    while (current.children && current.children.length > 0) {
      navTarget = current.children[current.children.length - 1];
      const next = nodeMap.get(navTarget);
      if (!next) break;
      current = next;
    }
    onNavigate(navTarget);
  };

  const label = node.role === "user" ? `${childNodes.length} 个回复` : `${childNodes.length} 个分支`;

  return (
    <div className="branch-switcher" ref={ref}>
      <span className="branch-label">🔄 {label}</span>
      <button className="branch-trigger" onClick={() => setOpen(!open)}>
        <span className="branch-current">{activeLabel}</span>
        <span className="branch-arrow">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="branch-dropdown">
          {childNodes.map(branch => {
            const isActive = activeBranch?.id === branch.id;
            const label = (branch.content || "").slice(0, 60) || branch.id.slice(0, 8);
            return (
              <button
                key={branch.id}
                className={`branch-dropdown-item ${isActive ? "branch-active-item" : ""}`}
                onClick={() => handleSelect(branch)}
              >
                {isActive ? "● " : "○ "}{label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ==================== MESSAGE BUBBLE ====================

const MessageBubble = memo(function MessageBubble({
  node, isActive, activePathIds, nodeMap, onNavigate, onEdit, onRegenerate, isEditing, editText, onEditChange, onEditSubmit, onEditCancel
}: {
  node: TreeNode;
  isActive: boolean;
  activePathIds: Set<string>;
  nodeMap: Map<string, TreeNode>;
  onNavigate: (id: string) => void;
  onEdit?: (id: string, content: string) => void;
  onRegenerate?: (id: string) => void;
  isEditing?: boolean;
  editText?: string;
  onEditChange?: (v: string) => void;
  onEditSubmit?: () => void;
  onEditCancel?: () => void;
}) {
  const isBranchPoint = node.children.length > 1;
  const isOnPath = isActive;

  return (
    <div className={`message ${node.role} ${isBranchPoint ? "branch-point" : ""} ${!isOnPath ? "off-path" : ""}`}>
      {/* Header */}
      <div className="message-header">
        <span className={`role-badge ${node.role}`}>
          {(node as any)._autoCount ? `⚡ ${(node as any)._autoCount} 步自动操作` :
           node.role === "user" ? "你" :
           node.role === "tool" ? `🔧 ${node.toolName || "工具"}` :
           (node.toolName ? `🤖 助手 · 🔧 ${node.toolName}` : "🤖 助手")}
          {node.toolError && " ❌"}
        </span>
        <AgentLabel 
          agentRole={node.agentRole} 
          agentName={node.agentName}
          isSubagentCall={node.isSubagentCall}
          subagentTask={node.subagentTask}
        />
        <span className="msg-time">{fmtTime(node.timestamp)}</span>
        {node.label && <span className="msg-label">📌 {node.label}</span>}
        {onEdit && (
          <button className="btn btn-ghost btn-sm" onClick={() => onEdit(node.id, node.content)}>✏️</button>
        )}
        {node.role === "assistant" && !isEditing && onRegenerate && (
          <button className="btn btn-ghost btn-sm" onClick={() => onRegenerate(node.id)} title="重新生成回复">🔄</button>
        )}
      </div>

      {/* Content or Edit mode */}
      {isEditing ? (
        <div className="edit-form">
          <textarea
            value={editText}
            onChange={e => onEditChange?.(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onEditSubmit?.(); }
              if (e.key === "Escape") onEditCancel?.();
            }}
            rows={4}
          />
          <div className="edit-actions">
            <button className="btn btn-primary btn-sm" onClick={onEditSubmit}>提交编辑</button>
            <button className="btn btn-ghost btn-sm" onClick={onEditCancel}>取消</button>
          </div>
        </div>
      ) : (
        <div className="message-content">
          {node.contentBlocks && node.contentBlocks.length > 0 ? (
            <div className="content-blocks">
              {node.contentBlocks.map((block, i) => (
                <ContentBlockView key={i} block={block} />
              ))}
            </div>
          ) : node.isThinking ? (
            <details className="thinking-details">
              <summary>💭 思考过程</summary>
              <pre>{node.content}</pre>
            </details>
          ) : node.role === "tool" ? (
            <pre className="tool-result">{trunc(node.content, 3000)}</pre>
          ) : (
            <MarkdownText text={node.content} />
          )}
        </div>
      )}

      {/* Inline tool results (Plan A) */}
      {(node as any)._inlineTools && ((node as any)._inlineTools as TreeNode[]).length > 0 && (
        <InlineTools tools={(node as any)._inlineTools as TreeNode[]} />
      )}

      {/* Branch navigation — show forkSiblings variants (same-content user nodes) */}
      {node.forkSiblings && node.forkSiblings.length > 0 && node.role === "user" && (
        <ForkSwitcher
          node={node}
          nodeMap={nodeMap}
          activePathIds={activePathIds}
          onNavigate={onNavigate}
        />
      )}

      {/* Branch navigation — show children branches (different assistant replies) */}
      {node.children.length > 1 && (
        <ChildBranchSwitcher
          node={node}
          nodeMap={nodeMap}
          activePathIds={activePathIds}
          onNavigate={onNavigate}
        />
      )}
    </div>
  );
});

// ==================== MARKDOWN TEXT ====================

const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  // Simple rendering: split on double newlines for paragraphs, handle code blocks
  if (!text) return null;

  const parts = text.split(/(```[\s\S]*?```)/g);

  return (
    <div className="markdown">
      {parts.map((part, i) => {
        if (part.startsWith("```")) {
          const content = part.replace(/```\w*\n?/, "").replace(/```$/, "");
          return <pre key={i} className="code-block"><code>{content}</code></pre>;
        }

        // Inline markdown: **bold**, *italic*, `code`
        // Use improved regex that handles bold/italic with internal single * chars
        const formatted = part
          .split(/(\*\*(?:(?!\*\*).)*\*\*|\*(?:(?!\*).)*\*|`[^`]*`)/g)
          .map((seg, j) => {
            if (seg.startsWith("**") && seg.endsWith("**")) {
              return <strong key={`${i}-${j}-bold`}>{seg.slice(2, -2)}</strong>;
            }
            if (seg.startsWith("*") && seg.endsWith("*")) {
              return <em key={`${i}-${j}-em`}>{seg.slice(1, -1)}</em>;
            }
            if (seg.startsWith("`") && seg.endsWith("`")) {
              return <code key={`${i}-${j}-code`} className="inline-code">{seg.slice(1, -1)}</code>;
            }
            // Convert newlines to <br/>
            return seg.split("\n").map((line, k, arr) =>
              k < arr.length - 1 ? <span key={`${i}-${j}-${k}`}>{line}<br /></span> : <span key={`${i}-${j}-${k}`}>{line}</span>
            );
          });

        return <p key={i}>{formatted}</p>;
      })}
    </div>
  );
});

// ==================== TREE VIEW ====================

function TreeView({
  nodeMap, activePathIds, onNavigate
}: {
  nodeMap: Map<string, TreeNode>;
  activePathIds: Set<string>;
  onNavigate: (id: string) => void;
}) {
  // Use nodeMap (already filtered by buildNodeState) for consistent rendering
  // Find root nodes: no parent, or parent not in (filtered) nodeMap
  const rootNodes = [...nodeMap.values()].filter(n =>
    n.label !== "branch_root" && (!n.parentId || !nodeMap.has(n.parentId))
  );

  return (
    <div className="tree">
      {rootNodes.map(root => (
        <TreeNodeItem
          key={root.id}
          node={root}
          nodeMap={nodeMap}
          activePathIds={activePathIds}
          onNavigate={onNavigate}
          level={0}
        />
      ))}
    </div>
  );
}

function TreeNodeItem({
  node, nodeMap, activePathIds, onNavigate, level
}: {
  node: TreeNode;
  nodeMap: Map<string, TreeNode>;
  activePathIds: Set<string>;
  onNavigate: (id: string) => void;
  level: number;
}) {
  const children = node.children
    .map(cid => nodeMap.get(cid))
    .filter(Boolean) as TreeNode[];
  const isActive = activePathIds.has(node.id);

  return (
    <div className="tree-node" style={{ paddingLeft: level * 16 }}>
      <button
        className={`tree-node-btn ${isActive ? "active" : ""}`}
        onClick={() => onNavigate(node.id)}
        title={node.content.slice(0, 80)}
      >
        <span className="tree-role">{node.role === "user" ? "👤" : node.role === "tool" ? "🔧" : "🤖"}</span>
        <span className="tree-label">{trunc(node.content.replace(/\n/g, " "), 50)}</span>
        <span className="tree-time">{fmtTime(node.timestamp)}</span>
      </button>
      {children.map(child => (
        <TreeNodeItem
          key={child.id}
          node={child}
          nodeMap={nodeMap}
          activePathIds={activePathIds}
          onNavigate={onNavigate}
          level={level + 1}
        />
      ))}
    </div>
  );
}

// ==================== DEBUG PANEL ====================

function DebugPanel({ logs, onClear, onClose }: { logs: LogEntry[]; onClear: () => void; onClose: () => void }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const errorCount = logs.filter(l => l.error).length;

  return (
    <div className="debug-panel">
      <div className="debug-header">
        <h3>🐛 调试日志 ({logs.length} 条, {errorCount} 个错误)</h3>
        <div className="debug-actions">
          <button className="btn btn-ghost btn-sm" onClick={onClear}>清空</button>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>
      </div>
      <div className="debug-logs">
        {logs.length === 0 && <div className="empty">暂无日志。操作页面后将自动记录。</div>}
        {logs.map(l => (
          <div key={l.id} className={`debug-entry ${l.error ? "debug-error" : ""}`}>
            <div className="debug-meta">
              <span className="debug-time">{l.time}</span>
              <span className="debug-method">{l.method}</span>
              <span className="debug-url">{l.url}</span>
              {l.status && <span className={`debug-status ${l.status >= 400 ? "bad" : "good"}`}>{l.status}</span>}
              <span className="debug-duration">{l.duration}ms</span>
            </div>
            {l.reqBody && (
              <details className="debug-detail">
                <summary>请求体</summary>
                <pre>{tryPrettify(l.reqBody)}</pre>
              </details>
            )}
            {l.resBody && (
              <details className="debug-detail">
                <summary>响应 ({l.status})</summary>
                <pre>{tryPrettify(l.resBody)}</pre>
              </details>
            )}
            {l.error && (
              <div className="debug-err">❌ {l.error}</div>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function tryPrettify(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

// ==================== SETTINGS DIALOG ====================

function SettingsDialog({ onClose, onUpdated }: { onClose: () => void; onUpdated: () => void }) {
  const [tab, setTab] = useState<"builtin" | "custom">("builtin");
  const [builtinProviders, setBuiltinProviders] = useState<ProviderConfig[]>([]);
  const [customProviders, setCustomProviders] = useState<CustomProviderConfig[]>([]);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("success");

  // Key editing state per provider
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");

  // Custom provider form
  const [showAddCustom, setShowAddCustom] = useState(false);
  const [editingCustomId, setEditingCustomId] = useState<string | null>(null);
  const [customForm, setCustomForm] = useState({ id: "", baseUrl: "", apiType: "openai-completions", apiKey: "" });
  const [scannedModels, setScannedModels] = useState<{ id: string }[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");

  useEffect(() => {
    loadProviders();
  }, []);

  async function loadProviders() {
    try {
      const data = await api.getProviders();
      setBuiltinProviders(data.builtin);
      setCustomProviders(data.custom);
    } catch (e: any) {
      showMsg("加载提供商失败：" + e.message, "error");
    }
  }

  function showMsg(text: string, type: "success" | "error" = "success") {
    setMessage(text);
    setMessageType(type);
    setTimeout(() => setMessage(""), 4000);
  }

  // ---- Built-in provider key operations ----
  async function handleSetBuiltinKey(providerId: string) {
    if (!keyInput.trim()) return;
    try {
      await api.setBuiltinKey(providerId, keyInput.trim());
      showMsg(`${providerId} 的 API Key 已保存`);
      setEditingKey(null);
      setKeyInput("");
      await loadProviders();
      onUpdated();
    } catch (e: any) {
      showMsg(e.message, "error");
    }
  }

  async function handleRemoveBuiltinKey(providerId: string) {
    try {
      await api.removeBuiltinKey(providerId);
      showMsg(`${providerId} 的 API Key 已删除`);
      await loadProviders();
      onUpdated();
    } catch (e: any) {
      showMsg(e.message, "error");
    }
  }

  // ---- Custom provider operations ----
  async function handleScanModels() {
    if (!customForm.baseUrl || !customForm.apiKey) {
      setScanError("请输入基础 URL 和 API Key");
      return;
    }
    setScanning(true);
    setScanError("");
    try {
      const models = await api.scanModels(customForm.baseUrl, customForm.apiKey);
      setScannedModels(models);
      if (models.length === 0) {
        setScanError("未发现模型，可在下方手动添加");
      } else {
        showMsg(`发现 ${models.length} 个模型`);
      }
    } catch (e: any) {
      setScanError(e.message);
    } finally {
      setScanning(false);
    }
  }

  // Manual model input state
  const [manualModelIds, setManualModelIds] = useState("");

  function handleEditCustomProvider(cp: CustomProviderConfig) {
    setEditingCustomId(cp.id);
    setCustomForm({
      id: cp.id,
      baseUrl: cp.baseUrl,
      apiType: cp.apiType === "openai-completions" || cp.apiType === "anthropic-messages" || cp.apiType === "google-generative-ai" ? cp.apiType : "openai-completions",
      apiKey: "", // Don't expose existing key; user can re-enter to change it
    });
    setScannedModels(cp.models.map(id => ({ id })));
    setManualModelIds(cp.models.join(", "));
    setScanError("");
    setShowAddCustom(true);
  }

  function handleCancelCustomForm() {
    setShowAddCustom(false);
    setEditingCustomId(null);
    setCustomForm({ id: "", baseUrl: "", apiType: "openai-completions", apiKey: "" });
    setScannedModels([]);
    setManualModelIds("");
    setScanError("");
  }

  async function handleAddCustomProvider() {
    // apiKey is required for new providers; for editing, it can be left blank to keep existing key
    if (!customForm.id || !customForm.baseUrl) {
      showMsg("名称和基础 URL 为必填项", "error");
      return;
    }
    if (!editingCustomId && !customForm.apiKey) {
      showMsg("API Key 为必填项", "error");
      return;
    }
    try {
      // Collect models: scanned models + manually entered models (comma/newline separated)
      const manualModels = manualModelIds
        .split(/[\n,]+/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(id => ({ id }));
      const allModels = [
        ...scannedModels,
        ...manualModels.filter(m => !scannedModels.some(s => s.id === m.id)),
      ];

      const payload: { id: string; baseUrl: string; apiType: string; apiKey: string; models?: { id: string }[] } = {
        id: customForm.id,
        baseUrl: customForm.baseUrl,
        apiType: customForm.apiType,
        apiKey: customForm.apiKey || "__KEEP_EXISTING__",
        models: allModels.length > 0 ? allModels : undefined,
      };

      const result = await api.upsertCustomProvider(payload);

      const isEditing = !!editingCustomId;
      let msg = isEditing
        ? `自定义提供商「${customForm.id}」已更新`
        : `自定义提供商「${customForm.id}」已保存`;
      if (result?.scanned) {
        msg += `，自动发现 ${result.savedModels?.length || 0} 个模型`;
      } else if (result?.scanError) {
        msg += `（模型扫描失败：${result.scanError}，已添加默认模型）`;
      }
      showMsg(msg);
      handleCancelCustomForm();
      await loadProviders();
      onUpdated();
    } catch (e: any) {
      showMsg(e.message, "error");
    }
  }

  async function handleRemoveCustom(id: string) {
    try {
      await api.removeCustomProvider(id);
      showMsg(`自定义提供商「${id}」已删除`);
      await loadProviders();
      onUpdated();
    } catch (e: any) {
      showMsg(e.message, "error");
    }
  }

  const apiTypes = [
    { value: "openai-completions", label: "OpenAI 兼容" },
    { value: "anthropic-messages", label: "Anthropic 消息" },
    { value: "google-generative-ai", label: "Google AI" },
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>提供商配置</h2>
          <button className="btn btn-ghost" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {/* Tabs */}
          <div className="settings-tabs">
            <button className={`settings-tab ${tab === "builtin" ? "active" : ""}`} onClick={() => setTab("builtin")}>
              内置提供商
            </button>
            <button className={`settings-tab ${tab === "custom" ? "active" : ""}`} onClick={() => setTab("custom")}>
              自定义提供商
            </button>
          </div>

          {/* Built-in Providers */}
          {tab === "builtin" && (
            <div className="provider-list">
              <p className="settings-desc">
                Pi 原生支持以下提供商，只需填入 API Key 即可自动发现模型。
              </p>
              <div className="provider-table-header">
                <span>提供商</span><span>API Key</span><span></span>
              </div>
              {builtinProviders.map(p => {
                const isEditing = editingKey === p.id;
                return (
                  <div key={p.id} className={`provider-row ${p.hasKey ? "configured" : ""}`}>
                    <span className="provider-name">
                      <span className={`status-dot ${p.hasKey ? "active" : ""}`} />
                      {p.name}
                    </span>
                    <span className="provider-key">
                      {isEditing ? (
                        <div className="key-edit-row">
                          <input
                            type="password"
                            value={keyInput}
                            onChange={e => setKeyInput(e.target.value)}
                            placeholder={p.envVar}
                            autoFocus
                            onKeyDown={e => e.key === "Enter" && handleSetBuiltinKey(p.id)}
                          />
                          <button className="btn btn-primary btn-xs" onClick={() => handleSetBuiltinKey(p.id)}>保存</button>
                          <button className="btn btn-ghost btn-xs" onClick={() => { setEditingKey(null); setKeyInput(""); }}>✕</button>
                        </div>
                      ) : (
                        <span className="key-preview" onClick={() => { setEditingKey(p.id); setKeyInput(""); }}>
                          {p.keyPreview || "点击设置 Key..."}
                        </span>
                      )}
                    </span>
                    <span className="provider-actions">
                      {!isEditing && (
                        <button className="btn btn-ghost btn-xs" onClick={() => { setEditingKey(p.id); setKeyInput(""); }}>
                          {p.hasKey ? "更新" : "设置 Key"}
                        </button>
                      )}
                      {p.hasKey && !isEditing && (
                        <button className="btn btn-ghost btn-xs" onClick={() => handleRemoveBuiltinKey(p.id)} title="删除 Key">🗑</button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Custom Providers */}
          {tab === "custom" && (
            <div className="provider-list">
              <p className="settings-desc">
                连接任意 OpenAI 兼容 API（Ollama、vLLM、LM Studio 等）或其他支持的 API 类型。
              </p>

              {/* Existing custom providers */}
              {customProviders.map(p => (
                <div key={p.id} className="provider-row configured">
                  <span className="provider-name"><span className="status-dot active" />{p.id}</span>
                  <span className="provider-key">{p.baseUrl} ({p.apiType}){p.models.length > 0 ? ` · ${p.models.length} 模型` : ""}</span>
                  <span className="provider-actions">
                    <button className="btn btn-ghost btn-xs" onClick={() => handleEditCustomProvider(p)} title="编辑">✏️</button>
                    <button className="btn btn-ghost btn-xs" onClick={() => handleRemoveCustom(p.id)} title="删除">🗑</button>
                  </span>
                </div>
              ))}

              {/* Add custom form */}
              {!showAddCustom ? (
                <button className="btn btn-primary btn-sm" onClick={() => { setEditingCustomId(null); setShowAddCustom(true); }} style={{ marginTop: 12 }}>
                  + 添加自定义提供商
                </button>
              ) : (
                <div className="custom-form">
                  <h4>{editingCustomId ? `编辑「${editingCustomId}」` : "添加自定义提供商"}</h4>
                  <div className="custom-form-grid">
                    <label>名称</label>
                    <input
                      type="text"
                      value={customForm.id}
                      onChange={e => setCustomForm(f => ({ ...f, id: e.target.value }))}
                      placeholder="例如: my-ollama"
                      disabled={!!editingCustomId}
                      style={editingCustomId ? { opacity: 0.6, cursor: "not-allowed" } : undefined}
                    />
                    <label>基础 URL</label>
                    <input
                      type="text"
                      value={customForm.baseUrl}
                      onChange={e => setCustomForm(f => ({ ...f, baseUrl: e.target.value }))}
                      placeholder="http://localhost:11434/v1"
                    />
                    <label>API 类型</label>
                    <select value={customForm.apiType} onChange={e => setCustomForm(f => ({ ...f, apiType: e.target.value }))}>
                      {apiTypes.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                    <label>API Key</label>
                    <input
                      type="password"
                      value={customForm.apiKey}
                      onChange={e => setCustomForm(f => ({ ...f, apiKey: e.target.value }))}
                      placeholder={editingCustomId ? "留空则保持原有 Key 不变" : "sk-... 或 ollama"}
                    />
                  </div>

                  {/* Model scanning */}
                  <div className="scan-section">
                    <button className="btn btn-ghost btn-sm" onClick={handleScanModels} disabled={scanning}>
                      {scanning ? "扫描中..." : "🔍 从端点扫描模型"}
                    </button>
                    {scanError && <span className="scan-error">{scanError}</span>}
                    {scannedModels.length > 0 && (
                      <div className="scanned-models">
                        <span>发现 {scannedModels.length} 个模型：</span>
                        <div className="scanned-model-list">
                          {scannedModels.slice(0, 20).map(m => (
                            <span key={m.id} className="model-tag">{m.id}</span>
                          ))}
                          {scannedModels.length > 20 && <span className="model-tag">...还有 {scannedModels.length - 20} 个</span>}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Manual model input */}
                  <div className="manual-models-section" style={{ marginTop: 12 }}>
                    <label style={{ display: "block", marginBottom: 4, fontSize: 13, color: "var(--text-secondary)" }}>
                      手动输入模型 ID（每行一个，或用逗号分隔）
                    </label>
                    <textarea
                      value={manualModelIds}
                      onChange={e => setManualModelIds(e.target.value)}
                      placeholder={"例如:\ngpt-4o\nclaude-sonnet-4-20250514\n或: model-a, model-b"}
                      rows={3}
                      style={{
                        width: "100%",
                        padding: 8,
                        fontSize: 13,
                        fontFamily: "monospace",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        background: "var(--bg-secondary)",
                        color: "var(--text-primary)",
                        resize: "vertical",
                      }}
                    />
                  </div>

                  <div className="custom-form-actions">
                    <button className="btn btn-primary" onClick={handleAddCustomProvider}>保存提供商</button>
                    <button className="btn btn-ghost" onClick={handleCancelCustomForm}>取消</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {message && <p className={`settings-msg ${messageType}`}>{message}</p>}
        </div>
      </div>
    </div>
  );
}

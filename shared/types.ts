// ============================================================
// Shared types between server and client
// ============================================================

/** A single node in the conversation tree */
export interface TreeNode {
  id: string;
  parentId: string | null;
  role: "user" | "assistant" | "tool";
  content: string;
  /** Tool name (only for tool nodes) */
  toolName?: string;
  /** Whether this is a tool error */
  toolError?: boolean;
  /** Whether the message is a thinking block */
  isThinking?: boolean;
  timestamp: number;
  /** Child node IDs (for tree rendering) */
  children: string[];
  /** Label (bookmark) */
  label?: string;
  /** Fork group ID (set on branch siblings) */
  forkGroup?: string;
  /** Sibling node IDs in the same fork group */
  forkSiblings?: string[];
  /** Agent 角色：main=主进程, architect=架构师, worker=工程师, subagent=其他子代理 */
  agentRole?: "main" | "architect" | "worker" | "subagent";
  /** Agent 名称 */
  agentName?: string;
  /** 是否是一个子代理调用入口 */
  isSubagentCall?: boolean;
  /** 子代理任务描述 */
  subagentTask?: string;
  /** 结构化内容块（用于渲染工具调用、思考等） */
  contentBlocks?: ContentBlock[];
}

export interface ContentBlock {
  type: "text" | "thinking" | "tool_call" | "tool_result";
  text?: string;
  toolName?: string;
  toolCallId?: string;
  arguments?: Record<string, any>;
  isError?: boolean;
}

/** Session summary shown in sidebar */
export interface SessionSummary {
  id: string;
  name: string;
  filePath: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** Session detail for loading into chat */
export interface SessionDetail {
  id: string;
  name: string;
  filePath: string;
  tree: TreeNode[];
  /** IDs of nodes on the active path (root → current leaf) */
  activePath: string[];
  /** Current leaf node ID */
  leafId: string;
}

/** Model info for selection UI */
export interface ModelInfo {
  provider: string;
  modelId: string;
  displayName: string;
  thinkingLevels: ThinkingLevel[];
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** API key entry */
export interface ApiKeyEntry {
  provider: string;
  key: string;
  /** Whether this is a one-time key (not persisted) */
  persist: boolean;
}

/** Streaming event from server to client */
export interface StreamEvent {
  type: "text_delta" | "thinking_delta" | "tool_start" | "tool_update" | "tool_end" | "turn_end" | "error" | "message_start" | "message_end" | "aborted";
  /** Delta text for text_delta events */
  delta?: string;
  /** Tool call ID */
  toolCallId?: string;
  /** Tool name */
  toolName?: string;
  /** Tool result/output */
  toolOutput?: string;
  /** Whether tool ended in error */
  toolError?: boolean;
  /** Error message */
  error?: string;
  /** New node added to tree (for turn_end) */
  newNode?: TreeNode;
  /** The ID of the message this event belongs to */
  messageId?: string;
}

/** Edit a message and re-generate */
export interface EditMessageRequest {
  entryId: string;
  newContent: string;
}

/** Raw session entry (unfiltered, from JSONL) */
export interface RawSessionEntry {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: number;
  message?: any;
  label?: string;
  [key: string]: any;
}

/** API response wrapper */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/** Built-in provider config */
export interface ProviderConfig {
  id: string;
  name: string;
  envVar: string;
  apiType: string;
  hasKey: boolean;
  keyPreview: string;
  isCustom: false;
}

/** Custom provider config */
export interface CustomProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiType: string;
  hasKey: boolean;
  isCustom: true;
  models: string[];
}

// ============================================================
// Types shared between server and client
// ============================================================

export interface TreeNode {
  id: string;
  parentId: string | null;
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  toolError?: boolean;
  isThinking?: boolean;
  timestamp: number;
  children: string[];
  label?: string;
  forkGroup?: string;
  forkSiblings?: string[];
  agentRole?: "main" | "architect" | "worker" | "subagent";
  agentName?: string;
  isSubagentCall?: boolean;
  subagentTask?: string;
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

export interface SessionSummary {
  id: string;
  name: string;
  filePath: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface SessionDetail {
  id: string;
  name: string;
  filePath: string;
  tree: TreeNode[];
  activePath: string[];
  leafId: string;
}

export interface ModelInfo {
  provider: string;
  modelId: string;
  displayName: string;
  thinkingLevels: ThinkingLevel[];
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface RawSessionEntry {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: number;
  message?: any;
  label?: string;
  [key: string]: any;
}

export interface StreamEvent {
  type: "text_delta" | "thinking_delta" | "tool_start" | "tool_update" | "tool_end" | "turn_end" | "error" | "message_start" | "message_end" | "aborted";
  delta?: string;
  toolCallId?: string;
  toolName?: string;
  toolOutput?: string;
  toolError?: boolean;
  error?: string;
  newNode?: TreeNode;
  messageId?: string;
  sessionId?: string;
}

/** API response wrapper */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/** API key entry */
export interface ApiKeyEntry {
  provider: string;
  key: string;
  persist: boolean;
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

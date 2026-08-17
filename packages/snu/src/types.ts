/**
 * Wire-format and domain interfaces for @snutils/snu
 */

import { SecurityGates, CommandPolicy } from './server/policy.js';

export { SecurityGates, CommandPolicy };

export interface AgentRequest {
  id: string;
  command: string;
  params?: Record<string, any>;
  instance?: string;
  timestamp?: number;
}

export interface AgentResponse<T = any> {
  id: string;
  command: string;
  status: 'success' | 'error';
  result?: T;
  error?: string;
  code?: string;
  timestamp: number;
  details?: {
    userFeedback?: string;
    reviewId?: string;
    instanceOrigin?: string;
    expiresIn?: number;
    [key: string]: any;
  };
}

export interface HelperCapabilities {
  protocolVersion: number;
  commandReview?: 1;
  rejectionFeedback?: 1;
  instanceSecurityGates?: 1;
}

export interface InstanceGateSnapshot {
  instanceOrigin: string; // Canonicalized: new URL(url).origin.toLowerCase()
  revision: number; // Monotonically increasing safe integer
  receivedAt: number; // Server-generated Date.now()
  gates: SecurityGates;
}

export interface ReviewEnvelope {
  required: true;
  reviewId: string;
  nonce: string;
  payloadHash: string;
  kind: 'background_script' | 'record_delete' | 'rest_delete' | 'ui_action' | 'bulk_delete';
  summary: string;
  targets?: Array<{ table: string; sys_id: string; display?: string }>;
  script?: string;
  instanceOrigin: string;
  client: {
    name: string;
    version?: string;
    hostKind: 'vscode' | 'standalone';
    pid?: number;
  };
}

export interface StagedWriteResult {
  staged: true;
  reviewId: string;
  message: string;
}

export interface AgentPortFile {
  port: number;
  token: string;
  pid: number;
  apiVersion: number;
  startedAt: number;
  extensionVersion?: string;
}

export interface HealthResponse {
  status: 'success';
  apiVersion: number;
  hostKind?: 'vscode' | 'standalone';
  commands: string[];
  pid: number;
}

export interface DiscoveryOptions {
  portFile?: string;
  cwd?: string;
}

export interface DiscoveryResult {
  port: number;
  token: string;
  pid: number;
  apiVersion: number;
  portFilePath: string;
  isGlobal: boolean;
}

export interface MappedCommand {
  command: string;
  instance?: string;
  params: Record<string, any>;
}

export interface ToolOptionDefinition {
  type: 'string' | 'boolean';
  short?: string;
  description?: string;
  default?: any;
}

export interface ToolDefinition {
  name: string;
  agentCommand: string;
  description: string;
  cliCommand: string;
  cliUsage?: string;
  cliOptions?: Record<string, ToolOptionDefinition>;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    additionalProperties?: boolean;
  };
  mapInput: (input: Record<string, any>) => MappedCommand;
}

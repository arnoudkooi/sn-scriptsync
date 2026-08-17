import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { StandaloneWsBridge } from './wsBridge.js';
import { defaultPendingRegistry, PendingRegistry } from './pendingRegistry.js';
import { AgentRequest, AgentResponse } from '../types.js';
import { getCommandPolicy, SecurityGates } from './policy.js';
import { resolveStandaloneConfig, StandaloneConfig } from './config.js';
import { computePayloadHash } from './canonical.js';

export interface StandaloneDispatcherOptions {
  cwd?: string;
  wsBridge: StandaloneWsBridge;
  pending?: PendingRegistry;
  cliFlags?: Partial<SecurityGates & { reviewHighRisk?: boolean }>;
}

export class StandaloneDispatcher {
  private cwd: string;
  private ws: StandaloneWsBridge;
  private pending: PendingRegistry;
  private config: StandaloneConfig;
  private pendingReviewRequests = new Map<string, string>(); // correlationId/requestId -> reviewId
  private requestIdToCorrelationId = new Map<string, string>(); // requestId -> correlationId

  constructor(opts: StandaloneDispatcherOptions) {
    this.cwd = opts.cwd || process.cwd();
    this.ws = opts.wsBridge;
    this.pending = opts.pending || defaultPendingRegistry;
    this.config = resolveStandaloneConfig(opts.cliFlags);
  }

  getWorkspaceRoot(): string {
    return this.cwd;
  }

  getInstanceSettings(instanceName: string): any {
    const p1 = path.join(this.cwd, instanceName, '_settings.json');
    const p2 = path.join(this.cwd, instanceName, 'settings.json');
    if (fs.existsSync(p1)) {
      try { return JSON.parse(fs.readFileSync(p1, 'utf8')); } catch {}
    }
    if (fs.existsSync(p2)) {
      try { return JSON.parse(fs.readFileSync(p2, 'utf8')); } catch {}
    }
    return null;
  }

  listInstanceFolders(): string[] {
    try {
      const entries = fs.readdirSync(this.cwd, { withFileTypes: true });
      const nonInstance = new Set(['.vscode', '.cursor', '.git', 'node_modules', 'dist', 'bin', 'packages', 'screenshots', 'agentrules']);
      return entries
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !nonInstance.has(d.name.toLowerCase()))
        .map((d) => path.join(this.cwd, d.name))
        .filter((f) => fs.existsSync(path.join(f, '_settings.json')) || fs.existsSync(path.join(f, 'settings.json')));
    } catch {
      return [];
    }
  }

  resolveInstance(requestInstance?: string): { name: string; folder: string; settings: any } {
    const folders = this.listInstanceFolders();
    const liveInstances = this.ws.getLiveInstances();

    if (requestInstance) {
      const settings = this.getInstanceSettings(requestInstance);
      if (settings) {
        return { name: requestInstance, folder: path.join(this.cwd, requestInstance), settings };
      }

      const needle = requestInstance.toLowerCase().replace(/\/$/, '');
      const live = liveInstances.find((candidate) => {
        try {
          const url = new URL(candidate.url);
          return candidate.name.toLowerCase() === needle ||
            url.hostname.toLowerCase() === needle ||
            url.origin.toLowerCase() === needle;
        } catch {
          return false;
        }
      });
      if (live) {
        return { name: live.name, folder: this.cwd, settings: live };
      }

      throw Object.assign(new Error(`No authenticated instance named "${requestInstance}" is connected. Run /token on that ServiceNow instance and retry.`), {
        code: 'E_INSTANCE_NOT_FOUND',
      });
    }

    if (folders.length === 1) {
      const name = path.basename(folders[0]);
      return { name, folder: folders[0], settings: this.getInstanceSettings(name) };
    }

    if (folders.length === 0) {
      if (liveInstances.length > 0) {
        const live = liveInstances[0];
        return { name: live.name, folder: this.cwd, settings: live };
      }
      throw Object.assign(new Error('No authenticated ServiceNow instance is connected. Run /token on the instance and retry.'), {
        code: 'E_INSTANCE_REQUIRED',
      });
    }

    // Check freshness to find default instance
    const now = Date.now();
    const ranked = folders.map((f) => {
      const name = path.basename(f);
      let mtime = 0;
      try { mtime = fs.statSync(path.join(f, '_settings.json')).mtimeMs; } catch {}
      return { name, folder: f, settings: this.getInstanceSettings(name), age: now - mtime };
    }).sort((a, b) => a.age - b.age);

    return ranked[0];
  }

  cancel(requestId: string, reason = 'CANCELLED'): void {
    const correlationId = this.requestIdToCorrelationId.get(requestId) || requestId;
    const reviewId = this.pendingReviewRequests.get(correlationId) || this.pendingReviewRequests.get(requestId);
    if (reviewId) {
      this.pendingReviewRequests.delete(correlationId);
      this.pendingReviewRequests.delete(requestId);
      this.ws.cancelReview(reviewId, reason);
    }
    this.pending.cancel(correlationId, reason);
    this.pending.cancel(requestId, reason);
    this.requestIdToCorrelationId.delete(requestId);
  }

  async dispatch(req: AgentRequest): Promise<AgentResponse> {
    const correlationId = `snu_req_${req.id}_${Date.now()}`;
    this.requestIdToCorrelationId.set(req.id, correlationId);
    const policy = getCommandPolicy(req);

    try {
      // 1. Connection Commands
      if (req.command === 'check_connection') {
        const isRunning = this.ws.isServerRunning();
        const hasBrowser = this.ws.hasBrowserClient();
        const state = this.ws.getHelperState();
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: {
            serverRunning: isRunning,
            browserConnected: hasBrowser,
            helper: hasBrowser
              ? {
                  tier: state.tier,
                  proFeatures: state.proFeatures,
                  cdp: state.cdp,
                  capabilities: state.capabilities,
                }
              : null,
          },
        };
      }

      if (req.command === 'list_instances') {
        const folders = this.listInstanceFolders();
        const now = Date.now();
        const instances: Array<{
          name: string;
          url: string | null;
          hasSettings: boolean;
          recentlyActive: boolean;
          lastActiveAgeMs: number | null;
          source: 'workspace' | 'browser';
        }> = folders.map((f) => {
          const name = path.basename(f);
          const settings = this.getInstanceSettings(name) || {};
          let lastActiveAgeMs: number | null = null;
          try {
            const mtime = fs.statSync(path.join(f, '_settings.json')).mtimeMs;
            lastActiveAgeMs = Math.max(0, now - mtime);
          } catch {}
          return {
            name,
            url: settings.url || null,
            hasSettings: !!settings.url,
            recentlyActive: lastActiveAgeMs !== null && lastActiveAgeMs < 10 * 3600 * 1000,
            lastActiveAgeMs,
            source: 'workspace' as const,
          };
        });

        for (const live of this.ws.getLiveInstances()) {
          const origin = new URL(live.url).origin.toLowerCase();
          const duplicate = instances.some((instance) => {
            try { return instance.url ? new URL(instance.url).origin.toLowerCase() === origin : false; } catch { return false; }
          });
          if (!duplicate) {
            const lastActiveAgeMs = Math.max(0, now - live.lastActiveAt);
            instances.push({
              name: live.name,
              url: live.url,
              hasSettings: true,
              recentlyActive: true,
              lastActiveAgeMs,
              source: 'browser',
            });
          }
        }

        instances.sort((a, b) => {
          if (a.lastActiveAgeMs === null) return 1;
          if (b.lastActiveAgeMs === null) return -1;
          return a.lastActiveAgeMs - b.lastActiveAgeMs;
        });

        const liveDefault = this.ws.getLiveInstances()[0]?.name;
        const recent = instances.filter((i) => i.recentlyActive);
        const defaultInstance = liveDefault || (recent.length === 1 ? recent[0].name : (instances[0]?.name || null));

        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: {
            instances,
            count: instances.length,
            connected: this.ws.hasBrowserClient(),
            defaultInstance,
            needsConfirmation: false,
          },
        };
      }

      if (req.command === 'get_instance_info') {
        const inst = this.resolveInstance(req.instance);
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: {
            instanceName: inst.name,
            hasSettings: !!inst.settings?.url,
            connected: this.ws.hasBrowserClient(),
          },
        };
      }

      if (req.command === 'get_capabilities') {
        const state = this.ws.getHelperState();
        const instanceGatesRecord: Record<string, any> = {};
        for (const [origin, snap] of state.instanceGates.entries()) {
          instanceGatesRecord[origin] = snap;
        }

        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: {
            apiVersion: 8,
            tier: state.tier,
            proFeatures: state.proFeatures,
            cdp: state.cdp,
            gates: this.config.gates,
            instanceGates: instanceGatesRecord,
            capabilities: state.capabilities,
          },
        };
      }

      // Check browser connection for all instance/remote commands
      if (!this.ws.hasBrowserClient()) {
        throw Object.assign(new Error('Browser helper disconnected. Open the SN Utils helper tab via /token in ServiceNow.'), {
          code: 'E_BROWSER_DISCONNECTED',
        });
      }

      const inst = this.resolveInstance(req.instance);
      const instanceUrl = inst.settings?.url || '';
      const instanceOrigin = instanceUrl ? new URL(instanceUrl).origin.toLowerCase() : '';

      // 2. Authoritative Security Gate Evaluation (Deny-Wins)
      for (const gateName of policy.gates) {
        // A. Check Host Gate (Fail-closed standalone authority)
        if (!this.config.gates[gateName]) {
          const label = gateName === 'backgroundScripts' ? 'Background Scripts' : gateName === 'deleteRecords' ? 'Delete Records' : gateName;
          throw Object.assign(
            new Error(`${label} is disabled in standalone host config. Pass --allow-${gateName.replace(/[A-Z]/g, (l) => '-' + l.toLowerCase())} or set SNU_ALLOW_${gateName.toUpperCase()}=1.`),
            { code: 'E_DISABLED' }
          );
        }

        // B. Check Helper Instance Gate (if instanceSecurityGates capability is present)
        const helperState = this.ws.getHelperState();
        if (helperState.capabilities?.instanceSecurityGates && instanceOrigin) {
          const helperGateMode = this.ws.getInstanceGate(instanceUrl, gateName);
          if (helperGateMode === 'off' || helperGateMode === false) {
            const label = gateName === 'backgroundScripts' ? 'Background Scripts' : gateName === 'deleteRecords' ? 'Delete Records' : gateName;
            throw Object.assign(
              new Error(`This instance (${instanceOrigin}) does not permit ${label.toLowerCase()} in SN Utils helper.`),
              { code: 'E_DISABLED' }
            );
          }
        }
      }

      // 3. Two-Phase Human Review Enforcement (when supported by connected helper)
      const helperState = this.ws.getHelperState();
      let isReviewRequired = policy.review === 'required' && this.config.reviewHighRisk;
      if (helperState.capabilities?.instanceSecurityGates && instanceOrigin) {
        for (const gateName of policy.gates) {
          const gateMode = this.ws.getInstanceGate(instanceUrl, gateName);
          if (gateMode === 'auto') {
            isReviewRequired = false;
          } else if (gateMode === 'approve') {
            isReviewRequired = true;
          }
        }
      }
      // Positive capability detection: helpers in the wild predate the review
      // protocol and send no capabilities at all, so only an explicit
      // commandReview: 1 opts into the review round-trip. Everything else falls
      // through to direct execution, still behind the fail-closed host gates.
      const hasCommandReview = this.ws.hasBrowserClient() && helperState.capabilities?.commandReview === 1;

      if (isReviewRequired && hasCommandReview) {
        const reviewId = `rev_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        const serverNonce = crypto.randomBytes(16).toString('hex');
        const payloadHash = computePayloadHash(1, instanceOrigin, req.command, req.params);

        this.ws.registerReview({
          reviewId,
          nonce: serverNonce,
          payloadHash,
          correlationId,
          command: req.command,
          params: req.params,
          instanceOrigin,
        });
        this.pendingReviewRequests.set(correlationId, reviewId);
        this.pendingReviewRequests.set(req.id, reviewId);

        // Send Phase 1 reviewRequest to browser
        const reviewTimeoutMs = 300_000; // 5 minutes
        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: reviewTimeoutMs });

        this.ws.sendToBrowser({
          action: 'reviewRequest',
          reviewId,
          nonce: serverNonce,
          payloadHash,
          reviewKind: policy.reviewKind,
          risk: policy.risk,
          command: req.command,
          params: req.params,
          instanceOrigin,
          instance: inst.settings,
          client: {
            name: 'SN Utils CLI',
            version: '0.1.0',
            hostKind: 'standalone',
            pid: process.pid,
          },
          expiresIn: Math.floor(reviewTimeoutMs / 1000),
          agentRequestId: correlationId,
        });

        try {
          const res = await pendingPromise;
          // approvedNotExecuted: the helper approved but cannot run this
          // command shape (bulk delete by query, REST DELETE, cascade) — fall
          // through to the direct execution branches below.
          if (res?.approvedNotExecuted !== true) {
            return {
              id: req.id,
              command: req.command,
              status: 'success',
              timestamp: Date.now(),
              result: res.output !== undefined ? { output: res.output } : res.data || res.result || { success: true },
            };
          }
        } finally {
          this.pendingReviewRequests.delete(correlationId);
          this.pendingReviewRequests.delete(req.id);
          this.ws.cancelReview(reviewId, 'COMPLETED_OR_TIMED_OUT');
        }
      }

      // 4. Standard Direct Execution (Unreviewed commands + legacy helper fallback)

      // Background Script
      if (req.command === 'run_background_script') {
        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: 70_000 });
        this.ws.sendToBrowser({
          action: 'agentRunBackgroundScript',
          agentRequestId: correlationId,
          script: req.params?.script,
          instance: inst.settings,
          appName: 'SN Utils CLI',
        });
        const res = await pendingPromise;
        if (res.success === false) {
          throw Object.assign(new Error(res.error || 'Background script failed'), { code: res.code || 'E_COMMAND_FAILED' });
        }
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: { output: res.output || '' },
        };
      }

      // Delete Record
      if (req.command === 'delete_record') {
        const { table, sys_id } = req.params || {};
        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: 70_000 });
        this.ws.sendToBrowser({
          action: 'agentRestApi',
          agentRequestId: correlationId,
          endpoint: `/api/now/table/${table}/${sys_id}`,
          method: 'DELETE',
          instance: inst.settings,
          appName: 'SN Utils CLI',
        });
        const res = await pendingPromise;
        if (res.success === false) {
          throw Object.assign(new Error(res.error || 'Delete failed'), { code: res.code || 'E_COMMAND_FAILED' });
        }
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: { deleted: true, table, sys_id },
        };
      }

      // Code Search (GraphQL)
      if (req.command === 'code_search') {
        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: 70_000 });
        this.ws.sendToBrowser({
          action: 'agentCodeSearch',
          agentRequestId: correlationId,
          term: req.params?.term,
          tables: req.params?.tables,
          limit: req.params?.limit ?? 50,
          activeOnly: req.params?.activeOnly === true,
          instance: inst.settings,
          appName: 'SN Utils CLI',
        });
        const res = await pendingPromise;
        if (res.success === false) {
          throw Object.assign(new Error(res.error || 'Code search failed'), { code: res.code || 'E_COMMAND_FAILED' });
        }
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: res,
        };
      }

      // Query Records (Table API)
      if (req.command === 'query_records') {
        const table = req.params?.table;
        const query = req.params?.query || '';
        const fields = req.params?.fields || 'sys_id,number,short_description,sys_created_on';
        const limit = req.params?.limit ?? 10;
        const orderBy = req.params?.orderBy;

        let sysparmQuery = query;
        if (orderBy) {
          sysparmQuery = sysparmQuery ? `${sysparmQuery}` + (sysparmQuery ? '^' : '') + `${orderBy}` : orderBy;
        }

        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: 70_000 });
        this.ws.sendToBrowser({
          action: 'agentRestApi',
          agentRequestId: correlationId,
          endpoint: `/api/now/table/${table}`,
          method: 'GET',
          queryParams: {
            sysparm_query: sysparmQuery,
            sysparm_fields: fields,
            sysparm_limit: String(limit),
            sysparm_display_value: 'true',
          },
          instance: inst.settings,
          appName: 'SN Utils CLI',
        });
        const res = await pendingPromise;
        if (res.success === false) {
          throw Object.assign(new Error(res.error || 'Query failed'), { code: res.status === 404 ? 'E_NOT_FOUND' : 'E_COMMAND_FAILED' });
        }
        const records = res.data?.result || [];
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: {
            table,
            count: records.length,
            records,
          },
        };
      }

      // Get Record
      if (req.command === 'get_record') {
        const table = req.params?.table;
        const sysId = req.params?.sys_id;
        const fields = req.params?.fields;

        const queryParams: Record<string, string> = { sysparm_display_value: 'true' };
        if (fields) queryParams.sysparm_fields = fields;

        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: 70_000 });
        this.ws.sendToBrowser({
          action: 'agentRestApi',
          agentRequestId: correlationId,
          endpoint: `/api/now/table/${table}/${sysId}`,
          method: 'GET',
          queryParams,
          instance: inst.settings,
          appName: 'SN Utils CLI',
        });
        const res = await pendingPromise;
        if (res.success === false) {
          throw Object.assign(new Error(res.error || `Record ${sysId} not found`), { code: res.status === 404 ? 'E_NOT_FOUND' : 'E_COMMAND_FAILED' });
        }
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: {
            table,
            sys_id: sysId,
            record: res.data?.result,
          },
        };
      }

      // Update Record
      if (req.command === 'update_record') {
        const { table, sys_id, field, content } = req.params || {};
        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: 70_000 });
        this.ws.sendToBrowser({
          action: 'agentRestApi',
          agentRequestId: correlationId,
          endpoint: `/api/now/table/${table}/${sys_id}`,
          method: 'PATCH',
          body: { [field]: content },
          instance: inst.settings,
          appName: 'SN Utils CLI',
        });
        const res = await pendingPromise;
        if (res.success === false) {
          throw Object.assign(new Error(res.error || 'Update failed'), { code: 'E_COMMAND_FAILED' });
        }
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: {
            updated: true,
            table,
            sys_id,
            field,
            record: res.data?.result,
          },
        };
      }

      // Create Artifact
      if (req.command === 'create_artifact') {
        const { table, fields } = req.params || {};
        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: 70_000 });
        this.ws.sendToBrowser({
          action: 'agentRestApi',
          agentRequestId: correlationId,
          endpoint: `/api/now/table/${table}`,
          method: 'POST',
          body: fields,
          instance: inst.settings,
          appName: 'SN Utils CLI',
        });
        const res = await pendingPromise;
        if (res.success === false) {
          throw Object.assign(new Error(res.error || 'Create artifact failed'), { code: 'E_COMMAND_FAILED' });
        }
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: {
            created: true,
            table,
            name: fields?.name,
            sys_id: res.data?.result?.sys_id,
            record: res.data?.result,
          },
        };
      }

      // Schema Metadata
      if (req.command === 'get_table_metadata') {
        const table = req.params?.table;
        const pendingPromise = this.pending.register({ id: correlationId, command: req.command });
        this.ws.sendToBrowser({
          action: 'agentRestApi',
          agentRequestId: correlationId,
          endpoint: `/api/now/doc/table/schema/${table}`,
          method: 'GET',
          instance: inst.settings,
          appName: 'SN Utils CLI',
        });
        const res = await pendingPromise;
        if (res.success === false) {
          throw Object.assign(new Error(res.error || `Schema for table ${table} not found`), { code: 'E_NOT_FOUND' });
        }
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: res.data?.result || res.data,
        };
      }

      // Browser Form & UI Actions
      if (['get_form_state', 'set_field', 'run_ui_action', 'navigate', 'take_screenshot'].includes(req.command)) {
        const actionMap: Record<string, string> = {
          get_form_state: 'agentGetFormState',
          set_field: 'agentSetField',
          run_ui_action: 'agentRunUiAction',
          navigate: 'agentNavigate',
          take_screenshot: 'agentTakeScreenshot',
        };
        const action = actionMap[req.command];
        const pendingPromise = this.pending.register({ id: correlationId, command: req.command, timeoutMs: 70_000 });
        this.ws.sendToBrowser({
          action,
          agentRequestId: correlationId,
          ...req.params,
          appName: 'SN Utils CLI',
        });
        const res = await pendingPromise;
        if (res.success === false) {
          throw Object.assign(new Error(res.error || `Browser command ${req.command} failed`), { code: res.code || 'E_COMMAND_FAILED' });
        }
        return {
          id: req.id,
          command: req.command,
          status: 'success',
          timestamp: Date.now(),
          result: res,
        };
      }

      throw Object.assign(new Error(`Unknown command: ${req.command}`), { code: 'E_UNKNOWN_COMMAND' });
    } catch (err: any) {
      this.pendingReviewRequests.delete(correlationId);
      this.pendingReviewRequests.delete(req.id);
      return {
        id: req.id,
        command: req.command,
        status: 'error',
        error: err.message || String(err),
        code: err.code || 'E_COMMAND_FAILED',
        timestamp: Date.now(),
        details: err.details,
      };
    } finally {
      this.requestIdToCorrelationId.delete(req.id);
    }
  }
}

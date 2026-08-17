import { AgentRequest } from './types';

export type CommandRisk = 'read' | 'write' | 'execute' | 'delete';

export type GateMode = 'off' | 'approve' | 'auto' | boolean;

export interface SecurityGates {
  backgroundScripts: GateMode;
  deleteRecords: GateMode;
  createArtifacts: GateMode;
  browserDebugger: GateMode;
  restRequest: GateMode;
}

export interface CommandPolicy {
  risk: CommandRisk;
  gates: Array<keyof SecurityGates>;
  review: 'never' | 'optional' | 'required';
  reviewKind?: 'background_script' | 'record_delete' | 'rest_delete' | 'ui_action' | 'bulk_delete';
}

export function getCommandPolicy(req: AgentRequest): CommandPolicy {
  switch (req.command) {
    case 'run_background_script':
      return { risk: 'execute', gates: ['backgroundScripts'], review: 'required', reviewKind: 'background_script' };

    case 'delete_record':
      return { risk: 'delete', gates: ['deleteRecords'], review: 'required', reviewKind: 'record_delete' };

    case 'delete_application':
      return { risk: 'delete', gates: ['deleteRecords', 'backgroundScripts'], review: 'required', reviewKind: 'bulk_delete' };

    case 'rest_request': {
      const method = (req.params?.method || 'GET').toUpperCase();
      if (method === 'DELETE') {
        return { risk: 'delete', gates: ['deleteRecords'], review: 'required', reviewKind: 'rest_delete' };
      }
      if (['POST', 'PUT', 'PATCH'].includes(method)) {
        return { risk: 'write', gates: ['restRequest'], review: 'never' };
      }
      return { risk: 'read', gates: [], review: 'never' };
    }

    case 'run_ui_action': {
      const action = String(req.params?.uiAction || '').toLowerCase();
      if (action.includes('delete') || action.includes('destroy')) {
        return { risk: 'delete', gates: ['deleteRecords'], review: 'required', reviewKind: 'ui_action' };
      }
      return { risk: 'execute', gates: [], review: 'never' };
    }

    case 'create_artifact':
    case 'create_application':
    case 'create_table':
    case 'add_column':
      return { risk: 'write', gates: ['createArtifacts'], review: 'never' };

    case 'update_record':
      return { risk: 'write', gates: [], review: 'never' };

    case 'take_screenshot': {
      const useCdp = req.params?.exactUrl === true || req.params?.cdp === true;
      return { risk: 'read', gates: useCdp ? ['browserDebugger'] : [], review: 'never' };
    }

    // Explicit CDP commands attach Chrome's debugger to the helper tab, so the
    // ones that start or expand a session carry the browserDebugger gate.
    // stop_* / clear_* / debugger_detach stay ungated so an agent can always
    // wind a session down even after the gate is switched off mid-capture.
    case 'start_network_capture':
    case 'start_console_capture':
    case 'capture_full_page':
    case 'set_dialog_handler':
      return { risk: 'execute', gates: ['browserDebugger'], review: 'never' };

    default:
      return { risk: 'read', gates: [], review: 'never' };
  }
}

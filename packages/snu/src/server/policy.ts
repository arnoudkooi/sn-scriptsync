import { AgentRequest } from '../types.js';

export type CommandRisk = 'read' | 'write' | 'execute' | 'delete';

export type GateMode = 'off' | 'approve' | 'auto' | boolean;

export interface SecurityGates {
  backgroundScripts: GateMode;
  deleteRecords: GateMode;
  createArtifacts: GateMode;
  /** Optional: only newer publishers set it, older ones fall back (GATE_FALLBACKS). */
  updateRecords?: GateMode;
  browserDebugger: GateMode;
  restRequest: GateMode;
}

/**
 * Gates a newer host or helper build publishes, and the older gate each one
 * inherits from when it is absent. Enforcement is deny-wins on a missing gate,
 * so without this a gate added here would refuse its commands on every build
 * already in the field until that build catches up.
 */
export const GATE_FALLBACKS: Partial<Record<keyof SecurityGates, keyof SecurityGates>> = {
  updateRecords: 'createArtifacts',
};

/** Read a gate out of a published snapshot, following GATE_FALLBACKS. */
export function resolveGateMode(
  gates: Record<string, any> | null | undefined,
  gate: keyof SecurityGates,
): GateMode | undefined {
  if (!gates) return undefined;
  if (gates[gate] !== undefined) return gates[gate];
  const fallback = GATE_FALLBACKS[gate];
  return fallback ? gates[fallback] : undefined;
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

    // Driving the form is a write path: navigate -> set_field -> run_ui_action
    // ('sysverb_update') commits whatever was typed into the open record. The
    // risk stays 'execute' because a UI action runs a script server-side, but
    // what it does to the instance is update an existing record, so that is the
    // permission that governs it. A custom action's name says nothing about its
    // effect, so this gates every action rather than trying to guess per verb;
    // the name check only ever escalates, never exempts.
    case 'run_ui_action': {
      const action = String(req.params?.uiAction || '').toLowerCase();
      if (action.includes('delete') || action.includes('destroy')) {
        return { risk: 'delete', gates: ['deleteRecords'], review: 'required', reviewKind: 'ui_action' };
      }
      return { risk: 'execute', gates: ['updateRecords'], review: 'never' };
    }

    // create_record sits with the other create_* commands on purpose: from the
    // user's side "let the agent create things on my instance" is one decision,
    // and it would be odd for filing an incident to need a stricter permission
    // than installing a Script Include.
    case 'create_artifact':
    case 'create_record':
    case 'create_application':
    case 'create_table':
    case 'add_column':
    // An upload inserts a sys_attachment row bound to the target record, so it
    // is a create like the rest and rides the same permission. Additive and
    // reversible, which is why it does not get a gate of its own.
    case 'upload_attachment':
      return { risk: 'write', gates: ['createArtifacts'], review: 'never' };

    // Overwriting fields on records that already exist is its own decision,
    // and on a populated table the bigger blast radius of the two. Gated on
    // updateRecords, which falls back to createArtifacts (see GATE_FALLBACKS)
    // on any host or helper build that does not publish the newer gate.
    case 'update_record':
    case 'update_record_batch':
      return { risk: 'write', gates: ['updateRecords'], review: 'never' };

    case 'pull_records':
    case 'pull_artifacts':
      return { risk: 'read', gates: [], review: 'never' };

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

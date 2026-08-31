import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebSocket } from 'ws';
import { StandaloneWsBridge } from '../server/wsBridge.js';
import { StandaloneDispatcher } from '../server/dispatcher.js';
import { PendingRegistry } from '../server/pendingRegistry.js';

test('TwoPhaseReview: full happy path approval and execution', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-review-test-'));
  const instDir = path.join(tmpDir, 'ven08329');
  fs.mkdirSync(instDir, { recursive: true });
  fs.writeFileSync(path.join(instDir, '_settings.json'), JSON.stringify({ url: 'https://ven08329.service-now.com' }));

  const pending = new PendingRegistry();
  const wsBridge = new StandaloneWsBridge(0, pending);
  const wsPort = await (wsBridge as any).start();

  const dispatcher = new StandaloneDispatcher({
    cwd: tmpDir,
    wsBridge,
    pending,
    cliFlags: {
      backgroundScripts: true,
      reviewHighRisk: true,
    },
  });

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    ws.send(
      JSON.stringify({
        action: 'helperBuildInfo',
        tier: 'pro',
        proFeatures: true,
        capabilities: {
          protocolVersion: 1,
          commandReview: 1,
          rejectionFeedback: 1,
          instanceSecurityGates: 1,
        },
      })
    );

    ws.send(
      JSON.stringify({
        action: 'helperGatesUpdated',
        instanceOrigin: 'https://ven08329.service-now.com',
        revision: 1,
        gates: {
          backgroundScripts: true,
          deleteRecords: true,
          createArtifacts: true,
          browserDebugger: false,
          restRequest: true,
        },
      })
    );

    await new Promise((r) => setTimeout(r, 60));

    let capturedReviewRequest: any = null;
    let capturedExecuteApproved: any = null;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString('utf8'));
        if (msg.action === 'reviewRequest') {
          capturedReviewRequest = msg;
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                action: 'reviewResponse',
                reviewId: msg.reviewId,
                nonce: msg.nonce,
                payloadHash: msg.payloadHash,
                approved: true,
              })
            );
          }, 30);
        } else if (msg.action === 'executeApproved') {
          capturedExecuteApproved = msg;
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                action: 'agentRunBackgroundScriptResponse',
                agentRequestId: msg.agentRequestId,
                success: true,
                output: '*** Script: Hello from Phase 4 Review Queue',
              })
            );
          }, 30);
        }
      } catch {}
    });

    const res = await dispatcher.dispatch({
      id: 'bg_1',
      command: 'run_background_script',
      params: { script: "gs.print('Hello from Phase 4 Review Queue');" },
    });

    assert.strictEqual(res.status, 'success');
    assert.strictEqual(res.result.output, '*** Script: Hello from Phase 4 Review Queue');
    assert.ok(capturedReviewRequest);
    assert.strictEqual(capturedReviewRequest.reviewKind, 'background_script');
    assert.ok(capturedExecuteApproved);
    assert.strictEqual(capturedExecuteApproved.reviewId, capturedReviewRequest.reviewId);

    ws.close();
  } finally {
    await wsBridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TwoPhaseReview: user rejection with feedback returns E_USER_REJECTED and propagates details', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-review-test-'));
  const instDir = path.join(tmpDir, 'ven08329');
  fs.mkdirSync(instDir, { recursive: true });
  fs.writeFileSync(path.join(instDir, '_settings.json'), JSON.stringify({ url: 'https://ven08329.service-now.com' }));

  const pending = new PendingRegistry();
  const wsBridge = new StandaloneWsBridge(0, pending);
  const wsPort = await (wsBridge as any).start();

  const dispatcher = new StandaloneDispatcher({
    cwd: tmpDir,
    wsBridge,
    pending,
    cliFlags: {
      backgroundScripts: true,
      reviewHighRisk: true,
    },
  });

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    ws.send(
      JSON.stringify({
        action: 'helperBuildInfo',
        tier: 'pro',
        proFeatures: true,
        capabilities: {
          protocolVersion: 1,
          commandReview: 1,
          rejectionFeedback: 1,
          instanceSecurityGates: 1,
        },
      })
    );

    ws.send(
      JSON.stringify({
        action: 'helperGatesUpdated',
        instanceOrigin: 'https://ven08329.service-now.com',
        revision: 1,
        gates: {
          backgroundScripts: true,
          deleteRecords: true,
          createArtifacts: true,
          browserDebugger: false,
          restRequest: true,
        },
      })
    );

    await new Promise((r) => setTimeout(r, 60));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString('utf8'));
        if (msg.action === 'reviewRequest') {
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                action: 'reviewResponse',
                reviewId: msg.reviewId,
                nonce: msg.nonce,
                payloadHash: msg.payloadHash,
                approved: false,
                userFeedback: 'Do not delete records. Use active=false instead.',
              })
            );
          }, 30);
        }
      } catch {}
    });

    const res = await dispatcher.dispatch({
      id: 'bg_2',
      command: 'run_background_script',
      params: { script: 'gr.deleteMultiple();' },
    });

    assert.strictEqual(res.status, 'error');
    assert.strictEqual(res.code, 'E_USER_REJECTED');
    assert.ok(res.error?.includes('Do not delete records. Use active=false instead.'));
    assert.strictEqual(res.details?.userFeedback, 'Do not delete records. Use active=false instead.');

    ws.close();
  } finally {
    await wsBridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TwoPhaseReview: approved execution failure is E_COMMAND_FAILED, not E_USER_REJECTED', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-review-execution-test-'));
  const instDir = path.join(tmpDir, 'ven08329');
  fs.mkdirSync(instDir, { recursive: true });
  fs.writeFileSync(path.join(instDir, '_settings.json'), JSON.stringify({ url: 'https://ven08329.service-now.com' }));

  const pending = new PendingRegistry();
  const wsBridge = new StandaloneWsBridge(0, pending);
  const wsPort = await wsBridge.start();
  const dispatcher = new StandaloneDispatcher({
    cwd: tmpDir,
    wsBridge,
    pending,
    cliFlags: { deleteRecords: true, reviewHighRisk: true },
  });

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({
      action: 'helperBuildInfo',
      tier: 'pro',
      proFeatures: true,
      capabilities: { protocolVersion: 1, commandReview: 1, instanceSecurityGates: 1 },
    }));
    ws.send(JSON.stringify({
      action: 'helperGatesUpdated',
      instanceOrigin: 'https://ven08329.service-now.com',
      revision: 1,
      gates: {
        backgroundScripts: true,
        deleteRecords: 'approve',
        createArtifacts: true,
        browserDebugger: false,
        restRequest: true,
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 60));

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.action === 'reviewRequest') {
        ws.send(JSON.stringify({
          action: 'reviewResponse',
          reviewId: msg.reviewId,
          nonce: msg.nonce,
          payloadHash: msg.payloadHash,
          approved: true,
        }));
      } else if (msg.action === 'executeApproved') {
        ws.send(JSON.stringify({
          action: 'agentRestApiResponse',
          agentRequestId: msg.agentRequestId,
          success: false,
          code: 'E_USER_REJECTED',
          error: 'Operation Failed',
          status: 403,
          detail: 'Cross-scope access denied by ServiceNow',
          data: { error: { message: 'Operation Failed' } },
        }));
      }
    });

    const response = await dispatcher.dispatch({
      id: 'delete_execution_failure',
      command: 'delete_record',
      params: { table: 'sys_script_include', sys_id: '0123456789abcdef0123456789abcdef' },
    });

    assert.strictEqual(response.status, 'error');
    assert.strictEqual(response.code, 'E_COMMAND_FAILED');
    assert.strictEqual(response.error, 'Operation Failed');
    assert.strictEqual(response.details?.status, 403);
    assert.strictEqual(response.details?.detail, 'Cross-scope access denied by ServiceNow');
    assert.deepStrictEqual(response.details?.response, { error: { message: 'Operation Failed' } });
    ws.close();
  } finally {
    await wsBridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TwoPhaseReview: timed out review cannot execute later (stale approval is dropped)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-review-test-'));
  const instDir = path.join(tmpDir, 'ven08329');
  fs.mkdirSync(instDir, { recursive: true });
  fs.writeFileSync(path.join(instDir, '_settings.json'), JSON.stringify({ url: 'https://ven08329.service-now.com' }));

  const pending = new PendingRegistry();
  const wsBridge = new StandaloneWsBridge(0, pending);
  const wsPort = await (wsBridge as any).start();

  const dispatcher = new StandaloneDispatcher({
    cwd: tmpDir,
    wsBridge,
    pending,
    cliFlags: {
      backgroundScripts: true,
      reviewHighRisk: true,
    },
  });

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    ws.send(
      JSON.stringify({
        action: 'helperBuildInfo',
        tier: 'pro',
        proFeatures: true,
        capabilities: { protocolVersion: 1, commandReview: 1, instanceSecurityGates: 1 },
      })
    );

    ws.send(
      JSON.stringify({
        action: 'helperGatesUpdated',
        instanceOrigin: 'https://ven08329.service-now.com',
        revision: 1,
        gates: {
          backgroundScripts: true,
          deleteRecords: true,
          createArtifacts: true,
          browserDebugger: false,
          restRequest: true,
        },
      })
    );

    await new Promise((r) => setTimeout(r, 60));

    let savedReviewRequest: any = null;
    let lateExecuteApprovedEmitted = false;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString('utf8'));
        if (msg.action === 'reviewRequest') {
          savedReviewRequest = msg;
        } else if (msg.action === 'executeApproved') {
          lateExecuteApprovedEmitted = true;
        }
      } catch {}
    });

    // Start dispatch with a background promise
    const dispatchPromise = dispatcher.dispatch({
      id: 'bg_timeout',
      command: 'run_background_script',
      params: { script: 'gs.sleep(100);' },
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.ok(savedReviewRequest);

    // Cancel / time out the request explicitly
    dispatcher.cancel('bg_timeout', 'TEST_TIMEOUT');
    await dispatchPromise;

    // Now simulate a late approval arriving after timeout
    ws.send(
      JSON.stringify({
        action: 'reviewResponse',
        reviewId: savedReviewRequest.reviewId,
        nonce: savedReviewRequest.nonce,
        payloadHash: savedReviewRequest.payloadHash,
        approved: true,
      })
    );

    await new Promise((r) => setTimeout(r, 60));
    // Verify executeApproved was NEVER sent
    assert.strictEqual(lateExecuteApprovedEmitted, false);

    ws.close();
  } finally {
    await wsBridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TwoPhaseReview: client cancellation triggers cancelReview on helper', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-review-test-'));
  const instDir = path.join(tmpDir, 'ven08329');
  fs.mkdirSync(instDir, { recursive: true });
  fs.writeFileSync(path.join(instDir, '_settings.json'), JSON.stringify({ url: 'https://ven08329.service-now.com' }));

  const pending = new PendingRegistry();
  const wsBridge = new StandaloneWsBridge(0, pending);
  const wsPort = await (wsBridge as any).start();

  const dispatcher = new StandaloneDispatcher({
    cwd: tmpDir,
    wsBridge,
    pending,
    cliFlags: {
      backgroundScripts: true,
      reviewHighRisk: true,
    },
  });

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    ws.send(
      JSON.stringify({
        action: 'helperBuildInfo',
        tier: 'pro',
        proFeatures: true,
        capabilities: { protocolVersion: 1, commandReview: 1, instanceSecurityGates: 1 },
      })
    );

    ws.send(
      JSON.stringify({
        action: 'helperGatesUpdated',
        instanceOrigin: 'https://ven08329.service-now.com',
        revision: 1,
        gates: {
          backgroundScripts: true,
          deleteRecords: true,
          createArtifacts: true,
          browserDebugger: false,
          restRequest: true,
        },
      })
    );

    await new Promise((r) => setTimeout(r, 60));

    let cancelReviewReceived: any = null;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString('utf8'));
        if (msg.action === 'cancelReview') {
          cancelReviewReceived = msg;
        }
      } catch {}
    });

    const dispatchPromise = dispatcher.dispatch({
      id: 'bg_cancel_test',
      command: 'run_background_script',
      params: { script: 'gs.print(1);' },
    });

    await new Promise((r) => setTimeout(r, 50));

    // Cancel by outer request ID
    dispatcher.cancel('bg_cancel_test', 'CLIENT_SIGINT');
    await dispatchPromise;

    await new Promise((r) => setTimeout(r, 50));
    assert.ok(cancelReviewReceived);
    assert.strictEqual(cancelReviewReceived.reason, 'CLIENT_SIGINT');

    ws.close();
  } finally {
    await wsBridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TwoPhaseReview: malformed or partial gate snapshots are strictly rejected', async () => {
  const wsBridge = new StandaloneWsBridge(0);
  const wsPort = await (wsBridge as any).start();

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    // 1. Partial gates (missing restRequest and deleteRecords) -> should be rejected
    ws.send(
      JSON.stringify({
        action: 'helperGatesUpdated',
        instanceOrigin: 'https://ven08329.service-now.com',
        revision: 1,
        gates: {
          backgroundScripts: true,
          createArtifacts: true,
          browserDebugger: true,
        },
      })
    );

    await new Promise((r) => setTimeout(r, 50));
    let state = wsBridge.getHelperState();
    assert.strictEqual(state.instanceGates.size, 0);

    // 2. Invalid number type instead of valid GateMode -> should be rejected
    ws.send(
      JSON.stringify({
        action: 'helperGatesUpdated',
        instanceOrigin: 'https://ven08329.service-now.com',
        revision: 2,
        gates: {
          backgroundScripts: 12345,
          deleteRecords: true,
          createArtifacts: true,
          browserDebugger: false,
          restRequest: true,
        },
      })
    );

    await new Promise((r) => setTimeout(r, 50));
    state = wsBridge.getHelperState();
    assert.strictEqual(state.instanceGates.size, 0);

    // 3. Complete valid boolean snapshot -> should be accepted
    ws.send(
      JSON.stringify({
        action: 'helperGatesUpdated',
        instanceOrigin: 'https://ven08329.service-now.com',
        revision: 3,
        gates: {
          backgroundScripts: true,
          deleteRecords: false,
          createArtifacts: true,
          browserDebugger: false,
          restRequest: true,
        },
      })
    );

    await new Promise((r) => setTimeout(r, 50));
    state = wsBridge.getHelperState();
    assert.strictEqual(state.instanceGates.size, 1);
    assert.strictEqual(wsBridge.getInstanceGate('https://ven08329.service-now.com', 'backgroundScripts'), true);
    assert.strictEqual(wsBridge.getInstanceGate('https://ven08329.service-now.com', 'deleteRecords'), false);

    // 4. Complete valid 3-way string gate snapshot ('approve', 'off', 'auto') -> should be accepted
    ws.send(
      JSON.stringify({
        action: 'helperGatesUpdated',
        instanceOrigin: 'https://ven08329.service-now.com',
        revision: 4,
        gates: {
          backgroundScripts: 'approve',
          deleteRecords: 'off',
          createArtifacts: 'auto',
          browserDebugger: 'auto',
          restRequest: 'auto',
        },
      })
    );

    await new Promise((r) => setTimeout(r, 50));
    state = wsBridge.getHelperState();
    assert.strictEqual(state.instanceGates.size, 1);
    assert.strictEqual(wsBridge.getInstanceGate('https://ven08329.service-now.com', 'backgroundScripts'), 'approve');
    assert.strictEqual(wsBridge.getInstanceGate('https://ven08329.service-now.com', 'deleteRecords'), 'off');

    // 5. Stale monotonic revision (revision 2 < current revision 4) -> should be dropped
    ws.send(
      JSON.stringify({
        action: 'helperGatesUpdated',
        instanceOrigin: 'https://ven08329.service-now.com',
        revision: 2,
        gates: {
          backgroundScripts: false,
          deleteRecords: false,
          createArtifacts: false,
          browserDebugger: false,
          restRequest: false,
        },
      })
    );

    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(wsBridge.getInstanceGate('https://ven08329.service-now.com', 'backgroundScripts'), 'approve');

    ws.close();
  } finally {
    await wsBridge.close();
  }
});

test('TwoPhaseReview: stale WebSocket clients are closed and their messages ignored', async () => {
  const wsBridge = new StandaloneWsBridge(0);
  const wsPort = await (wsBridge as any).start();

  try {
    const ws1 = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((resolve) => ws1.on('open', resolve));

    ws1.send(
      JSON.stringify({
        action: 'helperBuildInfo',
        tier: 'free',
        proFeatures: false,
      })
    );

    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(wsBridge.getHelperState().tier, 'free');

    // Connect second client (e.g. user refreshed helper tab)
    const ws2 = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((resolve) => ws2.on('open', resolve));

    ws2.send(
      JSON.stringify({
        action: 'helperBuildInfo',
        tier: 'pro',
        proFeatures: true,
      })
    );

    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(wsBridge.getHelperState().tier, 'pro');

    // Attempt to send update from old client ws1 -> should be ignored because ws1 was closed or is not activeClient
    try {
      ws1.send(
        JSON.stringify({
          action: 'helperBuildInfo',
          tier: 'enterprise',
          proFeatures: false,
        })
      );
    } catch {}

    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(wsBridge.getHelperState().tier, 'pro');

    ws2.close();
  } finally {
    await wsBridge.close();
  }
});

test('TwoPhaseReview: legacy helper without commandReview executes directly via fallback without hanging', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-legacy-helper-test-'));
  const instDir = path.join(tmpDir, 'ven08329');
  fs.mkdirSync(instDir, { recursive: true });
  fs.writeFileSync(path.join(instDir, '_settings.json'), JSON.stringify({ url: 'https://ven08329.service-now.com' }));

  const pending = new PendingRegistry();
  const wsBridge = new StandaloneWsBridge(0, pending);
  const wsPort = await (wsBridge as any).start();

  const dispatcher = new StandaloneDispatcher({
    cwd: tmpDir,
    wsBridge,
    pending,
    cliFlags: {
      backgroundScripts: true,
      reviewHighRisk: true,
    },
  });

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    // Legacy helper sends NO capabilities (standard in-the-wild SN Utils 10.x today)
    ws.send(
      JSON.stringify({
        action: 'helperBuildInfo',
        tier: 'pro',
        proFeatures: true,
      })
    );

    await new Promise((r) => setTimeout(r, 60));

    let reviewRequestReceived = false;
    let directScriptActionReceived = false;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString('utf8'));
        if (msg.action === 'reviewRequest') {
          reviewRequestReceived = true;
        } else if (msg.action === 'agentRunBackgroundScript') {
          directScriptActionReceived = true;
          // Reply with standard direct execution response
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                action: 'agentRunBackgroundScriptResponse',
                agentRequestId: msg.agentRequestId,
                success: true,
                output: '*** Script: Legacy Helper Executed Directly',
              })
            );
          }, 30);
        }
      } catch {}
    });

    const res = await dispatcher.dispatch({
      id: 'legacy_bg_1',
      command: 'run_background_script',
      params: { script: "gs.print('Legacy Helper Executed Directly');" },
    });

    assert.strictEqual(res.status, 'success');
    assert.strictEqual(res.result.output, '*** Script: Legacy Helper Executed Directly');
    assert.strictEqual(reviewRequestReceived, false, 'Should not have sent reviewRequest to legacy helper');
    assert.strictEqual(directScriptActionReceived, true, 'Should have executed directly via agentRunBackgroundScript');

    ws.close();
  } finally {
    await wsBridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

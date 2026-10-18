// Recovery tests for scripts/artifact-profile-fixtures.mjs against a fake
// bridge (no instance, no helper tab). The fake keeps an in-memory instance,
// records every change in the session's current update set like ServiceNow
// customer updates, refuses to delete an update set that still holds them,
// and can lose a response after a write was applied or refuse a write.
//
//   node --test scripts/test-artifact-profile-fixtures.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./artifact-profile-fixtures.mjs', import.meta.url));
const USER_SET = 'u'.repeat(32);
const CATALOG = 'c'.repeat(32);

function fakeBridge() {
    const db = { sys_update_set: { [USER_SET]: { sys_id: USER_SET, name: 'Default' } }, sc_catalog: { [CATALOG]: { sys_id: CATALOG, title: 'Service Catalog' } }, sys_update_xml: {} };
    const state = { current: USER_SET, calls: 0, faults: [], userSetChanges: 0 };
    const table = t => (db[t] ||= {});
    const track = (t, id, action) => {
        if (t === 'sys_update_xml' || t === 'sys_update_set') return;
        if (state.current === USER_SET) state.userSetChanges++;
        const xid = `x${Object.keys(db.sys_update_xml).length}`.padEnd(32, '0');
        db.sys_update_xml[xid] = { sys_id: xid, update_set: state.current, name: `${t}_${id}`, action };
    };
    const ok = result => ({ status: 'success', result });
    const err = (code, error, details) => ({ status: 'error', code, error, ...(details ? { details } : {}) });
    const handle = ({ command, params }) => {
        switch (command) {
            case 'rest_request': {
                if (params.endpoint === '/api/now/ui/concoursepicker/updateset') return ok({ status: 200, data: { result: { current: { sysId: state.current } } } });
                const m = params.endpoint.match(/^\/api\/now\/table\/([a-z_]+)(?:\/([0-9a-f]{32}))?$/);
                if (m && m[2]) return table(m[1])[m[2]] ? ok({ status: 200, data: { result: { sys_id: m[2] } } }) : err('E_NOT_FOUND', 'No Record found', { status: 404 });
                if (m && m[1] === 'sys_metadata') {
                    const ids = (params.queryParams.sysparm_query || '').replace('sys_idIN', '').split(',');
                    const rows = ids.flatMap(id => Object.values(db).map(t => t[id]).filter(Boolean).map(r => ({ sys_id: r.sys_id, sys_updated_on: '2026-10-18 20:00:00' })));
                    return ok({ status: 200, data: { result: rows } });
                }
                return err('E_INVALID_PARAMS', `fake bridge has no ${params.endpoint}`);
            }
            case 'query_records': {
                const [field, value] = params.query.split('=');
                return ok(Object.values(table(params.table)).filter(r => r[field] === value).slice(0, params.limit));
            }
            case 'create_records': {
                const row = { ...params.rows[0] };
                // Like the instance: a create without a sys_id gets a new one.
                row.sys_id ||= (Date.now().toString(16) + Math.random().toString(16).slice(2)).replace(/[^0-9a-f]/g, '').padEnd(32, '0').slice(0, 32);
                if (table(params.table)[row.sys_id]) return err('E_COMMAND_FAILED', 'duplicate sys_id');
                table(params.table)[row.sys_id] = { ...row };
                track(params.table, row.sys_id, 'INSERT_OR_UPDATE');
                return ok({ batchId: 'bat_fake_000000', rows: [{ index: 0, outcome: 'succeeded', sys_id: row.sys_id }], counts: { total: 1, succeeded: 1 } });
            }
            case 'run_background_script': {
                const id = params.script.match(/setNewGuidValue\('([0-9a-f]{32})'\)/)[1];
                table('catalog_ui_policy_action')[id] = { sys_id: id };
                track('catalog_ui_policy_action', id, 'INSERT_OR_UPDATE');
                return ok({ output: `*** Script: FXACTION ${id}` });
            }
            case 'switch_context':
                if (!db.sys_update_set[params.value]) return err('E_COMMAND_FAILED', 'Update set not found');
                state.current = params.value;
                return ok({ switched: true });
            case 'delete_record': {
                const rec = table(params.table)[params.sys_id];
                if (!rec) return err('E_COMMAND_FAILED', 'No Record found');
                if (params.table === 'sys_update_set' && Object.values(db.sys_update_xml).some(x => x.update_set === params.sys_id)) return err('E_ACL', 'Operation Failed');
                delete table(params.table)[params.sys_id];
                track(params.table, params.sys_id, 'DELETE');
                return ok({ deleted: true });
            }
            default:
                return err('E_UNKNOWN_COMMAND', command);
        }
    };
    const server = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const request = JSON.parse(body);
        const n = ++state.calls;
        const fault = state.faults.find(f => f.match(request, n));
        if (fault?.refuse) { res.end(JSON.stringify(err('E_ACL', 'refused by the test'))); return; }
        const answer = handle(request);
        if (fault?.loseAnswer) { res.destroy(); return; } // applied, but the caller never hears back
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(answer));
    });
    return { db, state, server };
}

async function withBridge(t) {
    const fake = fakeBridge();
    await new Promise(r => fake.server.listen(0, '127.0.0.1', r));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snu-fixture-test-'));
    const portFile = path.join(dir, 'agent-port.json');
    fs.writeFileSync(portFile, JSON.stringify({ port: fake.server.address().port, token: 't' }));
    t.after(() => { fake.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const stateFile = path.join(dir, 'fixture.json');
    const run = cmd => new Promise(resolve => {
        // Async spawn: the fake bridge lives in this process and must keep serving.
        import('node:child_process').then(({ spawn }) => {
            const child = spawn(process.execPath, [SCRIPT, cmd, '--instance', 'dev', '--state', stateFile, '--scope', 'x_app', '--prefix', 'T'], { env: { ...process.env, SNU_AGENT_PORT_FILE: portFile } });
            let out = '';
            child.stdout.on('data', d => { out += d; });
            child.stderr.on('data', d => { out += d; });
            child.on('close', code => resolve({ code, out }));
        });
    });
    const fixtureRows = () => ['item_option_new_set', 'item_option_new', 'sc_cat_item', 'io_set_item', 'sc_cat_item_catalog', 'catalog_ui_policy', 'catalog_ui_policy_action']
        .reduce((n, t) => n + Object.keys(fake.db[t] || {}).length, 0);
    const updateSets = () => Object.keys(fake.db.sys_update_set).filter(id => id !== USER_SET);
    return { fake, run, stateFile, fixtureRows, updateSets };
}

test('a create applied on the instance but answered by nobody is still tracked and cleaned up', async t => {
    const { fake, run, stateFile, fixtureRows, updateSets } = await withBridge(t);
    fake.state.faults.push({ match: r => r.command === 'create_records' && r.params.table === 'sc_cat_item' && /item B/.test(r.params.rows[0].name), loseAnswer: true });
    const setup = await run('setup');
    assert.notEqual(setup.code, 0, 'setup reports the failure');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.records.item_b.status, 'created', 'the lost write was reconciled against the instance');
    assert.ok(fake.db.sc_cat_item[state.records.item_b.sys_id], 'it really exists');
    assert.equal(state.records.a_urgent.status, 'planned', 'later records were never sent');
    assert.equal(fake.state.current, USER_SET, 'session restored');
    fake.state.faults.length = 0;
    const cleanup = await run('cleanup');
    assert.equal(cleanup.code, 0, cleanup.out);
    assert.equal(fixtureRows(), 0);
    assert.deepEqual(updateSets(), []);
    assert.ok(!fs.existsSync(stateFile));
    assert.equal(fake.state.userSetChanges, 0, 'nothing recorded in the user\'s update set');
});

test('a cleanup that fails partway keeps its update set and resumes', async t => {
    const { fake, run, stateFile, fixtureRows, updateSets } = await withBridge(t);
    assert.equal((await run('setup')).code, 0);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const urgent = state.records.a_urgent.sys_id;
    fake.state.faults.push({ match: r => r.command === 'delete_record' && r.params.sys_id === urgent, refuse: true });
    const first = await run('cleanup');
    assert.notEqual(first.code, 0);
    const mid = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.deepEqual(Object.keys(mid.records).sort(), ['a_urgent', 'update_set'], 'only what remains is still listed');
    assert.equal(updateSets().length, 1, 'the fixture update set is kept while a record remains');
    assert.equal(fake.state.current, USER_SET);
    fake.state.faults.length = 0;
    const second = await run('cleanup');
    assert.equal(second.code, 0, second.out);
    assert.equal(fixtureRows(), 0);
    assert.deepEqual(updateSets(), []);
    assert.ok(!fs.existsSync(stateFile));
    assert.equal(fake.state.userSetChanges, 0);
});

test('a resumed cleanup whose update set disappeared uses a temporary one, never the user\'s', async t => {
    const { fake, run, stateFile, fixtureRows, updateSets } = await withBridge(t);
    assert.equal((await run('setup')).code, 0);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    // Someone removed the fixture's update set by hand.
    for (const [id, x] of Object.entries(fake.db.sys_update_xml)) if (x.update_set === state.updateSets[0]) delete fake.db.sys_update_xml[id];
    delete fake.db.sys_update_set[state.updateSets[0]];
    const cleanup = await run('cleanup');
    assert.equal(cleanup.code, 0, cleanup.out);
    assert.equal(fixtureRows(), 0);
    assert.deepEqual(updateSets(), [], 'the temporary update set is removed too');
    assert.equal(fake.state.userSetChanges, 0);
    assert.equal(fake.state.current, USER_SET);
});

test('a policy action whose answer is lost is reconciled by its planned sys_id', async t => {
    const { fake, run, stateFile, fixtureRows } = await withBridge(t);
    fake.state.faults.push({ match: r => r.command === 'run_background_script', loseAnswer: true });
    assert.notEqual((await run('setup')).code, 0);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.records.a_action.status, 'created');
    fake.state.faults.length = 0;
    assert.equal((await run('cleanup')).code, 0);
    assert.equal(fixtureRows(), 0);
});

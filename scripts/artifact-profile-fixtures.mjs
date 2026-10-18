#!/usr/bin/env node
// Live fixtures and regression checks for analyze_artifact_type (catalog items).
//
// The fixture is two catalog items that share one variable set, plus a
// catalog UI policy on item A whose condition and action reference variables
// as IO:<sys_id>. It checks that the profile keeps A's own records, finds the
// shared set (and its variables) shared without following it into B, finds the
// embedded references, and leaves every fixture record unchanged.
//
// Talks to the running ScriptSync bridge (VS Code or `snu serve`) through its
// HTTP Agent API, discovered from ~/.sn-scriptsync/agent-port.json.
//
//   node scripts/artifact-profile-fixtures.mjs setup   --instance dev12345 --scope x_app --state fixtures.json [--prefix "SNU fixture"]
//   node scripts/artifact-profile-fixtures.mjs regress --instance dev12345 --state fixtures.json
//   node scripts/artifact-profile-fixtures.mjs status  --instance dev12345 --state fixtures.json
//   node scripts/artifact-profile-fixtures.mjs cleanup --instance dev12345 --state fixtures.json
//
// setup and cleanup write to the instance and switch the session's current
// update set while they run (restored afterwards); regress and status only read.
// setup needs the createArtifacts permission and, for the policy action,
// backgroundScripts: the Table API drops catalog_ui_policy_action.ui_policy and
// catalog_variable, so the fixture action is inserted server-side. That is
// fixture setup only, not a creation path to recommend. cleanup needs
// deleteRecords.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [command, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i += 2) opts[rest[i].replace(/^--/, '')] = rest[i + 1];
if (!['setup', 'regress', 'status', 'cleanup'].includes(command) || !opts.instance || !opts.state) {
    console.error('usage: artifact-profile-fixtures.mjs <setup|regress|status|cleanup> --instance <name> --state <file> [--scope <scope>] [--prefix <text>]');
    process.exit(2);
}

// SNU_AGENT_PORT_FILE points the script at another bridge (the local test uses a fake one).
const port = JSON.parse(fs.readFileSync(process.env.SNU_AGENT_PORT_FILE || path.join(os.homedir(), '.sn-scriptsync', 'agent-port.json'), 'utf8'));
let seq = 0;
async function agent(cmd, params = {}) {
    const res = await fetch(`http://127.0.0.1:${port.port}/api`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Agent-Token': port.token },
        body: JSON.stringify({ id: `fx_${Date.now()}_${++seq}`, command: cmd, instance: opts.instance, params }),
    });
    return res.json();
}
const must = (resp, what) => {
    if (resp.status !== 'success') throw new Error(`${what}: ${resp.code} ${resp.error}`);
    return resp.result;
};
async function query(table, q, fields, limit = 100) {
    const r = must(await agent('query_records', { table, query: q, fields, limit }), `query ${table}`);
    return Array.isArray(r) ? r : r.records || [];
}
async function createOne(table, row, scope) {
    const r = must(await agent('create_records', { table, ...(scope ? { scope } : {}), rows: [row] }), `create ${table}`);
    const out = r.rows[0];
    if (out.warnings?.length) console.warn(`  warning on ${table}: ${JSON.stringify(out.warnings)}`);
    return out.sys_id;
}
async function currentUpdateSet() {
    const r = must(await agent('rest_request', { endpoint: '/api/now/ui/concoursepicker/updateset', method: 'GET' }), 'read update set');
    return r.data.result.current.sysId;
}
const switchTo = async id => must(await agent('switch_context', { switchType: 'updateset', value: id, reloadTab: false }), 'switch update set');
const readState = () => JSON.parse(fs.readFileSync(opts.state, 'utf8'));
const writeState = state => fs.writeFileSync(opts.state, JSON.stringify(state, null, 2));
const newId = () => crypto.randomBytes(16).toString('hex');
/** true, false, or throws when the instance cannot tell (the outcome stays uncertain). */
async function exists(table, sysId) {
    const resp = await agent('rest_request', { endpoint: `/api/now/table/${table}/${sysId}`, method: 'GET', queryParams: { sysparm_fields: 'sys_id' } });
    if (resp.status === 'success') return true;
    if (resp.code === 'E_NOT_FOUND' || /no record found/i.test(String(resp.error || '')) || resp.details?.status === 404) return false;
    throw new Error(`could not check ${table} ${sysId}: ${resp.code} ${resp.error}`);
}
// A missing record: E_NOT_FOUND on the VS Code host, "No Record found" on the standalone host.
const gone = resp => resp.code === 'E_NOT_FOUND' || /no record found/i.test(String(resp.error || ''));

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); if (!ok) failures++; };

// Timestamps in internal UTC on every host (query_records formats them per
// host: the VS Code host returns display values in the user's time zone).
async function baseline(state) {
    const ids = Object.values(state.records).map(r => r.sys_id);
    const r = must(await agent('rest_request', { endpoint: '/api/now/table/sys_metadata', method: 'GET', queryParams: {
        sysparm_query: `sys_idIN${ids.join(',')}`, sysparm_fields: 'sys_id,sys_updated_on', sysparm_limit: '50', sysparm_display_value: 'false',
    } }), 'read timestamps');
    return Object.fromEntries((r.data?.result || []).map(x => [x.sys_id, x.sys_updated_on]));
}

async function setup() {
    if (fs.existsSync(opts.state)) throw new Error(`${opts.state} exists: run cleanup first or choose another --state`);
    const scope = opts.scope;
    if (!scope) throw new Error('setup needs --scope (fixture records are created in that application scope)');
    const prefix = opts.prefix || 'SNU fixture';
    const before = await currentUpdateSet();
    // Every record's sys_id is chosen and saved before anything is sent, so a
    // write whose answer is lost is still tracked: cleanup deletes by these ids
    // (a planned record that was never created is simply "already gone").
    const tables = {
        update_set: 'sys_update_set', set: 'item_option_new_set', set_reason: 'item_option_new', set_cost: 'item_option_new',
        item_a: 'sc_cat_item', item_b: 'sc_cat_item', a_urgent: 'item_option_new', a_details: 'item_option_new',
        a_set_link: 'io_set_item', b_set_link: 'io_set_item', a_catalog_link: 'sc_cat_item_catalog', b_catalog_link: 'sc_cat_item_catalog',
        a_policy: 'catalog_ui_policy', a_action: 'catalog_ui_policy_action',
    };
    const records = Object.fromEntries(Object.entries(tables).map(([key, table]) => [key, { table, sys_id: newId(), status: 'planned' }]));
    const state = { instance: opts.instance, scope, prefix, createdAt: new Date().toISOString(), updateSets: [records.update_set.sys_id], restoreUpdateSet: before, records, baseline: {} };
    writeState(state);
    const id = key => records[key].sys_id;
    const create = async (key, row) => {
        const rec = records[key];
        rec.status = 'sending'; writeState(state);
        try {
            const got = await createOne(rec.table, { ...row, sys_id: rec.sys_id }, scope);
            if (got && got !== rec.sys_id) throw new Error(`${key} was created as ${got}, not the planned ${rec.sys_id}`);
            rec.status = 'created'; writeState(state);
        } catch (err) {
            rec.status = 'uncertain'; writeState(state);
            throw err;
        }
    };
    let switched = false;
    try {
        await create('update_set', { name: `${prefix}: analyze_artifact_type`, description: 'Fixture for analyze_artifact_type regression checks. Safe to delete with the cleanup command.' });
        await switchTo(id('update_set'));
        switched = true;
        const catalog = (await query('sc_catalog', 'title=Service Catalog', 'sys_id', 1))[0]?.sys_id;
        if (!catalog) throw new Error('No "Service Catalog" catalog found');
        await create('set', { title: `${prefix} shared set`, internal_name: `${prefix.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_shared_set` });
        await create('set_reason', { variable_set: id('set'), name: 'fx_shared_reason', question_text: 'Reason', type: '6', order: '100' });
        await create('set_cost', { variable_set: id('set'), name: 'fx_shared_cost_center', question_text: 'Cost center', type: '6', order: '200' });
        await create('item_a', { name: `${prefix} item A`, short_description: 'analyze_artifact_type fixture root', active: 'true' });
        await create('item_b', { name: `${prefix} item B`, short_description: 'analyze_artifact_type fixture decoy sharing the set', active: 'true' });
        await create('a_urgent', { cat_item: id('item_a'), name: 'fx_a_urgent', question_text: 'Urgent', type: '7', order: '100' });
        await create('a_details', { cat_item: id('item_a'), name: 'fx_a_details', question_text: 'Details', type: '2', order: '300' });
        await create('a_set_link', { sc_cat_item: id('item_a'), variable_set: id('set'), order: '200' });
        await create('b_set_link', { sc_cat_item: id('item_b'), variable_set: id('set'), order: '100' });
        await create('a_catalog_link', { sc_cat_item: id('item_a'), sc_catalog: catalog });
        await create('b_catalog_link', { sc_cat_item: id('item_b'), sc_catalog: catalog });
        await create('a_policy', { catalog_item: id('item_a'), applies_to: 'item', short_description: `${prefix}: urgent needs a reason`, catalog_conditions: `IO:${id('a_urgent')}=true^EQ`, active: 'true', on_load: 'true', reverse_if_false: 'true' });
        // Fixture setup only: the Table API drops these two fields, so the action is inserted server-side, with its planned sys_id.
        records.a_action.status = 'sending'; writeState(state);
        const script = `// analyze_artifact_type fixture: catalog UI policy action\nvar gr = new GlideRecord('catalog_ui_policy_action'); gr.initialize(); gr.setWorkflow(false); gr.setNewGuidValue('${id('a_action')}');\ngr.setValue('ui_policy', '${id('a_policy')}'); gr.setValue('catalog_item', '${id('item_a')}'); gr.setValue('catalog_variable', 'IO:${id('set_reason')}');\ngr.setValue('mandatory', 'true'); gr.setValue('visible', 'ignore'); gr.setValue('disabled', 'ignore');\ngs.print('FXACTION ' + gr.insert());`;
        let out = '';
        try { out = must(await agent('run_background_script', { script }), 'insert policy action').output || ''; }
        catch (err) { records.a_action.status = 'uncertain'; writeState(state); throw err; }
        if (!out.includes(`FXACTION ${id('a_action')}`)) { records.a_action.status = 'uncertain'; writeState(state); throw new Error('policy action insert did not confirm its planned sys_id'); }
        records.a_action.status = 'created'; writeState(state);
    } finally {
        if (switched) {
            try { await switchTo(before); } catch (err) { console.warn(`  could not switch the session back to ${before}: ${err.message}`); failures++; }
        }
        // Settle every write whose outcome is not known by asking the instance.
        for (const [key, rec] of Object.entries(records)) {
            if (rec.status === 'created' || rec.status === 'planned') continue;
            try { rec.status = (await exists(rec.table, rec.sys_id)) ? 'created' : 'absent'; }
            catch (err) { console.warn(`  ${key}: outcome still unknown (${err.message}); cleanup will try to delete it`); }
        }
        state.baseline = await baseline(state).catch(() => ({}));
        writeState(state);
        const made = Object.values(records).filter(r => r.status === 'created').length;
        console.log(`Fixture state in ${opts.state}: ${made} record(s) created of ${Object.keys(records).length} planned.`);
    }
}

async function regress() {
    const state = readState();
    const r = state.records;
    const A = r.item_a.sys_id, B = r.item_b.sys_id;
    const classes = members => Object.fromEntries((members || []).map(m => [m.sys_id, m.class]));
    console.log('\n=== 1. item A with B outside the sample ===');
    const alone = must(await agent('analyze_artifact_type', { type: 'catalog_item', roots: [A], detail: true, refresh: true, save: false }), 'analyze A');
    const mA = classes(alone.sampleReports[0]?.members);
    for (const key of ['a_urgent', 'a_details', 'a_policy', 'a_action', 'a_set_link', 'a_catalog_link']) check(`${key} owned_by_reference`, mA[r[key].sys_id] === 'owned_by_reference', mA[r[key].sys_id]);
    check('shared set is shared', mA[r.set.sys_id] === 'shared', mA[r.set.sys_id]);
    for (const key of ['set_reason', 'set_cost']) check(`${key} inherits_shared`, mA[r[key].sys_id] === 'inherits_shared', mA[r[key].sys_id]);
    for (const key of ['item_b', 'b_set_link', 'b_catalog_link']) check(`${key} not pulled into A`, mA[r[key].sys_id] === undefined, mA[r[key].sys_id]);

    console.log('\n=== 2. the same with B in the sample ===');
    const both = must(await agent('analyze_artifact_type', { type: 'catalog_item', roots: [A, B], detail: true, refresh: true, save: false }), 'analyze A and B');
    const mBoth = classes(both.sampleReports.find(s => s.sys_id === A)?.members);
    check('A classified identically', JSON.stringify(Object.entries(mBoth).sort()) === JSON.stringify(Object.entries(mA).sort()));

    console.log('\n=== 3. embedded references and inherited sharing ===');
    const refs = alone.sampleReports[0]?.embeddedRefs || [];
    check('IO:<Urgent> in the policy condition resolves to A', refs.some(e => e.from === 'catalog_ui_policy.catalog_conditions' && e.target === r.a_urgent.sys_id && e.resolved.belongsTo === 'this_root'), JSON.stringify(refs));
    check('IO:<Reason> in the action resolves to the shared set', refs.some(e => e.from === 'catalog_ui_policy_action.catalog_variable' && e.target === r.set_reason.sys_id && e.resolved.belongsTo === 'variable_set'), JSON.stringify(refs));
    check('no unresolved embedded references', alone.coverage.unresolvedEmbedded === 0, alone.coverage.unresolvedEmbedded);

    console.log('\n=== 4. analysis left every fixture record unchanged ===');
    const now = await baseline(state);
    for (const [key, rec] of Object.entries(r)) {
        if (rec.table === 'sys_update_set') continue;
        check(`${key} unchanged`, state.baseline[rec.sys_id] && now[rec.sys_id] === state.baseline[rec.sys_id], `${state.baseline[rec.sys_id]} -> ${now[rec.sys_id]}`);
    }
}

async function status() {
    const state = readState();
    const now = await baseline(state);
    for (const [key, rec] of Object.entries(state.records)) {
        if (rec.table === 'sys_update_set') continue;
        check(`${key} present`, !!now[rec.sys_id]);
    }
}

async function cleanup() {
    const state = readState();
    const knownOrder = ['a_action', 'a_policy', 'a_set_link', 'b_set_link', 'a_catalog_link', 'b_catalog_link', 'a_urgent', 'a_details', 'item_a', 'item_b', 'set_reason', 'set_cost', 'set'];
    // Records the state knows beyond the fixed list (added by hand while
    // recovering) are children more often than parents: remove them first.
    const keys = () => [
        ...Object.keys(state.records).filter(k => k !== 'update_set' && !knownOrder.includes(k)),
        ...knownOrder.filter(k => state.records[k]),
    ];
    state.updateSets = state.updateSets || [];
    const before = await currentUpdateSet();

    // Deletions are recorded in an update set, never in the user's own: the
    // fixture's set if it still exists, or a temporary one removed at the end.
    let recordIn = null;
    for (const us of [...state.updateSets]) {
        if (await exists('sys_update_set', us)) { recordIn = us; break; }
        state.updateSets = state.updateSets.filter(x => x !== us);
        if (state.records.update_set?.sys_id === us) delete state.records.update_set;
        writeState(state);
    }
    if (!recordIn && keys().length) {
        recordIn = await createOne('sys_update_set', { name: 'SNU fixture cleanup (temporary)', description: 'Records fixture deletions; removed by the cleanup command.' }, state.scope);
        state.updateSets.push(recordIn);
        writeState(state);
    }
    if (recordIn) {
        await switchTo(recordIn);
        // Never delete while the session records changes anywhere else.
        const active = await currentUpdateSet();
        if (active !== recordIn) throw new Error(`the session is on update set ${active}, not ${recordIn}; nothing deleted`);
        try {
            for (const key of keys()) {
                const rec = state.records[key];
                const resp = await agent('delete_record', { table: rec.table, sys_id: rec.sys_id });
                const done = resp.status === 'success' || gone(resp);
                console.log(`  ${key}: ${resp.status === 'success' ? 'deleted' : gone(resp) ? 'already gone' : `FAILED ${resp.code} ${resp.error}`}`);
                if (done) { delete state.records[key]; writeState(state); }
                else failures++;
            }
        } finally {
            const restore = state.updateSets.includes(before) ? (state.restoreUpdateSet || before) : before;
            await switchTo(restore).catch(err => { console.warn(`  could not switch the session back: ${err.message}`); failures++; });
        }
    }

    // Update sets go last, and only when every fixture record is confirmed gone,
    // so a resumed cleanup always has its set to record the remaining deletions.
    const remaining = keys();
    if (remaining.length) {
        console.log(`  kept update set(s) ${state.updateSets.join(', ')}: ${remaining.length} record(s) remain (${remaining.join(', ')}); run cleanup again`);
        return;
    }
    for (const us of [...state.updateSets]) {
        // The platform refuses to delete an update set that still holds
        // customer updates (the UI's "Delete with updates"); remove that
        // tracking first. The tracked records themselves are already deleted.
        const updates = await query('sys_update_xml', `update_set=${us}`, 'sys_id', 500).catch(() => []);
        let tracked = true;
        for (const u of updates) {
            const r = await agent('delete_record', { table: 'sys_update_xml', sys_id: u.sys_id });
            if (r.status !== 'success' && !gone(r)) { console.log(`  customer update ${u.sys_id}: FAILED ${r.code}`); failures++; tracked = false; }
        }
        if (updates.length) console.log(`  update set ${us}: removed ${updates.length} customer update(s)`);
        if (!tracked) continue;
        const resp = await agent('delete_record', { table: 'sys_update_set', sys_id: us });
        console.log(`  update set ${us}: ${resp.status === 'success' ? 'deleted' : gone(resp) ? 'already gone' : `FAILED ${resp.code} ${resp.error}`}`);
        if (resp.status === 'success' || gone(resp)) {
            state.updateSets = state.updateSets.filter(x => x !== us);
            if (state.records.update_set?.sys_id === us) delete state.records.update_set;
            writeState(state);
        } else failures++;
    }
    if (!failures && !state.updateSets.length) fs.rmSync(opts.state);
}

try {
    await ({ setup, regress, status, cleanup })[command]();
} catch (err) {
    console.error(`\n${command} stopped: ${err.message}`);
    process.exit(1);
}
console.log(failures ? `\n${failures} check(s) failed.` : `\n${command}: all good.`);
process.exit(failures ? 1 : 0);

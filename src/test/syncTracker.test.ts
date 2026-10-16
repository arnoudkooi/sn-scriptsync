import test from 'node:test';
import assert from 'node:assert';
import { SyncTracker, revisionOf } from '../syncTracker';

const target = (fields: string[] = ['script'], sysId = 'a'.repeat(32)) => ({ instance: 'dev123', table: 'sys_script_include', sysId, fields });
const disk = (contents: Record<string, string | undefined>) => (filePath: string) => contents[filePath];

test('a confirmed save leaves the queue, an answered syncId is not in flight', () => {
	const tracker = new SyncTracker(() => 1000);
	const id = tracker.newSyncId();
	tracker.submit(id, target(), [{ filePath: '/w/a.js', content: 'v1' }]);
	assert.ok(tracker.isInFlight('/w/a.js'));
	assert.deepStrictEqual(tracker.busyFiles(), ['/w/a.js']);

	const result = tracker.resolve(id, true, disk({ '/w/a.js': 'v1' }));
	assert.ok(result);
	assert.deepStrictEqual(result!.files, [{ filePath: '/w/a.js', outcome: 'confirmed', submittedContent: 'v1' }]);
	assert.strictEqual(tracker.isInFlight('/w/a.js'), false);
	assert.strictEqual(tracker.size, 0);
});

test('an edit made while the save was in flight is not removed by the earlier acknowledgement', () => {
	const tracker = new SyncTracker();
	const id = tracker.newSyncId();
	tracker.submit(id, target(), [{ filePath: '/w/a.js', content: 'v1' }]);

	const result = tracker.resolve(id, true, disk({ '/w/a.js': 'v2' }));
	assert.strictEqual(result!.ok, true);
	assert.strictEqual(result!.files[0].outcome, 'superseded');
	assert.strictEqual(result!.files[0].submittedContent, 'v1');
});

test('a file that disappeared cannot hold a newer change', () => {
	const tracker = new SyncTracker();
	const id = tracker.newSyncId();
	tracker.submit(id, target(), [{ filePath: '/w/a.js', content: 'v1' }]);
	assert.strictEqual(tracker.resolve(id, true, disk({}))!.files[0].outcome, 'confirmed');
});

test('grouped fields: each file of one save is judged on its own revision', () => {
	const tracker = new SyncTracker();
	const id = tracker.newSyncId();
	tracker.submit(id, target(['script', 'description']), [
		{ filePath: '/w/x.script.js', content: 's1' },
		{ filePath: '/w/x.description.txt', content: 'd1' },
	]);
	assert.ok(tracker.isInFlight('/w/x.description.txt'));
	const result = tracker.resolve(id, true, disk({ '/w/x.script.js': 's1', '/w/x.description.txt': 'd2' }));
	assert.deepStrictEqual(result!.files.map(f => f.outcome), ['confirmed', 'superseded']);
	assert.strictEqual(tracker.size, 0);
});

test('a failed save keeps every file of the group, whatever its revision', () => {
	const tracker = new SyncTracker();
	const id = tracker.newSyncId();
	tracker.submit(id, target(['script', 'description']), [
		{ filePath: '/w/x.script.js', content: 's1' },
		{ filePath: '/w/x.description.txt', content: 'd1' },
	]);
	const result = tracker.resolve(id, false, disk({ '/w/x.script.js': 's1', '/w/x.description.txt': 'd2' }));
	assert.deepStrictEqual(result!.files.map(f => f.outcome), ['failed', 'failed']);
});

test('stale and duplicate replies change nothing', () => {
	const tracker = new SyncTracker();
	assert.strictEqual(tracker.resolve('sync_unknown', true, disk({})), undefined);
	const id = tracker.newSyncId();
	tracker.submit(id, target(), [{ filePath: '/w/a.js', content: 'v1' }]);
	assert.ok(tracker.resolve(id, true, disk({ '/w/a.js': 'v1' })));
	assert.strictEqual(tracker.resolve(id, true, disk({ '/w/a.js': 'v1' })), undefined);
	assert.strictEqual(tracker.resolve(id, false, disk({ '/w/a.js': 'v1' })), undefined);

	// A newer save of the same file is untouched by the old syncId.
	const again = tracker.newSyncId();
	tracker.submit(again, target(), [{ filePath: '/w/a.js', content: 'v2' }]);
	assert.strictEqual(tracker.resolve(id, false, disk({ '/w/a.js': 'v2' })), undefined);
	assert.ok(tracker.isInFlight('/w/a.js'));
});

test('a timeout gives up on one save, a disconnect on all of them', () => {
	const tracker = new SyncTracker();
	const first = tracker.newSyncId();
	const second = tracker.newSyncId();
	tracker.submit(first, target(), [{ filePath: '/w/a.js', content: 'v1' }]);
	tracker.submit(second, target(['script'], 'b'.repeat(32)), [{ filePath: '/w/b.js', content: 'v1' }]);

	const expired = tracker.expire(first);
	assert.strictEqual(expired?.files[0].filePath, '/w/a.js');
	assert.strictEqual(tracker.expire(first), undefined);
	assert.strictEqual(tracker.isInFlight('/w/a.js'), false);
	assert.ok(tracker.isInFlight('/w/b.js'));
	// The late answer for an expired save is ignored.
	assert.strictEqual(tracker.resolve(first, true, disk({ '/w/a.js': 'v1' })), undefined);

	const drained = tracker.drain();
	assert.deepStrictEqual(drained.map(s => s.syncId), [second]);
	assert.strictEqual(tracker.size, 0);
	assert.strictEqual(tracker.resolve(second, true, disk({ '/w/b.js': 'v1' })), undefined);
});

test('a second write to the same record fields waits for the first answer', () => {
	const tracker = new SyncTracker();
	const id = tracker.newSyncId();
	tracker.submit(id, target(['script']), [{ filePath: '/w/a.js', content: 'v1' }]);
	assert.ok(tracker.destinationBusy(target(['script'])));
	assert.ok(tracker.destinationBusy(target([])), 'unknown fields count as the whole record');
	assert.strictEqual(tracker.destinationBusy(target(['description'])), false);
	assert.strictEqual(tracker.destinationBusy(target(['script'], 'c'.repeat(32))), false);
	assert.strictEqual(tracker.destinationBusy({ ...target(['script']), instance: 'prod' }), false);
	tracker.resolve(id, true, disk({ '/w/a.js': 'v1' }));
	assert.strictEqual(tracker.destinationBusy(target(['script'])), false);
});

test('clear forgets in-flight saves without reporting them', () => {
	const tracker = new SyncTracker();
	const id = tracker.newSyncId();
	tracker.submit(id, target(), [{ filePath: '/w/a.js', content: 'v1' }]);
	tracker.clear();
	assert.strictEqual(tracker.size, 0);
	assert.strictEqual(tracker.resolve(id, true, disk({ '/w/a.js': 'v1' })), undefined);
});

test('revisions follow the content', () => {
	assert.strictEqual(revisionOf('abc'), revisionOf('abc'));
	assert.notStrictEqual(revisionOf('abc'), revisionOf('abc '));
	assert.strictEqual(revisionOf(undefined as unknown as string), revisionOf(''));
});

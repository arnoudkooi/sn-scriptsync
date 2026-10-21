import test from 'node:test';
import assert from 'node:assert/strict';
import { recordHistoryHtml } from '../RecordHistoryView';
import { HistoryBaseline } from '../UpdateSetCompare';

const entry: HistoryBaseline = { table: 'sys_update_version', id: 'a'.repeat(32), label: '<script>alert("x")</script>', state: 'Current', date: '2026-10-21 12:00:00', author: 'A & B', link: 'https://example.com', payload: 'secret script contents' };

test('history panel escapes record metadata and does not embed script payloads or source URLs', () => {
	const html = recordHistoryHtml('<img src=x onerror=alert(1)>', [entry], entry, ['<failure>'], 'testnonce');
	assert(!html.includes('<img src=x'));
	assert(!html.includes('<script>alert'));
	assert(html.includes('&lt;script&gt;'));
	assert(html.includes('A &amp; B'));
	assert(html.includes('&lt;failure&gt;'));
	assert(!html.includes(entry.payload));
	assert(!html.includes(entry.link));
	assert(html.includes("default-src 'none'"));
	assert(html.includes("script-src 'nonce-testnonce'"));
});

test('panel explains completed preference and fallback, and keeps history accessible without a baseline', () => {
	assert(recordHistoryHtml('Record', [entry], { ...entry, completed: true }, [], 'n').includes('completed local update set'));
	assert(recordHistoryHtml('Record', [entry], entry, [], 'n').includes('newest saved record version'));
	const html = recordHistoryHtml('Record', [], undefined, [], 'n');
	assert(html.includes('No readable history entries'));
	assert(html.includes('data-action="recommended" disabled'));
	assert(html.includes('Open version history'));
	assert(html.includes('Compare selected · Pro / Trial'));
	assert(html.includes('Compare all fields · Pro / Trial'));
});

test('selection has a row highlight, explicit badge, and persistent action label', () => {
	const html = recordHistoryHtml('Record', [{...entry, current: true}], entry, [], 'n');
	assert(html.includes('<tr class="selected">'));
	assert(html.includes('Current saved version</span>'));
	assert(html.includes('>Selected</span>'));
	assert(html.includes('id="selection-label"'));
	assert(html.includes("row.classList.toggle('selected',selected)"));
	assert(html.includes('Current saved version first'));
});

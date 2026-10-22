/**
 * Conformance vectors for background script results and the retry rule.
 *
 * backgroundScript.ts is mirrored into the `snu` CLI rather than shared
 * (separate builds), so both test suites run this same table. The outputs are
 * real sys.scripts.do results, trimmed, including the runs from the
 * 2026-10-22 update set session.
 *
 * Keep this file free of imports: it is copied verbatim into packages/snu.
 */

export interface ScriptOutputVector {
	name: string;
	output: string;
	expect: {
		stdout: string;
		warnings?: string[];
		errors?: string[];
		logLines?: string[];
		executionId: string | null;
		status: 'completed' | 'failed';
	};
}

const HEADER = "[0:00:00.673] Script completed in scope global: script<HR/>Script execution history <A target='blank' HREF='sys_script_execution_history.do?sys_id=47eea1d697485f14c3e2fc90f053af06'>available here</A><HR/>";

export const SCRIPT_OUTPUT_VECTORS: ScriptOutputVector[] = [
	{
		name: 'gs.print lines with the history link',
		output: HEADER + '<PRE>*** Script: iphone17-black.jpg: attachment + 2 doc chunks<BR/>*** Script: Current update set restored to null<BR/></PRE><HR/></BODY></HTML>',
		expect: {
			stdout: 'iphone17-black.jpg: attachment + 2 doc chunks\nCurrent update set restored to null',
			logLines: [],
			executionId: '47eea1d697485f14c3e2fc90f053af06',
			status: 'completed',
		},
	},
	{
		name: 'platform log lines are separated from printed output',
		output: HEADER + '<PRE>*** Script: Previous current update set: 11226d84a56503108bb220b7a4d212b2<BR/>[CacheFlushLog] event=catalog_ui_policy, count=1, ms=0: Flushing catalog catalog_ui_policy<BR/>*** Script: Policy updated: iPhone Studio | Office collection<BR/>MetadataCustomizationEngine: entry being deleted from sys_update_xml : sys_attachment_68cf699a97485f14c3e2fc90f053af5d<BR/></PRE><HR/></BODY></HTML>',
		expect: {
			stdout: 'Previous current update set: 11226d84a56503108bb220b7a4d212b2\nPolicy updated: iPhone Studio | Office collection',
			logLines: [
				'[CacheFlushLog] event=catalog_ui_policy, count=1, ms=0: Flushing catalog catalog_ui_policy',
				'MetadataCustomizationEngine: entry being deleted from sys_update_xml : sys_attachment_68cf699a97485f14c3e2fc90f053af5d',
			],
			executionId: '47eea1d697485f14c3e2fc90f053af06',
			status: 'completed',
		},
	},
	{
		name: 'a runtime error with its location lines',
		output: HEADER + '<PRE>Evaluator: com.glide.script.RhinoEcmaError: &quot;foo&quot; is not defined.\n   script : Line(1) column(0)\n==>   1: foo();\n<BR/></PRE><HR/></BODY></HTML>',
		expect: {
			stdout: '',
			errors: ['Evaluator: com.glide.script.RhinoEcmaError: "foo" is not defined.\n   script : Line(1) column(0)\n==>   1: foo();'],
			logLines: [],
			executionId: '47eea1d697485f14c3e2fc90f053af06',
			status: 'failed',
		},
	},
	{
		name: 'dev436517 run with an undefined function (2026-10-22)',
		output: "[0:00:00.006] Script completed in scope global: script<HR/>Script execution history <A target='blank' HREF='sys_script_execution_history.do?sys_id=7b75665697009f14c3e2fc90f053afa0'>available here</A><HR/><PRE>*** Script: before<BR/>Script execution error: Script Identifier: null.null.script, Error Description: &quot;undefinedFunctionXyz&quot; is not defined., Script ES Level: 0<BR/>Evaluator: com.glide.script.RhinoEcmaError: &quot;undefinedFunctionXyz&quot; is not defined.\n   script : Line(2) column(0)\n      1: gs.print(&quot;before&quot;);\n==&gt;   2: undefinedFunctionXyz();\n Stack trace:\n\tat null.null.script:2\n<BR/></PRE><HR/></BODY></HTML>",
		expect: {
			stdout: 'before',
			errors: [
				'Script execution error: Script Identifier: null.null.script, Error Description: "undefinedFunctionXyz" is not defined., Script ES Level: 0',
				'Evaluator: com.glide.script.RhinoEcmaError: "undefinedFunctionXyz" is not defined.\n   script : Line(2) column(0)\n      1: gs.print("before");\n==>   2: undefinedFunctionXyz();\n Stack trace:\n\tat null.null.script:2',
			],
			logLines: [],
			executionId: '7b75665697009f14c3e2fc90f053afa0',
			status: 'failed',
		},
	},
	{
		name: 'output printed before an error is kept',
		output: HEADER + '<PRE>*** Script: step 1<BR/>Javascript compiler exception: missing ; before statement (null.null.script; line 2) in:<BR/></PRE>',
		expect: {
			stdout: 'step 1',
			errors: ['Javascript compiler exception: missing ; before statement (null.null.script; line 2) in:'],
			executionId: '47eea1d697485f14c3e2fc90f053af06',
			status: 'failed',
		},
	},
	{
		name: 'warnings',
		output: HEADER + '<PRE>Security restricted: Read operation on table \'sys_user\' from scope \'x_app\' was denied<BR/>*** Script: done<BR/></PRE>',
		expect: {
			stdout: 'done',
			warnings: ["Security restricted: Read operation on table 'sys_user' from scope 'x_app' was denied"],
			executionId: '47eea1d697485f14c3e2fc90f053af06',
			status: 'completed',
		},
	},
	{
		name: 'entities in printed values are decoded',
		output: '<PRE>*** Script: a &lt;b&gt; &amp; &#39;c&#39;<BR/></PRE>',
		expect: { stdout: "a <b> & 'c'", executionId: null, status: 'completed' },
	},
	{
		name: 'plain text without markup',
		output: '*** Script: hello',
		expect: { stdout: 'hello', logLines: [], executionId: null, status: 'completed' },
	},
	{
		name: 'empty output',
		output: '',
		expect: { stdout: '', warnings: [], errors: [], logLines: [], executionId: null, status: 'completed' },
	},
];

export interface NotStartedVector {
	name: string;
	reply: any;
	/** The script provably did not run. */
	notStarted: boolean;
	/** A session-token refresh and one more run are allowed. */
	retry: boolean;
}

export const NOT_STARTED_VECTORS: NotStartedVector[] = [
	{ name: 'helper E_UNAUTHORIZED with notStarted', reply: { success: false, code: 'E_UNAUTHORIZED', details: { notStarted: true } }, notStarted: true, retry: true },
	{ name: 'older helper E_UNAUTHORIZED (pre-execution refusal)', reply: { success: false, code: 'E_UNAUTHORIZED', error: 'not authorized' }, notStarted: true, retry: true },
	{ name: 'bare not authorized page text', reply: { success: true, output: '  Not Authorized \n' }, notStarted: true, retry: true },
	{ name: 'blocked gate never ran but a token does not help', reply: { success: false, code: 'E_DISABLED', details: { notStarted: true } }, notStarted: true, retry: false },
	{ name: 'missing token never ran, no auth code', reply: { success: false, error: 'Missing instance authentication token', details: { notStarted: true } }, notStarted: true, retry: false },
	{ name: 'E_ACL without proof', reply: { success: false, code: 'E_ACL', error: 'User not authorized' }, notStarted: false, retry: false },
	{ name: 'message mentions authorization but no code', reply: { success: false, error: 'not authorized to read table' }, notStarted: false, retry: false },
	{ name: 'inferred token code', reply: { success: false, code: 'E_TOKEN_EXPIRED', error: 'auth failed' }, notStarted: false, retry: false },
	{ name: 'timeout', reply: { success: false, code: 'E_TIMEOUT' }, notStarted: false, retry: false },
	{ name: 'output that merely contains the words', reply: { success: true, output: '*** Script: user not authorized for x' }, notStarted: false, retry: false },
	{ name: 'an explicit notStarted: false wins over the code', reply: { success: false, code: 'E_UNAUTHORIZED', details: { notStarted: false } }, notStarted: false, retry: false },
	{ name: 'no reply', reply: null, notStarted: false, retry: false },
];

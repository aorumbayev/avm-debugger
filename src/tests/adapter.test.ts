/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as Path from 'path';
import * as fs from 'fs';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import { TEALDebuggingAssets } from '../debugAdapter/utils';
import { BasicServer } from '../debugAdapter/basicServer';
import { FileAccessor } from '../debugAdapter/txnGroupWalkerRuntime';

export const testFileAccessor: FileAccessor = {
	isWindows: typeof process !== 'undefined' && process.platform === 'win32',
	async readFile(path: string): Promise<Uint8Array> {
		return fs.readFileSync(path);
	},
	async writeFile(path: string, contents: Uint8Array) {
		return fs.writeFileSync(path, contents);
	}
};

async function assertVariables(dc: DebugClient, {
	stack,
}: {
	stack: string[],
}) {
	const scopesResponse = await dc.scopesRequest({ frameId: 0 });
	assert.ok(scopesResponse.success);
	const scopes = scopesResponse.body.scopes;

	const executionScope = scopes.find(scope => scope.name === 'Execution State');
	assert.ok(executionScope);

	const executionScopeResponse = await dc.variablesRequest({ variablesReference: executionScope.variablesReference });
	assert.ok(executionScopeResponse.success);
	const executionScopeVariables = executionScopeResponse.body.variables;

	const stackParentVariable = executionScopeVariables.find(variable => variable.name === 'stack');
	assert.ok(stackParentVariable);

	const stackVariableResponse = await dc.variablesRequest({ variablesReference: stackParentVariable.variablesReference });
	assert.ok(stackVariableResponse.success);
	const stackVariables = stackVariableResponse.body.variables;

	assert.strictEqual(stackVariables.length, stack.length);

	for (let i = 0; i < stack.length; i++) {
		assert.strictEqual(stackVariables[0].name, i.toString());
		assert.strictEqual(stackVariables[0].value, stack[i]);
	}
}

async function advanceTo(dc: DebugClient, args: { program: string, line: number, column?: number} ) {
	const breakpointResponse = await dc.setBreakpointsRequest({
		source: { path: args.program },
		breakpoints: [{
			line: args.line,
			column: args.column
		}],
	});
	assert.ok(breakpointResponse.success);
	assert.strictEqual(breakpointResponse.body.breakpoints.length, 1);
	const bp = breakpointResponse.body.breakpoints[0];
	assert.ok(bp.verified);

	const continueResponse = await dc.continueRequest({ threadId: 0 });
	assert.ok(continueResponse.success);

	await dc.assertStoppedLocation('breakpoint', { path: args.program, line: args.line, column: args.column });
}

async function assertEvaluationEquals(dc: DebugClient, expression: string, expectedValue: string) {
	const response = await dc.evaluateRequest({ expression });
	assert.ok(response.success);
	assert.strictEqual(response.body.result, expectedValue, `Expected "${expression}" to evaluate to "${expectedValue}", but got "${response.body.result}"`);
}

suite('Node Debug Adapter', () => {

	const DEBUG_ADAPTER = './out/debugAdapter.js';

	const PROJECT_ROOT = Path.join(__dirname, '../../');
	const DATA_ROOT = Path.join(PROJECT_ROOT, 'src/tests/data/');


	let server: BasicServer;
	let dc: DebugClient;

	setup( async () => {
		const debugAssets: TEALDebuggingAssets = await TEALDebuggingAssets.loadFromFiles(
			testFileAccessor,
			Path.join(DATA_ROOT, 'local-state-changes-resp.json'),
			Path.join(DATA_ROOT, 'state-changes-sources.json')
		);
		server = new BasicServer(testFileAccessor, debugAssets);

		dc = new DebugClient('node', DEBUG_ADAPTER, 'teal');
		await dc.start(server.port());
	});

	teardown( () => {
		dc.stop();
		server.dispose();
	});


	suite('basic', () => {

		test('unknown request should produce error', done => {
			dc.send('illegal_request').then(() => {
				done(new Error("does not report error on unknown request"));
			}).catch(() => {
				done();
			});
		});
	});

	suite('initialize', () => {

		test('should return supported features', () => {
			return dc.initializeRequest().then(response => {
				response.body = response.body || {};
				assert.strictEqual(response.body.supportsConfigurationDoneRequest, true);
			});
		});

		test('should produce error for invalid \'pathFormat\'', done => {
			dc.initializeRequest({
				adapterID: 'teal',
				linesStartAt1: true,
				columnsStartAt1: true,
				pathFormat: 'url'
			}).then(response => {
				done(new Error("does not report error on invalid 'pathFormat' attribute"));
			}).catch(err => {
				// error expected
				done();
			});
		});
	});

	suite('launch', () => {

		test('should run program to the end', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'state-changes.teal');

			return Promise.all([
				dc.configurationSequence(),
				dc.launch({ program: PROGRAM }),
				dc.waitForEvent('terminated')
			]);
		});

		test('should stop on entry', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'state-changes.teal');
			const ENTRY_LINE = 1;

			return Promise.all([
				dc.configurationSequence(),
				dc.launch({ program: PROGRAM, stopOnEntry: true }),
				dc.assertStoppedLocation('entry', { line: ENTRY_LINE } )
			]);
		});
	});

	suite('setBreakpoints', () => {

		test('should stop on a breakpoint', () => {

			const PROGRAM = Path.join(DATA_ROOT, 'state-changes.teal');
			const BREAKPOINT_LINE = 2;

			return dc.hitBreakpoint({ program: PROGRAM }, { path: PROGRAM, line: BREAKPOINT_LINE });
		});
	});

	suite('evaluation', () => {

		test('should return variables', async () => {
			const PROGRAM = Path.join(DATA_ROOT, 'state-changes.teal');
			const BREAKPOINT_LINE = 3;

			await dc.hitBreakpoint({ program: PROGRAM }, { path: PROGRAM, line: BREAKPOINT_LINE });

			await assertEvaluationEquals(dc, 'stack[0]', '1054');

			await advanceTo(dc, { program: PROGRAM, line: 14 });

			await assertEvaluationEquals(dc, 'stack[0]', '0x8e169311');
			await assertEvaluationEquals(dc, 'stack[1]', '0x8913c1f8');
			await assertEvaluationEquals(dc, 'stack[2]', '0xd513c44e');
			await assertEvaluationEquals(dc, 'stack[3]', '0x8e169311');

			await advanceTo(dc, { program: PROGRAM, line: 25 });

			await assertEvaluationEquals(dc, 'stack[-1]', '0x' + Buffer.from('xqcL').toString('hex'));
			await assertEvaluationEquals(dc, 'stack[-2]', '0x' + Buffer.from('local-bytes-key').toString('hex'));
		});
	});
});

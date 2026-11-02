import {test} from 'node:test';
import assert from 'node:assert/strict';
import {availableShortcutGroups,resolveBuiltinGroup} from './builtinShortcutGroups.ts';
import type { ShortcutGroup } from './shortcutGroupStore.ts';
import {relativeOperationPath,parseFileOperationResponse} from './fileOperations.ts';

test('built-in groups exist without mutating persisted groups and resolve on the selected target',()=>{
 const custom: ShortcutGroup[]=[];const groups=availableShortcutGroups(custom,'remote','Install');
 assert.equal(custom.length,0);assert.equal(groups.length,3);
 for(const group of groups){const resolved=resolveBuiltinGroup(group,'linux','bash');assert.ok(resolved.steps.length>0);assert.equal(group.steps.length,0);assert.equal(resolved.deviceKey,'remote');}
 assert.throws(()=>resolveBuiltinGroup(groups[0],'win32','bash'),/UNSUPPORTED_SHELL/);
});
test('file operation paths cannot escape either platform root',()=>{
 assert.equal(relativeOperationPath('/workspace','/workspace/notes/a.md'),'notes/a.md');
 assert.equal(relativeOperationPath('C:\\workspace','C:\\workspace\\notes\\a.md'),'notes/a.md');
 assert.throws(()=>relativeOperationPath('/workspace','/workspace-other/file'),/OUTSIDE_ROOT/);
 assert.throws(()=>relativeOperationPath('C:\\workspace','D:\\notes'),/OUTSIDE_ROOT/);
 assert.throws(()=>parseFileOperationResponse({status:'success',mutationVersion:2}));
});

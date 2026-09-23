import {test} from 'node:test';
import assert from 'node:assert/strict';
import {feedbackLink} from './feedbackLink.ts';
test('feedback URL retains only explicitly permitted context',()=>{
 const url=new URL(feedbackLink('https://example.com/feedback?device=private#secret','2.1.0','zh-CN'));
 assert.deepEqual([...url.searchParams.keys()],['pluginVersion','lang']);assert.equal(url.hash,'');
 assert.throws(()=>feedbackLink('http://example.com','2.1','en'));
 assert.throws(()=>feedbackLink('https://user:password@example.com','2.1','en'));
});

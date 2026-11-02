import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FEEDBACK_URL, feedbackLink} from './feedbackLink.ts';
test('feedback URL retains only explicitly permitted context',()=>{
 const url=new URL(feedbackLink('https://example.com/feedback?device=private#secret','2.1.0','zh-CN'));
 assert.deepEqual([...url.searchParams.keys()],['pluginVersion','lang']);assert.equal(url.hash,'');
 assert.throws(()=>feedbackLink('http://example.com','2.1','en'));
 assert.throws(()=>feedbackLink('https://user:password@example.com','2.1','en'));
});

test('fixed feedback endpoint supports HTTP without allowing arbitrary HTTP hosts', () => {
 const url = new URL(feedbackLink(FEEDBACK_URL, '2.1.0', 'zh-CN'));
 assert.equal(url.origin, 'http://cyber-bike.duckdns.org:3000');
 assert.equal(url.pathname, '/feedback');
 assert.equal(url.searchParams.get('pluginVersion'), '2.1.0');
 assert.equal(url.searchParams.get('lang'), 'zh-CN');
 assert.throws(() => feedbackLink('http://cyber-bike.duckdns.org:3001/', '2.1', 'en'));
 assert.throws(() => feedbackLink('javascript:alert(1)', '2.1', 'en'));
});

test('feedback URL carries the local OS without retaining unrelated parameters', () => {
 const url = new URL(feedbackLink('https://example.com/feedback?device=private&os=old', '2.1.0', 'en', 'linux'));
 assert.equal(url.searchParams.get('os'), 'linux');
 assert.deepEqual([...url.searchParams.keys()], ['pluginVersion', 'lang', 'os']);
});

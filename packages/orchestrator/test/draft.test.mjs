import test from 'node:test';
import assert from 'node:assert/strict';
import { documentDraftPrompt } from '../src/draft.mjs';

test('keeps generated documents in an explicit unapproved review state', () => {
  const requirement = documentDraftPrompt({ kind: 'requirement', source: 'Add a health endpoint' });
  assert.equal(requirement.role, 'requirements-analyst');
  assert.match(requirement.instructions, /Do not claim approval/);
  const cases = documentDraftPrompt({ kind: 'test-case', source: '# FR-001' });
  assert.equal(cases.role, 'test-designer');
  assert.match(cases.instructions, /traceability/);
});

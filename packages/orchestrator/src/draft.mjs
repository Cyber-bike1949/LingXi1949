export function documentDraftPrompt({ kind, source }) {
  if (!['requirement', 'test-case'].includes(kind)) throw new Error('INVALID_DRAFT_KIND');
  const instructions = kind === 'requirement'
    ? 'Produce Markdown only. Turn the raw request into a reviewable requirement document with scope, non-goals, FR identifiers, acceptance criteria identifiers, risks, assumptions, and open questions. Do not claim approval.'
    : 'Produce Markdown only. Derive a reviewable test-case document from the approved requirement. Include requirement/acceptance-criterion traceability, preconditions, test steps, expected results, priority, regression scope, and explicit environment risks. Do not change the requirement or claim approval.';
  return { role: kind === 'requirement' ? 'requirements-analyst' : 'test-designer', instructions, source, requiredOutput: 'Markdown document only' };
}

const requiredNodes = ['prepare-worktree', 'develop', 'git-verify', 'prepare-test-worktree', 'test', 'local-verify', 'ci', 'e2e', 'rc-build'];

export function evaluateRcGate({ nodes, workflows }) {
  const missingNodes = requiredNodes.filter(kind => !nodes.some(node => node.kind === kind && node.state === 'SUCCEEDED'));
  const failedNodes = nodes.filter(node => requiredNodes.includes(node.kind) && node.state === 'FAILED').map(node => node.kind);
  const incompleteWorkflows = workflows.filter(run => run.status !== 'completed' || run.conclusion !== 'success').map(run => ({ name: run.name, runId: run.runId, status: run.status, conclusion: run.conclusion }));
  return { passed: missingNodes.length === 0 && failedNodes.length === 0 && incompleteWorkflows.length === 0, missingNodes, failedNodes, incompleteWorkflows };
}

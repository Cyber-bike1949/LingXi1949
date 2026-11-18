const dependencies = {
  'prepare-worktree': [],
  develop: ['prepare-worktree'],
  'git-verify': ['develop'],
  'prepare-test-worktree': ['git-verify'],
  test: ['prepare-test-worktree'],
  'local-verify': ['test'],
  ci: ['local-verify'],
  e2e: ['local-verify'],
  'rc-build': ['ci', 'e2e'],
  rc: ['rc-build'],
};

export function retryKinds(from, nodes) {
  const available = new Set(nodes.map(node => node.kind));
  if (!available.has(from)) throw new Error('RETRY_NODE_NOT_FOUND');
  const reset = new Set([from]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const kind of available) {
      if (!reset.has(kind) && (dependencies[kind] ?? []).some(parent => reset.has(parent))) {
        reset.add(kind); changed = true;
      }
    }
  }
  return [...reset];
}

export function nextNodes(nodes) {
  const byKind = new Map(nodes.map(node => [node.kind, node]));
  return nodes.filter(node => node.state === 'PENDING' && (dependencies[node.kind] ?? []).every(kind => byKind.get(kind)?.state === 'SUCCEEDED'));
}

export function blockedBy(nodes) {
  const byKind = new Map(nodes.map(node => [node.kind, node]));
  return nodes.filter(node => node.state === 'PENDING').map(node => ({ kind: node.kind, waitingFor: (dependencies[node.kind] ?? []).filter(kind => byKind.get(kind)?.state !== 'SUCCEEDED') }));
}

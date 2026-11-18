export function preflightPlan({ project, runtime }) {
  const remoteNames = Object.entries(runtime.remotes).map(([role, remote]) => ({ role, session: remote.session, cli: remote.lingxiCli, shellKind: remote.shellKind, repositoryRoot: remote.repositoryRoot }));
  const agentNames = [
    { role: 'developer', ...runtime.agent, remote: runtime.remotes.development },
    { role: 'tester', ...runtime.tester, remote: runtime.remotes.test }
  ];
  return {
    repository: project.repository,
    remotes: remoteNames,
    agents: agentNames.map(agent => ({ role: agent.role, target: agent.target, executable: agent.executable })),
    workflows: [...runtime.workflows.required, ...(runtime.workflows.e2eRequired ?? []), ...runtime.workflows.rc.required]
  };
}

export function safeSummary(result) {
  return { exitCode: result.exitCode, stdout: String(result.stdout ?? '').trim().slice(0, 500), stderr: String(result.stderr ?? '').trim().slice(0, 500) };
}

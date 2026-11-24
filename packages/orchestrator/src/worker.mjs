const runnableStates = new Set(['TEST_CASES_APPROVED', 'IMPLEMENTING', 'LOCAL_VERIFYING', 'CI_VERIFYING', 'FIXING', 'RC_BUILDING']);

export function runnableTasks(tasks, { autoRelease = false } = {}) {
  const states = autoRelease ? new Set([...runnableStates, 'RC_READY', 'RELEASE_APPROVED', 'RELEASE_TRIGGERED']) : runnableStates;
  return tasks.filter(task => states.has(task.state));
}

export function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

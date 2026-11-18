const runnableStates = new Set(['TEST_CASES_APPROVED', 'IMPLEMENTING', 'LOCAL_VERIFYING', 'CI_VERIFYING', 'FIXING', 'RC_BUILDING']);

export function runnableTasks(tasks) { return tasks.filter(task => runnableStates.has(task.state)); }

export function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function createResourceSafety({ warn = console.warn } = {}) {
  const restartCounts = new Map();
  let apiUnavailable = false;
  return function check(row) {
    if (row.type === 'container_change' && !row.services.includes('api')) {
      if (!apiUnavailable) warn('API container is absent; benchmark continues');
      apiUnavailable = true;
    }
    if (row.type !== 'health') return null;
    if (row.oom_killed) return `Container ${row.service} reported OOM`;
    if (restartCounts.has(row.service) && row.restart_count > restartCounts.get(row.service)) {
      return `Container ${row.service} restarted during the run`;
    }
    restartCounts.set(row.service, row.restart_count);
    if (row.service === 'api') {
      const unavailable = row.status !== 'running' || row.health === 'unhealthy';
      if (unavailable && !apiUnavailable) warn('API is unhealthy; benchmark continues');
      if (!unavailable && apiUnavailable) warn('API recovered');
      apiUnavailable = unavailable;
    }
    return null;
  };
}
module.exports = { createResourceSafety };

export function areJobsTerminal(jobs) {
  return jobs.length > 0 && jobs.every((job) => job.status === "completed" || job.status === "failed");
}

export function startBatchPolling({ fetchBatch, onUpdate, onError, intervalMs = 1200, schedule = setTimeout, cancel = clearTimeout }) {
  let stopped = false;
  let timer = null;

  const stop = () => {
    stopped = true;
    if (timer !== null) cancel(timer);
    timer = null;
  };

  const poll = async () => {
    try {
      const batch = await fetchBatch();
      if (stopped) return;
      onUpdate(batch);
      if (areJobsTerminal(batch.jobs)) {
        stop();
        return;
      }
    } catch (error) {
      if (stopped) return;
      onError(error);
    }

    if (!stopped) timer = schedule(poll, intervalMs);
  };

  void poll();
  return stop;
}

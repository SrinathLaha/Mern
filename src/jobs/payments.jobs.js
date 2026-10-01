export function createPaymentJobs(
  service,
  {
    intervalMs = 30000,
    onError = () =>
      console.error("Payment reconciliation failed; durable work will retry."),
  } = {},
) {
  let running = null,
    closed = false;
  function sweep() {
    if (closed || running) return running ?? Promise.resolve();
    running = service
      .sweep()
      .catch(onError)
      .finally(() => {
        running = null;
      });
    return running;
  }
  const timer = setInterval(() => {
    void sweep();
  }, intervalMs);
  timer.unref();
  void sweep();
  return {
    async close() {
      closed = true;
      clearInterval(timer);
      if (running) await running;
    },
  };
}

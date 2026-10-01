// This bounded local queue keeps account lookup and email latency out of HTTP responses.
// It is deliberately in-memory; durable delivery/retries belong to the jobs milestone.
export function createRecoveryJobs(
  worker,
  {
    concurrency = 2,
    capacity = 100,
    onError = () => console.error("Password recovery delivery failed."),
  } = {},
) {
  const pending = [];
  const waiters = [];
  const activeEmails = new Set();
  let active = 0;
  let closed = false;
  function pump() {
    while (active < concurrency && pending.length) {
      const index = pending.findIndex((email) => !activeEmails.has(email));
      if (index === -1) break;
      const [email] = pending.splice(index, 1);
      activeEmails.add(email);
      active++;
      Promise.resolve()
        .then(() => worker(email))
        .catch(() => onError())
        .finally(() => {
          active--;
          activeEmails.delete(email);
          pump();
          if (!active && !pending.length)
            waiters.splice(0).forEach((resolve) => resolve());
        });
    }
  }
  return {
    enqueue(email) {
      if (closed || active + pending.length >= capacity) return false;
      pending.push(email);
      setImmediate(pump);
      return true;
    },
    idle() {
      return active || pending.length
        ? new Promise((resolve) => waiters.push(resolve))
        : Promise.resolve();
    },
    close() {
      closed = true;
      return this.idle();
    },
  };
}

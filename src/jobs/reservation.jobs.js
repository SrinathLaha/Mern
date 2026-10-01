import { expireOrders } from "../services/orders.service.js";
// Every transition is transactional and idempotent, including overlapping processes.
export function createReservationJobs({
  intervalMs = 30000,
  onError = () =>
    console.error("Reservation expiry sweep failed; it will retry."),
} = {}) {
  let running = null,
    closed = false;
  function sweep() {
    if (closed || running) return running ?? Promise.resolve();
    running = expireOrders()
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

import { attachRealtime } from "./realtime/realtime.js";
import { createPaymentJobs } from "./jobs/payments.jobs.js";
import { createReservationJobs } from "./jobs/reservation.jobs.js";
import mongoose from "mongoose";
import { createApp } from "./app.js";
import { readConfig } from "./config/env.js";
import { connectDatabase } from "./config/database.js";

const config = readConfig();
await connectDatabase(config.mongodbUri);
const app = createApp(config);
const reservationJobs = createReservationJobs();
const paymentJobs = createPaymentJobs(app.locals.paymentService);
const server = app.listen(config.port, config.host, () =>
  console.info(`API ready at http://${config.host}:${config.port}`),
);
const realtime = attachRealtime(server, config);
let closePromise;
function close() {
  closePromise ??= (async () => {
    // Disconnect long-polling and WebSocket clients before closing MongoDB.
    await realtime.close();
    await reservationJobs.close();
    await paymentJobs.close();
    await app.locals.recoveryJobs.close();
    await mongoose.disconnect();
  })();
  return closePromise;
}
server.on("error", async () => {
  console.error("API could not start. Check the port and host configuration.");
  process.exitCode = 1;
  await close();
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
    setTimeout(() => process.exit(1), 10000).unref();
  });

import { Server } from "socket.io";
import { authenticateAccessToken } from "../middleware/authenticate.js";
import { Order } from "../models/order.model.js";

const orderRoom = (orderId) => `order:${orderId}`;
const deniedMessage = "This order is not available to your account.";

async function authorizeOrder(token, orderId, config) {
  const user = await authenticateAccessToken(token, config);
  let ownership;
  if (user.role === "customer") ownership = { customerId: user._id };
  else if (user.role === "seller" && user.sellerStatus === "approved")
    ownership = { "groups.sellerId": String(user._id) };
  else throw new Error(deniedMessage);
  if (!(await Order.exists({ _id: orderId, ...ownership })))
    throw new Error(deniedMessage);
}

export function attachRealtime(
  server,
  config,
  {
    authCheckIntervalMs = 15000,
    authCheckBatchSize = 50,
    reconnectDelayMs = 1000,
    watchOrders = () => Order.watch([], { maxAwaitTimeMS: 1000 }),
  } = {},
) {
  const io = new Server(server, {
    path: "/api/realtime/socket.io",
    serveClient: false,
    maxHttpBufferSize: 16384,
    connectTimeout: 10000,
    cors: { origin: config.frontendOrigin },
    allowRequest: (req, done) =>
      done(null, req.headers.origin === config.frontendOrigin),
  });
  // Unlike CORS alone, this also rejects WebSocket upgrades and subsequent polls.
  io.engine.use((req, _res, next) => {
    next(
      req.headers.origin === config.frontendOrigin
        ? undefined
        : new Error("Origin is not allowed."),
    );
  });
  let closing = false,
    closePromise,
    stream,
    reconnectTimer,
    checkTimer;
  let checking = Promise.resolve(),
    draining = Promise.resolve();
  let checkRunning = false,
    drainRunning = false;
  let socketCursor = io.sockets.sockets.values();
  const pendingOrders = new Set();
  const retiringStreams = new Set();

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== "string" || token.length > 8192) throw new Error();
      await authenticateAccessToken(token, config);
      if (closing) throw new Error();
      socket.data.token = token;
      socket.data.subscriptionVersion = 0;
      next();
    } catch {
      next(new Error("Please sign in again."));
    }
  });
  io.on("connection", (socket) => {
    socket.on("order:subscribe", async (payload, acknowledge) => {
      if (typeof acknowledge !== "function") return;
      const version = ++socket.data.subscriptionVersion;
      const former = socket.data.orderId;
      socket.data.orderId = null;
      if (former) await socket.leave(orderRoom(former));
      try {
        if (
          !payload ||
          typeof payload !== "object" ||
          Array.isArray(payload) ||
          Object.keys(payload).length !== 1 ||
          typeof payload.orderId !== "string" ||
          !/^[a-f0-9]{24}$/.test(payload.orderId)
        )
          throw new Error();
        await authorizeOrder(socket.data.token, payload.orderId, config);
        if (
          closing ||
          !socket.connected ||
          version !== socket.data.subscriptionVersion
        )
          throw new Error();
        socket.data.orderId = payload.orderId;
        await socket.join(orderRoom(payload.orderId));
        acknowledge({ ok: true });
      } catch {
        acknowledge({ ok: false, message: deniedMessage });
      }
    });
  });

  async function deliver(socket, orderId) {
    const version = socket.data.subscriptionVersion;
    try {
      await authorizeOrder(socket.data.token, orderId, config);
      if (
        !closing &&
        socket.connected &&
        socket.data.orderId === orderId &&
        socket.data.subscriptionVersion === version
      )
        socket.emit("order:updated", { orderId });
    } catch {
      socket.disconnect(true);
    }
  }
  function invalidate(orderId) {
    if (closing || !io.sockets.adapter.rooms.has(orderRoom(orderId))) return;
    pendingOrders.add(orderId);
    if (drainRunning) return;
    drainRunning = true;
    draining = (async () => {
      while (!closing && pendingOrders.size) {
        const nextOrder = pendingOrders.values().next().value;
        pendingOrders.delete(nextOrder);
        const members = [
          ...(io.sockets.adapter.rooms.get(orderRoom(nextOrder)) ?? []),
        ];
        // Bound database work even when one popular order has many connected viewers.
        for (
          let offset = 0;
          offset < members.length && !closing;
          offset += 10
        ) {
          await Promise.all(
            members.slice(offset, offset + 10).map((id) => {
              const socket = io.sockets.sockets.get(id);
              return socket ? deliver(socket, nextOrder) : undefined;
            }),
          );
        }
      }
    })().finally(() => {
      drainRunning = false;
    });
  }
  function catchUp() {
    for (const socket of io.sockets.sockets.values())
      if (socket.data.orderId) invalidate(socket.data.orderId);
  }
  function retire(current) {
    const result = Promise.resolve()
      .then(() => current.close())
      .catch(() => {});
    retiringStreams.add(result);
    result.finally(() => retiringStreams.delete(result));
    return result;
  }
  function openStream() {
    if (closing) return;
    let current;
    let failed = false;
    const failure = () => {
      if (closing || failed) return;
      failed = true;
      stream = null;
      // No event data or driver error messages enter logs or client payloads.
      const closed = current ? retire(current) : Promise.resolve();
      closed.then(() => {
        if (!closing) {
          reconnectTimer = setTimeout(openStream, reconnectDelayMs);
          reconnectTimer.unref();
        }
      });
    };
    try {
      current = watchOrders();
      stream = current;
      // A fresh stream may miss events during an outage: refetch every owned room.
      current.once("resumeTokenChanged", () => {
        if (!failed) catchUp();
      });
      current.on("change", (event) => {
        if (!failed && event.documentKey?._id)
          invalidate(String(event.documentKey._id));
      });
      current.on("error", failure);
      current.on("close", failure);
      current.on("end", failure);
    } catch {
      failure();
    }
  }
  async function checkSocket(socket) {
    try {
      const user = await authenticateAccessToken(socket.data.token, config);
      if (user.role === "seller" && user.sellerStatus !== "approved")
        throw new Error();
    } catch {
      socket.disconnect(true);
    }
  }
  checkTimer = setInterval(() => {
    if (closing || checkRunning) return;
    const batch = [];
    for (let i = 0; i < authCheckBatchSize; i++) {
      let entry = socketCursor.next();
      if (entry.done) {
        socketCursor = io.sockets.sockets.values();
        if (batch.length) break;
        entry = socketCursor.next();
      }
      if (entry.done) break;
      batch.push(entry.value);
    }
    checkRunning = true;
    checking = Promise.all(batch.map(checkSocket)).finally(() => {
      checkRunning = false;
    });
  }, authCheckIntervalMs);
  checkTimer.unref();
  openStream();

  return {
    close() {
      closePromise ??= (async () => {
        closing = true;
        clearInterval(checkTimer);
        clearTimeout(reconnectTimer);
        pendingOrders.clear();
        if (stream) retire(stream);
        await Promise.all([checking, draining, ...retiringStreams]);
        await new Promise((resolve) => io.close(resolve));
      })();
      return closePromise;
    },
  };
}

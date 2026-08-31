import "dotenv/config";
import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeSquareClient } from "./square.js";
import { ordersToTickets, nextState } from "./tickets.js";
import { createDemoStore } from "./demo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const LOCATION_IDS = (process.env.SQUARE_LOCATION_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const hasSquareCreds = Boolean(process.env.SQUARE_ACCESS_TOKEN) && LOCATION_IDS.length > 0;
const DEMO_MODE = !hasSquareCreds;

if (!hasSquareCreds && process.env.SQUARE_ACCESS_TOKEN && LOCATION_IDS.length === 0) {
  console.warn(
    "[square-kds] SQUARE_ACCESS_TOKEN is set but SQUARE_LOCATION_IDS is empty — falling back to demo mode. Set SQUARE_LOCATION_IDS in .env."
  );
}

const square = hasSquareCreds
  ? makeSquareClient({
      accessToken: process.env.SQUARE_ACCESS_TOKEN,
      environment: (process.env.SQUARE_ENVIRONMENT || "sandbox").toLowerCase(),
    })
  : null;

const demo = DEMO_MODE ? createDemoStore() : null;

// Latest known snapshot of tickets, keyed by ticket id ("orderId:fulfillmentUid").
// This is what gets sent to newly-connected clients and diffed each poll.
let ticketsById = new Map();

function snapshot() {
  return Array.from(ticketsById.values()).sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
  );
}

// ---- WebSocket broadcast ----

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "snapshot", tickets: snapshot(), mode: DEMO_MODE ? "demo" : "live" }));
});

// ---- Polling loop (live mode) / tick loop (demo mode) ----

async function pollSquare() {
  try {
    const orders = await square.searchOpenOrders(LOCATION_IDS);
    const fresh = ordersToTickets(orders);
    ticketsById = new Map(fresh.map((t) => [t.id, t]));
    broadcast({ type: "snapshot", tickets: snapshot(), mode: "live" });
  } catch (err) {
    console.error("[square-kds] poll failed:", err.message);
    broadcast({ type: "error", message: "Lost connection to Square — retrying…" });
  }
}

function pollDemo() {
  ticketsById = new Map(demo.list().map((t) => [t.id, t]));
  broadcast({ type: "snapshot", tickets: snapshot(), mode: "demo" });
}

const tick = DEMO_MODE ? pollDemo : pollSquare;
tick();
setInterval(tick, DEMO_MODE ? 4000 : POLL_INTERVAL_MS);

// ---- REST API ----

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    mode: DEMO_MODE ? "demo" : "live",
    locationCount: LOCATION_IDS.length,
    pollIntervalMs: POLL_INTERVAL_MS,
  });
});

app.get("/api/tickets", (req, res) => {
  res.json({ tickets: snapshot(), mode: DEMO_MODE ? "demo" : "live" });
});

app.post("/api/tickets/:id/bump", async (req, res) => {
  const { id } = req.params;

  if (DEMO_MODE) {
    const result = demo.bump(id);
    if (!result.ok) return res.status(400).json(result);
    pollDemo();
    return res.json({ ok: true });
  }

  const ticket = ticketsById.get(id);
  if (!ticket) return res.status(404).json({ ok: false, error: "not_found" });

  const target = nextState(ticket.state);
  if (!target) return res.status(400).json({ ok: false, error: "already_complete" });

  try {
    await square.updateFulfillmentState({
      orderId: ticket.orderId,
      locationId: ticket.locationId,
      version: ticket.version,
      fulfillmentUid: ticket.fulfillmentUid,
      newState: target,
    });
    await pollSquare();
    res.json({ ok: true });
  } catch (err) {
    console.error("[square-kds] bump failed:", err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

httpServer.listen(PORT, () => {
  console.log(`[square-kds] listening on http://localhost:${PORT}`);
  console.log(`[square-kds] mode: ${DEMO_MODE ? "DEMO (fake orders)" : "LIVE (Square API, polling every " + POLL_INTERVAL_MS + "ms)"}`);
});

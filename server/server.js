import "dotenv/config";
import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
 
import { makeSquareClient } from "./square.js";
import { ordersToTickets, nextState } from "./tickets.js";
import { createDemoStore } from "./demo.js";
import { verifySquareSignature, debounce } from "./webhook.js";
 
const __dirname = path.dirname(fileURLToPath(import.meta.url));
 
const PORT = Number(process.env.PORT || 3000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const LOCATION_IDS = (process.env.SQUARE_LOCATION_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
 
// Optional — enables real-time push instead of relying solely on polling.
// Both must match exactly what you registered in the Square Developer
// Dashboard's Webhooks page for the subscription to verify. See README §4.
const WEBHOOK_SIGNATURE_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || "";
const WEBHOOK_URL = process.env.SQUARE_WEBHOOK_URL || "";
const WEBHOOKS_ENABLED = Boolean(WEBHOOK_SIGNATURE_KEY && WEBHOOK_URL);
 
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
// Stash the raw request bytes alongside the parsed body — Square's webhook
// signature is computed over the exact raw bytes, not the re-serialized JSON.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
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
// With webhooks enabled this interval is just a safety net (catches any
// missed delivery), so it's fine for it to be much slower than the default —
// override via POLL_INTERVAL_MS if you want to relax it further.
setInterval(tick, DEMO_MODE ? 4000 : POLL_INTERVAL_MS);
 
// A webhook event only tells us *something* changed (Square deliberately
// keeps the payload minimal), so the handler's job is just to trigger an
// immediate re-poll rather than parse order details out of the event itself.
const triggerImmediatePoll = debounce(() => {
  if (!DEMO_MODE) pollSquare().catch((err) => console.error("[square-kds] webhook-triggered poll failed:", err.message));
}, 400);
 
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
 
// Square calls this the instant an order or fulfillment changes, so updates
// can reach the iPad in well under a second instead of waiting for the next
// poll tick. See README §4 for how to register this URL with Square.
app.post("/api/webhooks/square", (req, res) => {
  if (!WEBHOOKS_ENABLED) {
    console.warn("[square-kds] webhook hit but SQUARE_WEBHOOK_SIGNATURE_KEY / SQUARE_WEBHOOK_URL aren't configured — ignoring");
    return res.status(503).end();
  }
 
  const valid = verifySquareSignature({
    signatureKey: WEBHOOK_SIGNATURE_KEY,
    notificationUrl: WEBHOOK_URL,
    rawBody: req.rawBody,
    signatureHeader: req.get("x-square-hmacsha256-signature"),
  });
 
  if (!valid) {
    console.warn("[square-kds] webhook signature verification failed — check SQUARE_WEBHOOK_URL matches the URL registered in Square exactly");
    return res.status(401).end();
  }
 
  // Acknowledge immediately — Square expects a fast 2xx and retries on timeout.
  res.status(200).end();
  triggerImmediatePoll();
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
  console.log(`[square-kds] webhooks: ${WEBHOOKS_ENABLED ? "enabled (POST /api/webhooks/square)" : "disabled — set SQUARE_WEBHOOK_SIGNATURE_KEY + SQUARE_WEBHOOK_URL to enable"}`);
});

# Square KDS

A Kitchen Display System for Square POS orders, designed to run full-screen on an iPad. Orders come in as tickets in a **New → Preparing → Ready** board; tap a ticket to bump it to the next stage.

It ships in **demo mode** by default — open it right now and you'll see fake orders flowing in, so you can try the UI before touching Square at all.

## 1. Try it in demo mode (no Square account needed)

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000` on this machine, or `http://<this-computer's-IP>:3000` from an iPad on the same Wi-Fi network, and add it to the Home Screen (Safari → Share → "Add to Home Screen") so it opens full-screen like a native app.

## 2. Connect it to your real Square account

### Create a Square developer app

1. Go to the [Square Developer Dashboard](https://developer.squareup.com/apps) and sign in with the same account you use for your Square POS.
2. Click **+ Create App**, give it any name (e.g. "My KDS"), and open it.
3. You'll land on the **Credentials** page for the **Sandbox** environment by default. Square gives every app a sandbox with fake test data — start there so you don't touch real orders while testing.
4. Copy the **Sandbox Access Token** shown on that page.
5. When you're ready to go live, switch the toggle at the top from Sandbox to Production and copy the **Production Access Token** instead (production tokens are only shown once you've completed Square's application details).

### Find your Location ID

Still in the dashboard, open the **Locations** tab for your app — it lists your business locations and their IDs (they look like `L1A2B3C4D5E6F`). You can also get this by calling `GET /v2/locations` with your access token.

### Configure the app

Edit `.env`:

```ini
SQUARE_ACCESS_TOKEN=your-token-here
SQUARE_ENVIRONMENT=sandbox        # or "production" when you're ready
SQUARE_LOCATION_IDS=L1A2B3C4D5E6F # comma-separate multiple locations
DEMO_MODE=true                    # ignored once a token + location are set
```

Restart the app (`npm start`). The badge in the top bar will switch from "Demo mode" to "Live", and it'll start pulling real open orders for that location every `POLL_INTERVAL_MS` (5 seconds by default).

### Generate a test order (sandbox)

While in sandbox, you can create a fake order to see it appear on the KDS using the [API Explorer's Create Order](https://developer.squareup.com/explorer/square/orders-api/create-order) tool, or Square's [sandbox test card guide](https://developer.squareup.com/docs/testing/sandbox). Give the order a `PICKUP` or `IN_STORE` fulfillment — those are what the KDS displays as tickets.

## 3. How it works

- The server polls Square's [Search Orders](https://developer.squareup.com/reference/square/orders-api/search-orders) API for `OPEN` orders at your location(s), turns each active fulfillment into a "ticket," and pushes the full board to every connected iPad over a WebSocket. That's what makes updates feel instant on-screen even though the Square side is polled rather than pushed.
- Tapping a ticket calls Square's [Update Order](https://developer.squareup.com/reference/square/orders-api/update-order) API to advance that fulfillment: `PROPOSED → RESERVED → PREPARED → COMPLETED`. Once complete, the order drops off the board — matching how Square's own Order Manager treats it.
- Multiple iPads can point at the same server and will all stay in sync.

## 4. Going further: real-time webhooks + hosting

Right now the server polls Square from wherever it's running. Polling only needs outbound internet, so it works anywhere — your laptop, a Raspberry Pi behind the counter, or a small cloud host.

Square also offers **webhooks**, where Square pushes order events to you the instant they happen instead of you asking every few seconds. The catch: Square requires a **public HTTPS URL** to send them to, so webhooks only make sense once this app is deployed somewhere reachable from the internet (e.g. [Render](https://render.com), [Railway](https://railway.app), [Fly.io](https://fly.io), or your own VPS — anything that keeps a Node process running works; avoid pure-serverless platforms since they don't hold the WebSocket connections open).

Once deployed, to switch to webhooks:

1. In the Developer Dashboard, go to your app → **Webhooks** and add a subscription for `order.updated` and `order.fulfillment.updated`, pointing at `https://your-deployed-app.com/api/webhooks/square`.
2. Add a route that verifies Square's signature header, applies the event to the in-memory ticket store, and calls the same `broadcast()` used by the poller.
3. You can drop the polling interval way down (or remove it) since webhooks now do the pushing.

This isn't wired up yet since it needs a real deployed URL to register with Square — happy to build it once you've picked where this is hosted.

## 5. Project layout

```
server/
  server.js   — Express app, WebSocket server, poll loop, REST endpoints
  square.js   — thin wrapper over the Square REST API (no SDK dependency)
  tickets.js  — converts Square Order objects into KDS ticket cards
  demo.js     — fake order generator used when no Square token is set
public/
  index.html, style.css, app.js — the iPad board itself
```

## Troubleshooting

- **Stuck on "Demo mode"** — `SQUARE_ACCESS_TOKEN` and `SQUARE_LOCATION_IDS` must both be set; check the server console for a warning.
- **"Lost connection to Square"** banner — usually an expired/invalid token, or a location ID that doesn't belong to that token's merchant. Check the server logs for the exact Square error.
- **Orders not appearing** — only orders with an active fulfillment (not yet `COMPLETED`/`CANCELED`) show up, and only for the location IDs you configured.

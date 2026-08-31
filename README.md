Square KDS

A Kitchen Display System for Square POS orders, designed to run full-screen on an iPad. Orders come in as tickets in a New → Preparing → Ready board; tap a ticket to bump it to the next stage.

It ships in demo mode by default — open it right now and you'll see fake orders flowing in, so you can try the UI before touching Square at all.

1. Try it in demo mode (no Square account needed)
bash
npm install
cp .env.example .env
npm start

Open http://localhost:3000 on this machine, or http://<this-computer's-IP>:3000 from an iPad on the same Wi-Fi network, and add it to the Home Screen (Safari → Share → "Add to Home Screen") so it opens full-screen like a native app.

2. Connect it to your real Square account
Create a Square developer app
Go to the Square Developer Dashboard and sign in with the same account you use for your Square POS.
Click + Create App, give it any name (e.g. "My KDS"), and open it.
You'll land on the Credentials page for the Sandbox environment by default. Square gives every app a sandbox with fake test data — start there so you don't touch real orders while testing.
Copy the Sandbox Access Token shown on that page.
When you're ready to go live, switch the toggle at the top from Sandbox to Production and copy the Production Access Token instead (production tokens are only shown once you've completed Square's application details).
Find your Location ID

Still in the dashboard, open the Locations tab for your app — it lists your business locations and their IDs (they look like L1A2B3C4D5E6F). You can also get this by calling GET /v2/locations with your access token.

Configure the app

Edit .env:

ini
SQUARE_ACCESS_TOKEN=your-token-here
SQUARE_ENVIRONMENT=sandbox        # or "production" when you're ready
SQUARE_LOCATION_IDS=L1A2B3C4D5E6F # comma-separate multiple locations
DEMO_MODE=true                    # ignored once a token + location are set

Restart the app (npm start). The badge in the top bar will switch from "Demo mode" to "Live", and it'll start pulling real open orders for that location every POLL_INTERVAL_MS (5 seconds by default).

Generate a test order (sandbox)

While in sandbox, you can create a fake order to see it appear on the KDS using the API Explorer's Create Order tool, or Square's sandbox test card guide. Give the order a PICKUP or IN_STORE fulfillment — those are what the KDS displays as tickets.

3. How it works
The server polls Square's Search Orders API for OPEN orders at your location(s), turns each active fulfillment into a "ticket," and pushes the full board to every connected iPad over a WebSocket. That's what makes updates feel instant on-screen even though the Square side is polled rather than pushed.
Tapping a ticket calls Square's Update Order API to advance that fulfillment: PROPOSED → RESERVED → PREPARED → COMPLETED. Once complete, the order drops off the board — matching how Square's own Order Manager treats it.
Multiple iPads can point at the same server and will all stay in sync.
4. Real-time updates via webhooks

Polling (the default) checks Square every POLL_INTERVAL_MS (5 seconds). The app also supports Square webhooks — Square pushes an event to your server the instant an order changes, so updates can reach the iPad in well under a second. This requires a public HTTPS URL, so it only works once the app is deployed (not on localhost).

Register the webhook subscription
In the Developer Dashboard, open your app → Webhooks → Add Endpoint.
Set the Notification URL to https://your-deployed-app.com/api/webhooks/square (use your actual deployed URL — it must match exactly, including no trailing slash).
Subscribe to these events: order.created, order.updated, order.fulfillment.updated.
Save, then copy the Signature Key shown for this subscription.
Configure the app

Add two environment variables wherever you're hosting it:

ini
SQUARE_WEBHOOK_SIGNATURE_KEY=the-signature-key-from-step-4
SQUARE_WEBHOOK_URL=https://your-deployed-app.com/api/webhooks/square   # must exactly match what you entered in step 2

Restart the app. The startup log will show webhooks: enabled (POST /api/webhooks/square), and Square will start pushing updates immediately instead of the app waiting on the next poll tick. Polling keeps running in the background as a safety net in case a webhook delivery is ever missed — feel free to raise POLL_INTERVAL_MS (e.g. to 60000) once webhooks are confirmed working, since it's no longer doing the heavy lifting.

How the webhook handler works

Square's webhook payloads are deliberately minimal (an order ID and version, not the full order), so the handler doesn't try to parse ticket details out of the event — it verifies the signature, then triggers an immediate re-poll of Square's Search Orders API, reusing all the same logic as the regular polling loop. A short debounce collapses the multiple events Square often fires for one change (e.g. both order.updated and order.fulfillment.updated) into a single re-poll.

5. Project layout
server/
  server.js   — Express app, WebSocket server, poll loop, REST endpoints
  square.js   — thin wrapper over the Square REST API (no SDK dependency)
  tickets.js  — converts Square Order objects into KDS ticket cards
  demo.js     — fake order generator used when no Square token is set
  webhook.js  — webhook signature verification + debounce helper
public/
  index.html, style.css, app.js — the iPad board itself
Troubleshooting
Stuck on "Demo mode" — SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_IDS must both be set; check the server console for a warning.
"Lost connection to Square" banner — usually an expired/invalid token, or a location ID that doesn't belong to that token's merchant. Check the server logs for the exact Square error.
Orders not appearing — only orders with an active fulfillment (not yet COMPLETED/CANCELED) show up, and only for the location IDs you configured.
"webhook signature verification failed" in the logs — almost always means SQUARE_WEBHOOK_URL doesn't exactly match the Notification URL you entered in the Square dashboard (trailing slash, http vs https, etc.), or SQUARE_WEBHOOK_SIGNATURE_KEY is wrong/from a different subscription. Square will still retry a few times, so the board recovers as soon as it's fixed

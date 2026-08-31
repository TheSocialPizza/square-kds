// Generates fake tickets in the exact same shape orderToTickets() produces,
// so the frontend can be previewed and tested with zero Square setup.

import { STATE_ORDER, nextState } from "./tickets.js";

const MENU = [
  { name: "Margherita Pizza", modifiers: ["Extra Basil"] },
  { name: "Pepperoni Pizza", modifiers: [] },
  { name: "Caesar Salad", modifiers: ["No Croutons", "Dressing on Side"] },
  { name: "Garlic Bread", modifiers: [] },
  { name: "Cheeseburger", modifiers: ["No Onion", "Add Bacon"] },
  { name: "Fries", modifiers: ["Large"] },
  { name: "Iced Tea", modifiers: ["No Ice"] },
  { name: "Chocolate Cake", modifiers: [] },
];

const NAMES = ["Sam", "Priya", "Jordan", "Alex", "Mia", "Chen", "Noah", "Fatima"];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomTicketId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export function createDemoStore() {
  /** @type {Map<string, any>} */
  const tickets = new Map();
  let counter = 1000;

  function spawnTicket() {
    const itemCount = 1 + Math.floor(Math.random() * 3);
    const items = Array.from({ length: itemCount }, () => {
      const base = randomFrom(MENU);
      return {
        name: base.name,
        quantity: String(1 + Math.floor(Math.random() * 2)),
        variationName: null,
        modifiers: base.modifiers,
        note: Math.random() < 0.15 ? "Allergy: peanuts" : null,
      };
    });

    const id = `demo-${counter++}`;
    const ticket = {
      id,
      orderId: id,
      version: 1,
      locationId: "demo-location",
      ticketLabel: randomTicketId(),
      createdAt: new Date().toISOString(),
      fulfillmentUid: "demo-fulfillment",
      fulfillmentType: Math.random() < 0.7 ? "PICKUP" : "IN_STORE",
      state: "PROPOSED",
      recipientName: randomFrom(NAMES),
      note: null,
      items,
    };
    tickets.set(id, ticket);
  }

  // Seed a few tickets so the board isn't empty on first load.
  spawnTicket();
  spawnTicket();
  spawnTicket();

  const spawnTimer = setInterval(() => {
    if (tickets.size < 12) spawnTicket();
  }, 12000 + Math.random() * 15000);
  spawnTimer.unref?.();

  function list() {
    return Array.from(tickets.values()).filter(
      (t) => t.state !== "COMPLETED"
    );
  }

  function bump(id) {
    const ticket = tickets.get(id);
    if (!ticket) return { ok: false, error: "not_found" };
    const next = nextState(ticket.state);
    if (!next) return { ok: false, error: "already_complete" };
    ticket.state = next;
    ticket.version += 1;
    if (next === "COMPLETED") {
      // Keep completed tickets around briefly isn't necessary for a KDS —
      // drop it so the board matches Square's "OPEN orders only" behavior.
      tickets.delete(id);
    }
    return { ok: true, ticket: tickets.get(id) || { ...ticket } };
  }

  return { list, bump, STATE_ORDER };
}

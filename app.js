const STATES = ["PROPOSED", "RESERVED", "PREPARED"];
const BUMP_LABEL = {
  PROPOSED: "Start Preparing",
  RESERVED: "Mark Ready",
  PREPARED: "Complete",
};

const cardTemplate = document.getElementById("cardTemplate");
const connDot = document.getElementById("connDot");
const modeBadge = document.getElementById("modeBadge");
const banner = document.getElementById("banner");
const clockEl = document.getElementById("clock");

/** @type {Map<string, any>} */
let tickets = new Map();
let bumping = new Set();

function setBanner(message) {
  if (!message) {
    banner.hidden = true;
    banner.textContent = "";
  } else {
    banner.hidden = false;
    banner.textContent = message;
  }
}

function setMode(mode) {
  modeBadge.textContent = mode === "demo" ? "Demo mode" : "Live";
  modeBadge.className = "badge " + (mode === "demo" ? "demo" : "live");
}

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function ageClass(ms) {
  const minutes = ms / 60000;
  if (minutes >= 12) return "age-danger";
  if (minutes >= 6) return "age-warn";
  return "";
}

function render() {
  for (const state of STATES) {
    const col = document.getElementById(`col-${state}`);
    const countEl = document.getElementById(`count-${state}`);
    const items = Array.from(tickets.values())
      .filter((t) => t.state === state)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    countEl.textContent = String(items.length);

    // Reconcile DOM nodes by ticket id instead of wiping innerHTML, so the
    // per-second timer tick doesn't rebuild the whole board.
    const existing = new Map(
      Array.from(col.children).map((el) => [el.dataset.id, el])
    );
    const seen = new Set();

    items.forEach((ticket, index) => {
      seen.add(ticket.id);
      let card = existing.get(ticket.id);
      if (!card) {
        card = buildCard(ticket);
        col.appendChild(card);
      }
      updateCard(card, ticket);
      const domIndex = Array.from(col.children).indexOf(card);
      if (domIndex !== index) col.insertBefore(card, col.children[index] || null);
    });

    for (const [id, el] of existing) {
      if (!seen.has(id)) el.remove();
    }

    if (items.length === 0 && !col.querySelector(".empty-hint")) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = "No tickets";
      col.appendChild(hint);
    } else if (items.length > 0) {
      col.querySelector(".empty-hint")?.remove();
    }
  }
}

function buildCard(ticket) {
  const node = cardTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.id = ticket.id;
  node.querySelector(".bump-btn").addEventListener("click", () => bump(ticket.id));
  return node;
}

function updateCard(card, ticket) {
  card.querySelector(".ticket-label").textContent = `#${ticket.ticketLabel}`;

  const recipientEl = card.querySelector(".recipient");
  const parts = [ticket.fulfillmentType?.replace("_", " ")];
  if (ticket.recipientName) parts.push(ticket.recipientName);
  recipientEl.textContent = parts.filter(Boolean).join(" · ");

  const list = card.querySelector(".items");
  list.innerHTML = "";
  for (const item of ticket.items) {
    const li = document.createElement("li");
    const qty = document.createElement("span");
    qty.className = "qty";
    qty.textContent = `${item.quantity}×`;
    li.appendChild(qty);
    li.appendChild(
      document.createTextNode(item.variationName ? `${item.name} (${item.variationName})` : item.name)
    );
    if (item.modifiers?.length) {
      const mods = document.createElement("span");
      mods.className = "mods";
      mods.textContent = item.modifiers.join(", ");
      li.appendChild(mods);
    }
    if (item.note) {
      const note = document.createElement("span");
      note.className = "mods";
      note.textContent = `Note: ${item.note}`;
      li.appendChild(note);
    }
    list.appendChild(li);
  }

  const noteEl = card.querySelector(".note");
  if (ticket.note) {
    noteEl.hidden = false;
    noteEl.textContent = ticket.note;
  } else {
    noteEl.hidden = true;
  }

  const btn = card.querySelector(".bump-btn");
  btn.textContent = BUMP_LABEL[ticket.state] || "Bump";
  btn.disabled = bumping.has(ticket.id);

  tickCard(card, ticket);
}

function tickCard(card, ticket) {
  const elapsed = Date.now() - new Date(ticket.createdAt).getTime();
  card.querySelector(".timer").textContent = formatElapsed(elapsed);
  card.classList.remove("age-warn", "age-danger");
  const cls = ageClass(elapsed);
  if (cls) card.classList.add(cls);
}

function tickAllTimers() {
  for (const state of STATES) {
    const col = document.getElementById(`col-${state}`);
    for (const card of col.children) {
      const ticket = tickets.get(card.dataset.id);
      if (ticket) tickCard(card, ticket);
    }
  }
}

async function bump(id) {
  if (bumping.has(id)) return;
  bumping.add(id);
  render();
  try {
    const res = await fetch(`/api/tickets/${encodeURIComponent(id)}/bump`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.error("Bump failed", body);
      setBanner("Couldn't update that ticket — check the connection.");
      setTimeout(() => setBanner(null), 4000);
    }
  } catch (err) {
    console.error(err);
    setBanner("Couldn't reach the server.");
  } finally {
    bumping.delete(id);
  }
}

// ---- WebSocket connection with auto-reconnect ----

let socket;
let reconnectDelay = 1000;

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws`);

  socket.addEventListener("open", () => {
    connDot.classList.add("connected");
    reconnectDelay = 1000;
    setBanner(null);
  });

  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "snapshot") {
      tickets = new Map(msg.tickets.map((t) => [t.id, t]));
      setMode(msg.mode);
      render();
    } else if (msg.type === "error") {
      setBanner(msg.message);
    }
  });

  socket.addEventListener("close", () => {
    connDot.classList.remove("connected");
    setBanner("Disconnected — reconnecting…");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
  });

  socket.addEventListener("error", () => {
    socket.close();
  });
}

function tickClock() {
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

connect();
tickClock();
setInterval(tickClock, 15000);
setInterval(tickAllTimers, 1000);

// Keep the iPad screen from feeling stale if it was backgrounded — refetch
// a fresh snapshot whenever the tab/app becomes visible again.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && socket?.readyState !== WebSocket.OPEN) {
    connect();
  }
});

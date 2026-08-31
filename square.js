// Minimal wrapper around the Square REST API — no SDK dependency, so it's
// easy to see exactly which endpoints are being called and why.

const HOSTS = {
  sandbox: "https://connect.squareupsandbox.com",
  production: "https://connect.squareup.com",
};

export function makeSquareClient({ accessToken, environment }) {
  const baseUrl = HOSTS[environment] || HOSTS.sandbox;

  async function request(path, { method = "GET", body } = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      const message =
        json?.errors?.map((e) => e.detail).join("; ") ||
        `Square API error (${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      err.squareErrors = json?.errors;
      throw err;
    }

    return json;
  }

  /**
   * Fetch all OPEN orders for the given locations, oldest first.
   * https://developer.squareup.com/reference/square/orders-api/search-orders
   */
  async function searchOpenOrders(locationIds) {
    const orders = [];
    let cursor;

    do {
      const json = await request("/v2/orders/search", {
        method: "POST",
        body: {
          location_ids: locationIds,
          cursor,
          limit: 100,
          query: {
            filter: {
              state_filter: { states: ["OPEN"] },
            },
            sort: {
              sort_field: "CREATED_AT",
              sort_order: "ASC",
            },
          },
        },
      });

      orders.push(...(json.orders || []));
      cursor = json.cursor;
    } while (cursor);

    return orders;
  }

  /**
   * Advance one fulfillment on an order to a new state.
   * https://developer.squareup.com/reference/square/orders-api/update-order
   */
  async function updateFulfillmentState({
    orderId,
    locationId,
    version,
    fulfillmentUid,
    newState,
  }) {
    return request(`/v2/orders/${orderId}`, {
      method: "PUT",
      body: {
        idempotency_key: `${orderId}-${fulfillmentUid}-${newState}-${Date.now()}`,
        order: {
          location_id: locationId,
          version,
          fulfillments: [{ uid: fulfillmentUid, state: newState }],
        },
      },
    });
  }

  async function listLocations() {
    const json = await request("/v2/locations");
    return json.locations || [];
  }

  return { searchOpenOrders, updateFulfillmentState, listLocations };
}

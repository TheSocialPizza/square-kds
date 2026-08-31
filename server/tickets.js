// Turns raw Square Order objects into the flat "ticket" shape the KDS
// frontend renders, and defines the bump state machine.

export const STATE_ORDER = ["PROPOSED", "RESERVED", "PREPARED", "COMPLETED"];

export function nextState(state) {
  const i = STATE_ORDER.indexOf(state);
  if (i === -1 || i === STATE_ORDER.length - 1) return null;
  return STATE_ORDER[i + 1];
}

function lineItemToItem(li) {
  return {
    name: li.name || li.catalog_object_id || "Item",
    quantity: li.quantity || "1",
    variationName: li.variation_name || null,
    modifiers: (li.modifiers || []).map((m) => m.name).filter(Boolean),
    note: li.note || null,
  };
}

function recipientName(fulfillment) {
  const details =
    fulfillment.pickup_details ||
    fulfillment.delivery_details ||
    fulfillment.shipment_details;
  return details?.recipient?.display_name || null;
}

function fulfillmentNote(fulfillment) {
  return (
    fulfillment.pickup_details?.note ||
    fulfillment.delivery_details?.note ||
    null
  );
}

/**
 * A Square order can carry multiple fulfillments. We surface one KDS ticket
 * per *active* (non-completed, non-canceled) fulfillment, since each is
 * tracked and bumped independently in the kitchen.
 */
export function orderToTickets(order) {
  const fulfillments = order.fulfillments || [];
  const items = (order.line_items || []).map(lineItemToItem);

  return fulfillments
    .filter((f) => f.state !== "COMPLETED" && f.state !== "CANCELED" && f.state !== "FAILED")
    .map((f) => ({
      id: `${order.id}:${f.uid}`,
      orderId: order.id,
      version: order.version,
      locationId: order.location_id,
      ticketLabel: (order.reference_id || order.id).slice(-6).toUpperCase(),
      createdAt: order.created_at,
      fulfillmentUid: f.uid,
      fulfillmentType: f.type,
      state: f.state,
      recipientName: recipientName(f),
      note: fulfillmentNote(f),
      items,
    }));
}

export function ordersToTickets(orders) {
  return orders.flatMap(orderToTickets);
}

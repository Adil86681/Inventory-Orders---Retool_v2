/**
 * Vercel Serverless Function — /api/kpi-sync
 *
 * Runs on a schedule (Vercel Cron) to detect order status transitions and
 * write them to the KPI Google Sheet — no browser required.
 *
 * Uses the Google Sheet itself as the snapshot (source of truth for what's
 * already been logged), so it's stateless, multi-instance safe, and picks
 * up where it left off even after downtime.
 */

const AUTH_TOKEN_URL  = 'https://auth.firstbasehq.com/oauth2/default/v1/token';
const AUTH_BASIC      = 'Basic MG9hdTA0ajNic3ZlNnZwanc1ZDc6TWl3RTBtU3g5TWlDRFQ1c2M5TlJDZktNMnN2SjBkZ0dZUWxqQTc3ZHhkNUNuZU0tSnpmSF9PS1c2b1AzZk1HSQ==';
const AUTH_SCOPE      = 'firstbase:service-accounts';
const GRAPHQL_URL     = 'https://api.firstbasehq.com/graphql';
const KPI_TRACKER_URL = 'https://script.google.com/macros/s/AKfycbxyST8dafoimwK8toJM9tN5nuQOeLozktvgUFqLb8djX8WbWp5Swr4ECzBX-RHIVQuAYQ/exec';

// ── Auth ─────────────────────────────────────────────────────────────────────

let cachedToken    = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
  const res = await fetch(AUTH_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': AUTH_BASIC },
    body:    'grant_type=client_credentials&scope=' + encodeURIComponent(AUTH_SCOPE)
  });
  if (!res.ok) throw new Error('Token fetch failed (' + res.status + '): ' + await res.text());
  const data     = await res.json();
  cachedToken    = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isBlockedWarehouse(wh) {
  if (!wh) return false;
  const n = wh.toLowerCase();
  return n === 'slc' || n.includes('warehouse - slc') || n.includes('warehouse slc');
}

function buildMeta(order, items) {
  return {
    inventory_order_id: order.id || '',
    organization:       order.organization?.name || '',
    warehouse:          order.warehouse?.name || '',
    product_title:      items.length === 1
                          ? (items[0].sku?.skuInformation?.productTitle || '')
                          : `${items.length} items`,
    total_qty:          items.reduce((s, it) => s + (it.quantity || 0), 0),
    submitted_by:       order.submittedBy
                          ? `${order.submittedBy.forename || ''} ${order.submittedBy.surname || ''}`.trim()
                          : ''
  };
}

// ── Fetch active orders from Firstbase API ────────────────────────────────────

const GQL_QUERY = `
  query GetInventoryOrders($paging: PagingAndSorting!, $filter: InventoryOrderFilter) {
    getInventoryOrdersPaginated(pagingAndSorting: $paging, filter: $filter) {
      data {
        id friendlyOrderId status createdAt updatedAt
        organization { id name }
        warehouse    { id name }
        submittedBy  { forename surname }
        inventoryOrderItems {
          id quantity status
          sku { id skuInformation { productTitle } vendor { name } }
        }
      }
      totalPages
    }
  }`;

async function fetchPage(token, pageNumber) {
  const res = await fetch(GRAPHQL_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body:    JSON.stringify({
      query:     GQL_QUERY,
      variables: {
        paging: { pageNumber, pageSize: 250, sort: [{ field: 'createdAt', direction: 'DESC' }] },
        filter: { statuses: ['ORDERED', 'PROCESSING', 'SHIPPED'], firstbaseSupplied: true }
      }
    })
  });
  if (!res.ok) throw new Error('GraphQL HTTP ' + res.status);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map(e => e.message).join('; '));
  return json.data?.getInventoryOrdersPaginated;
}

async function fetchAllActiveOrders(token) {
  const first      = await fetchPage(token, 1);
  const all        = [...(first?.data || [])];
  const totalPages = first?.totalPages || 1;
  if (totalPages > 1) {
    const rest = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, i) => fetchPage(token, i + 2))
    );
    rest.forEach(p => all.push(...(p?.data || [])));
  }
  return all;
}

// ── Read sheet as snapshot ────────────────────────────────────────────────────
// The sheet is the single source of truth — no localStorage, no per-browser
// state. Any instance of this function will naturally deduplicate against it.

async function readSheetSnapshot() {
  const res  = await fetch(KPI_TRACKER_URL + '?action=read');
  if (!res.ok) throw new Error('Sheet read failed: HTTP ' + res.status);
  const json = await res.json();
  if (!json.ok) throw new Error('Sheet read error: ' + (json.error || 'unknown'));

  const snapshot = {};
  (json.rows || []).forEach(r => {
    if (!r.friendly_order_id) return;
    snapshot[r.friendly_order_id] = {
      hasOrdered:    !!r.ordered_at,
      hasShipped:    !!r.shipped_at,
      hasAtFacility: !!r.at_facility_at,
      hasCompleted:  !!r.completed_at
    };
  });
  return snapshot;
}

// ── Send events to Apps Script ────────────────────────────────────────────────

async function sendEvents(events) {
  if (events.length === 0) return { ok: true, sent: 0 };
  const res  = await fetch(KPI_TRACKER_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body:    JSON.stringify({ events })
  });
  const json = await res.json();
  if (!json.ok) throw new Error('Sheet write failed: ' + (json.error || 'unknown'));
  return { ok: true, sent: events.length };
}

// ── Core diff logic ───────────────────────────────────────────────────────────

function detectTransitions(orders, snapshot) {
  const events  = [];
  const seenFids = new Set();
  const now     = new Date().toISOString();

  orders.forEach(order => {
    const fid   = order.friendlyOrderId || order.id;
    const wh    = order.warehouse?.name || '';
    if (isBlockedWarehouse(wh)) return;
    seenFids.add(fid);

    const items       = order.inventoryOrderItems || [];
    const itemStatuses = items.map(it => it.status).filter(Boolean);
    const orderStatus  = order.status || '';
    const meta         = buildMeta(order, items);
    const prev         = snapshot[fid];
    const isFirstSight = !prev;

    // ordered — first time we've ever seen this order
    if (!prev?.hasOrdered) {
      events.push({ friendly_order_id: fid, transition: 'ordered', timestamp: order.createdAt || now, ...meta });
    }

    if (isFirstSight) {
      // Mid-lifecycle first sight: don't emit stale events, just let future
      // runs pick up transitions from here onwards.
    } else {
      // shipped — witnessed the flip to SHIPPED
      if (!prev.hasShipped && orderStatus === 'SHIPPED') {
        events.push({ friendly_order_id: fid, transition: 'shipped', timestamp: now, ...meta });
      }
      // at_facility — any item reached the processing facility
      if (!prev.hasAtFacility && itemStatuses.includes('ARRIVED_AT_PROCESSING_FACILITY')) {
        events.push({ friendly_order_id: fid, transition: 'at_facility', timestamp: now, ...meta });
      }
    }
  });

  // completed — was in sheet as in-flight, no longer returned by the API
  Object.entries(snapshot).forEach(([fid, prev]) => {
    if (seenFids.has(fid))                  return; // still active
    if (prev.hasCompleted)                  return; // already logged
    if (!prev.hasShipped && !prev.hasAtFacility) return; // never progressed past ordered
    events.push({ friendly_order_id: fid, transition: 'completed', timestamp: now,
      inventory_order_id: '', organization: '', warehouse: '', product_title: '', total_qty: 0, submitted_by: '' });
  });

  return events;
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // Vercel automatically sets Authorization: Bearer <CRON_SECRET> on cron calls.
  // If you set CRON_SECRET in your Vercel env vars this blocks manual hits.
  if (process.env.CRON_SECRET) {
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const startedAt = Date.now();
  try {
    // Fetch orders and sheet snapshot in parallel
    const [token, snapshot] = await Promise.all([getAccessToken(), readSheetSnapshot()]);
    const orders             = await fetchAllActiveOrders(token);
    const events             = detectTransitions(orders, snapshot);
    const result             = await sendEvents(events);

    const elapsed = Date.now() - startedAt;
    console.log(`[kpi-sync] scanned=${orders.length} events=${events.length} elapsed=${elapsed}ms`);
    return res.status(200).json({ ok: true, ordersScanned: orders.length, eventsSent: events.length, elapsedMs: elapsed });

  } catch (err) {
    console.error('[kpi-sync] Error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
};

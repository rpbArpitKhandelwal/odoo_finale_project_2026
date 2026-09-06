/* DealFlow360 — Business logic engines (PostgreSQL, async) */
'use strict';
const { Q, ONE, RUN, getSetting, NOW_ISO, TODAY } = require('./db');

/* ============ 1. PRICING ENGINE ============ */
/* Price for a product for a given customer: base + variant extra + tier price list rule (matched on tier + currency). */
async function tierPriceRule(tier, currency) {
  return ONE(`SELECT * FROM price_lists WHERE active AND customer_tier=? AND currency=? ORDER BY value DESC`, [tier, currency]);
}
async function unitPriceFor(productId, variantId, customer, planId) {
  const p = await ONE('SELECT * FROM products WHERE id=?', [productId]);
  if (!p) return 0;
  let price = p.base_price;
  if (variantId) {
    const v = await ONE('SELECT * FROM product_variants WHERE id=? AND product_id=?', [variantId, productId]);
    if (v) price += v.extra_price;
  }
  if (p.product_type === 'subscription') {
    const pp = planId
      ? await ONE('SELECT * FROM product_plans WHERE product_id=? AND plan_id=?', [productId, planId])
      : await ONE('SELECT * FROM product_plans WHERE product_id=? ORDER BY id LIMIT 1', [productId]);
    if (pp) price = pp.recurring_price;
  }
  const rule = await tierPriceRule(customer.tier, customer.currency);
  if (rule && p.product_type !== 'subscription') {
    price = rule.rule_type === 'discount' ? price * (1 - rule.value / 100) : price * (1 + rule.value / 100);
  }
  return Math.round(price * 100) / 100;
}

/* ============ 2. BLENDED DISCOUNT RISK ENGINE ============ */
/*
 * allowedForLine = min(customer-tier ceiling, product-category ceiling)
 * violation(line) = max(0, effectiveDiscount − allowed)          (points over limit)
 * blendedRisk = maxViolation + 0.5 × (Σ violations − maxViolation)
 *   → worst line counts fully, smaller violations spread across many lines still add up (the "blended" pattern)
 * Routing (approval_rules): manager for low risk, finance for high risk or any single line over the hard cap.
 */
async function allowedDiscountFor(customerTier, categoryId) {
  const tier = await ONE('SELECT max_discount_pct FROM discount_tiers WHERE customer_tier=?', [customerTier]);
  const cat = await ONE('SELECT discount_ceiling FROM categories WHERE id=?', [categoryId]);
  const t = tier ? tier.max_discount_pct : 100;
  const c = cat ? cat.discount_ceiling : 100;
  return Math.min(t, c);
}
function effectiveDiscount(lineDiscount, orderDiscount) {
  const d1 = lineDiscount || 0, d2 = orderDiscount || 0;
  return d1 + d2 * (1 - d1 / 100); // compounded
}
async function computeRisk(quotation) {
  const customer = await ONE('SELECT * FROM customers WHERE id=?', [quotation.customer_id]);
  const lines = await Q('SELECT * FROM quotation_lines WHERE quotation_id=?', [quotation.id]);
  const od = quotation.order_discount_pct || 0;
  let maxV = 0, sumV = 0, worst = null;
  const lineBreakdown = [];
  for (const l of lines) {
    const prod = await ONE('SELECT * FROM products WHERE id=?', [l.product_id]);
    if (!prod) continue;
    const allowed = await allowedDiscountFor(customer.tier, prod.category_id);
    const given = effectiveDiscount(l.discount_pct, od);
    const over = Math.max(0, Math.round((given - allowed) * 100) / 100);
    if (over > maxV) { maxV = over; worst = { line_id: l.id, product: prod.name, given, allowed }; }
    sumV += over;
    const cat = await ONE('SELECT name FROM categories WHERE id=?', [prod.category_id]);
    lineBreakdown.push({
      line_id: l.id, product: prod.name, category: cat ? cat.name : null,
      discount_given: Math.round(given * 100) / 100, allowed, violation: over,
    });
  }
  const blended = maxV > 0 ? Math.round((maxV + 0.5 * Math.max(0, sumV - maxV)) * 100) / 100 : 0;
  const anyLineOver = lines.map(l => effectiveDiscount(l.discount_pct, od)).reduce((a, b) => Math.max(a, b), 0);
  return { risk_score: blended, max_violation: maxV, worst_line: worst, line_breakdown: lineBreakdown, total_overage: Math.round(sumV * 100) / 100, max_line_discount: Math.round(anyLineOver * 100) / 100 };
}
async function requiredApprovalLevel(quotation) {
  const risk = await computeRisk(quotation);
  const rules = await Q('SELECT * FROM approval_rules WHERE active ORDER BY sequence DESC');
  let level = null;
  if (risk.risk_score <= 0) return { level: 'none', risk };
  for (const r of rules) {
    const inRange = risk.risk_score >= r.risk_min && risk.risk_score <= r.risk_max;
    const hardCapHit = r.any_line_over != null && risk.max_line_discount > r.any_line_over;
    if (inRange || hardCapHit) { level = r.level; break; }
  }
  // any ceiling violation must be reviewed: if the configured ranges leave a gap, the Sales Manager is the safe default
  return { level: level || 'manager', risk };
}

/* ============ 3. TOTALS / MARGIN ============ */
async function recomputeTotals(quotationId) {
  const q = await ONE('SELECT * FROM quotations WHERE id=?', [quotationId]);
  if (!q) return null;
  const lines = await Q('SELECT * FROM quotation_lines WHERE quotation_id=?', [quotationId]);
  const od = q.order_discount_pct || 0;
  let subtotal = 0, discountTotal = 0, taxTotal = 0, costTotal = 0;
  for (const l of lines) {
    const gross = l.qty * l.unit_price;
    const eff = effectiveDiscount(l.discount_pct, od);
    const net = gross * (1 - eff / 100);
    const prod = await ONE('SELECT tax_rate FROM products WHERE id=?', [l.product_id]);
    subtotal += gross; discountTotal += gross - net; taxTotal += net * ((prod || { tax_rate: 0 }).tax_rate || 0) / 100;
    costTotal += l.qty * l.cost_price;
  }
  const total = subtotal - discountTotal + taxTotal;
  const margin = total > 0 ? (total - costTotal) / total * 100 : 0;
  const { risk_score, max_violation } = await computeRisk(q);
  await RUN(`UPDATE quotations SET subtotal=?, discount_total=?, tax_total=?, total=?, cost_total=?, margin_pct=?, risk_score=?, max_violation=?, last_activity_at=${NOW_ISO} WHERE id=?`,
    [r2(subtotal), r2(discountTotal), r2(taxTotal), r2(total), r2(costTotal), r1(margin), risk_score, max_violation, quotationId]);
  return ONE('SELECT * FROM quotations WHERE id=?', [quotationId]);
}
const r2 = (x) => Math.round(x * 100) / 100;
const r1 = (x) => Math.round(x * 10) / 10;

/* ============ 4. UPSELL / CROSS-SELL ENGINE ============ */
/* Rank by co-purchase score + promotion boost; only suggestions whose own margin clears the configured floor. */
async function upsellSuggestions(quotationId) {
  const q = await ONE('SELECT * FROM quotations WHERE id=?', [quotationId]);
  const customer = await ONE('SELECT * FROM customers WHERE id=?', [q.customer_id]);
  const lines = await Q('SELECT * FROM quotation_lines WHERE quotation_id=?', [quotationId]);
  const inCart = new Set(lines.map(l => l.product_id));
  const dismissed = new Set(String(q.dismissed_suggestions || '').split(',').filter(Boolean).map(Number));
  const minMargin = parseFloat(await getSetting('min_margin_pct', 30));
  const scores = new Map(); // product_id -> best score
  for (const l of lines) {
    const rules = await Q(`SELECT u.*, p.promoted FROM upsell_rules u JOIN products p ON p.id=u.suggested_product_id
      WHERE u.trigger_product_id=? AND u.active AND p.active`, [l.product_id]);
    for (const r of rules) {
      if (inCart.has(r.suggested_product_id) || dismissed.has(r.suggested_product_id)) continue;
      const score = r.co_score + (r.promoted ? 0.15 : 0);
      const prev = scores.get(r.suggested_product_id) || 0;
      if (score > prev) scores.set(r.suggested_product_id, score);
    }
  }
  const out = [];
  for (const [pid, score] of scores) {
    const p = await ONE('SELECT p.*, c.name category_name FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=?', [pid]);
    if (!p) continue;
    const price = await unitPriceFor(pid, null, customer);
    const marginPct = price > 0 ? (price - p.cost_price) / price * 100 : 0;
    if (marginPct < minMargin) continue; // unhealthy-margin suggestions never surface
    // margin delta if added at qty 1
    const revenue = price, margin$ = price - p.cost_price;
    const cur = await ONE('SELECT total, cost_total FROM quotations WHERE id=?', [quotationId]);
    const newMargin = (cur.total - cur.cost_total + margin$);
    const newTotal = cur.total + revenue;
    out.push({
      product_id: pid, name: p.name, sku: p.sku, category: p.category_name, price,
      promoted: !!p.promoted, score: Math.round(score * 100) / 100,
      margin_pct: Math.round(marginPct), margin_delta: r2(margin$),
      order_margin_after: newTotal > 0 ? Math.round(newMargin / newTotal * 1000) / 10 : 0,
      product_type: p.product_type,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 6);
}

/* ============ 5. WAREHOUSE SPLIT ENGINE ============ */
/*
 * Greedy allocation that minimizes the number of shipments:
 *  per line, prefer warehouses already used by this order (consolidation), then largest availability,
 *  then lower shipping cost weight. Remainder becomes a backorder parked at the cheapest warehouse.
 */
/* Units of a product a warehouse can still promise: on-hand minus what other confirmed orders have already
 * planned (but not yet shipped) from that warehouse. Two orders can never be promised the same unit. */
async function reservedQty(warehouseId, productId, excludeQuotationId) {
  const row = await ONE(`SELECT COALESCE(SUM(fs.qty),0) r FROM fulfillment_splits fs JOIN quotation_lines l ON l.id=fs.line_id
    WHERE fs.warehouse_id=? AND l.product_id=? AND fs.status='planned' AND fs.quotation_id!=?`, [warehouseId, productId, excludeQuotationId || 0]);
  return row ? Number(row.r) : 0;
}
async function freeStock(warehouseId, productId, excludeQuotationId) {
  const row = await ONE('SELECT qty FROM stock_levels WHERE warehouse_id=? AND product_id=?', [warehouseId, productId]);
  const onHand = row ? row.qty : 0;
  return Math.max(0, onHand - await reservedQty(warehouseId, productId, excludeQuotationId));
}
async function suggestSplit(quotationId) {
  const lines = await Q(`SELECT l.*, p.stocked, p.name FROM quotation_lines l JOIN products p ON p.id=l.product_id
    WHERE l.quotation_id=? AND p.stocked AND l.line_type='one_time'`, [quotationId]);
  const warehouses = await Q('SELECT * FROM warehouses WHERE active');
  const baseShip = parseFloat(await getSetting('base_ship_cost', 18));
  const usedWH = new Set();
  const plan = []; let shipments = 0; let estCost = 0;
  const committed = {}; // "wh:product" -> qty already earmarked by this plan (so two lines don't double-count the same stock)
  const availability = async (wid, pid) => {
    const free = await freeStock(wid, pid, quotationId);
    const taken = committed[`${wid}:${pid}`] || 0;
    return free - taken;
  };
  for (const l of lines) {
    let remaining = l.qty;
    const order = [];
    for (const wh of warehouses) order.push({ wh, avail: await availability(wh.id, l.product_id) });
    order.sort((a, b) => {
      const ua = usedWH.has(a.wh.id) ? 1 : 0, ub = usedWH.has(b.wh.id) ? 1 : 0;
      if (ua !== ub) return ub - ua; // consolidate into warehouses already shipping this order
      if (a.avail !== b.avail) return b.avail - a.avail; // largest availability first → fewest splits
      return a.wh.shipping_cost_weight - b.wh.shipping_cost_weight;
    });
    for (const { wh } of order) {
      if (remaining <= 0) break;
      const avail = Math.max(0, Math.min(await availability(wh.id, l.product_id), remaining));
      if (avail > 0) {
        plan.push({ line_id: l.id, product: l.name, warehouse_id: wh.id, warehouse: wh.name, weight: wh.shipping_cost_weight, qty: avail, status: 'planned' });
        committed[`${wh.id}:${l.product_id}`] = (committed[`${wh.id}:${l.product_id}`] || 0) + avail;
        remaining -= avail;
        if (!usedWH.has(wh.id)) { usedWH.add(wh.id); shipments++; estCost += baseShip * wh.shipping_cost_weight; }
      }
    }
    if (remaining > 0) {
      const cheapest = [...warehouses].sort((a, b) => a.shipping_cost_weight - b.shipping_cost_weight)[0];
      plan.push({ line_id: l.id, product: l.name, warehouse_id: cheapest.id, warehouse: cheapest.name, weight: cheapest.shipping_cost_weight, qty: remaining, status: 'backorder' });
    }
  }
  const perWarehouse = {};
  for (const p of plan) {
    perWarehouse[p.warehouse_id] = perWarehouse[p.warehouse_id] || { warehouse_id: p.warehouse_id, warehouse: p.warehouse, qty: 0, backorder: 0 };
    if (p.status === 'planned') perWarehouse[p.warehouse_id].qty += p.qty; else perWarehouse[p.warehouse_id].backorder += p.qty;
  }
  return { lines: plan, per_warehouse: Object.values(perWarehouse), shipment_count: shipments, est_cost: r2(estCost) };
}
async function canConsolidate(quotationId) {
  const rows = await Q(`SELECT fs.*, l.product_id FROM fulfillment_splits fs JOIN quotation_lines l ON l.id=fs.line_id
    WHERE fs.quotation_id=? AND fs.status='backorder'`, [quotationId]);
  for (const r of rows) {
    const whs = await Q('SELECT warehouse_id FROM stock_levels WHERE product_id=? AND qty>0', [r.product_id]);
    // consolidation adds on top of existing planned rows, so this order's own reservations count too (exclude nothing)
    for (const w of whs) if (await freeStock(w.warehouse_id, r.product_id, null) > 0) return true;
  }
  return false;
}
/* Move backordered units into planned shipments wherever free stock now exists (largest free pool first). */
async function consolidateBackorders(quotationId) {
  const backs = await Q(`SELECT fs.*, l.product_id, l.description FROM fulfillment_splits fs
    JOIN quotation_lines l ON l.id=fs.line_id WHERE fs.quotation_id=? AND fs.status='backorder'`, [quotationId]);
  let moved = 0;
  for (const b of backs) {
    let remaining = b.qty;
    const whs = await Q(`SELECT s.warehouse_id, s.qty, w.shipping_cost_weight FROM stock_levels s JOIN warehouses w ON w.id=s.warehouse_id
      WHERE s.product_id=? AND s.qty>0 AND w.active`, [b.product_id]);
    const pools = [];
    for (const w of whs) pools.push({ ...w, free: await freeStock(w.warehouse_id, b.product_id, null) });
    pools.sort((a, b2) => b2.free - a.free || a.shipping_cost_weight - b2.shipping_cost_weight);
    for (const p of pools) {
      if (remaining <= 0 || p.free <= 0) continue;
      const take = Math.min(p.free, remaining);
      await RUN(`INSERT INTO fulfillment_splits(quotation_id,line_id,warehouse_id,qty,status,est_cost) VALUES(?,?,?,?,'planned',0)`,
        [quotationId, b.line_id, p.warehouse_id, take]);
      remaining -= take; moved += take;
    }
    if (remaining === 0) await RUN(`DELETE FROM fulfillment_splits WHERE id=?`, [b.id]);
    else await RUN(`UPDATE fulfillment_splits SET qty=? WHERE id=?`, [remaining, b.id]);
  }
  return moved;
}

/* ============ 6. BILLING / SUBSCRIPTION ENGINE ============ */
function periodAddMonths(date, months) {
  const d = new Date(date); d.setMonth(d.getMonth() + months); return d;
}
function periodMonths(period) { return period === 'monthly' ? 1 : period === 'quarterly' ? 3 : 12; }
async function nextInvoiceNumber() {
  const row = await ONE(`SELECT number FROM invoices WHERE number LIKE 'INV-%' ORDER BY CAST(substr(number,5) AS INTEGER) DESC LIMIT 1`);
  const n = row ? parseInt(row.number.slice(4), 10) + 1 : 2033;
  return `INV-${n}`;
}
/* Per-unit recurring price for a line: list price − effective discount + product tax (recurring invoices are tax-inclusive, like one-time ones). */
async function recurringUnitPrice(line, orderDiscountPct) {
  const prod = await ONE('SELECT tax_rate FROM products WHERE id=?', [line.product_id]);
  const taxRate = (prod && prod.tax_rate) || 0;
  return line.unit_price * (1 - effectiveDiscount(line.discount_pct, orderDiscountPct || 0) / 100) * (1 + taxRate / 100);
}
/* Current billing cycle of a subscription line, anchored on the last invoiced schedule entry (not on "today"). */
async function currentCycle(line) {
  const months = periodMonths(line.billing_period || 'monthly');
  const last = await ONE(`SELECT scheduled_date FROM billing_schedule WHERE line_id=? AND status='invoiced' ORDER BY scheduled_date DESC LIMIT 1`, [line.id]);
  const start = last ? new Date(`${last.scheduled_date}T00:00:00Z`) : new Date();
  const end = periodAddMonths(start, months);
  const now = new Date();
  const daysInCycle = Math.max(1, Math.round((end - start) / 86400000));
  const daysRemaining = Math.max(0, Math.min(daysInCycle, Math.ceil((end - now) / 86400000)));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), days_in_cycle: daysInCycle, days_remaining: daysRemaining, months };
}
/* On confirmation: one-time lines → single invoice; recurring lines → first-cycle invoice + a 12-month forward schedule. */
async function generateBillingOnConfirm(quotationId) {
  const q = await ONE('SELECT * FROM quotations WHERE id=?', [quotationId]);
  if (!q) return;
  const existing = await ONE('SELECT COUNT(*) c FROM invoices WHERE quotation_id=?', [quotationId]);
  if (existing.c > 0) return;
  const lines = await Q('SELECT * FROM quotation_lines WHERE quotation_id=?', [quotationId]);
  const od = q.order_discount_pct || 0;
  const now = new Date().toISOString();
  let oneTimeNet = 0, oneTimeTax = 0;
  for (const l of lines.filter(l => l.line_type === 'one_time')) {
    const net = l.qty * l.unit_price * (1 - effectiveDiscount(l.discount_pct, od) / 100);
    oneTimeNet += net;
    const prod = await ONE('SELECT tax_rate FROM products WHERE id=?', [l.product_id]);
    oneTimeTax += net * ((prod || { tax_rate: 0 }).tax_rate || 0) / 100;
  }
  if (oneTimeNet > 0) {
    await RUN('INSERT INTO invoices(number,quotation_id,customer_id,kind,amount,status,due_date) VALUES(?,?,?,?,?,?,?)',
      [await nextInvoiceNumber(), quotationId, q.customer_id, 'one_time', r2(oneTimeNet + oneTimeTax), 'open', now.slice(0, 10)]);
  }
  for (const l of lines.filter(l => l.line_type === 'subscription')) {
    const cycleAmount = r2(l.qty * await recurringUnitPrice(l, od));
    const inv = await RUN('INSERT INTO invoices(number,quotation_id,customer_id,kind,amount,status,due_date) VALUES(?,?,?,?,?,?,?)',
      [await nextInvoiceNumber(), quotationId, q.customer_id, 'recurring', cycleAmount, 'open', now.slice(0, 10)]);
    await RUN(`INSERT INTO billing_schedule(quotation_id,line_id,scheduled_date,description,amount,status,invoice_id)
      VALUES(?,?,?,?,?,?,?)`, [quotationId, l.id, now.slice(0, 10), `${l.description} — cycle 1`, cycleAmount, 'invoiced', inv.lastInsertRowid]);
    const months = periodMonths(l.billing_period || 'monthly');
    const futureCycles = Math.max(1, Math.round(12 / months) - 1); // 12-month horizon, always at least the next renewal
    for (let i = 1; i <= futureCycles; i++) {
      const d = periodAddMonths(now, months * i).toISOString().slice(0, 10);
      await RUN(`INSERT INTO billing_schedule(quotation_id,line_id,scheduled_date,description,amount,status,invoice_id)
        VALUES(?,?,?,?,?,?,?)`, [quotationId, l.id, d, `${l.description} — cycle ${i + 1}`, cycleAmount, 'scheduled', null]);
    }
  }
}
/* Mid-cycle quantity change → proration for the remainder of the CURRENT cycle, per the plan's proration rule.
 *   daily → charge/credit (Δqty × unit price) × days_remaining / days_in_cycle, invoiced immediately
 *   none  → no adjustment now; the new quantity simply applies from the next cycle */
async function prorateLineChange(line, newQty) {
  const q = await ONE('SELECT * FROM quotations WHERE id=?', [line.quotation_id]);
  const plan = line.plan_id ? await ONE('SELECT * FROM subscription_plans WHERE id=?', [line.plan_id]) : null;
  const rule = plan ? plan.proration_rule : 'daily';
  const cycle = await currentCycle(line);
  const unit = await recurringUnitPrice(line, q.order_discount_pct);
  if (rule === 'none') return { delta: 0, rule, ...cycle, unit_price: r2(unit) };
  if (cycle.days_remaining <= 0) return { delta: 0, rule, ...cycle, unit_price: r2(unit) };
  const delta = (newQty - line.qty) * unit * (cycle.days_remaining / cycle.days_in_cycle);
  return { delta: r2(delta), rule, ...cycle, unit_price: r2(unit) };
}
/* Cancel subscription → credit note per plan policy (prorated / % of unused / none), honouring the plan's notice period. */
async function cancelSubscriptionCredit(line) {
  const q = await ONE('SELECT * FROM quotations WHERE id=?', [line.quotation_id]);
  const plan = line.plan_id ? await ONE('SELECT * FROM subscription_plans WHERE id=?', [line.plan_id]) : null;
  const cycleAmount = line.qty * await recurringUnitPrice(line, q.order_discount_pct);
  const cycle = await currentCycle(line);
  let refund = 0, policy = 'none', noticeDays = 0;
  if (plan) {
    policy = plan.cancellation_policy;
    noticeDays = plan.notice_days || 0;
    const unusedDays = Math.max(0, cycle.days_remaining - noticeDays); // service continues through the notice period
    const unusedShare = unusedDays / cycle.days_in_cycle;
    if (policy === 'refund_prorated') refund = cycleAmount * unusedShare;
    else if (policy === 'refund_pct') refund = cycleAmount * (plan.refund_pct / 100) * unusedShare;
  }
  return { refund: r2(refund), policy, notice_days: noticeDays, ...cycle };
}
/* Recurring billing run: every scheduled cycle whose date has arrived becomes an open invoice (one quotation, or all). */
async function generateDueInvoices(quotationId) {
  const due = quotationId
    ? await Q(`SELECT bs.*, q.customer_id FROM billing_schedule bs JOIN quotations q ON q.id=bs.quotation_id WHERE bs.quotation_id=? AND bs.status='scheduled' AND bs.scheduled_date<=${TODAY} ORDER BY bs.scheduled_date, bs.id`, [quotationId])
    : await Q(`SELECT bs.*, q.customer_id FROM billing_schedule bs JOIN quotations q ON q.id=bs.quotation_id WHERE bs.status='scheduled' AND bs.scheduled_date<=${TODAY} AND q.status IN ('confirmed','fulfilling','fulfilled') ORDER BY bs.scheduled_date, bs.id`);
  let created = 0;
  for (const s of due) {
    const inv = await RUN('INSERT INTO invoices(number,quotation_id,customer_id,kind,amount,status,due_date) VALUES(?,?,?,?,?,?,?)',
      [await nextInvoiceNumber(), s.quotation_id, s.customer_id, 'recurring', s.amount, 'open', s.scheduled_date]);
    await RUN(`UPDATE billing_schedule SET status='invoiced', invoice_id=? WHERE id=?`, [inv.lastInsertRowid, s.id]);
    created++;
  }
  return created;
}

/* ============ 7. DEAL HEALTH ENGINE ============ */
/* Idempotently materializes stalled / anomaly / slippage / backorder alerts.
 * Throttled: the dashboard and the notification bell poll this constantly, so a full re-scan runs at most every
 * 15 s unless a state change (restock, replenishment) forces it. */
let alertsRefreshedAt = 0, alertsInFlight = null;
async function refreshAlerts(force = false) {
  if (!force && Date.now() - alertsRefreshedAt < 15000) return;
  if (alertsInFlight) return alertsInFlight;
  alertsInFlight = refreshAlertsNow().finally(() => { alertsRefreshedAt = Date.now(); alertsInFlight = null; });
  return alertsInFlight;
}
async function refreshAlertsNow() {
  const stalledDays = parseInt(await getSetting('stalled_days', 3));
  const anomalyMult = parseFloat(await getSetting('anomaly_multiplier', 1.5));
  const slipDays = parseInt(await getSetting('slippage_days', 2));
  const insAlert = `INSERT INTO alerts(kind,quotation_id,message,severity) VALUES(?,?,?,?)
    ON CONFLICT(kind,quotation_id) DO UPDATE SET message=excluded.message, updated_at=${NOW_ISO}`;

  // stalled: draft/sent/negotiating with no activity for N days
  const stalled = await Q(`SELECT q.*, c.name customer_name FROM quotations q JOIN customers c ON c.id=q.customer_id
    WHERE q.status IN ('draft','sent','negotiating') AND EXTRACT(EPOCH FROM (now() AT TIME ZONE 'UTC' - q.last_activity_at::timestamp)) / 86400.0 > ?`, [stalledDays]);
  for (const q of stalled) {
    const days = Math.floor((Date.now() - new Date(q.last_activity_at).getTime()) / 86400000);
    await RUN(insAlert, ['stalled', q.id, `${q.number} (${q.customer_name}) inactive for ${days} days — status: ${q.status}`, 'medium']);
  }
  // anomaly: a quote whose avg discount far exceeds the rep's own historical (confirmed) average.
  // Material = over the multiplier AND ≥ 5 points above baseline; only deals won in the last 45 days are actionable.
  const ANOMALY_MIN_GAP = 5, ANOMALY_WINDOW_DAYS = 45;
  const quotes = await Q(`SELECT q.*, c.name customer_name FROM quotations q JOIN customers c ON c.id=q.customer_id
    WHERE q.status IN ('confirmed','fulfilling','fulfilled')`);
  const byRep = {};
  for (const q of quotes) {
    const avgDisc = q.subtotal > 0 ? q.discount_total / q.subtotal * 100 : 0;
    (byRep[q.rep_id] = byRep[q.rep_id] || []).push({ q, avgDisc: r1(avgDisc) });
  }
  const windowStart = new Date(Date.now() - ANOMALY_WINDOW_DAYS * 86400000).toISOString();
  for (const [repId, arr] of Object.entries(byRep)) {
    if (arr.length < 3) continue; // need a baseline before flagging
    const sorted = [...arr].sort((a, b) => a.q.confirmed_at?.localeCompare(b.q.confirmed_at || '') || 0);
    for (let i = 1; i < sorted.length; i++) {
      if ((sorted[i].q.confirmed_at || '') < windowStart) continue;
      const baseline = sorted.slice(0, i).reduce((s, x) => s + x.avgDisc, 0) / i;
      if (baseline > 0 && sorted[i].avgDisc > baseline * anomalyMult && sorted[i].avgDisc - baseline >= ANOMALY_MIN_GAP) {
        await RUN(insAlert, ['anomaly', sorted[i].q.id,
          `${sorted[i].q.number} (${sorted[i].q.customer_name}): ${sorted[i].avgDisc}% avg discount vs rep baseline ${r1(baseline)}% (×${anomalyMult})`, 'high']);
      }
    }
    // early warning: live (not yet won) quotes by the same rep that already breach the baseline pattern
    const baseline = arr.reduce((s, x) => s + x.avgDisc, 0) / arr.length;
    if (baseline > 0) {
      const live = await Q(`SELECT q.*, c.name customer_name FROM quotations q JOIN customers c ON c.id=q.customer_id
        WHERE q.rep_id=? AND q.subtotal>0 AND q.status IN ('pending_manager','pending_finance','approved','sent','negotiating')`, [Number(repId)]);
      for (const q of live) {
        const avgDisc = r1(q.discount_total / q.subtotal * 100);
        // early warning needs to be material: over the multiplier AND at least 5 points above the rep's baseline
        if (avgDisc > baseline * anomalyMult && avgDisc - baseline >= ANOMALY_MIN_GAP) {
          await RUN(insAlert, ['anomaly', q.id,
            `${q.number} (${q.customer_name}) in progress at ${avgDisc}% avg discount vs rep baseline ${r1(baseline)}% (×${anomalyMult}) — review before it closes`, 'high']);
        }
      }
    }
  }
  // backorder: stock has arrived for a backordered line → prompt "Consolidate remaining backorder" automatically
  const boQuotes = await Q(`SELECT DISTINCT q.id, q.number, c.name customer_name FROM fulfillment_splits fs
    JOIN quotations q ON q.id=fs.quotation_id JOIN customers c ON c.id=q.customer_id WHERE fs.status='backorder'`);
  const ready = new Set();
  for (const q of boQuotes) {
    if (await canConsolidate(q.id)) {
      ready.add(q.id);
      const units = await ONE(`SELECT COALESCE(SUM(qty),0) u FROM fulfillment_splits WHERE quotation_id=? AND status='backorder'`, [q.id]);
      await RUN(insAlert, ['backorder', q.id, `${q.number} (${q.customer_name}): stock arrived for ${units.u} backordered unit(s) — consolidate remaining backorder`, 'medium']);
    }
  }
  // backorder alerts resolve themselves once consolidated (or when stock is gone again)
  const openBO = await Q(`SELECT id, quotation_id FROM alerts WHERE kind='backorder' AND status!='dismissed'`);
  for (const a of openBO) if (!ready.has(a.quotation_id)) await RUN('DELETE FROM alerts WHERE id=?', [a.id]);
  // slippage: confirmed & not fully shipped past promised delivery
  const slipping = await Q(`SELECT q.*, c.name customer_name FROM quotations q JOIN customers c ON c.id=q.customer_id
    WHERE q.status IN ('confirmed','fulfilling') AND q.expected_delivery IS NOT NULL AND EXTRACT(EPOCH FROM (now() AT TIME ZONE 'UTC' - q.expected_delivery::timestamp)) / 86400.0 > ?`, [slipDays]);
  for (const q of slipping) {
    const openBO = await ONE(`SELECT COUNT(*) c FROM fulfillment_splits WHERE quotation_id=? AND status IN ('planned','backorder')`, [q.id]);
    if (openBO.c > 0) {
      await RUN(insAlert, ['slippage', q.id, `${q.number} (${q.customer_name}) past promised delivery with ${openBO.c} open fulfillment line(s)`, 'high']);
    }
  }
}
async function repBaselineDiscount(repId, excludeQuoteId) {
  const rows = await Q(`SELECT subtotal, discount_total FROM quotations WHERE rep_id=? AND id!=? AND status IN ('confirmed','fulfilled') AND subtotal>0`, [repId, excludeQuoteId]);
  if (!rows.length) return null;
  return r1(rows.reduce((s, r) => s + r.discount_total / r.subtotal * 100, 0) / rows.length);
}

/* ============ 7b. APPROVAL ROUTING ============ */
/* Creates the full approval chain for a quotation at the required level: manager is always step 1, finance step 2 when required. */
async function routeForApproval(quotationId, level) {
  await RUN('DELETE FROM approvals WHERE quotation_id=?', [quotationId]);
  if (level === 'none') return;
  await RUN(`INSERT INTO approvals(quotation_id,level,sequence,status) VALUES(?,?,1,'pending')`, [quotationId, 'manager']);
  if (level === 'finance') await RUN(`INSERT INTO approvals(quotation_id,level,sequence,status) VALUES(?,?,2,'waiting')`, [quotationId, 'finance']);
}

/* ============ 7c. COMMISSION ENGINE ============ */
/*
 * When an invoice is fully paid, a commission line is generated for the owning salesperson.
 * Rule matching is most-specific-wins: product > category > salesperson > team > everyone.
 * Rate can be a flat %, a fixed amount per order, or margin-tiered (higher margin → higher rate).
 */
async function nextCommissionNumber() {
  const row = await ONE(`SELECT number FROM commissions WHERE number LIKE 'COM-%' ORDER BY CAST(substr(number,5) AS INTEGER) DESC LIMIT 1`);
  return `COM-${String(row ? parseInt(row.number.slice(4), 10) + 1 : 1).padStart(4, '0')}`;
}
const SCOPE_SPECIFICITY = { product: 4, category: 3, salesperson: 2, team: 1, all: 0 };
async function generateCommissionsForInvoice(invoiceId, actor) {
  const inv = await ONE(`SELECT i.*, q.id qid, q.number quote_number, q.margin_pct, q.rep_id, q.exchange_rate, u.name rep_name, u.sales_team
    FROM invoices i JOIN quotations q ON q.id=i.quotation_id JOIN users u ON u.id=q.rep_id WHERE i.id=?`, [invoiceId]);
  if (!inv || inv.status !== 'paid' || inv.kind === 'credit_note') return [];
  inv.amount = r2(inv.amount / (inv.exchange_rate || 1)); // commissions are paid in USD — INR invoices convert at the quote's rate
  const already = await ONE('SELECT COUNT(*) c FROM commissions WHERE invoice_id=?', [invoiceId]);
  if (already.c > 0) return [];
  const lines = await Q(`SELECT l.product_id, p.category_id FROM quotation_lines l JOIN products p ON p.id=l.product_id WHERE l.quotation_id=?`, [inv.qid]);
  const rules = (await Q('SELECT * FROM commission_rules WHERE active'))
    .filter((r) => {
      switch (r.scope) {
        case 'salesperson': return r.salesperson_id === inv.rep_id;
        case 'team': return r.team === inv.sales_team;
        case 'category': return lines.some((l) => l.category_id === r.category_id);
        case 'product': return lines.some((l) => l.product_id === r.product_id);
        default: return true;
      }
    })
    .sort((a, b) => SCOPE_SPECIFICITY[b.scope] - SCOPE_SPECIFICITY[a.scope]);
  if (!rules.length) return [];
  const rule = rules[0];
  let rate = rule.rate;
  const rateType = rule.rate_type;
  if (rateType === 'margin_tier') {
    const tiers = typeof rule.margin_tiers === 'string' ? JSON.parse(rule.margin_tiers) : (rule.margin_tiers || []);
    const t = tiers.find((x) => inv.margin_pct >= x.min_margin) || tiers[tiers.length - 1];
    if (t) rate = t.rate;
  }
  const amount = rateType === 'fixed' ? rate : Math.round(inv.amount * rate / 100 * 100) / 100;
  if (!(amount > 0)) return [];
  const period = (inv.paid_at || new Date().toISOString()).slice(0, 7);
  const number = await nextCommissionNumber();
  const row = await RUN(`INSERT INTO commissions(number,quotation_id,invoice_id,salesperson_id,base_amount,margin_pct,rule_id,rule_name,rate,rate_type,amount,status,period)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
    [number, inv.qid, inv.id, inv.rep_id, inv.amount, r1(inv.margin_pct), rule.id, rule.name, rate, rateType, amount, period]);
  await audit('commission', row.lastInsertRowid, actor, 'generated',
    `${number} for ${inv.rep_name} on ${inv.quote_number}/${inv.number}: ${rateType === 'fixed' ? `$${rate} fixed` : `${rate}%`} → $${amount} (${rule.name})`);
  return [{ id: row.lastInsertRowid, number, amount }];
}

/* ============ 8. AUDIT ============ */
async function audit(entity, entityId, user, action, details) {
  await RUN('INSERT INTO audit_log(entity,entity_id,user_id,user_name,action,details) VALUES(?,?,?,?,?,?)',
    [entity, entityId, user ? user.id : null, user ? user.name : 'system', action, details || '']);
}

/* ============ 9. REPLENISHMENT RULES ============ */
/* Applies the per-warehouse replenishment rules: every stock line at or below its reorder point receives its replenishment lot. */
async function runReplenishment(warehouseId) {
  const rows = await Q(`SELECT s.*, p.name product_name, w.name warehouse_name FROM stock_levels s
    JOIN products p ON p.id=s.product_id JOIN warehouses w ON w.id=s.warehouse_id
    WHERE w.active AND p.active AND s.replenishment_qty>0 AND s.qty<=s.reorder_point ${warehouseId ? 'AND s.warehouse_id=?' : ''}`, warehouseId ? [warehouseId] : []);
  const applied = [];
  for (const s of rows) {
    await RUN('UPDATE stock_levels SET qty=qty+? WHERE id=?', [s.replenishment_qty, s.id]);
    applied.push({ stock_id: s.id, warehouse: s.warehouse_name, warehouse_id: s.warehouse_id, product: s.product_name, product_id: s.product_id, added: s.replenishment_qty, from: s.qty, to: s.qty + s.replenishment_qty });
  }
  return applied;
}

module.exports = {
  tierPriceRule, unitPriceFor, allowedDiscountFor, effectiveDiscount, computeRisk, requiredApprovalLevel,
  recomputeTotals, upsellSuggestions, suggestSplit, canConsolidate, consolidateBackorders, reservedQty, freeStock,
  generateBillingOnConfirm, recurringUnitPrice, currentCycle,
  prorateLineChange, cancelSubscriptionCredit, generateDueInvoices, refreshAlerts, repBaselineDiscount,
  routeForApproval, audit, r1, r2, nextInvoiceNumber, generateCommissionsForInvoice, nextCommissionNumber, runReplenishment,
};

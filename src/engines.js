/* DealFlow360 — Business logic engines */
'use strict';
const { db, getSetting } = require('./db');

/* ============ 1. PRICING ENGINE ============ */
/* Price for a product for a given customer: base + variant extra + tier price list rule (matched on tier + currency). */
function tierPriceRule(tier, currency) {
  return db.prepare(`SELECT * FROM price_lists WHERE active=1 AND customer_tier=? AND currency=? ORDER BY value DESC`).get(tier, currency) || null;
}
function unitPriceFor(productId, variantId, customer) {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!p) return 0;
  let price = p.base_price;
  if (variantId) {
    const v = db.prepare('SELECT * FROM product_variants WHERE id=? AND product_id=?').get(variantId, productId);
    if (v) price += v.extra_price;
  }
  if (p.product_type === 'subscription') {
    const pp = db.prepare('SELECT * FROM product_plans WHERE product_id=? ORDER BY id LIMIT 1').get(productId);
    if (pp) price = pp.recurring_price;
  }
  const rule = tierPriceRule(customer.tier, customer.currency);
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
function allowedDiscountFor(customerTier, categoryId) {
  const tier = db.prepare('SELECT max_discount_pct FROM discount_tiers WHERE customer_tier=?').get(customerTier);
  const cat = db.prepare('SELECT discount_ceiling FROM categories WHERE id=?').get(categoryId);
  const t = tier ? tier.max_discount_pct : 100;
  const c = cat ? cat.discount_ceiling : 100;
  return Math.min(t, c);
}
function effectiveDiscount(lineDiscount, orderDiscount) {
  const d1 = lineDiscount || 0, d2 = orderDiscount || 0;
  return d1 + d2 * (1 - d1 / 100); // compounded
}
function computeRisk(quotation) {
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(quotation.customer_id);
  const lines = db.prepare('SELECT * FROM quotation_lines WHERE quotation_id=?').all(quotation.id);
  const od = quotation.order_discount_pct || 0;
  let maxV = 0, sumV = 0, worst = null;
  const lineBreakdown = [];
  for (const l of lines) {
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(l.product_id);
    if (!prod) continue;
    const allowed = allowedDiscountFor(customer.tier, prod.category_id);
    const given = effectiveDiscount(l.discount_pct, od);
    const over = Math.max(0, Math.round((given - allowed) * 100) / 100);
    if (over > maxV) { maxV = over; worst = { line_id: l.id, product: prod.name, given, allowed }; }
    sumV += over;
    lineBreakdown.push({
      line_id: l.id, product: prod.name, category: (db.prepare('SELECT name FROM categories WHERE id=?').get(prod.category_id) || {}).name,
      discount_given: Math.round(given * 100) / 100, allowed, violation: over,
    });
  }
  const blended = maxV > 0 ? Math.round((maxV + 0.5 * Math.max(0, sumV - maxV)) * 100) / 100 : 0;
  const anyLineOver = lines.map(l => effectiveDiscount(l.discount_pct, od)).reduce((a, b) => Math.max(a, b), 0);
  return { risk_score: blended, max_violation: maxV, worst_line: worst, line_breakdown: lineBreakdown, total_overage: Math.round(sumV * 100) / 100, max_line_discount: Math.round(anyLineOver * 100) / 100 };
}
function requiredApprovalLevel(quotation) {
  const risk = computeRisk(quotation);
  const rules = db.prepare('SELECT * FROM approval_rules WHERE active=1 ORDER BY sequence DESC').all();
  let level = 'none';
  if (risk.risk_score <= 0) return { level: 'none', risk };
  for (const r of rules) {
    const inRange = risk.risk_score >= r.risk_min && risk.risk_score <= r.risk_max;
    const hardCapHit = r.any_line_over != null && risk.max_line_discount > r.any_line_over;
    if (inRange || hardCapHit) { level = r.level; break; }
  }
  return { level, risk };
}

/* ============ 3. TOTALS / MARGIN ============ */
function recomputeTotals(quotationId) {
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(quotationId);
  if (!q) return null;
  const lines = db.prepare('SELECT * FROM quotation_lines WHERE quotation_id=?').all(quotationId);
  const od = q.order_discount_pct || 0;
  let subtotal = 0, discountTotal = 0, taxTotal = 0, costTotal = 0;
  for (const l of lines) {
    const gross = l.qty * l.unit_price;
    const eff = effectiveDiscount(l.discount_pct, od);
    const net = gross * (1 - eff / 100);
    subtotal += gross; discountTotal += gross - net; taxTotal += net * ((db.prepare('SELECT tax_rate FROM products WHERE id=?').get(l.product_id) || { tax_rate: 0 }).tax_rate) / 100;
    costTotal += l.qty * l.cost_price;
  }
  const total = subtotal - discountTotal + taxTotal;
  const margin = total > 0 ? (total - costTotal) / total * 100 : 0;
  const { risk_score, max_violation } = computeRisk(q);
  db.prepare(`UPDATE quotations SET subtotal=?, discount_total=?, tax_total=?, total=?, cost_total=?, margin_pct=?, risk_score=?, max_violation=?, last_activity_at=datetime('now') WHERE id=?`)
    .run(r2(subtotal), r2(discountTotal), r2(taxTotal), r2(total), r2(costTotal), r1(margin), risk_score, max_violation, quotationId);
  return db.prepare('SELECT * FROM quotations WHERE id=?').get(quotationId);
}
const r2 = (x) => Math.round(x * 100) / 100;
const r1 = (x) => Math.round(x * 10) / 10;

/* ============ 4. UPSELL / CROSS-SELL ENGINE ============ */
/* Rank by co-purchase score + promotion boost; only suggestions whose own margin clears the configured floor. */
function upsellSuggestions(quotationId) {
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(quotationId);
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(q.customer_id);
  const lines = db.prepare('SELECT * FROM quotation_lines WHERE quotation_id=?').all(quotationId);
  const inCart = new Set(lines.map(l => l.product_id));
  const minMargin = parseFloat(getSetting('min_margin_pct', 30));
  const scores = new Map(); // product_id -> best score
  for (const l of lines) {
    const rules = db.prepare(`SELECT u.*, p.promoted FROM upsell_rules u JOIN products p ON p.id=u.suggested_product_id
      WHERE u.trigger_product_id=? AND u.active=1 AND p.active=1`).all(l.product_id);
    for (const r of rules) {
      if (inCart.has(r.suggested_product_id)) continue;
      const score = r.co_score + (r.promoted ? 0.15 : 0);
      const prev = scores.get(r.suggested_product_id) || 0;
      if (score > prev) scores.set(r.suggested_product_id, score);
    }
  }
  const out = [];
  for (const [pid, score] of scores) {
    const p = db.prepare('SELECT p.*, c.name category_name FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=?').get(pid);
    if (!p) continue;
    const price = unitPriceFor(pid, null, customer);
    const marginPct = price > 0 ? (price - p.cost_price) / price * 100 : 0;
    if (marginPct < minMargin) continue; // unhealthy-margin suggestions never surface
    // margin delta if added at qty 1
    const revenue = price, margin$ = price - p.cost_price;
    const cur = db.prepare('SELECT total, cost_total FROM quotations WHERE id=?').get(quotationId);
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
function suggestSplit(quotationId) {
  const lines = db.prepare(`SELECT l.*, p.stocked, p.name FROM quotation_lines l JOIN products p ON p.id=l.product_id
    WHERE l.quotation_id=? AND p.stocked=1 AND l.line_type='one_time'`).all(quotationId);
  const warehouses = db.prepare('SELECT * FROM warehouses WHERE active=1').all();
  const baseShip = parseFloat(getSetting('base_ship_cost', 18));
  const usedWH = new Set();
  const plan = []; let shipments = 0; let estCost = 0;
  const committed = {}; // "wh:product" -> qty already earmarked by this plan (so two lines don't double-count the same stock)
  const availability = (wid, pid) => {
    const row = db.prepare('SELECT qty FROM stock_levels WHERE warehouse_id=? AND product_id=?').get(wid, pid);
    const taken = committed[`${wid}:${pid}`] || 0;
    return (row ? row.qty : 0) - taken;
  };
  for (const l of lines) {
    let remaining = l.qty;
    const order = [...warehouses].sort((a, b) => {
      const ua = usedWH.has(a.id) ? 1 : 0, ub = usedWH.has(b.id) ? 1 : 0;
      if (ua !== ub) return ub - ua; // consolidate into warehouses already shipping this order
      const aa = availability(a.id, l.product_id), ab = availability(b.id, l.product_id);
      if (aa !== ab) return ab - aa; // largest availability first → fewest splits
      return a.shipping_cost_weight - b.shipping_cost_weight;
    });
    for (const wh of order) {
      if (remaining <= 0) break;
      const avail = Math.max(0, Math.min(availability(wh.id, l.product_id), remaining));
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
function canConsolidate(quotationId) {
  const rows = db.prepare(`SELECT fs.*, l.product_id FROM fulfillment_splits fs JOIN quotation_lines l ON l.id=fs.line_id
    WHERE fs.quotation_id=? AND fs.status='backorder'`).all(quotationId);
  for (const r of rows) {
    const whs = db.prepare('SELECT warehouse_id, qty FROM stock_levels WHERE product_id=? AND qty>0').all(r.product_id);
    if (whs.length) return true;
  }
  return false;
}

/* ============ 6. BILLING / SUBSCRIPTION ENGINE ============ */
function periodAddMonths(date, months) {
  const d = new Date(date); d.setMonth(d.getMonth() + months); return d;
}
function periodMonths(period) { return period === 'monthly' ? 1 : period === 'quarterly' ? 3 : 12; }
function nextInvoiceNumber() {
  const row = db.prepare(`SELECT number FROM invoices WHERE number LIKE 'INV-%' ORDER BY CAST(substr(number,5) AS INTEGER) DESC LIMIT 1`).get();
  const n = row ? parseInt(row.number.slice(4), 10) + 1 : 2033;
  return `INV-${n}`;
}
/* On confirmation: one-time lines → single invoice; recurring lines → first-cycle invoice + future schedule. */
function generateBillingOnConfirm(quotationId) {
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(quotationId);
  if (!q) return;
  const existing = db.prepare('SELECT COUNT(*) c FROM invoices WHERE quotation_id=?').get(quotationId).c;
  if (existing > 0) return;
  const lines = db.prepare('SELECT * FROM quotation_lines WHERE quotation_id=?').all(quotationId);
  const od = q.order_discount_pct || 0;
  const now = new Date().toISOString();
  let oneTimeNet = 0, oneTimeTax = 0;
  for (const l of lines.filter(l => l.line_type === 'one_time')) {
    const net = l.qty * l.unit_price * (1 - effectiveDiscount(l.discount_pct, od) / 100);
    oneTimeNet += net;
    oneTimeTax += net * ((db.prepare('SELECT tax_rate FROM products WHERE id=?').get(l.product_id) || { tax_rate: 0 }).tax_rate) / 100;
  }
  if (oneTimeNet > 0) {
    db.prepare('INSERT INTO invoices(number,quotation_id,customer_id,kind,amount,status,due_date) VALUES(?,?,?,?,?,?,?)')
      .run(nextInvoiceNumber(), quotationId, q.customer_id, 'one_time', r2(oneTimeNet + oneTimeTax), 'open', now.slice(0, 10));
  }
  for (const l of lines.filter(l => l.line_type === 'subscription')) {
    const net = l.qty * l.unit_price * (1 - effectiveDiscount(l.discount_pct, od) / 100);
    const inv = db.prepare('INSERT INTO invoices(number,quotation_id,customer_id,kind,amount,status,due_date) VALUES(?,?,?,?,?,?,?)')
      .run(nextInvoiceNumber(), quotationId, q.customer_id, 'recurring', r2(net), 'open', now.slice(0, 10));
    db.prepare(`INSERT INTO billing_schedule(quotation_id,line_id,scheduled_date,description,amount,status,invoice_id)
      VALUES(?,?,?,?,?,?,?)`).run(quotationId, l.id, now.slice(0, 10), `${l.description} — cycle 1`, r2(net), 'invoiced', Number(inv.lastInsertRowid));
    const months = periodMonths(l.billing_period || 'monthly');
    for (let i = 1; i <= 11; i++) {
      const d = periodAddMonths(now, months * i).toISOString().slice(0, 10);
      db.prepare(`INSERT INTO billing_schedule(quotation_id,line_id,scheduled_date,description,amount,status,invoice_id)
        VALUES(?,?,?,?,?,?,?)`).run(quotationId, l.id, d, `${l.description} — cycle ${i + 1}`, r2(net), 'scheduled', null);
    }
  }
}
/* Mid-cycle quantity change → daily proration credit/charge for the remainder of the current cycle. */
function prorateLineChange(line, newQty) {
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(line.quotation_id);
  const months = periodMonths(line.billing_period || 'monthly');
  const cycleEnd = periodAddMonths(new Date(), months); // current cycle boundary (approx from today for demo)
  const daysInCycle = Math.max(1, Math.round((cycleEnd - new Date()) / 86400000) + 30);
  const daysRemaining = Math.max(0, Math.round((cycleEnd - new Date()) / 86400000));
  if (daysRemaining <= 0) return null;
  const od = q.order_discount_pct || 0;
  const price = line.unit_price * (1 - effectiveDiscount(line.discount_pct, od) / 100);
  const delta = (newQty - line.qty) * price * (daysRemaining / Math.max(1, daysInCycle));
  return { delta: r2(delta), days_remaining: daysRemaining, days_in_cycle: daysInCycle };
}
/* Cancel subscription → credit note per plan policy. */
function cancelSubscriptionCredit(line) {
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(line.quotation_id);
  const plan = line.plan_id ? db.prepare('SELECT * FROM subscription_plans WHERE id=?').get(line.plan_id) : null;
  const od = q.order_discount_pct || 0;
  const net = line.qty * line.unit_price * (1 - effectiveDiscount(line.discount_pct, od) / 100);
  let refund = 0, policy = 'none';
  if (plan) {
    policy = plan.cancellation_policy;
    const months = periodMonths(plan.billing_period);
    const cycleEnd = periodAddMonths(new Date(), months);
    const daysRemaining = Math.max(0, Math.round((cycleEnd - new Date()) / 86400000));
    const daysInCycle = 30 * months;
    if (policy === 'refund_prorated') refund = net * daysRemaining / daysInCycle;
    else if (policy === 'refund_pct') refund = net * plan.refund_pct / 100 * daysRemaining / daysInCycle;
  }
  return { refund: r2(refund), policy };
}
function generateDueInvoices(quotationId) {
  const due = db.prepare(`SELECT * FROM billing_schedule WHERE quotation_id=? AND status='scheduled' AND scheduled_date<=date('now')`).all(quotationId);
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(quotationId);
  let created = 0;
  for (const s of due) {
    const inv = db.prepare('INSERT INTO invoices(number,quotation_id,customer_id,kind,amount,status,due_date) VALUES(?,?,?,?,?,?,?)')
      .run(nextInvoiceNumber(), quotationId, q.customer_id, 'recurring', s.amount, 'open', s.scheduled_date);
    db.prepare(`UPDATE billing_schedule SET status="invoiced", invoice_id=? WHERE id=?`).run(Number(inv.lastInsertRowid), s.id);
    created++;
  }
  return created;
}

/* ============ 7. DEAL HEALTH ENGINE ============ */
/* Idempotently materializes stalled / anomaly / slippage alerts. */
function refreshAlerts() {
  const stalledDays = parseInt(getSetting('stalled_days', 3));
  const anomalyMult = parseFloat(getSetting('anomaly_multiplier', 1.5));
  const slipDays = parseInt(getSetting('slippage_days', 2));
  const insAlert = db.prepare(`INSERT INTO alerts(kind,quotation_id,message,severity) VALUES(?,?,?,?)
    ON CONFLICT(kind,quotation_id) DO UPDATE SET message=excluded.message, updated_at=datetime('now')`);

  // stalled: draft/sent/negotiating with no activity for N days
  const stalled = db.prepare(`SELECT q.*, c.name customer_name, c.id FROM quotations q JOIN customers c ON c.id=q.customer_id
    WHERE q.status IN ('draft','sent','negotiating') AND julianday('now') - julianday(q.last_activity_at) > ?`).all(stalledDays);
  for (const q of stalled) {
    const days = Math.floor((Date.now() - new Date(q.last_activity_at + 'Z').getTime()) / 86400000);
    insAlert.run('stalled', q.id, `${q.number} (${q.customer_name}) inactive for ${days} days — status: ${q.status}`, 'medium');
  }
  // anomaly: confirmed quote whose avg discount far exceeds the rep's own historical average
  const quotes = db.prepare(`SELECT q.*, c.name customer_name FROM quotations q JOIN customers c ON c.id=q.customer_id
    WHERE q.status IN ('confirmed','fulfilled')`).all();
  const byRep = {};
  for (const q of quotes) {
    const avgDisc = q.subtotal > 0 ? q.discount_total / q.subtotal * 100 : 0;
    (byRep[q.rep_id] = byRep[q.rep_id] || []).push({ q, avgDisc: r1(avgDisc) });
  }
  for (const [repId, arr] of Object.entries(byRep)) {
    if (arr.length < 3) continue; // need a baseline before flagging
    const sorted = [...arr].sort((a, b) => a.q.confirmed_at?.localeCompare(b.q.confirmed_at || '') || 0);
    for (let i = 1; i < sorted.length; i++) {
      const baseline = sorted.slice(0, i).reduce((s, x) => s + x.avgDisc, 0) / i;
      if (baseline > 0 && sorted[i].avgDisc > baseline * anomalyMult) {
        insAlert.run('anomaly', sorted[i].q.id,
          `${sorted[i].q.number} (${sorted[i].q.customer_name}): ${sorted[i].avgDisc}% avg discount vs rep baseline ${r1(baseline)}% (×${anomalyMult})`, 'high');
      }
    }
  }
  // slippage: confirmed & not fully shipped past promised delivery
  const slipping = db.prepare(`SELECT q.*, c.name customer_name FROM quotations q JOIN customers c ON c.id=q.customer_id
    WHERE q.status IN ('confirmed','fulfilling') AND q.expected_delivery IS NOT NULL AND julianday('now') - julianday(q.expected_delivery) > ?`).all(slipDays);
  for (const q of slipping) {
    const openBO = db.prepare(`SELECT COUNT(*) c FROM fulfillment_splits WHERE quotation_id=? AND status IN ('planned','backorder')`).get(q.id).c;
    if (openBO > 0) {
      insAlert.run('slippage', q.id, `${q.number} (${q.customer_name}) past promised delivery with ${openBO} open fulfillment line(s)`, 'high');
    }
  }
}
function repBaselineDiscount(repId, excludeQuoteId) {
  const rows = db.prepare(`SELECT subtotal, discount_total FROM quotations WHERE rep_id=? AND id!=? AND status IN ('confirmed','fulfilled') AND subtotal>0`).all(repId, excludeQuoteId);
  if (!rows.length) return null;
  return r1(rows.reduce((s, r) => s + r.discount_total / r.subtotal * 100, 0) / rows.length);
}

/* ============ 7b. APPROVAL ROUTING ============ */
/* Creates the full approval chain for a quotation at the required level: manager is always step 1, finance step 2 when required. */
function routeForApproval(quotationId, level) {
  db.prepare('DELETE FROM approvals WHERE quotation_id=?').run(quotationId);
  if (level === 'none') return;
  db.prepare(`INSERT INTO approvals(quotation_id,level,sequence,status) VALUES(?,?,1,'pending')`).run(quotationId, 'manager');
  if (level === 'finance') db.prepare(`INSERT INTO approvals(quotation_id,level,sequence,status) VALUES(?,?,2,'waiting')`).run(quotationId, 'finance');
}

/* ============ 8. AUDIT ============ */
function audit(entity, entityId, user, action, details) {
  db.prepare('INSERT INTO audit_log(entity,entity_id,user_id,user_name,action,details) VALUES(?,?,?,?,?,?)')
    .run(entity, entityId, user ? user.id : null, user ? user.name : 'system', action, details || '');
}

module.exports = {
  tierPriceRule, unitPriceFor, allowedDiscountFor, effectiveDiscount, computeRisk, requiredApprovalLevel,
  recomputeTotals, upsellSuggestions, suggestSplit, canConsolidate, generateBillingOnConfirm,
  prorateLineChange, cancelSubscriptionCredit, generateDueInvoices, refreshAlerts, repBaselineDiscount,
  routeForApproval, audit, r1, r2, nextInvoiceNumber,
};

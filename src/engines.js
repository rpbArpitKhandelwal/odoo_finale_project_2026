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

module.exports = {
  tierPriceRule, unitPriceFor, allowedDiscountFor, effectiveDiscount, computeRisk, requiredApprovalLevel, recomputeTotals, r1, r2,
};

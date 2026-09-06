# 🎬 DealFlow360 — 5-Minute Demo Script

Two complete end-to-end flows, exactly as the brief asks: **(A)** a governed high-discount deal from quotation → auto-routed approval → multi-warehouse fulfillment → hybrid billing → payment → commission, and **(B)** a customer negotiating in the portal whose confirmation re-enters approval by itself. Flow C is a 30-second control-room finish if time allows.

**Prep (2 min before):**
- `npm run reset` then `npm start` (or `start.bat`) → http://localhost:4300. The seed is deterministic — every number below is what you will see.
- Tab 1: staff app, logged in as **rep@dealflow.io / Rep@123**. Tab 2: `http://localhost:4300/#/portal` (customer portal, keep it on the sign-in page).
- Say once at the start: *"The avatar menu is a persona switcher — one click moves me between Rep, Manager, Finance and Admin. No logging out."*

---

## Flow A — The self-governing deal (≈ 3 min)

### 1. Rep builds a risky quote (40 s)
Quotations → **＋ New** → customer **Acme Corp — gold (USD)** → Create.
- **＋ Add line** → *Laptop Pro 15"* → qty **10**, discount **12 %** → the unit price is **$1,234.05** (5 % Gold Partner pricelist applied automatically), ceiling 15 %, no badge.
- **＋ Add line** → *Installation & Setup* → discount **18 %**.
- Instantly: the service line shows **+8 over** in red (Services ceiling is 10 % even for Gold), the header **blended risk jumps to 8.0** and reads *routes to Manager → Finance*. The **live margin bar** sits around 20 %.
- Click **+** on the laptop quantity stepper once and back **−** to show totals, margin and risk recompute on every keystroke.

**Say:** *"Every line is checked live against the stricter of the customer tier and the product category. A Gold customer does not get Gold freedom on thin-margin services. The blended score counts the worst line fully and half of every other overage — spreading small over-discounts across many lines cannot slip through either."*

*(The split in step 5 is computed after the monitor upsell in step 2, so Main ships 9 units: 8 laptops + 1 monitor.)*

### 2. Upsell panel (20 s)
Right panel: ranked suggestions from co-purchase history (**27" 4K Monitor 0.96** — promoted, boosted +0.15), each with **+margin delta** and the order margin after adding.
→ **Add** the top one → the line appears, total and margin update, the monitor disappears from the ranking.
→ **Dismiss** one suggestion → it moves to the dismissed list with an undo.

**Say:** *"Margin-guarded — anything under the configured 30 % margin floor never appears. You see the margin impact before you add."*

### 3. Auto-routing (15 s)
→ **Submit for approval ▸** → status **To Approve (Manager)**, toast *"Submitted — risk routing applied"*. Open the **Approvals** tab: chain **Manager (pending) → Finance (waiting)** and the per-line breakdown (Laptop ✓, Installation +8).

**Say:** *"Nobody filed an approval request. The score decided the chain."*

### 4. Manager → Finance (30 s)
Avatar menu → **Achintya Rai (Manager)** → open the quote → **Approve / Reject ▼ → ✅ Approve** → status flips to **To Approve (Finance)** automatically.
Avatar menu → **Arpit Khandelwal (Finance)** → same quote → **✅ Approve** → **Approved**.

### 5. Multi-warehouse split on free stock (25 s)
Back to **Gangadhar (Rep)** → **Fulfillment** tab. Suggested split: **Main Warehouse 9 (8 laptops + the monitor) + East Depot 2 laptops — 2 shipments, est. $43.20** (Main has 8 laptops, East 6 — largest availability first, warehouses already shipping the order are reused, then cheapest freight).
→ **Accept split → confirm order**. Show the **Manual override** button too.

**Say:** *"The split only promises free stock — units already planned for other confirmed orders are excluded. Stock decrements when a shipment actually leaves."*

### 6. Bill → pay → commission generates itself (30 s)
**Invoicing** tab: the one-time invoice for the whole order. (*Recurring lines show a separate cycle-1 invoice plus a 12-month schedule — Flow B's QT-1032 has one.*)
→ **💰 Pay** → **PAID** → toast mentions the commission.
→ **Commission** tab: a **draft commission** appeared, rule-matched (*Gangadhar — Star Rep Plan, 5 %*).

**Say:** *"The moment cash lands, the engine picks the most specific rule — product over category over salesperson over team — and computes the payout. Rep confirms, manager approves, finance settles."*

---

## Flow B — Customer portal negotiation → automatic re-approval (≈ 1.5 min)

### 7. The customer signs in (15 s)
Tab 2 (`/#/portal`) → click **buyer@deltalog.com** → **Open my quotations** → Delta Logistics sees **only its own** quotations → open **QT-1032** (status **Sent**, one-time laptop + recurring *Cloud Backup Pro* line).

**Say:** *"This is a separate, restricted surface — its own login cookie, or a per-quotation secure link the rep copies from the Customer tab. Staff sessions are rejected here; customers only ever see their own company's documents."*

### 8. Line-level negotiation (30 s)
- Click **💬** on the *Laptop Pro* line → type *"Can you include onboarding at this price?"* → **Send question** → status **Under Negotiation**.
- Switch to Tab 1 as **Gangadhar** → open QT-1032 → **Customer** tab (badge shows 1 open) → reply *"Onboarding is included — happy to add a training day at 10 %."* → **Send reply to portal**.
- Back in Tab 2 the staff reply appears in the thread (it refreshes itself every 15 s, or reload).
- **Counter-offer: 22 %** → **Submit counter-offer** → **✔ Confirm quotation**.

### 9. Governance takes over (20 s)
Portal now reads **Confirmed — awaiting internal approval**. In Tab 1 the quote shows an orange banner: *customer confirmed negotiated terms … re-entered the approval flow automatically*; the Approvals tab shows a fresh **Manager → Finance** chain (22 % breaks the 12 % subscription ceiling and the 15 % hardware ceiling) and the audit trail logs the re-route.

**Say:** *"The same risk engine runs on submit, on rep-accepted counters and on portal confirmations — one path, one audit trail. Had the customer countered at 10 %, confirmation would have gone straight to fulfillment."*

---

## Flow C — Control room (if time allows, 30 s)

- **Dashboard**: KPI chips, revenue chart, **deal-health alerts** — stalled deal (QT-1018, 12 days idle), discount anomalies (QT-1010 closed at 16.2 % vs Gangadhar's 0.8 % baseline; QT-1041 flagged *before* it closes), delivery slippage (QT-1025) — each with **Nudge / Escalate / Dismiss** and click-through.
- **Warehouses** (as Finance): the USB-C dock is sold out everywhere and QT-1025 has 2 docks on backorder. Click **⟳ Run replenishment rules** (or **Restock** the dock at East Depot) → toast *"Stock arrived for backordered order QT-1025 — prompt raised"*, a 📦 alert appears in the bell, and QT-1025 shows the green **Consolidate Remaining Backorder** banner → click it → the units become a planned shipment.
- **Invoices & Billing** (as Finance): **⟳ Run recurring billing (N due)** invoices every subscription cycle whose date has arrived across all ~270 orders in one click — the receivables KPI jumps immediately.
- **Reporting → Sales Analytics**: 8 months of history, filter by period / rep / approval / category → **⬇ PDF / XLS / CSV** (totals in USD equivalent).

---

## Q&A ammo

- **"Is the risk score hardcoded?"** No — tier ceilings, category ceilings and the risk-range → approver mapping are edited live in *Discount Governance*; routing recomputes on every submit and every confirmation.
- **"Does the split really check stock?"** Yes — suggestions use free stock (on hand − reserved by other orders); shipping decrements stock; restocking re-evaluates every open backorder and raises the consolidate prompt automatically.
- **"How does proration work?"** Cycles are anchored on the last invoiced date. Δqty × unit × days remaining ÷ days in cycle, invoiced immediately (or applied next cycle if the plan says *no proration*). Cancellation credits follow the plan policy after its notice period.
- **"Portal security?"** Separate cookie, per-quotation tokens, tenant check on every read — cross-customer access is tested and blocked.
- **"How do you know nothing is broken?"** `npm test` — 102 end-to-end checks over HTTP covering the official 8 steps plus the edge cases.
- **"Stack?"** React 18 (Vite, zero UI libs) · Node.js + Express 5 · PostgreSQL (24 tables) · Docker Compose for a one-command environment.

Architecture one-pager: **docs/architecture.svg**.

<p align="center">
  <img src="docs/logo.svg" width="96" alt="DealFlow360 logo" />
</p>

<h1 align="center">DealFlow360</h1>

<p align="center"><b>An Intelligent, Self-Governing Sales Operations Platform</b><br/>
Quotation → Approval → Negotiation → Fulfillment → Billing → Commission → Reporting — governed by rules, not by chasing people.</p>

<p align="center">
  <img alt="stack" src="https://img.shields.io/badge/React_18-Vite-61DAFB?logo=react&logoColor=white&labelColor=1F2328" />
  <img alt="node" src="https://img.shields.io/badge/Node.js_22-Express_5-339933?logo=node.js&logoColor=white&labelColor=1F2328" />
  <img alt="db" src="https://img.shields.io/badge/PostgreSQL-24_tables-4169E1?logo=postgresql&logoColor=white&labelColor=1F2328" />
  <img alt="tests" src="https://img.shields.io/badge/E2E_checks-102_passing-0F7B3D?labelColor=1F2328" />
  <img alt="latency" src="https://img.shields.io/badge/API_latency-%3C10_ms_median-714B67?labelColor=1F2328" />
  <img alt="deps" src="https://img.shields.io/badge/UI_%2F_chart_%2F_export_libs-0-B3611E?labelColor=1F2328" />
</p>

<p align="center">
  <a href="#-quick-start">Quick start</a> ·
  <a href="#-five-minute-demo">Demo</a> ·
  <a href="#-what-it-does-mapped-to-the-brief">Features</a> ·
  <a href="#-how-the-engines-decide">Engines</a> ·
  <a href="#-architecture">Architecture</a> ·
  <a href="#-security-model">Security</a> ·
  <a href="#-performance">Performance</a> ·
  <a href="#-testing">Testing</a> ·
  <a href="#-what-wed-build-next">Roadmap</a>
</p>

---

## Why this exists

Most sales tools stop at *quote → confirm → invoice*. Real B2B teams live in messier conditions:

- discounts that need **two levels of approval** depending on how far over the line they go,
- stock **spread across warehouses**, with backorders that nobody remembers to release,
- **subscriptions mixed with one-time hardware** on the same order, prorated mid-cycle,
- customers who want to **negotiate line by line** instead of over email,
- managers who find out a deal is **stuck or over-discounted** only after it is lost.

**DealFlow360 makes the deal govern itself.** Every discount is checked live against tier *and* category ceilings; risky quotes route their own approvals; orders split themselves across warehouses on *free* stock; subscriptions and one-time lines bill together with real proration; customers negotiate in a restricted portal whose confirmations re-enter approval automatically; and commissions pay out the moment cash lands. Everything is configurable live and written to an audit trail.

---

## ✨ What it does (mapped to the brief)

| Brief | Module | What you get |
|---|---|---|
| A1 | **Authentication** | Staff signup/login (scrypt), 5 roles with RBAC on every endpoint. Customer portal login **or** per-quotation secure link on a separate cookie surface |
| A2 | **Products & price lists** | Categories, variants with extra price, tier × currency price lists (discount or markup), plan pricing for subscriptions |
| A3 | **Discount governance** | Tier ceilings (Bronze 5 / Silver 10 / Gold 15), category ceilings, **blended risk score**, approval chain Manager → Finance with hard caps. Every decision audited with user, timestamp, reason |
| A4 | **Warehouses** | Stock per warehouse, reorder point + replenishment lot with a **one-click replenishment run**, shipping-cost weighting used by the split engine |
| A5 | **Subscription plans** | Monthly / quarterly / yearly, proration rule (daily or none), cancellation policy (prorated / % / none) with notice period |
| A6 | **Upsell rules** | Co-purchase scores, promoted boost, minimum-margin floor |
| A7 | **Reporting** | Period / rep / approval / product / category filters, **PDF · XLS · CSV** export, all money normalised to a reporting currency |
| B1–B3 | **Sales workspace** | Quotations list, Pipeline kanban, *Reload Data / Go to Back-end / Close Workspace*; builder with +/− quantities, line & order discounts, ceiling badges, **live margin indicator**, KPI chips that filter the list |
| B4 | **Approval screen** | Blended score, per-line breakdown, chain timeline, approve / return / reject with reasons, confirmation in the audit trail |
| B5 | **Upsell panel** | Ranked suggestions with margin delta and promotion tag; Add / Dismiss (with undo). Totals and margin update instantly |
| B6 | **Fulfillment split** | Suggested split on **free stock** (units promised to other orders excluded), shipment count + cost, Accept / Manual override, backorders. **A restock raises the "Consolidate Remaining Backorder" prompt automatically** |
| B7 | **Billing** | One-time and recurring lines invoiced separately, 12-month schedule, **cycle-anchored proration**, cancel → credit note per policy, **recurring billing run** for every due cycle |
| B8 | **Customer portal** | Restricted surface; statuses *Sent / Under Negotiation / Confirmed*; **line-level questions and change requests**, counter-offer, one-click confirm; rep replies in-thread; **auto re-approval** when terms breach ceilings |
| B9 | **Deal health** | Stalled, discount anomaly (incl. early warning on live quotes), delivery slippage, backorder-ready alerts. Click-through, nudge, escalate |
| + | **Commissions** | Rule engine (product › category › rep › team › all; % / fixed / margin-tiered), generated on full payment, draft → confirmed → approved → paid with settlement runs and statements |

---

## 🚀 Quick start

### Option A — Docker (nothing to install)
```bash
docker compose up --build        # → http://localhost:4300
```

### Option B — local PostgreSQL 14+
```bash
# one-time, in psql as a superuser
CREATE USER dealflow WITH PASSWORD 'DealFlow@2026';
CREATE DATABASE dealflow360 OWNER dealflow;

# install both packages, build the React client, run
npm run setup
npm start                        # → http://localhost:4300
```
Windows: double-click **`start.bat`**. Dev mode with hot reload: `npm start` + `npm run client` (Vite on :5173 proxies `/api`).

Connection defaults `localhost:5432 / dealflow / DealFlow@2026 / dealflow360`; override with `PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE` (see [`.env.example`](.env.example)). The schema, indexes and a deterministic demo dataset are created on first start.

| Command | What it does |
|---|---|
| `npm start` | API + built React app on **http://localhost:4300** |
| `npm run reset` | Drop and reseed the demo database (identical data every time) |
| `npm test` | 102-check end-to-end suite over HTTP (`DF_PORT=4310 npm test` for another port) |
| `npm run test:fresh` | Reset, then test |

### Deploy to the cloud (free)
The repo ships a **Render Blueprint** ([`render.yaml`](render.yaml)): *Render dashboard → New → Blueprint → pick this repo → Apply* creates the web service and a PostgreSQL database and deploys on every push. The app also runs unchanged on Railway, Fly.io or any Docker host — it reads `DATABASE_URL`, honours `PORT`, exposes `/api/health` and seeds itself on first start. Step-by-step: **[docs/DEPLOY.md](docs/DEPLOY.md)**.

### The demo dataset
10 customers (USD and INR, all three tiers), 4 sales reps in 2 teams, **~270 quotations over 8 months**: ~200 fulfilled with paid invoices, shipments, subscription schedules and commissions, plus live quotes in every stage. Every seeded quotation is priced, risk-scored and approval-levelled by the same engines the live app uses, so nothing on screen is hand-typed.

---

## 👤 Demo accounts

| Role | Email | Password | Show |
|---|---|---|---|
| Sales Rep — Gangadhar (Enterprise) | `rep@dealflow.io` | `Rep@123` | Builder, upsell panel, portal replies, commissions |
| Sales Rep — Vikram Singh (SMB) | `rep2@dealflow.io` | `Rep@123` | Team reports |
| Sales Reps — Neha Iyer, Karan Mehta | `rep3@dealflow.io`, `rep4@dealflow.io` | `Rep@123` | Leaderboard, statements |
| Sales Manager — Achintya Rai | `manager@dealflow.io` | `Manager@123` | Approval inbox, deal health, commission approval |
| Finance — Arpit Khandelwal | `finance@dealflow.io` | `Finance@123` | 2nd-level approvals, restock, replenishment, billing run, settlement |
| Admin | `admin@dealflow.io` | `Admin@123` | All backend configuration |
| Customer — Acme Corp (gold) | `buyer@acmecorp.com` | `Customer@123` | Portal: own quotations only |
| Customer — Gamma Retail (bronze, INR) | `buyer@gammaretail.in` | `Customer@123` | Portal, INR quotes |
| Customer — Delta Logistics (gold) | `buyer@deltalog.com` | `Customer@123` | Portal negotiation on **QT-1032** |

The **avatar menu (top right) switches persona** in one click. **🌐 Customer Portal** opens the separate surface in a new tab (`/#/portal`). Every quotation also has a per-quotation **secure link** (`/#/portal/q/QT-1032?k=…`, in the quotation's *Customer* tab) that opens that one quotation without any login.

---

## 🎬 Five-minute demo

Full script with timings and talking points: **[DEMO_GUIDE.md](DEMO_GUIDE.md)**. In short:

**Flow A — the self-governing deal.** Build a Gold quote with a 12 % laptop discount (fine) and an 18 % service discount (+8 over its 10 % ceiling) → the risk bar reads 8.0 and *routes to Manager → Finance*. Accept the promoted upsell; totals and margin move instantly. Submit → the chain creates itself. Approve as Manager, then Finance. The Fulfillment tab proposes *Main 9 + East 2, 2 shipments, $43.20* on free stock → accept. Pay the invoice → the rep's commission drafts itself.

**Flow B — portal negotiation.** The customer signs in, sees only their company's quotations, asks a question on a specific line, gets the rep's reply in the same thread, counters at 22 % and confirms. The portal reads *Confirmed — awaiting internal approval*; the staff side shows the quote **re-entered the approval flow automatically** with a fresh Manager → Finance chain.

**Flow C — control room.** Deal-health alerts with nudge / escalate; run replenishment rules and watch the *Consolidate Remaining Backorder* banner appear; run recurring billing for every due subscription cycle; export the filtered sales report.

### The official 8-step Quick Test Flow
1. **Configure** products, price lists, tiers, warehouses, plans, upsell rules — all live, no restart.
2. **Build** a quotation with a discount above the ceiling → the line shows `+N over` and the risk bar moves.
3. **Submit** → routed to Manager (or Manager → Finance) without anyone asking.
4. **Accept an upsell** → total and margin update immediately, suggestion re-ranks away.
5. **Approve** as Manager then Finance → split suggested across warehouses on free stock; accept or override.
6. **Billing** → one-time and recurring invoices separate; change a subscription quantity → prorated charge for the days left in the current cycle.
7. **Portal** → counter at a bigger discount and confirm → the quote re-enters approval automatically.
8. **Pay** → invoice PAID → commission drafted.

`npm test` automates all eight plus tenant isolation, reserved stock, automatic backorder prompts, replenishment, proration rules, cancellation credits, validation and currency normalisation.

---

## 🧠 How the engines decide

All business rules live in [`src/engines.js`](src/engines.js). Every route calls the same functions, so the builder, a rep accepting a counter, and a customer confirming on the portal all get identical answers.

**Blended discount risk & routing**
```
allowed(line)   = min(customer-tier ceiling, product-category ceiling)
effective(line) = line% + order% × (1 − line%/100)
violation(line) = max(0, effective − allowed)
risk            = worst violation + 0.5 × Σ(other violations)
level           = approval_rules match on risk range or hard cap "any line over X%"
                  → none · Sales Manager · Sales Manager → Finance   (any violation with no matching rule → Manager)
```
The worst line counts fully; smaller overages spread across many lines still add up, so a rep cannot keep every line "almost within limits" while giving the order away.

**Upsell** — co-purchase score per trigger product, +0.15 for promoted items, filtered by a configurable margin floor; each suggestion shows the margin delta and the order margin after adding.

**Warehouse split** — free stock only (`on hand − units planned for other confirmed orders`); greedy: reuse a warehouse already shipping this order › largest availability › cheapest freight; remainder becomes a backorder at the cheapest depot. Stock decrements when a shipment leaves. A restock or replenishment run re-evaluates every open backorder and raises the consolidate prompt.

**Hybrid billing** — one-time lines invoice at confirmation; each recurring line bills cycle 1 and schedules a 12-month horizon. Cycles are anchored on the last invoiced date: `Δqty × unit × days remaining ÷ days in cycle` (or none, per plan). Cancellation credit = policy × unused days after the notice period.

**Deal health** — stalled (no activity > N days), discount anomaly vs the rep's own baseline (material gap, recent deals, plus early warning on live quotes), delivery slippage, backorder-ready. Thresholds are settings.

**Commissions** — on full payment the most specific active rule wins (product › category › salesperson › team › all): flat %, fixed, or margin-tiered. Lifecycle draft → confirmed → approved → paid with finance settlement runs; INR invoices convert to USD at the quote's rate.

---

## 🏗 Architecture

**One-page architecture & data model: [docs/architecture.svg](docs/architecture.svg)** (also served by the app at `/docs/architecture.svg`) · narrative with Mermaid: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

```
client/                    React 18 + Vite SPA — Odoo-inspired design system, hand-built SVG charts, zero UI libraries
  src/pages/               Sales (workspace, builder, approvals, fulfillment, billing, customer thread, audit)
                           Portal (separate surface) · Dashboard · Reports · Catalog · Warehouses · Invoices · Commissions · Admin
  src/components/          Navbar (persona switcher, alert bell), ListView, charts, Logo, ui kit
server.js                  Express 5 — /api + built client + /docs
src/db.js                  PostgreSQL layer (pg pool, ?→$n shim, schema, idempotent migrations, deterministic seed + volume generator)
src/engines.js             pricing · blended risk & routing · upsell · warehouse split · billing & proration · deal health ·
                           replenishment · commission · audit
src/routes/                auth · config · sales · ops (fulfillment, billing) · portal · dash (KPIs, reports) · commissions
src/util.js                sessions, scrypt, RBAC middleware (requireInternal · requireRole · requirePortal)
src/exporter.js            dependency-free CSV / XLS (SpreadsheetML) / PDF writers · src/invoiceDoc.js invoice PDFs
test-e2e.js                102-check end-to-end suite over HTTP
docker-compose.yml         PostgreSQL + app, one command
```

**Data model (24 tables)** — identity (`users`, `sessions`, `customers`) · catalog (`categories`, `products`, `product_variants`, `price_lists`, `subscription_plans`, `product_plans`, `upsell_rules`) · governance & inventory (`discount_tiers`, `approval_rules`, `warehouses`, `stock_levels`) · deal core (`quotations`, `quotation_lines`, `approvals`, `negotiations`, `alerts`) · fulfillment & billing (`fulfillment_splits`, `invoices`, `payments`, `billing_schedule`) · commissions (`commission_rules`, `commissions`) · `audit_log`, `settings`. CHECK constraints on every status, UNIQUE keys on rules, JSONB for margin-tier ladders, indexes on every hot join.

---

## 🔐 Security model

| | |
|---|---|
| **Two auth surfaces** | `df_session` for staff, `df_portal` for customers. Staff sessions are rejected on portal routes and customers on staff routes; nothing on the portal is reachable anonymously |
| **RBAC** | `requireInternal` (any staff role) · `requireRole(...)` (explicit roles) · `requirePortal` (customer cookie or per-quotation token) on every endpoint |
| **Record-level checks** | Reps edit only quotations they own and see only their own commissions; the approval step checks the pending level against the caller's role; portal users only ever reach their own company's rows, cross-tenant reads return 404 |
| **Credentials** | scrypt with per-user salt, 7-day sessions, HttpOnly SameSite cookies |
| **Audit** | Every mutation writes who, when, what and why to `audit_log` |

The full role matrix is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the suite asserts RBAC and tenant isolation.

---

## ⚡ Performance

Measured on the full demo dataset (≈270 quotations, ≈300 invoices), 15 sequential requests per endpoint, local PostgreSQL:

| Endpoint | Median | p95 |
|---|---|---|
| `GET /quotations` (list, 270 rows) | 7 ms | 8 ms |
| `GET /dashboard` (KPIs + deal-health) | 10 ms | 52 ms |
| `GET /reports/sales` | 6 ms | 7 ms |
| `GET /reports/export?format=pdf` | 6 ms | 44 ms |
| `GET /quotations/:id` (detail) · `/upsell` | 7 ms · 5 ms | 17 ms · 11 ms |
| `GET /invoices` · `/commissions` · `/warehouses` | 6 · 7 · 3 ms | ≤ 9 ms |

The deal-health re-scan is throttled to once per 15 s (forced immediately on restock or replenishment). Money KPIs are normalised to a reporting currency via each quotation's exchange rate, so INR and USD never add up naively.

---

## 🧪 Testing

```bash
npm run test:fresh     # reset the database, then run 102 checks over HTTP
```
The suite plays the official 8-step flow end to end and then the edge cases: over-ceiling routing to Manager → Finance, return-and-resubmit, upsell re-ranking, multi-warehouse split, stock decrement on ship, one-time vs recurring invoicing, cycle-anchored proration math, plan rule *none*, cancellation credit with notice period, portal isolation (magic link, company login, cross-tenant 404), line-level change requests and rep replies, automatic re-approval, reserved stock between two orders, automatic backorder prompt after restock, replenishment rules, recurring billing run, input validation, RBAC and exports.

---

## 🔮 What we'd build next

1. **Learned upsell scoring** — derive co-purchase scores from live order history nightly, with confidence intervals and per-segment ranking, instead of seeded rules.
2. **Approval SLAs & delegation** — timers that auto-escalate stale approvals, out-of-office delegation, Slack/email notifications for approvers and customers.
3. **Stock reservations with expiry & ATP** — reserve at approval with a time-to-live, available-to-promise dates from replenishment lead times, carrier rate cards for the shipping-cost model.
4. **Accounting integration** — journal export of invoices, credit notes, payments and commission settlements; GST/VAT by region; multi-company books.
5. **Commission forecasting** — projected vs earned payouts from the open pipeline weighted by stage.

---

## 📦 Repository map

| File | Purpose |
|---|---|
| [DEMO_GUIDE.md](DEMO_GUIDE.md) | Five-minute demo script, two full flows, judge Q&A |
| [docs/architecture.svg](docs/architecture.svg) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | One-page architecture and data model |
| [docker-compose.yml](docker-compose.yml) · [Dockerfile](Dockerfile) | One-command environment |
| [render.yaml](render.yaml) · [docs/DEPLOY.md](docs/DEPLOY.md) | One-click cloud deployment + hosting guide |
| [test-e2e.js](test-e2e.js) | The automated end-to-end suite |
| [.env.example](.env.example) | Connection settings |

<p align="center"><sub>Built for the Odoo Hackathon · React · Node.js · PostgreSQL · no UI, chart or export libraries — every rule is application logic.</sub></p>

# DealFlow360 v2 🌊

**An Intelligent, Self-Governing Sales Operations Platform** — built for the Odoo Hackathon.

**Stack: React (Vite) · Node.js (Express) · PostgreSQL**

Most sales tools stop at quote → confirm → invoice. Real B2B teams operate in messier conditions: multi-level discount approvals, partial stock spread across warehouses, subscriptions mixed with one-time hardware, customers who want to negotiate in a portal instead of over email, and reps whose commissions arrive three weeks late on a spreadsheet. **DealFlow360 is a self-governing deal engine** — it enforces pricing discipline, reacts to inventory reality in real time, keeps recurring and one-time revenue reconciled on a single order, gives reps *and* customers a living negotiable document, and pays commission automatically the moment cash lands.

---

## ✨ Modules

| Module | Highlights |
|---|---|
| **Quotations** | Odoo-style list + kanban pipeline, builder with per-line ceilings, order-level discount, blended-risk meter |
| **Discount Governance** | Tier × category ceilings, blended risk score, auto routing Manager → Finance |
| **Upsell engine** | Co-purchase scoring + promotion boost, margin-guarded suggestions, one-click add with live margin impact |
| **Fulfillment** | Greedy multi-warehouse split (consolidation-aware), backorders + restock consolidation |
| **Hybrid billing** | One-time + recurring lines, first-cycle + 11 future cycles, daily proration, policy credit notes |
| **Deal health** | Stalled / discount-anomaly / slippage alerts with nudge / escalate / dismiss |
| **Customer portal** | Per-quote magic links, comments, counter-offers, one-click confirm → auto re-approval |
| **Commissions** | Rule engine (person / team / category / product scoped; %-fixed-margin-tiered), auto-generated on invoice payment, draft → confirm → approve → settle lifecycle, **Commissions by Salesperson** + **Sales Commission Detail** reports, CSV/XLS/PDF statements |
| **Reporting** | Filterable sales reports (period / rep / approval / product / category) + PDF/XLS/CSV exports |

## 🚀 Quick start

```bash
# 1. PostgreSQL (one-time, any PostgreSQL 14+)
#    psql -U postgres:
CREATE USER dealflow WITH PASSWORD 'DealFlow@2026';
CREATE DATABASE dealflow360 OWNER dealflow;

# 2. Install + run
npm install                 # server deps (express, pg)
npm run client:build        # build the React client (vite)
npm start                   # → http://localhost:4300

# Dev mode (hot reload)
npm start                   # API on :4300
npm run client              # Vite dev server on :5173 (proxies /api)
```

Connection defaults: `localhost:5432 / dealflow / DealFlow@2026 / dealflow360` — override with
`PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE`. The database auto-creates its schema and a
"lived-in" demo company on first start. Reset to pristine data: `npm run reset` + restart.

## 👤 Demo accounts

| Role | Email | Password | What to show |
|---|---|---|---|
| Sales Rep (Asha, Enterprise) | `rep@dealflow.io` | `Rep@123` | Builder, upsell panel, commissions |
| Sales Manager (Priya) | `manager@dealflow.io` | `Manager@123` | Approval inbox, deal health, commission approval |
| Finance (Rahul) | `finance@dealflow.io` | `Finance@123` | 2nd-level approvals, restock, invoices, commission settlement |
| Admin | `admin@dealflow.io` | `Admin@123` | All backend configuration |
| Customer — Acme Corp | `buyer@acmecorp.com` | `Customer@123` | Portal negotiation |
| Customer — Gamma Retail | `buyer@gammaretail.in` | `Customer@123` | Portal (INR quotes) |

Every quotation also gets a **magic portal link** (`/#/portal/q/QT-1032?k=…`) — the customer can
view, comment, counter-offer and confirm with zero login.

## 🧪 The 8-step Quick Test Flow

1. **Configure** — Products / Pricelists / Discount tiers / Approval rules / Warehouses / Subscription plans / Upsell rules / **Commission rules**
2. **Build a quotation** — tier pricing auto-applies; per-line ceiling + violation badges update live
3. **Discount governance** — blended risk = worst violation + 50% of the rest; auto-routes Manager → Finance (finance joins when risk > 5 or any line > 20%)
4. **Approve** — role-gated chain (manager step 1, finance step 2) with reasons + full audit trail
5. **Upsell** — margin-guarded suggestions ranked by co-score; adding updates totals, margin and ranking instantly
6. **Fulfill** — split suggestion across 2+ warehouses with backorders; ship per allocation; consolidate after restock
7. **Bill** — one-time + recurring invoiced separately; mid-cycle qty change prorates daily; cancel issues policy credit notes; **payment auto-generates the salesperson's commission**
8. **Monitor** — dashboard KPIs, deal-health alerts, reports + PDF/XLS/CSV exports, commission statements

## 🏗 Architecture

```
client/               React 18 + Vite SPA (Odoo-inspired design system, zero UI libraries)
  src/api.js          fetch client + formatters
  src/components/     Navbar (dropdown menus), ListView, Kanban, SVG charts, ui kit
  src/pages/          Sales, Commissions, Catalog, Warehouses, Invoices, Reports, Admin, Portal
server.js             Express 5 — serves /api + client/dist
src/db.js             PostgreSQL layer (pg pool, ?→$n shim, schema, demo seed)
src/engines.js        pricing · blended risk · upsell · warehouse split · billing/proration ·
                      deal health · approval routing · commission engine
src/routes/           auth · config · sales · ops · portal · dash · commissions
src/exporter.js       dependency-free CSV / XLS (SpreadsheetML) / PDF writers
test-e2e.js           54-check end-to-end suite (the full quick-test flow over HTTP)
```

**Commission engine** — when an invoice is fully paid, the owning salesperson's commission is
generated using the most specific matching rule (product › category › salesperson › team › everyone):
flat %, fixed amount, or margin-tiered rates (higher order margin → higher rate). Lifecycle:
draft → confirmed → approved → paid, with finance settlement runs and full audit.

## 🔮 What we'd build next (with more time)

1. **Learned upsell scoring** — derive co-purchase scores from live order history nightly instead of seeded rules, with confidence intervals and per-segment ranking.
2. **Commission forecasting** — projected vs earned commission per rep based on open pipeline weighted by stage, so reps see future payouts in real time.
3. **ERP/accounting export** — posting invoices, credit notes and settlements to external accounting (e.g. journal-entry export), plus GST/VAT handling per region.
4. **Approval SLAs & delegation** — timeouts that auto-escalate stale approvals, and out-of-office delegation chains.
5. **Multi-company support** — the data model already isolates tenants per customer; extend it to per-company catalogs, warehouses and commission plans.

## 📜 Scripts

| Command | What it does |
|---|---|
| `npm start` | API + built React app on **http://localhost:4300** |
| `npm run client` | Vite dev server (hot reload) on :5173 |
| `npm run client:build` | Production build of the React client |
| `npm run reset` | Drop + reseed the PostgreSQL demo data |
| `npm test` | 54-check E2E suite (run on a fresh DB) |

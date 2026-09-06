# DealFlow360 — Architecture (one page)

> Printable one-pager: **[docs/architecture.svg](architecture.svg)** (open in any browser, export to PDF from the print dialog).
> This file is the same content as GitHub-rendered Mermaid so it stays readable inline.

## 1. System layers

```mermaid
flowchart TB
  subgraph Clients["React 18 SPA (Vite) — zero UI libraries"]
    WS["Sales Workspace<br/>Quotations · Pipeline · Builder · Approvals<br/>Fulfillment · Invoicing · Customer thread · Audit"]
    CFG["Backend Configuration & Reporting<br/>Products · Pricelists · Governance · Plans · Upsell<br/>Warehouses · Users · Settings · Dashboard · Reports"]
    PORTAL["Customer Portal — separate restricted surface<br/>own cookie or per-quote secure link<br/>line-level Q&A · change requests · counter · confirm"]
  end

  subgraph API["Node.js · Express 5 — RBAC middleware"]
    R1["/api/auth"]:::api
    R2["/api config"]:::api
    R3["/api/quotations"]:::api
    R4["/api ops (fulfillment · billing)"]:::api
    R5["/api/portal"]:::api
    R6["/api dashboard · reports"]:::api
    R7["/api/commissions"]:::api
  end

  subgraph Engines["src/engines.js — business rules (live-configurable)"]
    E1["Pricing"]
    E2["Blended risk +<br/>approval routing"]
    E3["Upsell<br/>(margin-guarded)"]
    E4["Warehouse split<br/>+ backorders"]
    E5["Hybrid billing<br/>+ proration"]
    E6["Deal health"]
    E7["Commission"]
    E8["Audit"]
  end

  DB[("PostgreSQL — 24 tables")]

  WS --> R3 & R4 & R6
  CFG --> R2 & R6 & R7
  PORTAL --> R5
  R3 --> E1 & E2 & E3 & E8
  R4 --> E4 & E5 & E7 & E8
  R5 --> E2 & E8
  R6 --> E6
  R7 --> E7
  Engines --> DB
  classDef api fill:#EAF3FB,stroke:#9CC3E5
```

## 2. Data model

```mermaid
erDiagram
  users ||--o{ quotations : "rep_id"
  users ||--o{ sessions : ""
  customers ||--o{ users : "portal login"
  customers ||--o{ quotations : ""
  categories ||--o{ products : "discount_ceiling"
  products ||--o{ product_variants : ""
  products ||--o{ product_plans : ""
  subscription_plans ||--o{ product_plans : ""
  products ||--o{ upsell_rules : "trigger / suggested"
  products ||--o{ stock_levels : ""
  warehouses ||--o{ stock_levels : ""
  quotations ||--|{ quotation_lines : ""
  products ||--o{ quotation_lines : ""
  subscription_plans ||--o{ quotation_lines : "plan_id"
  quotations ||--o{ approvals : "manager → finance"
  quotations ||--o{ negotiations : "comment · change_request · counter"
  quotations ||--o{ alerts : "stalled · anomaly · slippage · backorder"
  quotation_lines ||--o{ fulfillment_splits : ""
  warehouses ||--o{ fulfillment_splits : ""
  quotations ||--o{ invoices : "one_time · recurring · credit_note"
  invoices ||--o{ payments : ""
  quotation_lines ||--o{ billing_schedule : "cycles"
  invoices ||--o{ billing_schedule : "invoice_id"
  invoices ||--o{ commissions : "on full payment"
  commission_rules ||--o{ commissions : "matched rule"
  users ||--o{ commissions : "salesperson"

  quotations {
    text number
    text status
    float order_discount_pct
    float subtotal
    float discount_total
    float tax_total
    float total
    float cost_total
    float margin_pct
    float risk_score
    text approval_level
    text portal_token
    text customer_confirmed_at
  }
  quotation_lines {
    float qty
    float unit_price
    float cost_price
    float discount_pct
    text line_type
    int plan_id
    text billing_period
  }
  discount_tiers { text customer_tier  float max_discount_pct }
  approval_rules { text level  float risk_min  float risk_max  float any_line_over }
  stock_levels { int qty  int reorder_point  int replenishment_qty }
  fulfillment_splits { float qty  text status }
  billing_schedule { text scheduled_date  float amount  text status }
```

Also present: `price_lists` (tier × currency, discount/markup), `discount_tiers`, `approval_rules`, `settings` (thresholds), `audit_log` (every state change), `commission_rules`.

## 3. How the modules connect end-to-end

| Step | Trigger | Engine(s) | Writes |
|---|---|---|---|
| 1 Build | rep adds/edits lines, discounts, upsell | Pricing · Upsell · Risk (live) | `quotation_lines`, `quotations` totals/margin/risk |
| 2 Submit | `POST /quotations/:id/submit` | Risk → `requiredApprovalLevel` → `routeForApproval` | `approvals` chain, status `pending_manager` (or `approved`) |
| 3 Approve | manager, then finance if required | role checks, chain advance | `approvals`, status, `audit_log` |
| 4 Negotiate | portal comment / change request / counter / confirm | Risk re-evaluated on confirm | `negotiations`, `customer_confirmed_at`; re-enters step 2 if ceilings breached |
| 5 Fulfil | accept / override split · ship · restock | Warehouse split (free stock) · consolidation | `fulfillment_splits`, `stock_levels`, `alerts(backorder)` |
| 6 Bill | confirmation · qty change · cancel | Hybrid billing · proration · credit notes | `invoices`, `billing_schedule` |
| 7 Pay | `POST /invoices/:id/pay` | Commission rule matching | `payments`, invoice `paid`, `commissions` |
| 8 Monitor | dashboard poll · restock · nightly | Deal health | `alerts` (stalled · anomaly · slippage · backorder) |

### The blended discount risk score

```
allowed(line)   = min(tier ceiling, category ceiling)
effective(line) = line% + order% × (1 − line%/100)
violation(line) = max(0, effective − allowed)
risk            = worst violation + 0.5 × Σ(other violations)
level           = approval_rules match on risk range, or hard cap "any line over X%"
```

The worst line counts fully; smaller overages spread across many lines still add up — so a rep cannot keep every line
"almost within limits" while giving the order away.

## 4. Role matrix (as enforced by the API)

✅ allowed · 👤 own records only · ❌ denied

| Capability | Sales Rep | Manager | Finance | Admin | Customer (portal) |
|---|---|---|---|---|---|
| Staff login / persona switch | ✅ | ✅ | ✅ | ✅ | ❌ |
| Portal login / per-quotation secure link | ❌ | ❌ | ❌ | ❌ | ✅ |
| View quotations, pipeline, detail | ✅ | ✅ | ✅ | ✅ | ❌ |
| Create quotation | ✅ | ✅ | ✅ | ✅ | ❌ |
| Edit lines / discounts / upsell, submit, send, reply, accept or decline requests | 👤 own | ✅ | ❌ | ✅ | ❌ |
| Approve / return / reject — Manager step | ❌ | ✅ | ❌ | ✅ | ❌ |
| Approve / return / reject — Finance step | ❌ | ❌ | ✅ | ✅ | ❌ |
| Split suggestion, accept / override, ship, consolidate backorder | ✅ | ✅ | ✅ | ✅ | ❌ |
| Restock, stock levels, replenishment run, warehouses | ❌ | ❌ | ✅ | ✅ | ❌ |
| View invoices, invoice PDF, record payment, modify / cancel subscription | ✅ | ✅ | ✅ | ✅ | own quote's invoices |
| Recurring billing run, void invoice | ❌ | ❌ | ✅ | ✅ | ❌ |
| List / view own company's quotations; questions, change requests, counter, confirm | ❌ | ❌ | ❌ | ❌ | 👤 own company |
| Dashboard, alerts (nudge / escalate / dismiss), reports, exports | ✅ | ✅ | ✅ | ✅ | ❌ |
| View / confirm commissions | 👤 own | ✅ | ✅ | ✅ | ❌ |
| Approve / cancel commissions, commission rules, upsell rules, customers | ❌ | ✅ | ❌ | ✅ | ❌ |
| Settle commission payouts | ❌ | ❌ | ✅ | ✅ | ❌ |
| Products, variants, price lists, discount tiers, approval rules, plans, settings, users | ❌ | ❌ | ❌ | ✅ | ❌ |

## 5. Security model

- **Two auth surfaces**: `df_session` (staff) and `df_portal` (customers) cookies; magic links carry a per-quotation token.
- `requireInternal` rejects customers on staff routes; `requirePortal` rejects staff sessions on portal routes.
- Customers resolve quotations by `customer_id` — cross-tenant reads return 404. Verified in `test-e2e.js`.
- Passwords: scrypt with per-user salt; sessions expire after 7 days.
- Every mutation is written to `audit_log` with user, timestamp and reason.

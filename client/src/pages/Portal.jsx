import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { api, fmtMoney, fmtDate, fmtDateTime } from '../api';
import { Pill, useToast } from '../components/ui';
import ProductImage from '../components/ProductImage';
import Logo from '../components/Logo';

/* Customer-facing portal — a SEPARATE, restricted surface.
 *   /#/portal                 → customer sign-in (own cookie, never shares the staff session)
 *   /#/portal/quotes          → only this customer's quotations
 *   /#/portal/q/QT-1032?k=…   → per-quotation secure link (no login; that one quotation only)
 */

const DEMO_CUSTOMERS = [
  ['Acme Corp (gold)', 'buyer@acmecorp.com'],
  ['Gamma Retail (bronze, INR)', 'buyer@gammaretail.in'],
  ['Delta Logistics (gold)', 'buyer@deltalog.com'],
];

const PORTAL_STATUS_STYLE = {
  'Sent': 'sent', 'Under Negotiation': 'negotiating', 'Confirmed': 'confirmed',
  'Confirmed — awaiting internal approval': 'pending_manager', 'Under internal review': 'pending_manager',
  'Ready for your review': 'approved', 'Declined internally': 'rejected', 'Cancelled': 'cancelled', 'In preparation': 'draft',
};
function PortalPill({ label }) { return <Pill status={PORTAL_STATUS_STYLE[label] || 'draft'} label={label} />; }

function PortalFrame({ children, session, onSignOut, subtitle }) {
  const nav = useNavigate();
  return (
    <div className="portal-shell">
      <div className="portal-hero compact">
        <div className="portal-top">
          <div className="portal-brand" style={{ cursor: 'pointer' }} onClick={() => nav(session ? '/portal/quotes' : '/portal')}><Logo size={30} textSize={16} variant="light" suffix="· Customer Portal" /></div>
          <div className="portal-meta" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {session ? (
              <>
                <span>{session.customer_name} · <span className="tier-chip">{session.customer_tier} partner</span></span>
                <button className="btn sm" style={{ background: 'rgba(255,255,255,.18)', color: '#fff', border: '1px solid rgba(255,255,255,.35)' }} onClick={() => nav('/portal/quotes')}>My quotations</button>
                <button className="btn sm" style={{ background: 'rgba(255,255,255,.18)', color: '#fff', border: '1px solid rgba(255,255,255,.35)' }} onClick={onSignOut}>Sign out</button>
              </>
            ) : <span>{subtitle || 'Secure access — you only ever see your own company\'s documents'}</span>}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function Portal({ mode }) {
  const { number } = useParams();
  const [params] = useSearchParams();
  const key = params.get('k');
  const [session, setSession] = useState(undefined); // undefined = loading

  const loadSession = () => api.get('/auth/portal/me').then((r) => setSession(r.user)).catch(() => setSession(null));
  useEffect(() => { loadSession(); }, []);
  const signOut = async () => { try { await api.post('/auth/portal/logout'); } catch {} setSession(null); window.location.hash = '#/portal'; };

  if (session === undefined) return <div className="page-loading">Opening customer portal…</div>;
  if (number) return <QuoteView number={number} magicKey={key} session={session} onSignOut={signOut} />;
  if (mode === 'quotes' || session) return session ? <QuotesList session={session} onSignOut={signOut} /> : <PortalLogin onLogin={loadSession} />;
  return <PortalLogin onLogin={loadSession} />;
}

/* ---------- sign in ---------- */
function PortalLogin({ onLogin }) {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await api.post('/auth/portal/login', { email, password }); await onLogin(); nav('/portal/quotes'); }
    catch (ex) { setErr(ex.message); }
    setBusy(false);
  };
  return (
    <div className="portal-shell">
      <div className="portal-hero">
        <div className="portal-brand"><Logo size={34} textSize={18} variant="light" /></div>
        <h1 style={{ margin: '14px 0 6px' }}>Customer Negotiation Portal</h1>
        <p>View your live quotations, ask line-level questions, request changes, counter a discount and confirm in one click — no email back-and-forth.</p>
      </div>
      <div className="portal-login-grid">
        <div className="card pad">
          <h3 style={{ marginTop: 0 }}>Sign in to your company account</h3>
          <form onSubmit={submit}>
            <div className="field"><label className="f">Email</label><input className="f" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="buyer@yourcompany.com" required /></div>
            <div className="field"><label className="f">Password</label><input className="f" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required /></div>
            {err && <div style={{ color: '#CD3D63', fontSize: 12.5, margin: '4px 0 8px' }}>{err}</div>}
            <button className="btn-new" style={{ width: '100%', justifyContent: 'center', padding: 10 }} disabled={busy}>{busy ? 'Signing in…' : 'Open my quotations'}</button>
          </form>
          <div className="demo-creds" style={{ marginTop: 14 }}>
            <b>Demo customer accounts</b> (click to fill · password <code>Customer@123</code>):
            {DEMO_CUSTOMERS.map(([label, em]) => (
              <div key={em} style={{ display: 'flex', justifyContent: 'space-between', margin: '4px 0' }}>
                <span>{label}</span><code onClick={() => { setEmail(em); setPassword('Customer@123'); }}>{em}</code>
              </div>
            ))}
          </div>
        </div>
        <div className="card pad">
          <h3 style={{ marginTop: 0 }}>🔗 Have a secure quotation link?</h3>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0 }}>
            Your salesperson can send you a per-quotation link (<code>/portal/q/QT-…?k=…</code>). It opens that quotation only — no account needed.
            Everything you do here is logged on the quotation's audit trail, and terms above our approval ceilings are routed for internal approval automatically.
          </p>
          <ul style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.7, paddingLeft: 18 }}>
            <li>Line-level questions and change requests</li>
            <li>Counter-offer a discount</li>
            <li>One-click confirmation</li>
            <li>Download invoices and see your recurring billing schedule</li>
          </ul>
          <div style={{ marginTop: 16 }}><a onClick={() => nav('/')} style={{ cursor: 'pointer', fontSize: 12.5 }}>← Staff sign-in</a></div>
        </div>
      </div>
    </div>
  );
}

/* ---------- my quotations ---------- */
function QuotesList({ session, onSignOut }) {
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get('/portal/quotes').then(setData).catch((e) => setErr(e.message)); }, []);
  return (
    <>
      <PortalFrame session={session} onSignOut={onSignOut}>
        <div className="hero-main"><div><div className="hero-kicker">YOUR QUOTATIONS</div><h1 style={{ margin: '2px 0 4px', fontSize: 26 }}>{session.customer_name}</h1>
          <div className="hero-fact">Only documents issued to your company are visible here.</div></div></div>
      </PortalFrame>
      <div className="portal-shell" style={{ paddingTop: 0 }}>
        {err && <div className="card pad" style={{ color: '#CD3D63' }}>{err}</div>}
        {!data && !err && <div className="page-loading">Loading…</div>}
        {data && (
          <div style={{ display: 'grid', gap: 12 }}>
            {data.quotes.map((q) => (
              <div key={q.number} className="portal-quote-row" style={{ cursor: 'pointer' }} onClick={() => nav(`/portal/q/${q.number}`)}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                    <b style={{ fontSize: 16 }}>{q.number}</b><PortalPill label={q.portal_status} />
                    {q.open_requests > 0 && <span className="pill" style={{ background: '#FFE8CC', color: '#B3611E' }}>{q.open_requests} open request(s)</span>}
                    {q.open_invoices > 0 && <span className="pill" style={{ background: '#FBF0D9', color: '#9C6F07' }}>{q.open_invoices} invoice(s) due</span>}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 5 }}>Created {fmtDate(q.created_at)} · valid until {fmtDate(q.valid_until)}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 17, fontWeight: 700 }}>{fmtMoney(q.total, q.currency)}</div>
                  <div style={{ fontSize: 12, color: 'var(--brand)' }}>Open →</div>
                </div>
              </div>
            ))}
            {!data.quotes.length && <div className="card pad empty-state">No quotations have been shared with your company yet.</div>}
          </div>
        )}
      </div>
    </>
  );
}

/* ---------- single quotation (session or secure link) ---------- */
function QuoteView({ number, magicKey, session, onSignOut }) {
  const nav = useNavigate();
  const { toast } = useToast();
  const [quote, setQuote] = useState(null);
  const [via, setVia] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [kind, setKind] = useState('comment');
  const [lineId, setLineId] = useState('');
  const [counter, setCounter] = useState('');
  const [counterMsg, setCounterMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const qs = magicKey ? `?k=${magicKey}` : '';

  const load = () => api.get(`/portal/quote/${number}${qs}`).then((r) => { setQuote(r.quote); setVia(r.via); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [number, magicKey]);
  useEffect(() => { const t = setInterval(load, 15000); return () => clearInterval(t); }, [number, magicKey]); // live: staff replies appear without refresh

  const post = async (action, body, okMsg) => {
    setBusy(true);
    try {
      const r = await api.post(`/portal/quote/${number}/${action}${qs}`, body || {});
      toast(okMsg, 'ok');
      setQuote(r.quote); setMsg(''); setCounter(''); setCounterMsg(''); setLineId('');
      if (r.re_approval && r.re_approval !== 'none') toast('Your negotiated terms exceed our standard limits — sent for a quick internal approval. We will confirm shortly.', '');
    } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };

  if (err) {
    return (
      <div className="portal-shell">
        <div className="card pad" style={{ maxWidth: 560, margin: '50px auto', textAlign: 'center' }}>
          <div style={{ fontSize: 40 }}>🔒</div>
          <h3 style={{ margin: '8px 0' }}>Unable to open quotation</h3>
          <p style={{ color: 'var(--muted)' }}>{err}</p>
          <button className="btn" onClick={() => nav('/portal')}>Go to portal sign-in</button>
        </div>
      </div>
    );
  }
  if (!quote) return <div className="page-loading">Opening quotation…</div>;

  const cur = quote.currency;
  const lineName = (id) => (quote.lines.find((l) => l.id === Number(id)) || {}).description;
  const recurring = quote.lines.filter((l) => l.line_type === 'subscription');
  const oneTime = quote.lines.filter((l) => l.line_type !== 'subscription');

  return (
    <>
      <PortalFrame session={session} onSignOut={onSignOut} subtitle={via === 'magic' ? 'Secure link — this quotation only' : undefined}>
        <div className="hero-main">
          <div>
            <div className="hero-kicker">QUOTATION · {quote.customer?.name}</div>
            <h1 style={{ margin: '2px 0 8px', fontSize: 30 }}>{quote.number}</h1>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <PortalPill label={quote.portal_status} />
              <span className="hero-fact">Sent {fmtDate(quote.sent_at || quote.created_at)}</span>
              <span className="hero-fact">· Valid until <b>{fmtDate(quote.valid_until)}</b></span>
              <span className="hero-fact">· Delivery {fmtDate(quote.expected_delivery)}</span>
              {quote.salesperson && <span className="hero-fact">· Your contact: <b>{quote.salesperson.name}</b></span>}
            </div>
          </div>
          {quote.can_confirm && (
            <button className="btn-new btn-lg" disabled={busy} onClick={() => post('confirm', {}, 'Quotation confirmed — thank you!')}>✔ Confirm quotation</button>
          )}
          {quote.customer_confirmed_at && <div className="confirm-badge">✔ Confirmed by you on {fmtDate(quote.customer_confirmed_at)}</div>}
        </div>
      </PortalFrame>

      <div className="portal-shell" style={{ paddingTop: 0 }}>
        {/* lines + totals */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">Order lines <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 12 }}>· click 💬 to ask about a specific line</span></div>
          <table className="list portal-lines">
            <thead><tr><th>Product</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Discount</th><th className="num">Amount</th>{quote.can_negotiate && <th></th>}</tr></thead>
            <tbody>
              {quote.lines.map((l) => (
                <tr key={l.id} className={Number(lineId) === l.id ? 'row-selected' : ''}>
                  <td data-label="Product"><ProductImage product={l} size={28} style={{ marginRight: 8 }} /><b>{l.description}</b>
                    {l.line_type === 'subscription' && <span className="pill" style={{ background: '#E5F0F0', color: '#017E84', marginLeft: 8 }}>recurring · {l.billing_period}</span>}</td>
                  <td className="num" data-label="Qty">{l.qty}</td>
                  <td className="num" data-label="Unit">{fmtMoney(l.unit_price, cur)}</td>
                  <td className="num" data-label="Discount">{l.effective_discount}%</td>
                  <td className="num" data-label="Amount"><b>{fmtMoney(l.net, cur)}</b></td>
                  {quote.can_negotiate && <td data-label=""><button className="btn sm" title="Ask about this line" onClick={() => { setLineId(String(l.id)); document.getElementById('portal-msg')?.focus(); }}>💬</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="portal-totals">
            <div className="t-row"><span>Subtotal</span><b>{fmtMoney(quote.subtotal, cur)}</b></div>
            <div className="t-row disc"><span>Discount</span><b>−{fmtMoney(quote.discount_total, cur)}</b></div>
            <div className="t-row"><span>Tax</span><b>{fmtMoney(quote.tax_total, cur)}</b></div>
            <div className="t-row grand"><span>Total ({cur})</span><b>{fmtMoney(quote.total, cur)}</b></div>
            {recurring.length > 0 && oneTime.length > 0 && (
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                Includes {oneTime.length} one-time line(s) billed once and {recurring.length} recurring line(s) billed per cycle.
              </div>
            )}
          </div>
        </div>

        {/* negotiation + billing */}
        <div className="portal-grid">
          <div className="card pad">
            <h3 style={{ marginTop: 0 }}>💬 Questions, change requests & negotiation</h3>
            <div className="thread-scroll">
              {(quote.thread || []).map((n) => (
                <div key={n.id} className={`bubble ${n.author === 'customer' ? 'me' : 'them'}`}>
                  <div className="b-head">
                    {n.author === 'customer' ? (n.user_name || 'You') : `${n.user_name || 'Sales team'} (DealFlow360)`}
                    {' · '}{n.kind === 'change_request' ? 'change request' : n.kind === 'counter' ? 'counter-offer' : n.author === 'staff' ? 'reply' : 'question'}
                    {n.line_label && <> · <span className="line-chip">{n.line_label}</span></>}
                    {' · '}{fmtDateTime(n.created_at)}
                  </div>
                  {n.message}
                  {n.proposed_discount != null && <div style={{ marginTop: 4 }}><b>Proposed discount: {n.proposed_discount}%</b></div>}
                  {n.status !== 'info' && n.status !== 'open' && <div className={`b-status ${n.status}`}>● {n.status}</div>}
                  {n.status === 'open' && n.author === 'customer' && <div className="b-status" style={{ color: 'var(--muted)' }}>● awaiting reply</div>}
                </div>
              ))}
              {!(quote.thread || []).length && <div style={{ color: 'var(--muted)', fontSize: 13, padding: '10px 0' }}>No messages yet — ask us anything about this quotation.</div>}
            </div>
            {quote.can_negotiate ? (
              <>
                <div className="grid2">
                  <div className="field"><label className="f">Type</label>
                    <select className="f" value={kind} onChange={(e) => setKind(e.target.value)}>
                      <option value="comment">Question / comment</option>
                      <option value="change_request">Change request (qty, spec, delivery…)</option>
                    </select>
                  </div>
                  <div className="field"><label className="f">About</label>
                    <select className="f" value={lineId} onChange={(e) => setLineId(e.target.value)}>
                      <option value="">Whole quotation</option>
                      {quote.lines.map((l) => <option key={l.id} value={l.id}>{l.description}</option>)}
                    </select>
                  </div>
                </div>
                <div className="field"><label className="f">Message to {quote.salesperson?.name || 'your salesperson'}{lineId && <> · about <b>{lineName(lineId)}</b></>}</label>
                  <textarea id="portal-msg" className="f" rows={2} value={msg} onChange={(e) => setMsg(e.target.value)}
                    placeholder={kind === 'change_request' ? 'e.g. Please change the quantity to 12 and deliver by the 20th' : 'e.g. Does this include onboarding?'} />
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                  <button className="btn primary" disabled={!msg.trim() || busy} onClick={() => post('comment', { message: msg, line_id: lineId ? Number(lineId) : null, kind }, kind === 'change_request' ? 'Change request submitted' : 'Question sent to your salesperson')}>
                    {kind === 'change_request' ? 'Submit change request' : 'Send question'}
                  </button>
                </div>
                <div className="counter-box">
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Counter-offer a discount</div>
                  <div className="grid2">
                    <div className="field"><label className="f">Discount % on all lines</label>
                      <input className="f" type="number" min="0" max="90" value={counter} onChange={(e) => setCounter(e.target.value)} placeholder="e.g. 18" /></div>
                    <div className="field"><label className="f">Reason</label>
                      <input className="f" value={counterMsg} onChange={(e) => setCounterMsg(e.target.value)} placeholder="Competitor offered…" /></div>
                  </div>
                  <button className="btn" disabled={counter === '' || busy} onClick={() => post('counter', { discount_pct: Number(counter), message: counterMsg }, `Counter-offer at ${counter}% sent`)}>Submit counter-offer</button>
                  <div className="hint">Confirming the quotation applies your latest open counter-offer automatically. Terms above our approval ceilings go through a quick internal approval first.</div>
                </div>
              </>
            ) : (
              <div className="hint">{quote.customer_confirmed_at ? 'You have confirmed this quotation — the discussion is closed. Your salesperson will keep you posted here.' : 'Negotiation is not open for this quotation right now.'}</div>
            )}
          </div>

          <div>
            <div className="card pad" style={{ marginBottom: 16 }}>
              <h3 style={{ marginTop: 0 }}>🧾 Invoices on this order</h3>
              <div className="inv-list">
                {quote.invoices.map((i) => (
                  <div key={i.id} className="inv-row">
                    <div className="inv-main">
                      <div className="inv-title"><b>{i.number}</b><Pill status={i.status} /></div>
                      <div className="inv-sub">{i.kind === 'credit_note' ? 'Credit note in your favour' : i.kind === 'recurring' ? 'Recurring cycle' : 'One-time products & services'} · due {fmtDate(i.due_date)}</div>
                    </div>
                    <div className="inv-side">
                      <b className="inv-amt">{i.kind === 'credit_note' ? '−' : ''}{fmtMoney(i.amount, cur)}</b>
                      <a className="btn sm inv-dl" href={`/api/portal/quote/${number}/invoice/${i.id}/pdf${qs}`} target="_blank" rel="noreferrer">⬇ PDF</a>
                    </div>
                  </div>
                ))}
                {!quote.invoices.length && <div className="hint" style={{ marginTop: 0 }}>Invoices appear here once the order is confirmed and scheduled.</div>}
              </div>
            </div>
            {recurring.length > 0 && (
              <div className="card pad">
                <h3 style={{ marginTop: 0 }}>🔄 Recurring billing schedule</h3>
                {quote.schedule?.length ? (
                  <table className="list" style={{ fontSize: 12.5 }}>
                    <thead><tr><th>Date</th><th>Cycle</th><th className="num">Amount</th><th></th></tr></thead>
                    <tbody>{quote.schedule.map((s, i) => (
                      <tr key={i}><td>{fmtDate(s.scheduled_date)}</td><td>{s.description}</td><td className="num">{fmtMoney(s.amount, cur)}</td><td><Pill status={s.status} /></td></tr>
                    ))}</tbody>
                  </table>
                ) : <div className="hint" style={{ marginTop: 0 }}>Your schedule is generated when the order is confirmed.</div>}
              </div>
            )}
            <div className="hint" style={{ marginTop: 12 }}>
              Access: {via === 'magic' ? 'secure per-quotation link' : 'your company account'} — you only ever see your own company's documents. Every action is recorded on the quotation's audit trail.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

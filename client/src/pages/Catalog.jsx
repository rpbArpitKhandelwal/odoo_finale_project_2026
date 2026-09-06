import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, fmtMoney, fmtPct } from '../api';
import ListView from '../components/ListView';
import ProductImage from '../components/ProductImage';
import { Pill, Modal, useToast, Meter } from '../components/ui';
import { useAuth } from '../auth';

/* ============================================================ PRODUCTS */
export function Products() {
  const { user } = useAuth();
  const { toast } = useToast();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const canEdit = user?.role === 'admin';

  const load = () => api.get('/products').then(setData).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, []);
  if (!data) return <div className="page-loading">Loading products…</div>;

  return (
    <>
      <div className="kpi-chips">
        <div className="kpi-chip" style={{ background: '#4C689E' }}><span className="cnt">{data.products.filter((p) => p.product_type === 'one_time' && p.stocked).length}</span> Goods</div>
        <div className="kpi-chip" style={{ background: '#7A6DAE' }}><span className="cnt">{data.products.filter((p) => p.product_type === 'one_time' && !p.stocked).length}</span> Services</div>
        <div className="kpi-chip" style={{ background: '#0F7B3D' }}><span className="cnt">{data.products.filter((p) => p.product_type === 'subscription').length}</span> Subscriptions</div>
        <div className="kpi-summary"><div><b>{data.products.filter((p) => p.promoted).length} promoted</b><span className="up">+0.15 upsell score boost</span></div></div>
      </div>
      <ListView
        rows={data.products}
        onRowClick={(p) => nav(`/products/${p.id}`)}
        searchKeys={['name', 'sku', 'category_name', 'description']}
        actions={canEdit && <button className="btn-new" onClick={() => setShowNew(true)}>＋ New</button>}
        empty="No products — create one"
        columns={[
          { key: 'name', label: 'Product', link: true, render: (p) => <><ProductImage product={p} size={34} style={{ marginRight: 10 }} /><b>{p.name}</b>{p.promoted && <span className="promo-tag" style={{ marginLeft: 8 }}>promoted</span>}{!p.active && <span className="pill" style={{ marginLeft: 8, background: '#EEE', color: '#777' }}>archived</span>}</> },
          { key: 'sku', label: 'SKU', width: 100 },
          { key: 'category_name', label: 'Category', width: 120 },
          { key: 'product_type', label: 'Type', width: 110, render: (p) => p.product_type === 'subscription' ? <span className="pill" style={{ background: '#E5F0F0', color: '#017E84' }}>recurring</span> : p.stocked ? 'stocked' : 'service' },
          { key: 'base_price', label: 'Price', num: true, render: (p) => p.product_type === 'subscription' ? '—' : fmtMoney(p.base_price) },
          { key: 'cost_price', label: 'Cost', num: true, render: (p) => fmtMoney(p.cost_price) },
          { key: 'margin', label: 'Margin', num: true, sort: false, render: (p) => p.base_price > 0 ? fmtPct((p.base_price - p.cost_price) / p.base_price * 100) : '—' },
          { key: 'discount_ceiling', label: 'Disc. ceiling', num: true, render: (p) => `${p.discount_ceiling}%` },
          { key: 'variants', label: 'Variants', sort: false, width: 90, render: (p) => data.variants.filter((v) => v.product_id === p.id).length || '—' },
        ]}
      />
      {showNew && <ProductModal categories={data.products} onClose={() => setShowNew(false)} reload={load} />}
    </>
  );
}

/* ============================================================ PRODUCT DETAIL (Odoo-style form view) */
export function ProductDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [extra, setExtra] = useState(null);
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(null);
  const [variant, setVariant] = useState({ attribute: '', value: '', extra_price: '' });
  const canEdit = user?.role === 'admin';

  const load = async () => {
    const all = await api.get('/products');
    const p = all.products.find((x) => String(x.id) === String(id));
    if (!p) { toast('Product not found', 'err'); return nav('/products'); }
    setData({ ...all, product: p });
    setF({ name: p.name, base_price: p.base_price, cost_price: p.cost_price, tax_rate: p.tax_rate, description: p.description, category_id: p.category_id });
    api.get(`/products/${p.id}/price-preview`).then(setExtra).catch(() => {});
  };
  useEffect(() => { load(); setEdit(false); }, [id]);
  if (!data || !f) return <div className="page-loading">Loading product…</div>;
  const p = data.product;
  const variants = data.variants.filter((v) => v.product_id === p.id);
  const plan = data.plans.find((pp) => pp.product_id === p.id);
  const margin = p.base_price > 0 ? (p.base_price - p.cost_price) / p.base_price * 100 : 0;

  const save = async () => {
    try {
      await api.put(`/products/${p.id}`, { ...f, base_price: Number(f.base_price), cost_price: Number(f.cost_price), tax_rate: Number(f.tax_rate) });
      toast('Product saved', 'ok'); setEdit(false); load();
    } catch (e) { toast(e.message, 'err'); }
  };
  const setFlag = async (patch, msg) => {
    try { await api.put(`/products/${p.id}`, patch); toast(msg, 'ok'); load(); } catch (e) { toast(e.message, 'err'); }
  };
  const addVariant = async () => {
    try { await api.post(`/products/${p.id}/variants`, { ...variant, extra_price: Number(variant.extra_price || 0) }); toast('Variant added', 'ok'); setVariant({ attribute: '', value: '', extra_price: '' }); load(); }
    catch (e) { toast(e.message, 'err'); }
  };
  const delVariant = async (vid) => {
    try { await api.del(`/variants/${vid}`); load(); } catch (e) { toast(e.message, 'err'); }
  };

  const Field = ({ label, children, wide }) => (
    <div className="field" style={{ marginBottom: 10, gridColumn: wide ? '1 / -1' : undefined }}>
      <label className="f">{label}</label>
      {children}
    </div>
  );

  return (
    <>
      <div className="breadcrumbs">Products <b>{p.name}</b></div>
      <div className="ctrl-bar">
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <ProductImage product={p} size={64} />
          {p.name}
          <span className="pill" style={{ background: '#E5F0F0', color: '#017E84' }}>{p.product_type === 'subscription' ? 'recurring' : p.stocked ? 'stocked good' : 'service'}</span>
          <span className="pill" style={{ background: '#EDEFF2', color: '#5F6B7A' }}>{p.category_name}</span>
          {p.promoted && <span className="promo-tag">promoted</span>}
          {!p.active && <span className="pill" style={{ background: '#EEE', color: '#777' }}>archived</span>}
        </h2>
        <div style={{ flex: 1 }} />
        {canEdit && !edit && <button className="btn" onClick={() => setEdit(true)}>✎ Edit</button>}
        {canEdit && !edit && <button className="btn" onClick={() => setFlag({ promoted: !p.promoted }, p.promoted ? 'Unpromoted' : 'Promoted')}>{p.promoted ? 'Unpromote' : '⭐ Promote'}</button>}
        {canEdit && !edit && <button className="btn warning" onClick={() => setFlag({ active: !p.active }, p.active ? 'Archived' : 'Activated')}>{p.active ? 'Archive' : 'Activate'}</button>}
        {edit && <><button className="btn" onClick={() => { setEdit(false); setF({ name: p.name, base_price: p.base_price, cost_price: p.cost_price, tax_rate: p.tax_rate, description: p.description, category_id: p.category_id }); }}>Cancel</button>
          <button className="btn primary" onClick={save}>💾 Save</button></>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 12, padding: '0 18px 18px', alignItems: 'start' }}>
        <div>
          {/* General Information */}
          <div className="card pad" style={{ margin: 0, marginBottom: 12 }}>
            <h3 style={{ marginTop: 0 }}>📋 General Information</h3>
            <div className="grid2">
              <Field label="Product Name">
                {edit ? <input className="f" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
                  : <div className="form-value"><b>{p.name}</b></div>}
              </Field>
              <Field label="SKU"><div className="form-value">{p.sku}</div></Field>
              <Field label="Category">
                {edit ? (
                  <select className="f" value={f.category_id} onChange={(e) => setF({ ...f, category_id: Number(e.target.value) })}>
                    {[...new Map(data.products.map((x) => [x.category_id, { id: x.category_id, name: x.category_name, ceiling: x.discount_ceiling }])).values()]
                      .map((c) => <option key={c.id} value={c.id}>{c.name} (ceiling {c.ceiling}%)</option>)}
                  </select>
                ) : <div className="form-value">{p.category_name} · ceiling {p.discount_ceiling}%</div>}
              </Field>
              <Field label="Taxes">
                {edit ? <input className="f" type="number" value={f.tax_rate} onChange={(e) => setF({ ...f, tax_rate: e.target.value })} />
                  : <div className="form-value">{p.tax_rate}% sales tax</div>}
              </Field>
              <Field label="Base Price">
                {edit ? <input className="f" type="number" value={f.base_price} onChange={(e) => setF({ ...f, base_price: e.target.value })} />
                  : <div className="form-value"><b>{p.product_type === 'subscription' ? (plan ? fmtMoney(plan.recurring_price) + ' / ' + plan.billing_period : '—') : fmtMoney(p.base_price)}</b></div>}
              </Field>
              <Field label="Cost">
                {edit ? <input className="f" type="number" value={f.cost_price} onChange={(e) => setF({ ...f, cost_price: e.target.value })} />
                  : <div className="form-value">{fmtMoney(p.cost_price)}</div>}
              </Field>
              <Field label="Internal Notes / Description" wide>
                {edit ? <textarea className="f" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
                  : <div className="form-value" style={{ color: 'var(--muted)' }}>{p.description || '—'}</div>}
              </Field>
            </div>
          </div>

          {/* Variants */}
          <div className="card" style={{ margin: 0, marginBottom: 12 }}>
            <div className="ctrl-bar" style={{ padding: '10px 14px 2px' }}><h3 style={{ margin: 0 }}>🧬 Variants {variants.length > 0 && <span className="cnt">{variants.length}</span>}</h3></div>
            {variants.length > 0 ? (
              <table className="list">
                <thead><tr><th>Attribute</th><th>Value</th><th className="num">Extra price</th>{canEdit && <th></th>}</tr></thead>
                <tbody>
                  {variants.map((v) => (
                    <tr key={v.id}>
                      <td>{v.attribute}</td><td><b>{v.value}</b></td>
                      <td className="num">{fmtMoney(v.extra_price)}</td>
                      {canEdit && <td><button className="btn sm danger" onClick={() => delVariant(v.id)}>✕</button></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="empty-state" style={{ padding: 16 }}>No variants — this product sells as a single configuration</div>}
            {canEdit && (
              <div style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid #EEF0F3', flexWrap: 'wrap' }}>
                <input className="f" style={{ width: 130 }} placeholder="Attribute (Pack)" value={variant.attribute} onChange={(e) => setVariant({ ...variant, attribute: e.target.value })} />
                <input className="f" style={{ width: 170 }} placeholder="Value (3-Pack)" value={variant.value} onChange={(e) => setVariant({ ...variant, value: e.target.value })} />
                <input className="f" style={{ width: 110 }} type="number" placeholder="+ price" value={variant.extra_price} onChange={(e) => setVariant({ ...variant, extra_price: e.target.value })} />
                <button className="btn primary sm" disabled={!variant.attribute || !variant.value} onClick={addVariant}>＋ Add variant</button>
              </div>
            )}
          </div>

          {/* Tier pricing preview */}
          <div className="card pad" style={{ margin: 0 }}>
            <h3 style={{ marginTop: 0 }}>💳 Tier pricing preview <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>what each customer tier actually pays</span></h3>
            {!extra && <div className="empty-state" style={{ padding: 14 }}>Computing…</div>}
            {extra && (
              <table className="list">
                <thead><tr><th>Customer tier</th><th>Currency</th><th>Pricelist rule</th><th className="num">Price</th><th className="num">Margin after</th></tr></thead>
                <tbody>
                  {extra.preview.map((row, i) => {
                    const m = row.price > 0 ? (row.price - p.cost_price) / row.price * 100 : 0;
                    return (
                      <tr key={i}>
                        <td><span className="tier-chip-static">{row.tier}</span></td>
                        <td>{row.currency}</td>
                        <td style={{ color: row.rule ? 'var(--text)' : 'var(--muted)' }}>{row.rule || 'list price (no rule)'}</td>
                        <td className="num"><b>{fmtMoney(row.price, row.currency)}</b></td>
                        <td className="num" style={{ color: m >= 30 ? '#0F7B3D' : '#B3611E' }}>{m.toFixed(0)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* smart buttons sidebar */}
        <div className="smart-col">
          <div className="smart-btn" onClick={() => nav('/quotations')}>
            <div className="sb-num">{extra?.times_quoted ?? '—'}</div>
            <div className="sb-lbl">Times quoted</div>
          </div>
          <div className="smart-btn" style={{ cursor: 'default' }}>
            <div className="sb-num">{p.product_type === 'subscription' ? `${variants.length} variant${variants.length === 1 ? '' : 's'}` : variants.length || '—'}</div>
            <div className="sb-lbl">Variants</div>
          </div>
          {p.stocked && (
            <div className="smart-btn" style={{ cursor: 'default' }}>
              <div className="sb-num">{extra?.stock_total ?? '—'}</div>
              <div className="sb-lbl">Units on hand</div>
            </div>
          )}
          <div className="smart-btn" style={{ cursor: 'default' }}>
            <div className="sb-num" style={{ color: margin >= 30 ? '#0F7B3D' : '#B3611E' }}>{margin.toFixed(0)}%</div>
            <div className="sb-lbl">Gross margin</div>
          </div>
          {p.product_type === 'subscription' && plan && (
            <div className="smart-btn" style={{ cursor: 'default' }}>
              <div className="sb-num" style={{ fontSize: 15 }}>{plan.plan_name}</div>
              <div className="sb-lbl">{fmtMoney(plan.recurring_price)} / {plan.billing_period}</div>
            </div>
          )}
          {extra && p.stocked && extra.stock.length > 0 && (
            <div className="card pad" style={{ margin: 0 }}>
              <h3 style={{ margin: '0 0 8px', fontSize: 13 }}>📦 Stock by warehouse</h3>
              {extra.stock.map((s) => (
                <div key={s.warehouse} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12 }}>
                  <div style={{ width: 105, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.warehouse}</div>
                  <Meter value={s.qty} max={Math.max(s.reorder_point * 2, s.qty, 1)} color={s.qty <= s.reorder_point ? '#CD3D63' : '#0F7B3D'} />
                  <b style={{ width: 26, textAlign: 'right' }}>{s.qty}</b>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function ProductModal({ onClose, reload }) {
  const { toast } = useToast();
  const [f, setF] = useState({ name: '', sku: '', category_id: '', product_type: 'one_time', base_price: '', cost_price: '', tax_rate: 8, description: '' });
  const [cats, setCats] = useState([]);
  useEffect(() => { api.get('/categories').then((r) => setCats(r.categories)); }, []);
  const save = async () => {
    try {
      await api.post('/products', { ...f, category_id: Number(f.category_id), base_price: Number(f.base_price || 0), cost_price: Number(f.cost_price || 0), stocked: f.product_type === 'one_time' });
      toast('Product created', 'ok'); reload(); onClose();
    } catch (e) { toast(e.message, 'err'); }
  };
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Modal title="New product" onClose={onClose} wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!f.name || !f.sku || !f.category_id} onClick={save}>Create</button></>}>
      <div className="grid2">
        <div className="field"><label className="f">Name</label><input className="f" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div className="field"><label className="f">SKU</label><input className="f" value={f.sku} onChange={(e) => set('sku', e.target.value)} placeholder="LP-16" /></div>
      </div>
      <div className="grid3">
        <div className="field"><label className="f">Category</label>
          <select className="f" value={f.category_id} onChange={(e) => set('category_id', e.target.value)}>
            <option value="">Select…</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name} (ceiling {c.discount_ceiling}%)</option>)}
          </select>
        </div>
        <div className="field"><label className="f">Type</label>
          <select className="f" value={f.product_type} onChange={(e) => set('product_type', e.target.value)}>
            <option value="one_time">One-time</option>
            <option value="subscription">Subscription</option>
          </select>
        </div>
        <div className="field"><label className="f">Tax %</label><input className="f" type="number" value={f.tax_rate} onChange={(e) => set('tax_rate', Number(e.target.value))} /></div>
      </div>
      <div className="grid2">
        <div className="field"><label className="f">Base price</label><input className="f" type="number" value={f.base_price} onChange={(e) => set('base_price', e.target.value)} /></div>
        <div className="field"><label className="f">Cost price</label><input className="f" type="number" value={f.cost_price} onChange={(e) => set('cost_price', e.target.value)} /></div>
      </div>
      <div className="field"><label className="f">Description</label><textarea className="f" rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} /></div>
    </Modal>
  );
}

/* ============================================================ PRICELISTS */
export function Pricelists() {
  const { user } = useAuth();
  const { toast } = useToast();
  const nav = useNavigate();
  const [pls, setPls] = useState(null);
  const [products, setProducts] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [open, setOpen] = useState(null); // pricelist detail
  const canEdit = user?.role === 'admin';
  const load = () => api.get('/price-lists').then((r) => setPls(r.price_lists)).catch((e) => toast(e.message, 'err'));
  useEffect(() => {
    load();
    api.get('/products').then((r) => setProducts(r.products.filter((p) => p.active && p.product_type === 'one_time'))).catch(() => {});
  }, []);
  if (!pls) return <div className="page-loading">Loading pricelists…</div>;

  const apply = (pl, price) => Math.round(price * (pl.rule_type === 'discount' ? (1 - pl.value / 100) : (1 + pl.value / 100)) * 100) / 100;
  const sample = (pl) => products.find((p) => p.base_price > 0) || null;

  return (
    <>
      <div className="breadcrumbs">Products ‣ Configuration <b>Pricelists</b></div>
      <div className="ctrl-bar">
        <span className="page-title">Tier pricing — click a pricelist to preview computed prices</span>
        <div style={{ flex: 1 }} />
        {canEdit && <button className="btn-new" onClick={() => setShowNew(true)}>＋ New</button>}
      </div>
      <ListView
        rows={pls}
        onRowClick={(p) => setOpen(p)}
        searchKeys={['name', 'customer_tier', 'currency']}
        columns={[
          { key: 'name', label: 'Pricelist', link: true, render: (p) => <b>{p.name}</b> },
          { key: 'customer_tier', label: 'Customer tier', render: (p) => <Pill status={`tier-${p.customer_tier}`} label={p.tier_label || p.customer_tier} /> },
          { key: 'currency', label: 'Currency', width: 90 },
          { key: 'rule_type', label: 'Rule', render: (p) => p.rule_type === 'discount' ? 'Discount %' : 'Markup %' },
          { key: 'value', label: 'Value', num: true, render: (p) => `${p.value}%` },
          {
            key: 'example', label: 'Example', sort: false, render: (p) => {
              const s = sample(p);
              return s ? <span style={{ color: 'var(--muted)', fontSize: 12 }}>{s.sku}: <b style={{ color: 'var(--text)' }}>{fmtMoney(apply(p, s.base_price), p.currency)}</b> <span style={{ fontSize: 11 }}>(list {fmtMoney(s.base_price)})</span></span> : '—';
            },
          },
          { key: 'active', label: 'Status', render: (p) => <Pill status={p.active ? 'fulfilled' : 'cancelled'} label={p.active ? 'active' : 'off'} /> },
        ]}
      />
      {showNew && <PLModal onClose={() => setShowNew(false)} reload={load} />}
      {open && <PLDetail pl={open} products={products} canEdit={canEdit} onClose={() => setOpen(null)} reload={load} />}
    </>
  );
}

/* Odoo-style pricelist detail: form card + computed price table over the catalog */
function PLDetail({ pl, products, canEdit, onClose, reload }) {
  const { toast } = useToast();
  const [f, setF] = useState({ ...pl });
  const [edit, setEdit] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const apply = (price) => Math.round(price * (f.rule_type === 'discount' ? (1 - f.value / 100) : (1 + f.value / 100)) * 100) / 100;

  const save = async () => {
    try { await api.put(`/price-lists/${pl.id}`, f); toast('Pricelist saved', 'ok'); setEdit(false); reload(); }
    catch (e) { toast(e.message, 'err'); }
  };
  const del = async () => {
    if (!confirm(`Delete ${pl.name}?`)) return;
    try { await api.del(`/price-lists/${pl.id}`); toast('Pricelist deleted', 'ok'); onClose(); reload(); } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <Modal title={`Pricelist — ${pl.name}`} onClose={onClose} wide
      footer={canEdit && (
        <>
          {!edit && <button className="btn danger" onClick={del}>Delete</button>}
          <div style={{ flex: 1 }} />
          {!edit && <button className="btn" onClick={onClose}>Close</button>}
          {!edit && <button className="btn primary" onClick={() => setEdit(true)}>✎ Edit</button>}
          {edit && <button className="btn" onClick={() => { setF({ ...pl }); setEdit(false); }}>Cancel</button>}
          {edit && <button className="btn primary" onClick={save}>💾 Save</button>}
        </>
      )}>
      <div className="grid4" style={{ marginBottom: 14 }}>
        <div className="field" style={{ margin: 0 }}><label className="f">Name</label>
          {edit ? <input className="f" value={f.name} onChange={(e) => set('name', e.target.value)} /> : <div className="form-value"><b>{f.name}</b></div>}
        </div>
        <div className="field" style={{ margin: 0 }}><label className="f">Tier</label>
          {edit ? <select className="f" value={f.customer_tier} onChange={(e) => set('customer_tier', e.target.value)}><option>gold</option><option>silver</option><option>bronze</option></select>
            : <div className="form-value"><Pill status={`tier-${f.customer_tier}`} label={f.customer_tier} /></div>}
        </div>
        <div className="field" style={{ margin: 0 }}><label className="f">Rule</label>
          {edit ? <select className="f" value={f.rule_type} onChange={(e) => set('rule_type', e.target.value)}><option value="discount">Discount off list</option><option value="markup">Markup on list</option></select>
            : <div className="form-value">{f.rule_type === 'discount' ? '−' : '+'}{f.value}%</div>}
        </div>
        <div className="field" style={{ margin: 0 }}><label className="f">Value % · Currency</label>
          {edit ? <span style={{ display: 'flex', gap: 6 }}>
            <input className="f" type="number" value={f.value} onChange={(e) => set('value', Number(e.target.value))} />
            <select className="f" style={{ width: 80 }} value={f.currency} onChange={(e) => set('currency', e.target.value)}><option>USD</option><option>INR</option></select>
          </span> : <div className="form-value">{f.value}% · {f.currency}</div>}
        </div>
      </div>

      <h3 style={{ margin: '4px 0 8px', fontSize: 13.5 }}>Computed prices <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>— every active one-time product</span></h3>
      <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
        <table className="list" style={{ margin: 0 }}>
          <thead><tr><th>Product</th><th className="num">List price</th><th className="num">{f.rule_type === 'discount' ? 'Discount' : 'Markup'}</th><th className="num">Computed price</th><th className="num">Margin after</th></tr></thead>
          <tbody>
            {products.slice(0, 14).map((p) => {
              const fin = apply(p.base_price);
              const m = fin > 0 ? (fin - p.cost_price) / fin * 100 : 0;
              return (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className="num">{fmtMoney(p.base_price)}</td>
                  <td className="num" style={{ color: '#B3611E' }}>{f.rule_type === 'discount' ? '−' : '+'}{fmtMoney(Math.abs(fin - p.base_price))}</td>
                  <td className="num"><b>{fmtMoney(fin, f.currency)}</b></td>
                  <td className="num" style={{ color: m >= 30 ? '#0F7B3D' : '#B3611E' }}>{m.toFixed(0)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
function PLModal({ onClose, reload }) {
  const { toast } = useToast();
  const [f, setF] = useState({ name: '', customer_tier: 'gold', currency: 'USD', rule_type: 'discount', value: 5 });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    try { await api.post('/price-lists', f); toast('Pricelist created', 'ok'); reload(); onClose(); }
    catch (e) { toast(e.message, 'err'); }
  };
  return (
    <Modal title="New pricelist" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!f.name} onClick={save}>Create</button></>}>
      <div className="field"><label className="f">Name</label><input className="f" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
      <div className="grid3">
        <div className="field"><label className="f">Tier</label>
          <select className="f" value={f.customer_tier} onChange={(e) => set('customer_tier', e.target.value)}>
            <option>gold</option><option>silver</option><option>bronze</option>
          </select>
        </div>
        <div className="field"><label className="f">Currency</label>
          <select className="f" value={f.currency} onChange={(e) => set('currency', e.target.value)}><option>USD</option><option>INR</option></select>
        </div>
        <div className="field"><label className="f">Value %</label><input className="f" type="number" value={f.value} onChange={(e) => set('value', Number(e.target.value))} /></div>
      </div>
      <div className="field"><label className="f">Rule</label>
        <select className="f" value={f.rule_type} onChange={(e) => set('rule_type', e.target.value)}>
          <option value="discount">Discount from list</option><option value="markup">Markup on list</option>
        </select>
      </div>
    </Modal>
  );
}

/* ============================================================ GOVERNANCE (discount tiers + approval rules) */
export function Governance() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const canEdit = user?.role === 'admin';
  const [err, setErr] = useState('');
  const load = () => { setErr(''); api.get('/governance').then(setData).catch((e) => { setErr(e.message); toast(e.message, 'err'); }); };
  useEffect(() => { load(); }, []);
  if (err) return <div className="card pad" style={{ margin: 20 }}><h3>Unable to load governance</h3><p style={{ color: '#DC2626' }}>{err}</p><button className="btn primary" onClick={load}>Retry</button></div>;
  if (!data) return <div className="page-loading">Loading governance…</div>;

  const saveTier = async (tier, val) => {
    try { await api.put(`/discount-tiers/${tier}`, { max_discount_pct: Number(val) }); toast('Ceiling updated', 'ok'); load(); } catch (e) { toast(e.message, 'err'); }
  };
  const delRule = async (id) => {
    if (!confirm('Delete rule?')) return;
    try { await api.del(`/approval-rules/${id}`); load(); } catch (e) { toast(e.message, 'err'); }
  };
  const toggleRule = async (r) => {
    try { await api.put(`/approval-rules/${r.id}`, { active: !r.active }); load(); } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <>
      <div className="breadcrumbs">Products ‣ Configuration <b>Discount Governance</b></div>
      <div className="settings-section">
        <h2>Customer-tier discount ceilings</h2>
        <div className="desc">Per-line discount = min(tier ceiling, category ceiling). Effective discount is line + compounded order discount.</div>
        {data.discount_tiers.map((t) => (
          <div className="setting-row" key={t.customer_tier}>
            <div className="lbl"><b style={{ textTransform: 'capitalize' }}>{t.customer_tier} customers</b><span>max allowed discount before violations accrue</span></div>
            <div className="ctl" style={{ display: 'flex', gap: 6 }}>
              <input className="f" type="number" defaultValue={t.max_discount_pct} disabled={!canEdit} id={`tier-${t.customer_tier}`} />
              {canEdit && <button className="btn sm" onClick={() => saveTier(t.customer_tier, document.getElementById(`tier-${t.customer_tier}`).value)}>Save</button>}
            </div>
          </div>
        ))}
      </div>
      <div className="settings-section">
        <h2>Approval routing rules</h2>
        <div className="desc">Blended risk = worst-line violation + 50% of remaining overage. Rules route quotations to manager/finance in sequence.</div>
        <ListView
          rows={data.approval_rules}
          searchKeys={['name', 'level']}
          columns={[
            { key: 'name', label: 'Rule', link: true },
            { key: 'level', label: 'Approver', render: (r) => <b style={{ textTransform: 'capitalize' }}>{r.level}</b> },
            { key: 'sequence', label: 'Step', num: true },
            { key: 'risk_min', label: 'Risk min', num: true },
            { key: 'risk_max', label: 'Risk max', num: true },
            { key: 'any_line_over', label: 'Hard cap (any line >)', num: true, render: (r) => r.any_line_over != null ? `${r.any_line_over}%` : '—' },
            { key: 'active', label: 'Status', render: (r) => <Pill status={r.active ? 'fulfilled' : 'cancelled'} label={r.active ? 'active' : 'off'} /> },
            ...(canEdit ? [{ key: '_act', label: '', sort: false, render: (r) => (
              <span style={{ display: 'flex', gap: 6 }}>
                <button className="btn sm" onClick={() => toggleRule(r)}>{r.active ? 'Disable' : 'Enable'}</button>
                <button className="btn sm danger" onClick={() => delRule(r.id)}>Delete</button>
              </span>
            ) }] : []),
          ]}
        />
      </div>
    </>
  );
}

/* ============================================================ SUBSCRIPTION PLANS */
export function Plans() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const canEdit = user?.role === 'admin';
  const [err, setErr] = useState('');
  const load = () => { setErr(''); api.get('/plans').then(setData).catch((e) => { setErr(e.message); toast(e.message, 'err'); }); };
  useEffect(() => { load(); }, []);
  if (err) return <div className="card pad" style={{ margin: 20 }}><h3>Unable to load subscription plans</h3><p style={{ color: '#DC2626' }}>{err}</p><button className="btn primary" onClick={load}>Retry</button></div>;
  if (!data) return <div className="page-loading">Loading plans…</div>;

  return (
    <>
      <div className="breadcrumbs">Products ‣ Configuration <b>Subscription Plans</b></div>
      <div className="ctrl-bar">
        <span className="page-title">Billing cycles, <b>daily proration</b> & cancellation policies</span>
        <div style={{ flex: 1 }} />
        {canEdit && <button className="btn-new" onClick={() => setShowNew(true)}>＋ New plan</button>}
      </div>
      <ListView
        rows={data.plans}
        searchKeys={['name', 'billing_period', 'cancellation_policy']}
        columns={[
          { key: 'name', label: 'Plan', link: true },
          { key: 'billing_period', label: 'Cycle', render: (p) => <span style={{ textTransform: 'capitalize' }}>{p.billing_period}</span> },
          { key: 'proration_rule', label: 'Proration', render: (p) => p.proration_rule === 'daily' ? 'Daily' : 'None' },
          { key: 'cancellation_policy', label: 'Cancellation', render: (p) => p.cancellation_policy === 'refund_prorated' ? 'Prorated refund' : p.cancellation_policy === 'refund_pct' ? `${p.refund_pct}% refund` : 'No refund' },
          { key: 'notice_days', label: 'Notice days', num: true },
          { key: 'active', label: 'Status', render: (p) => <Pill status={p.active ? 'fulfilled' : 'cancelled'} label={p.active ? 'active' : 'off'} /> },
        ]}
      />
      <div className="card pad" style={{ marginTop: 4 }}>
        <h3>Product ↔ plan bindings</h3>
        <table className="list">
          <thead><tr><th>Product</th><th>Plan</th><th className="num">Recurring price</th></tr></thead>
          <tbody>
            {data.product_plans.map((pp) => (
              <tr key={pp.id}><td>{pp.product_name}</td><td>{pp.plan_name}</td><td className="num"><b>{fmtMoney(pp.recurring_price)}</b></td></tr>
            ))}
          </tbody>
        </table>
      </div>
      {showNew && <PlanModal onClose={() => setShowNew(false)} reload={load} />}
    </>
  );
}
function PlanModal({ onClose, reload }) {
  const { toast } = useToast();
  const [f, setF] = useState({ name: '', billing_period: 'monthly', proration_rule: 'daily', cancellation_policy: 'refund_prorated', refund_pct: 0, notice_days: 0 });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    try { await api.post('/plans', f); toast('Plan created', 'ok'); reload(); onClose(); }
    catch (e) { toast(e.message, 'err'); }
  };
  return (
    <Modal title="New subscription plan" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!f.name} onClick={save}>Create</button></>}>
      <div className="field"><label className="f">Plan name</label><input className="f" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
      <div className="grid3">
        <div className="field"><label className="f">Billing</label>
          <select className="f" value={f.billing_period} onChange={(e) => set('billing_period', e.target.value)}>
            <option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option>
          </select>
        </div>
        <div className="field"><label className="f">Proration</label>
          <select className="f" value={f.proration_rule} onChange={(e) => set('proration_rule', e.target.value)}>
            <option value="daily">Daily</option><option value="none">None</option>
          </select>
        </div>
        <div className="field"><label className="f">Notice days</label><input className="f" type="number" value={f.notice_days} onChange={(e) => set('notice_days', Number(e.target.value))} /></div>
      </div>
      <div className="grid2">
        <div className="field"><label className="f">Cancellation policy</label>
          <select className="f" value={f.cancellation_policy} onChange={(e) => set('cancellation_policy', e.target.value)}>
            <option value="refund_prorated">Prorated refund</option>
            <option value="refund_pct">% refund</option>
            <option value="none">No refund</option>
          </select>
        </div>
        {f.cancellation_policy === 'refund_pct' && (
          <div className="field"><label className="f">Refund %</label><input className="f" type="number" value={f.refund_pct} onChange={(e) => set('refund_pct', Number(e.target.value))} /></div>
        )}
      </div>
    </Modal>
  );
}

/* ============================================================ UPSELL RULES */
export function Upsell() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const canEdit = ['admin', 'manager'].includes(user?.role);
  const load = () => api.get('/upsell-rules').then(setData).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, []);
  if (!data) return <div className="page-loading">Loading upsell rules…</div>;

  return (
    <>
      <div className="breadcrumbs">Products ‣ Configuration <b>Upsell Rules</b></div>
      <div className="ctrl-bar">
        <span className="page-title">Co-purchase engine — <b>score + 0.15</b> boost for promoted products</span>
        <div style={{ flex: 1 }} />
        {canEdit && <button className="btn-new" onClick={() => setShowNew(true)}>＋ New rule</button>}
      </div>
      <ListView
        rows={data.rules}
        searchKeys={['trigger_name', 'suggested_name', 'source']}
        columns={[
          { key: 'trigger_name', label: 'When cart has…' },
          { key: 'suggested_name', label: 'Suggest' },
          { key: 'co_score', label: 'Co-score', num: true, render: (r) => <b>{r.co_score.toFixed(2)}</b> },
          { key: 'source', label: 'Source', render: (r) => <span className="pill" style={{ background: '#EDEFF2', color: '#5F6B7A' }}>{r.source}</span> },
          { key: 'active', label: 'Status', render: (r) => <Pill status={r.active ? 'fulfilled' : 'cancelled'} label={r.active ? 'active' : 'off'} /> },
          ...(canEdit ? [{ key: '_act', label: '', sort: false, render: (r) => (
            <span style={{ display: 'flex', gap: 6 }}>
              <button className="btn sm" onClick={async () => { await api.put(`/upsell-rules/${r.id}`, { active: !r.active }); load(); }}>{r.active ? 'Disable' : 'Enable'}</button>
              <button className="btn sm danger" onClick={async () => { if (confirm('Delete rule?')) { await api.del(`/upsell-rules/${r.id}`); load(); } }}>Delete</button>
            </span>
          ) }] : []),
        ]}
      />
      {showNew && <UpsellModal onClose={() => setShowNew(false)} reload={load} />}
    </>
  );
}
function UpsellModal({ onClose, reload }) {
  const { toast } = useToast();
  const [products, setProducts] = useState([]);
  const [f, setF] = useState({ trigger_product_id: '', suggested_product_id: '', co_score: 0.5 });
  useEffect(() => { api.get('/products').then((r) => setProducts(r.products.filter((p) => p.active))); }, []);
  const save = async () => {
    try {
      await api.post('/upsell-rules', { trigger_product_id: Number(f.trigger_product_id), suggested_product_id: Number(f.suggested_product_id), co_score: Number(f.co_score), source: 'manual' });
      toast('Rule created', 'ok'); reload(); onClose();
    } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <Modal title="New upsell rule" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!f.trigger_product_id || !f.suggested_product_id} onClick={save}>Create</button></>}>
      <div className="field"><label className="f">Trigger product (in cart)</label>
        <select className="f" value={f.trigger_product_id} onChange={(e) => setF({ ...f, trigger_product_id: e.target.value })}>
          <option value="">Select…</option>
          {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="field"><label className="f">Suggested product</label>
        <select className="f" value={f.suggested_product_id} onChange={(e) => setF({ ...f, suggested_product_id: e.target.value })}>
          <option value="">Select…</option>
          {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="field"><label className="f">Co-purchase score (0–1)</label><input className="f" type="number" step="0.01" min="0" max="1" value={f.co_score} onChange={(e) => setF({ ...f, co_score: e.target.value })} /></div>
    </Modal>
  );
}

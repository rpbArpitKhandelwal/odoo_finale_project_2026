import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtMoney } from '../api';
import ListView from '../components/ListView';
import { Pill, Modal, useToast, Meter } from '../components/ui';
import { useAuth } from '../auth';

export default function Warehouses() {
  const { user } = useAuth();
  const nav = useNavigate();
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [restock, setRestock] = useState(null); // {warehouse, product}
  const [lowFilter, setLowFilter] = useState(null); // warehouse id → table shows only that warehouse's below-reorder lines
  const canEdit = ['admin', 'finance'].includes(user.role);

  const load = () => api.get('/warehouses').then(setData).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, []);
  if (!data) return <div className="page-loading">Loading inventory…</div>;

  const doRestock = async (qty) => {
    try {
      const r = await api.post(`/warehouses/${restock.warehouse.id}/restock`, { product_id: restock.product.product_id, qty: Number(qty) });
      toast(`+${qty} ${restock.product.product_name} → ${restock.warehouse.name}`, 'ok');
      if (r.backorder_prompts?.length) toast(`📦 Stock arrived for backordered order(s) ${r.backorder_prompts.map((p) => p.number).join(', ')} — "Consolidate Remaining Backorder" prompt raised`, '');
      setRestock(null); load();
    } catch (e) { toast(e.message, 'err'); }
  };
  const replenish = async () => {
    try {
      const r = await api.post('/warehouses/replenish', {});
      toast(r.applied.length ? `Replenishment rules applied: ${r.applied.map((a) => `${a.product} @ ${a.warehouse} +${a.added}`).join(', ')}` : 'Nothing below its reorder point', r.applied.length ? 'ok' : '');
      load();
    } catch (e) { toast(e.message, 'err'); }
  };
  const belowReorder = data.stock.filter((s) => s.qty <= s.reorder_point && s.replenishment_qty > 0).length;
  const totalReserved = data.stock.reduce((s, r) => s + (r.reserved || 0), 0);
  const totalBackorder = (data.backorders || []).reduce((s, b) => s + Number(b.qty), 0);

  return (
    <>
      <div className="breadcrumbs">Inventory <b>Warehouses & Stock</b></div>
      <div className="kpi-chips">
        {data.warehouses.map((w) => {
          const rows = data.stock.filter((s) => s.warehouse_id === w.id);
          const low = rows.filter((s) => s.qty <= s.reorder_point).length;
          return (
            <div className={`kpi-chip ${lowFilter === w.id ? 'active' : ''}`} key={w.id} style={{ background: low > 0 ? '#B3611E' : '#0F7B3D' }}
              onClick={() => setLowFilter((f) => (f === w.id ? null : w.id))} title={`Show ${w.name} lines at or below their reorder point`}>
              <span className="cnt">{low}</span> {w.name} low
            </div>
          );
        })}
        {lowFilter && <button className="btn sm" style={{ alignSelf: 'center' }} onClick={() => setLowFilter(null)}>✕ Clear filter</button>}
        <div className="kpi-summary">
          <div><b>{totalReserved}</b><span className="up">units reserved by confirmed orders</span></div>
          <div style={{ cursor: totalBackorder ? 'pointer' : 'default' }} title={totalBackorder ? 'Open the orders with backordered units' : ''} onClick={() => totalBackorder && nav('/orders?chip=deliver')}>
            <b style={{ color: totalBackorder ? '#CD3D63' : 'inherit' }}>{totalBackorder}</b><span className="up">units on backorder{totalBackorder ? ' · view orders →' : ''}</span>
          </div>
          {canEdit && <div><button className="btn primary sm" onClick={replenish} disabled={!belowReorder} title="Top up every stock line at/below its reorder point by its replenishment lot">⟳ Run replenishment rules ({belowReorder})</button></div>}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12, padding: '6px 18px' }}>
        {data.warehouses.map((w) => {
          const rows = data.stock.filter((s) => s.warehouse_id === w.id);
          const totalUnits = rows.reduce((s, r) => s + r.qty, 0);
          return (
            <div className="card pad" key={w.id} style={{ margin: 0 }}>
              <h3>{w.name} <span className="muted">({w.code})</span>
                <Pill status={w.active ? 'fulfilled' : 'cancelled'} label={w.active ? 'active' : 'off'} />
              </h3>
              <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 8 }}>
                {w.address} · freight weight ×{w.shipping_cost_weight} · {totalUnits} units on hand
              </div>
              {rows.slice(0, 6).map((s) => {
                const low = s.qty <= s.reorder_point;
                return (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12.5 }}>
                    <div style={{ width: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.product_name}>{s.product_name}</div>
                    <Meter value={s.qty} max={Math.max(s.reorder_point * 2, s.qty, 1)} color={low ? '#CD3D63' : '#0F7B3D'} />
                    <b style={{ width: 34, textAlign: 'right', color: low ? '#CD3D63' : 'inherit' }} title={`${s.free} free · ${s.reserved || 0} reserved`}>{s.qty}</b>
                    {canEdit && <button className="btn sm" onClick={() => setRestock({ warehouse: w, product: s })}>+</button>}
                  </div>
                );
              })}
              {rows.length > 6 && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>+{rows.length - 6} more products…</div>}
            </div>
          );
        })}
      </div>

      <div style={{ height: 8 }} />
      <ListView
        rows={lowFilter ? data.stock.filter((s) => s.warehouse_id === lowFilter && s.qty <= s.reorder_point) : data.stock}
        searchKeys={['product_name', 'sku', 'warehouse_name']}
        empty={lowFilter ? 'Nothing below its reorder point in this warehouse' : 'No stock records'}
        columns={[
          { key: 'product_name', label: 'Product', link: true },
          { key: 'sku', label: 'SKU', width: 100 },
          { key: 'warehouse_name', label: 'Warehouse', width: 150 },
          { key: 'qty', label: 'On hand', num: true, render: (s) => <b style={{ color: s.qty <= s.reorder_point ? '#CD3D63' : 'inherit' }}>{s.qty}</b> },
          { key: 'reserved', label: 'Reserved', num: true, render: (s) => <span className="stock-reserved">{s.reserved || 0}</span> },
          { key: 'free', label: 'Free', num: true, render: (s) => <span className="stock-free">{s.free}</span> },
          { key: 'reorder_point', label: 'Reorder pt', num: true },
          { key: 'replenishment_qty', label: 'Replenish lot', num: true },
          { key: 'state', label: 'State', sort: false, render: (s) => <Pill status={s.qty <= s.reorder_point ? 'backorder' : 'fulfilled'} label={s.qty <= s.reorder_point ? 'below reorder point' : 'healthy'} /> },
          ...(canEdit ? [{ key: '_act', label: '', sort: false, render: (s) => (
            <button className="btn sm" onClick={() => setRestock({ warehouse: data.warehouses.find((w) => w.id === s.warehouse_id), product: s })}>Restock</button>
          ) }] : []),
        ]}
      />

      {restock && <RestockModal ctx={restock} onClose={() => setRestock(null)} onSave={doRestock} />}
    </>
  );
}

function RestockModal({ ctx, onClose, onSave }) {
  const [qty, setQty] = useState('10');
  return (
    <Modal title={`Restock ${ctx.product.product_name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onSave(qty)}>Add stock</button></>}>
      <p style={{ marginTop: 0 }}>Add units to <b>{ctx.warehouse.name}</b>. Replenishment lot size: {ctx.product.replenishment_qty}.</p>
      <div className="field"><label className="f">Quantity</label><input className="f" type="number" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
    </Modal>
  );
}

/* Hand-built SVG charts — interactive hover tooltips (HTML overlay for crisp text), no chart library */
import React, { useState } from 'react';

/* HTML tooltip positioned over the chart (percent-based, distortion-free) */
function ChartTip({ tip, height }) {
  if (!tip) return null;
  const topPx = Math.max(4, (tip.yPct / 100) * height - 46);
  return (
    <div className="chart-tip" style={{ left: `${tip.xPct}%`, top: topPx }}>
      <div className="t-label">{tip.label}</div>
      <div className="t-value">{tip.value}</div>
      <div className="t-arrow" />
    </div>
  );
}

export function BarChart({ data, height = 190, fmt }) {
  // data: [{ label, value, color? }] — hover a bar to highlight it and show a tooltip
  const [tip, setTip] = useState(null);
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const bw = 100 / Math.max(data.length, 1);
  const H = height / 3;
  const show = (v) => (fmt ? fmt(v) : String(v));
  return (
    <div style={{ position: 'relative' }}>
      <ChartTip tip={tip} height={height} />
      <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }}>
        <defs>
          <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#926483" />
            <stop offset="100%" stopColor="#714B67" />
          </linearGradient>
        </defs>
        <line x1={0} y1={H - 6} x2={100} y2={H - 6} stroke="#E5E7EB" strokeWidth={0.3} />
        {data.map((d, i) => {
          const h = (d.value / max) * (H - 10);
          const cx = i * bw + bw / 2;
          const isHover = hover === i;
          return (
            <g key={i}
              onMouseEnter={() => { setHover(i); setTip({ xPct: cx, yPct: ((H - 6 - h) / H) * 100, label: d.label, value: show(d.value) }); }}
              onMouseLeave={() => { setHover(null); setTip(null); }}
              style={{ cursor: 'pointer' }}>
              <rect x={i * bw} y={0} width={bw} height={H} fill="transparent" />
              <rect x={i * bw + bw * 0.18} y={H - 6 - h} width={bw * 0.64} height={h} rx={0.6}
                fill={d.color || 'url(#barGrad)'}
                opacity={hover == null || isHover ? 0.95 : 0.4}
                style={{ transition: 'opacity .15s' }} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function LineChart({ series, height = 190, fmt }) {
  // hover anywhere to track the nearest point with a guide line + tooltip
  const [hover, setHover] = useState(null);
  const vals = series.map((s) => s.value);
  const max = Math.max(1, ...vals);
  const H = height / 3, W = 100;
  const pt = (i) => [(i / Math.max(1, series.length - 1)) * (W - 8) + 4, H - 8 - (vals[i] / max) * (H - 18)];
  const line = series.map((_, i) => pt(i).join(',')).join(' ');
  const area = `4,${H - 8} ${line} ${W - 4},${H - 8}`;
  const show = (v) => (fmt ? fmt(v) : String(v));
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const rel = ((e.clientX - r.left) / r.width) * W;
    let best = 0, bestD = 1e9;
    series.forEach((_, i) => { const d = Math.abs(pt(i)[0] - rel); if (d < bestD) { bestD = d; best = i; } });
    setHover(best);
  };
  const tip = hover != null ? {
    xPct: pt(hover)[0], yPct: (pt(hover)[1] / H) * 100,
    label: series[hover].label, value: show(series[hover].value),
  } : null;
  return (
    <div style={{ position: 'relative' }}>
      <ChartTip tip={tip} height={height} />
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="lineFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#714B67" stopOpacity={0.28} />
            <stop offset="100%" stopColor="#714B67" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <line x1={0} y1={H - 8} x2={100} y2={H - 8} stroke="#E5E7EB" strokeWidth={0.3} />
        <polygon points={area} fill="url(#lineFill)" />
        <polyline points={line} fill="none" stroke="#714B67" strokeWidth={0.9} strokeLinejoin="round" />
        {series.map((s, i) => (
          <circle key={i} cx={pt(i)[0]} cy={pt(i)[1]} r={hover === i ? 1.8 : 1.1} fill={hover === i ? '#4E2E5E' : '#714B67'}
            stroke="#fff" strokeWidth={hover === i ? 0.45 : 0} style={{ transition: 'r .12s' }} />
        ))}
        {hover != null && (
          <line x1={pt(hover)[0]} y1={4} x2={pt(hover)[0]} y2={H - 8} stroke="#B78CA9" strokeWidth={0.3} strokeDasharray="1.2 1" />
        )}
      </svg>
    </div>
  );
}

export function HBars({ data, fmt }) {
  // data: [{ label, value, color?, sub? }] — hoverable rows with value chip + native tooltip
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const show = (v) => (fmt ? fmt(v) : String(v));
  return (
    <div>
      {data.map((d, i) => (
        <div key={i} className={`hbar-row ${hover === i ? 'hot' : ''}`}
          onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
          title={`${d.label}: ${show(d.value)}${d.sub ? ' · ' + d.sub : ''}`}>
          <div style={{ width: 150, flex: 'none', fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}</div>
          <div className="meter" style={{ flex: 1, height: 13 }}>
            <div style={{ width: `${(d.value / max) * 100}%`, background: d.color || 'linear-gradient(90deg,#926483,#714B67)', transition: 'width .18s' }} />
          </div>
          <b style={{ width: 92, textAlign: 'right', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>{show(d.value)}</b>
        </div>
      ))}
    </div>
  );
}

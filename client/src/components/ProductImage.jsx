/* Hand-drawn SVG product illustrations — zero image assets, crisp at any size.
 * pickIcon maps sku/type to a line-art drawing with its soft background color. */
import React from 'react';

const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' };

const ICONS = {
  laptop: { bg: '#E8EEF9', fg: '#3B5BDB', draw: <><rect x="9" y="10" width="30" height="20" rx="2.5" {...S} /><path d="M5 36h38l-4-6H9z" {...S} /></> },
  monitor: { bg: '#E6F3F1', fg: '#0B7285', draw: <><rect x="8" y="9" width="32" height="22" rx="2.5" {...S} /><path d="M24 31v7M16 38h16" {...S} /></> },
  mouse: { bg: '#FDF0E7', fg: '#C2571B', draw: <><rect x="15" y="7" width="18" height="34" rx="9" {...S} /><path d="M24 7v12M15 19h18" {...S} /></> },
  keyboard: { bg: '#EFEAF7', fg: '#6741B8', draw: <><rect x="6" y="14" width="36" height="20" rx="3" {...S} /><path d="M12 20h4M20 20h4M28 20h4M36 20h.5M12 27h20M36 27h.5" {...S} /></> },
  router: { bg: '#E7F0FA', fg: '#1C64A8', draw: <><rect x="9" y="24" width="30" height="14" rx="3" {...S} /><path d="M16 24v-8M32 24v-8M14 31h4M22 31h4" {...S} /><path d="M20 12a6 6 0 0 1 8 0" {...S} /></> },
  dock: { bg: '#F3EDE4', fg: '#8A6D2F', draw: <><rect x="10" y="16" width="28" height="18" rx="3" {...S} /><path d="M15 23h5M24 23h5M33 23h.5M15 29h18M40 25h4v8" {...S} /></> },
  sleeve: { bg: '#F7EBEA', fg: '#B03A2E', draw: <><path d="M9 12h10l3 5h17a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V15a3 3 0 0 1 3-3z" {...S} /><path d="M14 24h20" {...S} /></> },
  wrench: { bg: '#E9F1EC', fg: '#2B7A4B', draw: <><path d="M31 9a9 9 0 0 0-8.6 12L9 34.4A4 4 0 0 0 14.6 40L28 26.6A9 9 0 0 0 40 18l-6 3-4-4 3-6a9 9 0 0 0-2-2z" {...S} /></> },
  board: { bg: '#FDF3E0', fg: '#9A6A00', draw: <><rect x="8" y="9" width="32" height="22" rx="2.5" {...S} /><path d="M14 26l7-9 5 6 4-5 4 8M16 31l-3 7M32 31l3 7" {...S} /></> },
  shield: { bg: '#E8F0FB', fg: '#2F5CB8', draw: <><path d="M24 6l15 5v11c0 9.5-6.4 16.6-15 20-8.6-3.4-15-10.5-15-20V11z" {...S} /><path d="M17 24l5 5 9-10" {...S} /></> },
  cloudUp: { bg: '#E6F5F3', fg: '#0C7F72', draw: <><path d="M14 30a6 6 0 0 1-.8-12A9 9 0 0 1 30 15a6.5 6.5 0 0 1 4 15H14z" {...S} /><path d="M24 24v12M19 29l5-5 5 5" {...S} /></> },
  headset: { bg: '#F1E9F8', fg: '#7048B6', draw: <><path d="M11 28v-3a13 13 0 0 1 26 0v3" {...S} /><rect x="8" y="27" width="7" height="11" rx="2.5" {...S} /><rect x="33" y="27" width="7" height="11" rx="2.5" {...S} /><path d="M36 38a8 8 0 0 1-8 5h-3" {...S} /></> },
  lock: { bg: '#FBEEE8', fg: '#C2410C', draw: <><rect x="12" y="21" width="24" height="18" rx="3" {...S} /><path d="M17 21v-5a7 7 0 0 1 14 0v5M24 28v5" {...S} /></> },
  box: { bg: '#EDEFF2', fg: '#5F6B7A', draw: <><path d="M24 7l15 7v20l-15 7-15-7V14z" {...S} /><path d="M9 14l15 7 15-7M24 21v20" {...S} /></> },
  briefcase: { bg: '#EDEFF2', fg: '#5F6B7A', draw: <><rect x="7" y="15" width="34" height="22" rx="3" {...S} /><path d="M18 15v-3a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v3M7 25h34" {...S} /></> },
  cloud: { bg: '#E6F5F3', fg: '#0C7F72', draw: <><path d="M14 32a6 6 0 0 1-.8-12A9 9 0 0 1 30 17a6.5 6.5 0 0 1 4 15H14z" {...S} /></> },
};

const bySku = {
  'LP-': 'laptop', 'LU-': 'laptop', 'MON-': 'monitor', 'MOU-': 'mouse', 'KBD-': 'keyboard',
  'RTR-': 'router', 'DOCK-': 'dock', 'SLV-': 'sleeve',
  'SVC-INST': 'wrench', 'SVC-TRN': 'board', 'SVC-WAR': 'shield',
  'SUB-BKP': 'cloudUp', 'SUB-SUP': 'headset', 'SUB-SEC': 'lock',
};

/* order/portal lines carry descriptions, not SKUs — match by product name prefix */
const byName = {
  'Laptop Pro': 'laptop', 'Laptop Ultra': 'laptop', '27" 4K': 'monitor', 'Wireless Mouse': 'mouse',
  'Mechanical Keyboard': 'keyboard', 'Wi-Fi 6': 'router', 'USB-C Docking': 'dock', 'Laptop Sleeve': 'sleeve',
  'Installation': 'wrench', 'Onsite Training': 'board', 'Extended Warranty': 'shield',
  'Cloud Backup': 'cloudUp', 'Premium Support': 'headset', 'Security Suite': 'lock',
};

export function pickProductIcon(product) {
  const sku = String(product?.sku || '');
  for (const [prefix, icon] of Object.entries(bySku)) if (sku.startsWith(prefix)) return icon;
  const name = String(product?.name || product?.description || '');
  for (const [prefix, icon] of Object.entries(byName)) if (name.startsWith(prefix)) return icon;
  if (product?.product_type === 'subscription') return 'cloud';
  if (product?.product_type === 'one_time' && product?.stocked === false) return 'briefcase';
  return 'box';
}

export default function ProductImage({ product, size = 34, style }) {
  const key = pickProductIcon(product);
  const icon = ICONS[key] || ICONS.box;
  return (
    <span className="p-img" style={{ width: size, height: size, background: icon.bg, color: icon.fg, ...style }} title={product?.name}>
      <svg viewBox="0 0 48 48" width={size * 0.68} height={size * 0.68}>{icon.draw}</svg>
    </span>
  );
}

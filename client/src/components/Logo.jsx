import React from 'react';

/* DealFlow360 brand mark: a bold "D" carved by three flow lines (deals flowing through governance),
 * with a 360° arc sweeping around it. Pure SVG, crisp at any size, no image assets. */
export function LogoMark({ size = 28, variant = 'light' }) {
  // light: white tile + purple mark (on the purple navbar) · dark: purple tile + white mark (on light backgrounds)
  const tile = variant === 'light' ? '#FFFFFF' : 'url(#dfTile)';
  const ink = variant === 'light' ? '#714B67' : '#FFFFFF';
  const accent = variant === 'light' ? '#017E84' : '#8FE3DA';
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-label="DealFlow360" style={{ display: 'block', flex: 'none' }}>
      <defs>
        <linearGradient id="dfTile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#8B5E83" />
          <stop offset="100%" stopColor="#4E2E5E" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="38" height="38" rx="10" fill={tile} />
      {/* the D */}
      <path d="M12 9.5h7.5c6.1 0 10.5 4.6 10.5 10.5S25.6 30.5 19.5 30.5H12z" fill={ink} />
      {/* three flow lines cutting through the D */}
      <path d="M8 15.5h17M8 20h19M8 24.5h17" stroke={tile === '#FFFFFF' ? '#FFFFFF' : '#5A3A5A'} strokeWidth="2.4" strokeLinecap="round" fill="none" />
      {/* 360° sweep */}
      <path d="M31 12.5a11.5 11.5 0 0 1 1.2 13.9" stroke={accent} strokeWidth="2.4" strokeLinecap="round" fill="none" />
      <circle cx="32.6" cy="29.2" r="1.9" fill={accent} />
    </svg>
  );
}

/* Wordmark: "DealFlow" + accent "360". Inherits the surrounding text colour. */
export function Wordmark({ size = 16, accent = '#8FE3DA', suffix }) {
  return (
    <span style={{ fontWeight: 800, fontSize: size, letterSpacing: '-0.2px', whiteSpace: 'nowrap', lineHeight: 1 }}>
      DealFlow<span style={{ color: accent, fontWeight: 900 }}>360</span>
      {suffix && <span style={{ fontWeight: 500, opacity: 0.85 }}> {suffix}</span>}
    </span>
  );
}

export default function Logo({ size = 28, textSize = 16, variant = 'light', accent, suffix, gap = 9 }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap }}>
      <LogoMark size={size} variant={variant} />
      <Wordmark size={textSize} accent={accent || (variant === 'light' ? '#8FE3DA' : '#017E84')} suffix={suffix} />
    </span>
  );
}

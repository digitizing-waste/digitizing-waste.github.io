import { useState, useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer } from '@deck.gl/layers';
import { MapView, FlyToInterpolator } from '@deck.gl/core';
import issopayData from '../data/geojson/Issopay.geojson';

// ─── Constants ───────────────────────────────────────────────────────────────

const LIVELLI = ['A', 'B', 'C', 'D', 'E'];

// Per-layer focus view states.
// Each shifts pitch + latitude so that specific Livello's Z elevation
// lands near the centre of the viewport. Second click returns to overview.
const LAYER_FOCUS = {
  A: { pitch: 35, latitude: 31.76,  zoom: 10.6, longitude: 9.21 },
  B: { pitch: 35, latitude: 31.76,  zoom: 10.8, longitude: 9.21 },
  C: { pitch: 35, latitude: 31.73,  zoom: 11.4, longitude: 9.21 },
  D: { pitch: 35, latitude: 31.71, zoom: 11.8, longitude: 9.21 },
  E: { pitch: 35, latitude: 31.67,  zoom: 13, longitude: 9.21  },
};

// Z base elevation (metres) for each geological layer.
// The field spans ~10 km; layers are spaced 5 km apart so the stack
// is visually prominent at the 12-zoom view.
const LIVELLO_Z = { A: 20000, B: 15000, C: 10000, D: 5000, E: 0 };

// Colours assigned to each Livello for the toggle UI badges.
const LIVELLO_HUE = {
  A: '#e07b54',
  B: '#c45c3a',
  C: '#a33f22',
  D: '#7d2510',
  E: '#560f04',
};

const INITIAL_VIEW_STATE = {
  longitude: 9.12,
  // Offset north of the feature centroid (31.6566) so that with pitch 65°
  // the mid-point of the Z stack (Z≈10 km) appears at screen centre rather
  // than the top layers projecting above the viewport.
  latitude: 31.885,
  zoom: 10.2,
  pitch: 65,
  bearing: -20,
  minPitch: 0,
  maxPitch: 85,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Maps a Thickness value (0–25) to an RGBA colour array.
 * Thickness 0 → pale, transparent amber-red
 * Thickness 25 → deep, opaque crimson
 */
function thicknessToColor(thickness) {
  const t = Math.min(Math.max(thickness / 25, 0), 1);
  const r = Math.round(255 - t * 75);  // 255 → 180
  const g = Math.round(160 - t * 160); // 160 → 0
  const b = 0;
  const a = Math.round(55 + t * 195);  // 55 → 250
  return [r, g, b, a];
}

/**
 * Transforms a MultiPolygon feature by appending a Z coordinate (in metres)
 * to every position, placing each Livello at a distinct elevation.
 */
function elevateFeature(feature) {
  const z = LIVELLO_Z[feature.properties.Livello] ?? 0;
  const transformed = feature.geometry.coordinates.map(polygon =>
    polygon.map(ring =>
      ring.map(([lng, lat]) => [lng, lat, z])
    )
  );
  return {
    ...feature,
    geometry: { ...feature.geometry, coordinates: transformed },
  };
}

// Pre-process once: split features by Livello and add Z coordinates.
const featuresByLivello = LIVELLI.reduce((acc, lv) => {
  acc[lv] = issopayData.features
    .filter(f => f.properties.Livello === lv)
    .map(elevateFeature);
  return acc;
}, {});

// ─── Tooltip ─────────────────────────────────────────────────────────────────

function getTooltip({ object }) {
  if (!object) return null;
  const { Livello, Thickness } = object.properties;
  return {
    html: `
      <div style="font-family:monospace;font-size:13px;line-height:1.6">
        <span style="opacity:.6;text-transform:uppercase;letter-spacing:.08em;font-size:11px">Geological layer</span><br/>
        <strong style="font-size:15px">Livello ${Livello}</strong><br/>
        <span style="opacity:.6;font-size:11px">Net pay</span><br/>
        <strong>${Thickness} m</strong>
      </div>
    `,
    style: {
      background: 'rgba(10,10,10,0.92)',
      color: '#f0ece6',
      borderRadius: '6px',
      padding: '10px 14px',
      border: '1px solid rgba(255,255,255,0.08)',
      maxWidth: '180px',
      backdropFilter: 'blur(8px)',
      pointerEvents: 'none',
    },
  };
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function IssopayMap() {
  const [visible, setVisible] = useState(
    LIVELLI.reduce((acc, lv) => ({ ...acc, [lv]: true }), {})
  );
  const [panelOpen, setPanelOpen] = useState(false);
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const [focusedLayer, setFocusedLayer] = useState(null);

  function flyTo(target) {
    setViewState({
      ...target,
      transitionDuration: 1100,
      transitionInterpolator: new FlyToInterpolator({ speed: 1.4 }),
    });
  }

  function focusLayer(lv) {
    const isAlreadyFocused = focusedLayer === lv;
    setFocusedLayer(isAlreadyFocused ? null : lv);
    flyTo(isAlreadyFocused ? INITIAL_VIEW_STATE : { ...INITIAL_VIEW_STATE, ...LAYER_FOCUS[lv] });
  }

  function resetView() {
    setFocusedLayer(null);
    flyTo(INITIAL_VIEW_STATE);
  }

  const layers = useMemo(() =>
    LIVELLI.map(lv =>
      new GeoJsonLayer({
        id: `livello-${lv}`,
        data: featuresByLivello[lv],
        pickable: true,
        stroked: true,
        filled: true,
        extruded: true,
        wireframe: false,
        getElevation: 1500,
        getFillColor: f => {
          const [r, g, b, a] = thicknessToColor(f.properties.Thickness);
          // Dim layers that are not in focus
          const dimmed = focusedLayer !== null && focusedLayer !== lv;
          return [r, g, b, dimmed ? Math.round(a * 0.2) : a];
        },
        getLineColor: [255, 255, 255, 30],
        lineWidthMinPixels: 1,
        // Hide layers with higher Z than the focused one so they don't
        // block the top-down view of the selected layer.
        visible: visible[lv] && !(focusedLayer !== null && LIVELLO_Z[lv] > LIVELLO_Z[focusedLayer]),
        updateTriggers: { visible: visible[lv], focusedLayer },
      })
    ),
    [visible, focusedLayer]
  );

  function toggleLayer(lv) {
    setVisible(prev => ({ ...prev, [lv]: !prev[lv] }));
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* ── Map canvas ─────────────────────────────────────────────────────── */}
      <DeckGL
        viewState={viewState}
        onViewStateChange={({ viewState: vs }) => setViewState(vs)}
        controller={true}
        views={new MapView({ repeat: true })}
        layers={layers}
        getTooltip={getTooltip}
        style={{ background: '#0a0a0a' }}
      />

      {/* ── Layer toggles ──────────────────────────────────────────────────── */}
      <div style={{
        position: 'absolute',
        top: '20px',
        left: '20px',
        background: 'rgba(10,10,10,0.85)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '8px',
        padding: '14px 16px',
        color: '#f0ece6',
        fontFamily: 'monospace',
        fontSize: '12px',
        backdropFilter: 'blur(12px)',
        userSelect: 'none',
        minWidth: '140px',
        zIndex: 1,
      }}>
        <div style={{
          opacity: 0.5,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          fontSize: '10px',
          marginBottom: '10px',
        }}>
          Geological Layers
        </div>

        {LIVELLI.map(lv => (
          <label
            key={lv}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '9px',
              marginBottom: '8px',
              cursor: 'pointer',
              opacity: visible[lv] ? 1 : 0.35,
              transition: 'opacity 0.2s',
            }}
          >
            {/* Custom checkbox */}
            <span
              onClick={() => toggleLayer(lv)}
              style={{
                width: '14px',
                height: '14px',
                borderRadius: '3px',
                border: `2px solid ${LIVELLO_HUE[lv]}`,
                background: visible[lv] ? LIVELLO_HUE[lv] : 'transparent',
                display: 'inline-block',
                flexShrink: 0,
                transition: 'background 0.15s',
              }}
            />
            <span onClick={() => toggleLayer(lv)} style={{ lineHeight: 1 }}>
              Livello {lv}
            </span>
          </label>
        ))}

        <div style={{
          marginTop: '12px',
          paddingTop: '10px',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          opacity: 0.4,
          fontSize: '10px',
          lineHeight: 1.5,
        }}>
          Drag to rotate<br />Scroll to zoom
        </div>
      </div>

      {/* ── Source maps toggle button ──────────────────────────────────────── */}
      <button
        onClick={() => setPanelOpen(p => !p)}
        style={{
          position: 'absolute',
          top: '20px',
          right: panelOpen ? '360px' : '20px',
          transition: 'right 0.3s ease',
          background: panelOpen ? 'rgba(224,123,84,0.15)' : 'rgba(10,10,10,0.85)',
          border: `1px solid ${panelOpen ? 'rgba(224,123,84,0.5)' : 'rgba(255,255,255,0.12)'}`,
          borderRadius: '8px',
          padding: '8px 14px',
          color: '#f0ece6',
          fontFamily: 'monospace',
          fontSize: '11px',
          letterSpacing: '0.06em',
          cursor: 'pointer',
          backdropFilter: 'blur(12px)',
          zIndex: 3,
          display: 'flex',
          alignItems: 'center',
          gap: '7px',
          whiteSpace: 'nowrap',
        }}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
          <rect x="1" y="1" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
          <line x1="4" y1="14" x2="12" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          <line x1="8" y1="11" x2="8" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
        {panelOpen ? 'Hide sources' : 'Source maps'}
      </button>

      {/* ── Source maps panel ─────────────────────────────────────────────── */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: '340px',
          background: 'rgba(8,8,8,0.96)',
          borderLeft: '1px solid rgba(255,255,255,0.08)',
          transform: panelOpen ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.3s ease',
          overflowY: 'auto',
          zIndex: 2,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Panel header */}
        <div style={{
          padding: '18px 20px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          position: 'sticky',
          top: 0,
          background: 'rgba(8,8,8,0.98)',
          zIndex: 1,
        }}>
          <div style={{ fontSize: '10px', letterSpacing: '0.12em', textTransform: 'uppercase', opacity: 0.4, marginBottom: '3px', fontFamily: 'monospace', color: '#f0ece6' }}>
            Archival sources
          </div>
          <div style={{ fontSize: '13px', fontFamily: 'monospace', color: '#f0ece6', opacity: 0.85 }}>
            Original geological maps
          </div>
        </div>

        {/* One card per Livello */}
        <div style={{ padding: '16px 20px 24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {LIVELLI.map(lv => (
            <div
              key={lv}
              style={{
                opacity: visible[lv] ? 1 : 0.25,
                transition: 'opacity 0.25s',
              }}
            >
              {/* Card label */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginBottom: '8px',
              }}>
                <span style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '2px',
                  background: LIVELLO_HUE[lv],
                  flexShrink: 0,
                  display: 'inline-block',
                }} />
                <span style={{
                  fontFamily: 'monospace',
                  fontSize: '11px',
                  color: '#f0ece6',
                  letterSpacing: '0.06em',
                }}>
                  Livello {lv}
                </span>
                {!visible[lv] && (
                  <span style={{ fontFamily: 'monospace', fontSize: '10px', opacity: 0.4, color: '#f0ece6', marginLeft: 'auto' }}>
                    hidden
                  </span>
                )}
              </div>

              {/* Source image — click to fly the camera to this layer */}
              <div style={{ position: 'relative' }}>
                <img
                  src={`/sources/Isopay_livello${lv}.png`}
                  alt={`Original geological map – Livello ${lv}`}
                  loading="lazy"
                  onClick={() => focusLayer(lv)}
                  style={{
                    width: '100%',
                    display: 'block',
                    borderRadius: '5px',
                    border: focusedLayer === lv
                      ? `2px solid ${LIVELLO_HUE[lv]}`
                      : '1px solid rgba(255,255,255,0.07)',
                    cursor: 'pointer',
                    transition: 'border 0.2s, box-shadow 0.2s',
                    boxShadow: focusedLayer === lv
                      ? `0 0 12px ${LIVELLO_HUE[lv]}55`
                      : 'none',
                  }}
                />
                {/* Focus hint overlay */}
                <div style={{
                  position: 'absolute',
                  bottom: '7px',
                  right: '7px',
                  background: focusedLayer === lv ? LIVELLO_HUE[lv] : 'rgba(10,10,10,0.75)',
                  color: '#f0ece6',
                  fontFamily: 'monospace',
                  fontSize: '9px',
                  letterSpacing: '0.06em',
                  padding: '3px 7px',
                  borderRadius: '3px',
                  pointerEvents: 'none',
                  transition: 'background 0.2s',
                }}>
                  {focusedLayer === lv ? '↩ reset' : '↗ focus'}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Thickness legend ───────────────────────────────────────────────── */}
      <div style={{
        position: 'absolute',
        bottom: '28px',
        left: '20px',
        background: 'rgba(10,10,10,0.85)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '8px',
        padding: '12px 16px',
        color: '#f0ece6',
        fontFamily: 'monospace',
        fontSize: '11px',
        backdropFilter: 'blur(12px)',
        zIndex: 1,
      }}>
        <div style={{
          opacity: 0.5,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          fontSize: '10px',
          marginBottom: '8px',
        }}>
          Net Pay (m)
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ opacity: 0.5 }}>0</span>
          {/* Gradient bar */}
          <div style={{
            width: '100px',
            height: '10px',
            borderRadius: '3px',
            background: 'linear-gradient(to right, rgba(255,160,0,0.22), rgba(180,0,0,0.98))',
          }} />
          <span>25</span>
        </div>
      </div>

      {/* ── Reset / overview button ─────────────────────────────────────────── */}
      <button
        onClick={resetView}
        title="Return to full stack overview"
        style={{
          position: 'absolute',
          bottom: '28px',
          right: '20px',
          background: 'rgba(10,10,10,0.85)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '8px',
          padding: '8px 14px',
          color: '#f0ece6',
          fontFamily: 'monospace',
          fontSize: '11px',
          letterSpacing: '0.06em',
          cursor: 'pointer',
          backdropFilter: 'blur(12px)',
          zIndex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          <path d="M13.5 2.5v3h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Overview
      </button>
    </div>
  );
}

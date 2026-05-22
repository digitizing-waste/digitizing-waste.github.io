import { useState, useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer } from '@deck.gl/layers';
import { MapView } from '@deck.gl/core';
import issopayData from '../data/geojson/Issopay.geojson';

// ─── Constants ───────────────────────────────────────────────────────────────

const LIVELLI = ['A', 'B', 'C', 'D', 'E'];

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
        getFillColor: f => thicknessToColor(f.properties.Thickness),
        getLineColor: [255, 255, 255, 30],
        lineWidthMinPixels: 1,
        visible: visible[lv],
        updateTriggers: { visible: visible[lv] },
      })
    ),
    [visible]
  );

  function toggleLayer(lv) {
    setVisible(prev => ({ ...prev, [lv]: !prev[lv] }));
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* ── Map canvas ─────────────────────────────────────────────────────── */}
      <DeckGL
        initialViewState={INITIAL_VIEW_STATE}
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
    </div>
  );
}

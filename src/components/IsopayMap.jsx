import { useState, useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer, ColumnLayer, BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { MapView, FlyToInterpolator, LinearInterpolator } from '@deck.gl/core';
import issopayData from '../data/geojson/Isopay.geojson';
import pozziData from '../data/geojson/pozzi.geojson';

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

// "true" geological depths
const TRUE_DEPTHS = { A: -2340, B: -2370, C: -2390, D: -2410, E: -2430 };

// ── Visual depth mapping ─────────────────────────────────────────────────────
// The real A→E separation is only ~90 m, which is invisible at map scale.
// We linearly map the true proportions onto a larger visual range so the
// layer cake is clearly distinguishable without distorting inter-layer ratios.
//
// IMPORTANT: deck.gl’s MapView is built for above-surface Z coordinates;
// negative Z causes frustum-culling and clipping bugs at certain camera angles.
// We therefore use POSITIVE Z (higher = shallower stratum), with the satellite
// basemap placed at SLAB_TOP (= VISUAL_DEPTH_A + slab thickness) as the
// “surface lid” on top of the stack. TRUE_DEPTHS are preserved for display.
//
//   VISUAL_DEPTH_A  visual Z (m) for the shallowest stratum (Livello A)
//   VISUAL_SPREAD   total visual extent from A down to E
//
//   LIVELLO_Z[lv] = VISUAL_DEPTH_A
//                 − ( (TRUE[lv]−TRUE[A]) / (TRUE[E]−TRUE[A]) ) × VISUAL_SPREAD
//
// Resulting Z values (m, positive = higher in 3D scene = shallower in reality):
//   A: 20 000   B: 13 333   C:  8 889   D:  4 444   E:  0
const VISUAL_DEPTH_A = 20000;
const VISUAL_SPREAD  = 20000;

const _DEPTH_RANGE = TRUE_DEPTHS.E - TRUE_DEPTHS.A; // = −90
const LIVELLO_Z = Object.fromEntries(
  Object.entries(TRUE_DEPTHS).map(([lv, d]) => [
    lv,
    VISUAL_DEPTH_A - ((d - TRUE_DEPTHS.A) / _DEPTH_RANGE) * VISUAL_SPREAD,
  ])
);

// True-depth variant: physically correct negative Z values.
// WARNING: deck.gl MapView may cull or clip at high zoom / certain pitches.
//   A: −20 000   B: −26 667   C: −31 111   D: −35 556   E: −40 000
const LIVELLO_Z_TRUE = Object.fromEntries(
  Object.entries(TRUE_DEPTHS).map(([lv, d]) => [
    lv,
    -20000 - ((d - TRUE_DEPTHS.A) / _DEPTH_RANGE) * 20000,
  ])
);

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
  // the mid-point of the Z stack appears near screen centre.
  latitude: 31.885,
  zoom: 10.2,
  pitch: 65,
  bearing: -20,
  minPitch: 0,
  maxPitch: 85,
};

// Camera position suited to the true-depth (negative-Z) viewing geometry.
const TRUE_DEPTH_VIEW_STATE = {
  longitude: 9.12,
  latitude: 31.4,
  zoom: 10.0,
  pitch: 65,
  bearing: -1,
  minPitch: 0,
  maxPitch: 85,
};

// ─── Well constants ─────────────────────────────────────────────────────────

// Which geological layer each well penetrates down to (keyed by feature id).
// Deeper = smaller LIVELLO_Z value (E=0 is deepest, A=20000 is shallowest).
const WELL_DEPTH = {
  9:  'E',
  5:  'D', 1:  'D', 14: 'D', 4:  'D', 6:  'D',  // id 6 = label "6bis"
  8:  'C', 7:  'C',
  13: 'B',
  12: 'A', 10: 'A',
};
const WELL_DEPTH_DEFAULT = 'A'; // fallback for unassigned wells

// Fill colour by operational status
const WELL_STATUS_COLOR = {
  'produttivo':      [255, 200, 75],
  'sterile':         [130, 130, 130],
  'in perforazione': [80,  185, 255],
  'in programma':    [145, 205, 145],
  'incidentato':     [255,  80,  80],
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
function elevateFeature(feature, livelloZ) {
  const z = livelloZ[feature.properties.Livello] ?? 0;
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

// ─── Tooltip ─────────────────────────────────────────────────────────────────

const TOOLTIP_STYLE = {
  background: 'rgba(10,10,10,0.92)',
  color: '#f0ece6',
  borderRadius: '6px',
  padding: '10px 14px',
  border: '1px solid rgba(255,255,255,0.08)',
  maxWidth: '200px',
  backdropFilter: 'blur(8px)',
  pointerEvents: 'none',
};

// Shared style for nav-control buttons
const NAV_BTN = {
  background: 'transparent',
  border: 'none',
  color: '#f0ece6',
  fontFamily: 'monospace',
  fontSize: '13px',
  lineHeight: 1,
  padding: '8px 10px',
  cursor: 'pointer',
  opacity: 0.7,
};

function getTooltip({ object }) {
  if (!object) return null;
  const p = object.properties;

  // Geological layer feature
  if (p.Livello !== undefined) {
    return {
      html: `
        <div style="font-family:monospace;font-size:13px;line-height:1.6">
          <span style="opacity:.6;text-transform:uppercase;letter-spacing:.08em;font-size:11px">Geological layer</span><br/>
          <strong style="font-size:15px">Livello ${p.Livello}</strong><br/>
          <span style="opacity:.6;font-size:11px">Net pay</span><br/>
          <strong>${p.Thickness} m</strong>
        </div>`,
      style: TOOLTIP_STYLE,
    };
  }

  // Well feature
  const depth = WELL_DEPTH[p.id];
  const statusLabel = p.status.charAt(0).toUpperCase() + p.status.slice(1);
  return {
    html: `
      <div style="font-family:monospace;font-size:13px;line-height:1.6">
        <span style="opacity:.6;text-transform:uppercase;letter-spacing:.08em;font-size:11px">Oil well</span><br/>
        <strong style="font-size:15px">Well ${p.label}</strong><br/>
        <span style="opacity:.6;font-size:11px">Status</span><br/>
        <strong>${statusLabel}</strong>
        ${p.Spessore_m != null
          ? `<br/><span style="opacity:.6;font-size:11px">Net pay</span><br/><strong>${p.Spessore_m} m</strong>`
          : ''}
        ${depth
          ? `<br/><span style="opacity:.6;font-size:11px">Penetrates to</span><br/><strong>Livello ${depth}</strong>`
          : ''}
      </div>`,
    style: TOOLTIP_STYLE,
  };
}

// ─── Info modal section helper ───────────────────────────────────────────────

function Section({ label, children, last }) {
  return (
    <div style={{ marginBottom: last ? 0 : '18px' }}>
      <div style={{
        fontSize: '10px',
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        opacity: 0.35,
        marginBottom: '8px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        paddingBottom: '5px',
      }}>
        {label}
      </div>
      <div style={{ opacity: 0.8 }}>{children}</div>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function IsopayMap() {
  const [visible, setVisible] = useState({
    ...LIVELLI.reduce((acc, lv) => ({ ...acc, [lv]: true }), {}),
    wells: true,
    basemap: false,
  });
  const [panelOpen, setPanelOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const [focusedLayer, setFocusedLayer] = useState(null);
  const [trueDepth, setTrueDepth] = useState(false);

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

  function adjustView(delta) {
    setViewState(prev => ({
      ...prev,
      zoom:    delta.zoom    !== undefined ? Math.min(20, Math.max(1,  prev.zoom  + delta.zoom))  : prev.zoom,
      pitch:   delta.pitch   !== undefined ? Math.min(85, Math.max(0,  prev.pitch + delta.pitch)) : prev.pitch,
      bearing: delta.bearing !== undefined ? prev.bearing + delta.bearing                         : prev.bearing,
      transitionDuration: 200,
      transitionInterpolator: new LinearInterpolator(),
    }));
  }

  function resetNorth() {
    setViewState(prev => ({
      ...prev,
      bearing: 0,
      transitionDuration: 400,
      transitionInterpolator: new LinearInterpolator(),
    }));
  }

  function handleToggleTrueDepth() {
    const next = !trueDepth;
    setTrueDepth(next);
    setFocusedLayer(null);
    flyTo(next ? TRUE_DEPTH_VIEW_STATE : INITIAL_VIEW_STATE);
  }

  const layers = useMemo(() => {
    // Switch between the display-optimised (positive Z) and physically-correct
    // (negative Z) coordinate systems depending on the trueDepth toggle.
    const lz       = trueDepth ? LIVELLO_Z_TRUE : LIVELLO_Z;
    const SLAB_TOP = trueDepth ? 0 : lz['A'] + 1500;

    // Re-elevate features with the active Z values.
    const featuresByLivello = LIVELLI.reduce((acc, lv) => {
      acc[lv] = issopayData.features
        .filter(f => f.properties.Livello === lv)
        .map(f => elevateFeature(f, lz));
      return acc;
    }, {});

    const MAX_SPESSORE = 55; // cap for radius scaling

    const basemapLayer = new TileLayer({
      id: 'basemap',
      // ESRI World Imagery — free satellite tiles, no API key required
      data: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      minZoom: 0,
      maxZoom: 19,
      tileSize: 256,
      visible: visible.basemap,
      renderSubLayers: props => {
        const { bbox: { west, south, east, north } } = props.tile;
        const z = SLAB_TOP; // visual surface lid, above the shallowest geological slab
        return new BitmapLayer(props, {
          data: null,
          image: props.data,
          // Four corners with Z = Livello A elevation so the surface sits
          // flush on top of the shallowest geological stratum.
          bounds: [
            [west,  south, z],
            [east,  south, z],
            [east,  north, z],
            [west,  north, z],
          ],
          opacity: 0.75,
        });
      },
    });

    const geoLayers = LIVELLI.map(lv =>
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
        visible: visible[lv] && !(focusedLayer !== null && lz[lv] > lz[focusedLayer]),
        updateTriggers: { visible: visible[lv], focusedLayer, trueDepth },
      })
    );

    const wellLayer = new ColumnLayer({
      id: 'wells',
      data: pozziData.features,
      visible: visible.wells,
      diskResolution: 32,
      radius: 100, // metres; ColumnLayer has no per-instance getRadius
      // Cylinder base sits at the bottom of the target Livello; it extrudes
      // upward to the top of Livello A — punching through the whole stack.
      getPosition: d => {
        const depth = lz[WELL_DEPTH[d.properties.id] ?? WELL_DEPTH_DEFAULT];
        return [d.geometry.coordinates[0], d.geometry.coordinates[1], depth];
      },
      getElevation: d => {
        const depth = lz[WELL_DEPTH[d.properties.id] ?? WELL_DEPTH_DEFAULT];
        return SLAB_TOP - depth;
      },
      // Spessore_m encodes into alpha: higher net pay → more opaque cylinder.
      getFillColor: d => {
        const base = WELL_STATUS_COLOR[d.properties.status] ?? [150, 150, 150];
        const wellDepthZ = lz[WELL_DEPTH[d.properties.id] ?? WELL_DEPTH_DEFAULT];
        // Dim wells that don’t reach the currently-focused layer
        const dimmed = focusedLayer !== null && wellDepthZ > lz[focusedLayer];
        const s = d.properties.Spessore_m;
        // productive wells: alpha scales 140–255 with net pay; others fixed at 180
        const alpha = dimmed ? 40 : (s != null ? Math.round(140 + (Math.min(s, 55) / 55) * 115) : 180);
        return [...base, alpha];
      },
      getLineColor: [255, 255, 255, 50],
      stroked: true,
      lineWidthUnits: 'pixels',
      lineWidthMinPixels: 1,
      pickable: true,
      updateTriggers: {
        getPosition:  trueDepth,
        getElevation: trueDepth,
        getFillColor: [focusedLayer, trueDepth],
        visible:      visible.wells,
      },
    });

    return [basemapLayer, ...geoLayers, wellLayer];
  }, [visible, focusedLayer, trueDepth]);

  function toggleLayer(lv) {
    setVisible(prev => ({ ...prev, [lv]: !prev[lv] }));
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* ── Map canvas ─────────────────────────────────────────────────────── */}
      <DeckGL
        viewState={viewState}
        onViewStateChange={({ viewState: vs }) => setViewState(vs)}
        controller={{ dragMode: 'rotate' }}
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

        {/* ── Wells toggle ──────────────────────────────────────────────── */}
        <div style={{
          marginTop: '10px',
          paddingTop: '10px',
          borderTop: '1px solid rgba(255,255,255,0.08)',
        }}>
          <div style={{
            opacity: 0.5,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            fontSize: '10px',
            marginBottom: '8px',
          }}>Wells</div>
          <label style={{
            display: 'flex',
            alignItems: 'center',
            gap: '9px',
            cursor: 'pointer',
            opacity: visible.wells ? 1 : 0.35,
            transition: 'opacity 0.2s',
          }}>
            <span
              onClick={() => toggleLayer('wells')}
              style={{
                width: '14px',
                height: '14px',
                borderRadius: '3px',
                border: '2px solid #ffc84b',
                background: visible.wells ? '#ffc84b' : 'transparent',
                display: 'inline-block',
                flexShrink: 0,
                transition: 'background 0.15s',
              }}
            />
            <span onClick={() => toggleLayer('wells')} style={{ lineHeight: 1 }}>
              Oil wells
            </span>
          </label>
        </div>

        {/* ── Surface map (basemap) toggle ─────────────────────────── */}
        <div style={{
          marginTop: '10px',
          paddingTop: '10px',
          borderTop: '1px solid rgba(255,255,255,0.08)',
        }}>
          <div style={{
            opacity: 0.5,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            fontSize: '10px',
            marginBottom: '8px',
          }}>Surface</div>
          <label style={{
            display: 'flex',
            alignItems: 'center',
            gap: '9px',
            cursor: 'pointer',
            opacity: visible.basemap ? 1 : 0.35,
            transition: 'opacity 0.2s',
          }}>
            <span
              onClick={() => toggleLayer('basemap')}
              style={{
                width: '14px',
                height: '14px',
                borderRadius: '3px',
                border: '2px solid #6baed6',
                background: visible.basemap ? '#6baed6' : 'transparent',
                display: 'inline-block',
                flexShrink: 0,
                transition: 'background 0.15s',
              }}
            />
            <span onClick={() => toggleLayer('basemap')} style={{ lineHeight: 1 }}>
              Satellite
            </span>
          </label>
        </div>

        <div style={{
          marginTop: '12px',
          paddingTop: '10px',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          opacity: 0.4,
          fontSize: '10px',
          lineHeight: 1.5,
        }}>
          Drag to rotate<br />Right-drag to pan<br />Scroll to zoom
        </div>

        {/* ── True depth mode toggle ──────────────────────────────────── */}
        <div style={{
          marginTop: '10px',
          paddingTop: '10px',
          borderTop: `1px solid ${trueDepth ? 'rgba(255,200,75,0.35)' : 'rgba(255,255,255,0.08)'}`,
        }}>
          <div style={{
            opacity: 0.5,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            fontSize: '10px',
            marginBottom: '8px',
            color: trueDepth ? '#ffc84b' : 'inherit',
          }}>Experimental</div>
          <label style={{
            display: 'flex',
            alignItems: 'center',
            gap: '9px',
            cursor: 'pointer',
            opacity: 1,
            transition: 'opacity 0.2s',
          }}>
            <span
              onClick={handleToggleTrueDepth}
              style={{
                width: '14px',
                height: '14px',
                borderRadius: '3px',
                border: '2px solid #ffc84b',
                background: trueDepth ? '#ffc84b' : 'transparent',
                display: 'inline-block',
                flexShrink: 0,
                transition: 'background 0.15s',
              }}
            />
            <span onClick={handleToggleTrueDepth} style={{ lineHeight: 1 }}>
              True depth
            </span>
          </label>
          {trueDepth && (
            <div style={{
              marginTop: '8px',
              padding: '7px 8px',
              background: 'rgba(255,200,75,0.07)',
              border: '1px solid rgba(255,200,75,0.2)',
              borderRadius: '4px',
              fontSize: '9px',
              lineHeight: 1.55,
              color: '#ffc84b',
              opacity: 0.85,
            }}>
              ⚠ A: {TRUE_DEPTHS.A} m<br />
              ⚠ E: {TRUE_DEPTHS.E} m<br />
              Rendering may degrade<br />at high zoom or low pitch.
            </div>
          )}
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

      {/* ── Info button ──────────────────────────────────────────────────── */}
      <button
        onClick={() => setInfoOpen(p => !p)}
        style={{
          position: 'absolute',
          top: '64px',
          right: panelOpen ? '360px' : '20px',
          transition: 'right 0.3s ease',
          background: infoOpen ? 'rgba(100,160,220,0.12)' : 'rgba(10,10,10,0.85)',
          border: `1px solid ${infoOpen ? 'rgba(100,160,220,0.45)' : 'rgba(255,255,255,0.12)'}`,
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
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5"/>
          <line x1="8" y1="7" x2="8" y2="11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          <circle cx="8" cy="4.5" r="0.8" fill="currentColor"/>
        </svg>
        {infoOpen ? 'Close' : 'How to use'}
      </button>

      {/* ── Info modal overlay ───────────────────────────────────────────── */}
      {infoOpen && (
        <div
          onClick={() => setInfoOpen(false)}
          style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.55)',
            backdropFilter: 'blur(5px)',
            zIndex: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'rgba(10,10,12,0.97)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '12px',
              padding: '28px 32px',
              maxWidth: '520px',
              width: '90%',
              maxHeight: '80vh',
              overflowY: 'auto',
              color: '#f0ece6',
              fontFamily: 'monospace',
              fontSize: '12px',
              lineHeight: 1.7,
              position: 'relative',
            }}
          >
            {/* Close */}
            <button
              onClick={() => setInfoOpen(false)}
              style={{ position: 'absolute', top: '16px', right: '16px', background: 'transparent', border: 'none', color: '#f0ece6', cursor: 'pointer', opacity: 0.45, fontSize: '20px', lineHeight: 1, padding: '2px 6px' }}
            >×</button>

            {/* Title */}
            <div style={{ marginBottom: '22px' }}>
              <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.12em', opacity: 0.35, marginBottom: '4px' }}>Digitizing Waste</div>
              <div style={{ fontSize: '15px', fontWeight: 'bold', letterSpacing: '0.02em', marginBottom: '5px' }}>El Burma — Net Pay Stratigraphy</div>
              <div style={{ opacity: 0.5, fontSize: '11px' }}>Interactive 3D stratigraphic model · Ghadames Basin, Tunisia</div>
            </div>

            {/* About */}
            <Section label="About">
              This visualization maps the net pay of the El Burma oil camp, a petroleum concession in the Ghadames Basin of southwest Tunisia operated under Tunisian-Italian license agreements during the 1960s–70s. The source data are <em>isopay maps</em> — a type of isopach map that records only the thickness of reservoir rock that is porous, permeable, and contains extractable hydrocarbons. Five stratigraphic layers (Livelli A–E) in the Ordovician reservoir are modelled, each representing a distinct net pay zone.
              <br /><br />
              <strong style={{ color: '#ffc84b', opacity: 0.9 }}>⚠ Vertical exaggeration</strong>
              <br />
              The five layers sit between <strong>−2,340 m and −2,430 m</strong> below the surface — a real vertical span of only <strong>90 m</strong>. The field is roughly 20–30 km wide, so at true scale all five layers would collapse into a sheet thinner than a pixel on screen. To make the stratigraphy legible, the vertical axis is exaggerated <strong>~222×</strong>: each visual "slab" is rendered 1,500 m thick and the A→E stack spans 20,000 m. This is standard practice in subsurface geology — seismic sections and reservoir models routinely apply 10×–1,000× vertical exaggeration for the same reason.
            </Section>

            {/* Geological Layers */}
            <Section label="Geological layers">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', marginBottom: '9px' }}>
                {[['A', '−2,340 m', 'shallowest'], ['B', '−2,370 m', ''], ['C', '−2,390 m', ''], ['D', '−2,410 m', ''], ['E', '−2,430 m', 'deepest']].map(([lv, depth, note]) => (
                  <div key={lv} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ width: '9px', height: '9px', borderRadius: '2px', background: LIVELLO_HUE[lv], display: 'inline-block', flexShrink: 0 }} />
                    <span style={{ opacity: 0.85 }}>Livello {lv}</span>
                    <span style={{ opacity: 0.4, fontSize: '11px' }}>{depth}</span>
                    {note && <span style={{ opacity: 0.3, fontSize: '10px' }}>({note})</span>}
                  </div>
                ))}
              </div>
              <div style={{ opacity: 0.5, fontSize: '11px' }}>
                Color intensity encodes <strong style={{ opacity: 0.9 }}>net pay thickness</strong>: pale amber = thin (0 m), deep crimson = thick (25 m). Toggle individual layers using the panel on the left.
              </div>
            </Section>

            {/* Wells */}
            <Section label="Oil wells (19 boreholes)">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', marginBottom: '9px' }}>
                {[
                  { rgb: [255,200,75],  label: 'Productive' },
                  { rgb: [80,185,255],  label: 'In drilling' },
                  { rgb: [145,205,145], label: 'Planned' },
                  { rgb: [255,80,80],   label: 'Damaged / accidental' },
                  { rgb: [130,130,130], label: 'Sterile (dry)' },
                ].map(({ rgb, label }) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: `rgb(${rgb.join(',')})`, display: 'inline-block', flexShrink: 0 }} />
                    <span style={{ opacity: 0.8 }}>{label}</span>
                  </div>
                ))}
              </div>
              <div style={{ opacity: 0.5, fontSize: '11px' }}>
                Each cylinder extends from the deepest penetrated layer to the surface. Cylinder opacity scales with net pay thickness. Hover for details.
              </div>
            </Section>

            {/* Source maps */}
            <Section label="Archival source maps">
              <div style={{ opacity: 0.8 }}>Five original geological maps — one per layer — digitized from AGIP survey documents. Open the <strong style={{ opacity: 0.95 }}>Source maps →</strong> panel (top-right) to compare the 3D model with the archival cartography. Click any map image to fly the camera to that stratum.
              </div>
            </Section>

            {/* Navigation */}
            <Section label="Navigation" last>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                {[
                  ['Left-drag',              'Rotate the 3D view'],
                  ['Right-drag / two-finger','Pan the map'],
                  ['Scroll / pinch',         'Zoom in and out'],
                  ['Click layer label',      'Show or hide that stratum'],
                  ['Click source map image', 'Focus camera on that layer'],
                  ['Click compass',          'Reset bearing to north'],
                  ['OVERVIEW button',        'Return to initial view'],
                ].map(([key, val]) => (
                  <div key={key} style={{ display: 'flex', gap: '10px' }}>
                    <span style={{ opacity: 0.4, minWidth: '165px', fontSize: '11px', flexShrink: 0 }}>{key}</span>
                    <span style={{ opacity: 0.8 }}>{val}</span>
                  </div>
                ))}
              </div>
            </Section>

            {/* Footer */}
            <div style={{ marginTop: '18px', paddingTop: '12px', borderTop: '1px solid rgba(255,255,255,0.06)', opacity: 0.3, fontSize: '10px' }}>
              Source data: AGIP geological surveys, 1960s–70s · Ghadames Basin concession records
            </div>
          </div>
        </div>
      )}

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
        bottom: '34px',
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

      {/* ── Navigation control ───────────────────────────────────────────── */}
      <div style={{
        position: 'absolute',
        bottom: '34px',
        right: panelOpen ? '360px' : '20px',
        transition: 'right 0.3s ease',
        background: 'rgba(10,10,10,0.85)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '8px',
        backdropFilter: 'blur(12px)',
        zIndex: 1,
        color: '#f0ece6',
        fontFamily: 'monospace',
        overflow: 'hidden',
        userSelect: 'none',
        minWidth: '114px',
      }}>
        {/* Bearing row: left arrow ─ compass ─ right arrow */}
        <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <button onClick={() => adjustView({ bearing: -15 })} title="Rotate left" style={NAV_BTN}>◄</button>
          {/* Compass: rotating needle shows where north is; click to face north */}
          <div onClick={resetNorth} title="Click to face north"
            style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '5px 0', cursor: 'pointer' }}>
            <svg width="38" height="38" viewBox="0 0 38 38">
              <circle cx="19" cy="19" r="16" stroke="rgba(255,255,255,0.12)" strokeWidth="1" fill="rgba(255,255,255,0.02)"/>
              <line x1="19" y1="3" x2="19" y2="8" stroke="rgba(255,255,255,0.22)" strokeWidth="1"/>
              <line x1="19" y1="30" x2="19" y2="35" stroke="rgba(255,255,255,0.22)" strokeWidth="1"/>
              <line x1="3" y1="19" x2="8" y2="19" stroke="rgba(255,255,255,0.22)" strokeWidth="1"/>
              <line x1="30" y1="19" x2="35" y2="19" stroke="rgba(255,255,255,0.22)" strokeWidth="1"/>
              {/* Needle group rotates so amber tip always points toward north */}
              <g transform={`rotate(${-viewState.bearing}, 19, 19)`}>
                <polygon points="19,5 21.5,19 16.5,19" fill="#ffc84b" opacity="0.95"/>
                <polygon points="19,33 21.5,19 16.5,19" fill="rgba(255,255,255,0.18)"/>
                <circle cx="19" cy="19" r="2.5" fill="rgba(8,8,8,0.9)" stroke="rgba(255,255,255,0.2)" strokeWidth="0.8"/>
                <text x="19" y="4" textAnchor="middle" dominantBaseline="middle" fill="#ffc84b" fontSize="5.5" fontFamily="monospace" fontWeight="bold">N</text>
              </g>
            </svg>
          </div>
          <button onClick={() => adjustView({ bearing: 15 })} title="Rotate right" style={NAV_BTN}>►</button>
        </div>

        {/* Pitch row */}
        <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <button onClick={() => adjustView({ pitch: 5 })}  title="Tilt up"   style={{ ...NAV_BTN, flex: 1 }}>▲</button>
          <div style={{ width: '1px', background: 'rgba(255,255,255,0.07)' }}/>
          <button onClick={() => adjustView({ pitch: -5 })} title="Tilt down" style={{ ...NAV_BTN, flex: 1 }}>▼</button>
        </div>

        {/* Zoom row */}
        <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <button onClick={() => adjustView({ zoom:  0.5 })} title="Zoom in"  style={{ ...NAV_BTN, flex: 1, fontSize: '16px' }}>+</button>
          <div style={{ width: '1px', background: 'rgba(255,255,255,0.07)' }}/>
          <button onClick={() => adjustView({ zoom: -0.5 })} title="Zoom out" style={{ ...NAV_BTN, flex: 1, fontSize: '16px' }}>−</button>
        </div>

        {/* Overview / reset */}
        <button onClick={resetView} style={{
          ...NAV_BTN, width: '100%', fontSize: '9px', letterSpacing: '0.08em',
          opacity: 0.5, padding: '7px',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
        }}>
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
            <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            <path d="M13.5 2.5v3h-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          OVERVIEW
        </button>
      </div>

      {/* ── Status bar ──────────────────────────────────────────────────── */}
      <div style={{
        position: 'absolute',
        bottom: 0, left: 0, right: 0,
        height: '26px',
        background: 'rgba(5,5,5,0.88)',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '24px',
        fontFamily: 'monospace',
        fontSize: '10px',
        color: '#f0ece6',
        opacity: 0.65,
        letterSpacing: '0.04em',
        zIndex: 2,
        pointerEvents: 'none',
        userSelect: 'none',
      }}>
        <span>{viewState.latitude.toFixed(4)}° N</span>
        <span>{viewState.longitude.toFixed(4)}° E</span>
        <span>zoom {viewState.zoom.toFixed(2)}</span>
        <span>pitch {Math.round(viewState.pitch)}°</span>
        <span>bearing {Math.round(((viewState.bearing % 360) + 360) % 360)}°</span>
      </div>
    </div>
  );
}

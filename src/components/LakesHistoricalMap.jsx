import { useEffect, useMemo, useRef, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer, BitmapLayer, ScatterplotLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { MapView } from '@deck.gl/core';
import lakesData from '../data/geojson/lakes-historical.geojson';
import elBormaFindingsCsv from '../data/csv/el_borma_findings.csv?raw';

const ROIS = [
  {
    id: 'elborma',
    title: 'El Borma',
    subtitle: '',
    center: [9.183, 31.716],
    zoom: 12.2,
    color: [233, 121, 47],
    // [minLng, minLat, maxLng, maxLat]
    bounds: [9.165, 31.705, 9.195, 31.728],
  },
  {
    id: 'zenaiga',
    title: 'Near Zenaiga',
    subtitle: '',
    center: [9.168, 31.6548],
    zoom: 13.2,
    color: [78, 170, 121],
    bounds: [9.160, 31.647, 9.173, 31.662],
  },
];

const OUTLIER_AREA_M2 = 7000;
const YEAR_BANDWIDTH = 0.55;

const BASEMAPS = {
  satellite: {
    id: 'satellite',
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  },
  hydrocarbon: {
    id: 'hydrocarbon',
    label: 'Hydrocarbon',
    url: '/sources/hydrocarbon_tiles/{z}/{x}/{y}.png',
  },
};

const EL_BORMA_FINDING_FIELDS = [
  {
    parameter: 'liquid_surface_elev_m',
    format: value => `Liquid surface elevation: ${Number(value).toFixed(1)} m`,
  },
  {
    parameter: 'mean_spillover_elev_m',
    format: value => `Mean spillover elevation: ${Number(value).toFixed(1)} m`,
  },
  {
    parameter: 'mean_depth_m',
    format: value => `Mean depth: ${Number(value).toFixed(1)} m`,
  },
  {
    parameter: 'approx_planform_area_m2',
    format: value => `Approximate planform area: ${(Number(value) / 1_000_000).toFixed(2)} km2`,
  },
  {
    parameter: 'volume_best_estimate_Mm3',
    format: value => `Estimated volume: ${Number(value).toFixed(1)} Mm3`,
  },
  {
    parameter: 'profile_spacing_m',
    format: (value, entries) => `Profile spacing: ${Number(value).toFixed(0)} m across ${entries.n_cross_sections} cross-sections`,
  },
  {
    parameter: 'dem_source',
    format: value => `DEM source: ${value}`,
  },
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function featureBbox(geometry) {
  const coords = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  for (const polygon of coords) {
    for (const ring of polygon) {
      for (const point of ring) {
        const [lng, lat] = point;
        minLng = Math.min(minLng, lng);
        minLat = Math.min(minLat, lat);
        maxLng = Math.max(maxLng, lng);
        maxLat = Math.max(maxLat, lat);
      }
    }
  }

  return [minLng, minLat, maxLng, maxLat];
}

function intersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function polygonCentroid(geometry) {
  const polygon = geometry.type === 'Polygon' ? geometry.coordinates[0] : geometry.coordinates[0][0];
  let area2 = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0; i < polygon.length - 1; i += 1) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[i + 1];
    const cross = x1 * y2 - x2 * y1;
    area2 += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }

  if (Math.abs(area2) < 1e-12) {
    const [x, y] = polygon[0];
    return [x, y];
  }

  return [cx / (3 * area2), cy / (3 * area2)];
}

function scaleRing(ring, center, scale) {
  const [centerLng, centerLat] = center;

  return ring.map(([lng, lat]) => [
    centerLng + (lng - centerLng) * scale,
    centerLat + (lat - centerLat) * scale,
  ]);
}

function scaleGeometry(geometry, scale) {
  const center = polygonCentroid(geometry);

  if (geometry.type === 'Polygon') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map((ring) => scaleRing(ring, center, scale)),
    };
  }

  if (geometry.type === 'MultiPolygon') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map((polygon) =>
        polygon.map((ring) => scaleRing(ring, center, scale))
      ),
    };
  }

  return geometry;
}

function transformFeature(feature, scale) {
  return {
    ...feature,
    geometry: scaleGeometry(feature.geometry, scale),
  };
}

function weightAtYear(featureYear, currentYear) {
  const diff = currentYear - featureYear;
  return Math.exp(-(diff * diff) / (2 * YEAR_BANDWIDTH * YEAR_BANDWIDTH));
}

function areaToRadius(areaM2) {
  return Math.sqrt(Math.max(areaM2, 0) / Math.PI);
}

function calculateScale(zoom, latitude) {
  // Meters per pixel at given zoom and latitude (Web Mercator)
  const metersPerPixel = (156543.03392 * Math.cos((latitude * Math.PI) / 180)) / Math.pow(2, zoom);
  
  // Target scale bar width in pixels
  const targetPixels = 100;
  const meters = metersPerPixel * targetPixels;
  
  // Round to nice numbers
  let distance = meters;
  let unit = 'm';
  
  if (meters >= 1000) {
    distance = meters / 1000;
    unit = 'km';
  }
  
  // Round to 1, 2, 5, 10, 20, 50, 100, etc.
  const magnitude = Math.pow(10, Math.floor(Math.log10(distance)));
  const normalized = distance / magnitude;
  
  let nice;
  if (normalized < 1.5) nice = 1;
  else if (normalized < 3.5) nice = 2;
  else if (normalized < 7.5) nice = 5;
  else nice = 10;
  
  const niceDistance = nice * magnitude;
  const niceMeters = unit === 'km' ? niceDistance * 1000 : niceDistance;
  const nicePixels = niceMeters / metersPerPixel;
  
  return {
    distance: niceDistance,
    unit,
    pixels: nicePixels,
    label: `${niceDistance} ${unit}`,
  };
}

function parseSimpleCsv(csvText) {
  const lines = csvText.trim().split('\n');
  const entries = {};

  for (const line of lines.slice(1)) {
    const commaIndex = line.indexOf(',');
    if (commaIndex === -1) continue;

    const parameter = line.slice(0, commaIndex).trim();
    const rawValue = line.slice(commaIndex + 1).trim();
    entries[parameter] = rawValue.replace(/^"|"$/g, '');
  }

  return entries;
}

function buildElBormaFindings(csvText) {
  const entries = parseSimpleCsv(csvText);

  return EL_BORMA_FINDING_FIELDS
    .filter(({ parameter }) => entries[parameter] != null)
    .map(({ parameter, format }) => format(entries[parameter], entries));
}

function buildRoiDataset() {
  const allFeatures = lakesData.features.map((feature) => {
    const year = Number(feature.properties.year);
    const areaM2 = Number(feature.properties.area_m2 || 0);
    const bbox = featureBbox(feature.geometry);
    const centroid = polygonCentroid(feature.geometry);
    return {
      ...feature,
      __year: year,
      __areaM2: areaM2,
      __bbox: bbox,
      __centroid: centroid,
      __isOutlier: areaM2 < OUTLIER_AREA_M2,
    };
  });

  const years = [...new Set(allFeatures.map((f) => f.__year))].sort((a, b) => a - b);

  const byRoi = ROIS.reduce((acc, roi) => {
    acc[roi.id] = allFeatures.filter((feature) => intersects(feature.__bbox, roi.bounds));
    return acc;
  }, {});

  return { years, byRoi };
}

export default function LakesHistoricalMap() {
  const { years, byRoi } = useMemo(buildRoiDataset, []);
  const elBormaFindings = useMemo(() => buildElBormaFindings(elBormaFindingsCsv), []);
  const minYear = years[0];
  const maxYear = years[years.length - 1];

  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(0.35); // years per second
  const [yearFloat, setYearFloat] = useState(minYear);
  const [basemap, setBasemap] = useState('satellite');
  const [showElBormaInfo, setShowElBormaInfo] = useState(false);
  const rafRef = useRef(null);
  const lastRef = useRef(0);

  useEffect(() => {
    if (!playing) {
      lastRef.current = 0;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return undefined;
    }

    function tick(ts) {
      if (!lastRef.current) {
        lastRef.current = ts;
      }

      const dt = (ts - lastRef.current) / 1000;
      lastRef.current = ts;

      setYearFloat((prev) => {
        const next = prev + dt * speed;
        return next > maxYear ? minYear : next;
      });

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastRef.current = 0;
    };
  }, [playing, speed, minYear, maxYear]);

  const yearLabel = yearFloat.toFixed(1);

  function createLayers(roi) {
    const roiFeatures = byRoi[roi.id] || [];
    const activeFeatures = roiFeatures.filter((feature) => weightAtYear(feature.__year, yearFloat) > 0.01);
    const bodyFeatures = activeFeatures
      .filter((feature) => !feature.__isOutlier)
      .map((feature) => {
        const weight = weightAtYear(feature.__year, yearFloat);
        const scale = 1 + 0.05 * weight;
        return transformFeature(feature, scale);
      });
    const bodyGlowFeatures = activeFeatures
      .filter((feature) => !feature.__isOutlier)
      .map((feature) => {
        const weight = weightAtYear(feature.__year, yearFloat);
        const scale = 1 + 0.13 * weight;
        return transformFeature(feature, scale);
      });
    const outlierFeatures = activeFeatures
      .filter((feature) => feature.__isOutlier)
      .map((feature) => {
        const weight = weightAtYear(feature.__year, yearFloat);
        const scale = 1 + 0.18 * weight;
        return transformFeature(feature, scale);
      });

    const basemapConfig = BASEMAPS[basemap];
    const basemapLayer = new TileLayer({
      id: `basemap-${basemapConfig.id}-${roi.id}`,
      data: basemapConfig.url,
      minZoom: 0,
      maxZoom: 19,
      tileSize: 256,
      renderSubLayers: (props) => {
        const {
          bbox: { west, south, east, north },
        } = props.tile;

        return new BitmapLayer(props, {
          data: null,
          image: props.data,
          bounds: [west, south, east, north],
          opacity: 0.9,
        });
      },
    });

    const bodyLayer = new GeoJsonLayer({
      id: `lake-body-${roi.id}`,
      data: bodyFeatures,
      filled: true,
      stroked: true,
      pickable: true,
      lineWidthMinPixels: 0.6,
      getLineColor: (f) => {
        const w = weightAtYear(f.__year, yearFloat);
        return [255, 248, 233, Math.round(160 * w)];
      },
      getFillColor: (f) => {
        const w = weightAtYear(f.__year, yearFloat);
        const areaBoost = clamp(Math.log10(f.__areaM2 + 1) / 6, 0.2, 1);
        const alpha = Math.round(190 * w * areaBoost);
        return [...roi.color, alpha];
      },
      updateTriggers: {
        getFillColor: [yearFloat],
        getLineColor: [yearFloat],
      },
    });

    const bodyGlowLayer = new GeoJsonLayer({
      id: `lake-glow-${roi.id}`,
      data: bodyGlowFeatures,
      filled: true,
      stroked: false,
      pickable: false,
      getFillColor: (f) => {
        const w = weightAtYear(f.__year, yearFloat);
        const alpha = Math.round(80 * w);
        return [...roi.color, alpha];
      },
      updateTriggers: {
        getFillColor: [yearFloat],
      },
    });

    const outlierLayer = new ScatterplotLayer({
      id: `spill-outlier-${roi.id}`,
      data: outlierFeatures,
      getPosition: (f) => f.__centroid,
      radiusUnits: 'meters',
      stroked: true,
      filled: true,
      getRadius: (f) => areaToRadius(f.__areaM2) * 1.3,
      getLineColor: (f) => {
        const w = weightAtYear(f.__year, yearFloat);
        return [206, 225, 255, Math.round(180 * w)];
      },
      getFillColor: (f) => {
        const w = weightAtYear(f.__year, yearFloat);
        return [130, 176, 220, Math.round(75 * w)];
      },
      lineWidthMinPixels: 1,
      updateTriggers: {
        getFillColor: [yearFloat],
        getLineColor: [yearFloat],
      },
    });

    const corePulse = new ScatterplotLayer({
      id: `core-pulse-${roi.id}`,
      data: bodyFeatures,
      getPosition: (f) => f.__centroid,
      radiusUnits: 'meters',
      stroked: false,
      filled: true,
      getRadius: (f) => areaToRadius(f.__areaM2) * 0.38,
      getFillColor: (f) => {
        const w = weightAtYear(f.__year, yearFloat);
        const pulse = 0.72 + 0.28 * Math.sin((yearFloat - years[0]) * Math.PI * 2);
        return [255, 224, 170, Math.round(120 * w * pulse)];
      },
      updateTriggers: {
        getFillColor: [yearFloat],
      },
    });

    return [basemapLayer, bodyGlowLayer, bodyLayer, outlierLayer, corePulse];
  }

  const tooltip = ({ object }) => {
    if (!object) return null;
    const p = object.properties;
    return {
      html: `<div style="font-family:monospace;font-size:12px;line-height:1.45">
        <div style="opacity:.65;letter-spacing:.05em;text-transform:uppercase;font-size:10px">Inventory frame</div>
        <strong>${p.year}</strong><br/>
        Area: <strong>${Math.round(p.area_m2).toLocaleString()} m2</strong>
      </div>`,
      style: {
        background: 'rgba(8,8,8,0.9)',
        color: '#f3ecdf',
        border: '1px solid rgba(255,255,255,0.2)',
        borderRadius: '6px',
        padding: '8px 10px',
        maxWidth: '220px',
      },
    };
  };

  return (
    <div className="lakes-root">
      <div className="hud">
        <div className="hud-top">
          <div>
            <p className="kicker">Historical Oil Lakes</p>
            <h2>Fluid Temporal Approximation</h2>
          </div>
          <div className="year-pill">{yearLabel}</div>
        </div>

        <div className="controls">
          <div className="basemap-toggle">
            {Object.values(BASEMAPS).map((bm) => (
              <button
                key={bm.id}
                type="button"
                className={basemap === bm.id ? 'active' : ''}
                onClick={() => setBasemap(bm.id)}
              >
                {bm.label}
              </button>
            ))}
          </div>

          <button type="button" onClick={() => setPlaying((v) => !v)}>
            {playing ? 'Pause' : 'Play'}
          </button>

          <label>
            Year
            <input
              type="range"
              min={years[0]}
              max={years[years.length - 1]}
              step={0.1}
              value={yearFloat}
              onChange={(event) => {
                setYearFloat(Number(event.target.value));
                setPlaying(false);
              }}
            />
          </label>

          <label>
            Speed ({speed.toFixed(2)} y/s)
            <input
              type="range"
              min={0.1}
              max={1.2}
              step={0.05}
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
            />
          </label>
        </div>

        <p className="note">
          Main lakes are rendered as dense fluid masses. Small temporary detections are treated as pale spill pulses.
        </p>
      </div>

      <div className="grid">
        {ROIS.map((roi) => {
          const scale = calculateScale(roi.zoom, roi.center[1]);
          return (
            <section key={roi.id} className="map-card">
              <header>
                <div className="card-heading-row">
                  <div>
                    <h3>{roi.title}</h3>
                    <p>{roi.subtitle}</p>
                  </div>
                  {roi.id === 'elborma' && (
                    <div className="info-wrap">
                      <button
                        type="button"
                        className="info-button"
                        aria-label="Show El Borma findings"
                        aria-expanded={showElBormaInfo}
                        onClick={() => setShowElBormaInfo((prev) => !prev)}
                      >
                        i
                      </button>
                      {showElBormaInfo && (
                        <div className="info-tooltip" role="dialog" aria-label="El Borma findings">
                          <div className="info-tooltip-title">El Borma findings</div>
                          <ul>
                            {elBormaFindings.map((finding) => (
                              <li key={finding}>{finding}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </header>
              <div className="map-stage">
                <DeckGL
                  key={`${roi.id}-${basemap}`}
                  viewState={{
                    longitude: roi.center[0],
                    latitude: roi.center[1],
                    zoom: roi.zoom,
                    pitch: 0,
                    bearing: 0,
                    maxZoom: 18,
                    minZoom: 8,
                  }}
                  controller={true}
                  views={new MapView({ repeat: false })}
                  layers={createLayers(roi)}
                  getTooltip={tooltip}
                  style={{ width: '100%', height: '100%' }}
                />
                <div className="scale-bar">
                  <div className="scale-bar-line" style={{ width: `${scale.pixels}px` }} />
                  <div className="scale-bar-label">{scale.label}</div>
                </div>
              </div>
            </section>
          );
        })}
      </div>

      <section className="narrative" aria-label="Visualization narrative">
        <h3>Narrative</h3>
        <p>
          El Borma is only one of several deep oil lakes in the desert. From satellite imagery,
          many dark spots appear to indicate oil reservoirs; however, many are persistent
          superficial stains left by temporary spills. The two lakes shown here are material
          manifestations of upstream oil-production externalities, resembling the behavior of a
          natural lake.
        </p>
      </section>

      <style>{`
        .lakes-root {
          position: absolute;
          inset: 0;
          background: radial-gradient(140% 110% at 10% 0%, #24140f 0%, #0d0b0a 55%, #050505 100%);
          color: #f3ecdf;
          font-family: "IBM Plex Mono", "SFMono-Regular", Menlo, monospace;
          display: flex;
          flex-direction: column;
          gap: 12px;
          padding: 14px;
          overflow: auto;
        }

        .hud {
          position: relative;
          z-index: 3;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: linear-gradient(135deg, rgba(27, 17, 12, 0.83), rgba(12, 14, 12, 0.82));
          backdrop-filter: blur(8px);
          border-radius: 10px;
          padding: 12px 14px;
          display: grid;
          gap: 8px;
        }

        .hud-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .kicker {
          font-size: 10px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          opacity: 0.62;
          margin: 0 0 2px;
        }

        .hud h2 {
          margin: 0;
          font-size: clamp(1rem, 2vw, 1.2rem);
          letter-spacing: 0.01em;
        }

        .year-pill {
          min-width: 74px;
          text-align: center;
          border: 1px solid rgba(255, 212, 160, 0.45);
          background: rgba(255, 168, 94, 0.14);
          padding: 6px 10px;
          border-radius: 999px;
          font-size: 13px;
        }

        .controls {
          display: grid;
          grid-template-columns: auto auto 1fr 1fr;
          gap: 12px;
          align-items: center;
        }

        .basemap-toggle {
          display: flex;
          gap: 0.25rem;
          background: rgba(20, 20, 20, 0.6);
          padding: 0.25rem;
          border-radius: 6px;
          border: 1px solid rgba(255, 255, 255, 0.15);
        }

        .basemap-toggle button {
          background: transparent;
          color: rgba(255, 255, 255, 0.65);
          border: none;
          padding: 0.4rem 0.85rem;
          font-size: 13px;
          font-weight: 500;
          border-radius: 4px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .basemap-toggle button:hover {
          background: rgba(255, 255, 255, 0.1);
          color: rgba(255, 255, 255, 0.9);
        }

        .basemap-toggle button.active {
          background: rgba(255, 255, 255, 0.2);
          color: #fff;
          font-weight: 600;
        }

        .controls > button {
          border: 1px solid rgba(255, 255, 255, 0.25);
          background: rgba(255, 255, 255, 0.08);
          color: inherit;
          padding: 8px 12px;
          border-radius: 6px;
          cursor: pointer;
          font-family: inherit;
        }

        .controls label {
          display: grid;
          gap: 4px;
          font-size: 11px;
          opacity: 0.92;
        }

        input[type="range"] {
          width: 100%;
          accent-color: #f5a25f;
        }

        .note {
          margin: 0;
          font-size: 11px;
          line-height: 1.4;
          opacity: 0.68;
        }

        .grid {
          position: relative;
          z-index: 1;
          flex: 1;
          min-height: 0;
          display: flex;
          flex-wrap: nowrap;
          gap: 12px;
        }

        .map-card {
          position: relative;
          flex: 1 1 0;
          min-width: 0;
          min-height: 0;
          border-radius: 12px;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.13);
          background: rgba(10, 10, 10, 0.6);
          display: flex;
          flex-direction: column;
        }

        .map-card header {
          position: relative;
          z-index: 1;
          padding: 10px 12px;
          background: linear-gradient(to right, rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0.35));
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }

        .card-heading-row {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 10px;
        }

        .map-card h3 {
          margin: 0;
          font-size: 14px;
          letter-spacing: 0.04em;
        }

        .map-card p {
          margin: 2px 0 0;
          font-size: 11px;
          opacity: 0.65;
        }

        .info-wrap {
          position: relative;
          flex-shrink: 0;
        }

        .info-button {
          width: 22px;
          height: 22px;
          border: 1px solid rgba(255, 255, 255, 0.22);
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.08);
          color: rgba(243, 236, 223, 0.92);
          font: inherit;
          font-size: 12px;
          line-height: 1;
          cursor: pointer;
        }

        .info-button:hover {
          background: rgba(255, 255, 255, 0.14);
        }

        .info-tooltip {
          position: absolute;
          top: calc(100% + 8px);
          right: 0;
          width: min(300px, 60vw);
          padding: 10px 12px;
          border-radius: 8px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(8, 8, 8, 0.95);
          box-shadow: 0 10px 26px rgba(0, 0, 0, 0.32);
          backdrop-filter: blur(8px);
        }

        .info-tooltip-title {
          margin: 0 0 8px;
          font-size: 10px;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          opacity: 0.7;
        }

        .info-tooltip ul {
          margin: 0;
          padding-left: 16px;
          display: grid;
          gap: 6px;
        }

        .info-tooltip li {
          font-size: 11px;
          line-height: 1.45;
          color: rgba(243, 236, 223, 0.92);
        }

        .narrative {
          position: relative;
          z-index: 2;
          border: 1px solid rgba(255, 255, 255, 0.13);
          border-radius: 12px;
          background: linear-gradient(145deg, rgba(14, 12, 11, 0.9), rgba(20, 16, 13, 0.86));
          padding: 14px 16px;
        }

        .narrative h3 {
          margin: 0 0 8px;
          font-size: 12px;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          opacity: 0.76;
        }

        .narrative p {
          margin: 0;
          font-size: 13px;
          line-height: 1.65;
          color: rgba(243, 236, 223, 0.9);
          max-width: 110ch;
        }

        .scale-bar {
          position: absolute;
          bottom: 16px;
          left: 16px;
          background: rgba(0, 0, 0, 0.75);
          border: 1px solid rgba(255, 255, 255, 0.25);
          border-radius: 4px;
          padding: 6px 8px;
          pointer-events: none;
          z-index: 10;
        }

        .scale-bar-line {
          height: 2px;
          background: rgba(255, 255, 255, 0.9);
          margin-bottom: 3px;
          border-left: 2px solid rgba(255, 255, 255, 0.9);
          border-right: 2px solid rgba(255, 255, 255, 0.9);
        }

        .scale-bar-label {
          font-size: 10px;
          color: rgba(255, 255, 255, 0.9);
          text-align: center;
          letter-spacing: 0.02em;
          font-family: monospace;
        }

        
        .map-stage {
          position: relative;
          flex: 1;
          min-height: 0;
        }

        @media (max-width: 980px) {
          .controls {
            grid-template-columns: 1fr;
          }

          .grid {
            flex-direction: column;
          }
        }
      `}</style>
    </div>
  );
}

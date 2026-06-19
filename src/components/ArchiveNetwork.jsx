import { useEffect, useRef, useState, useCallback } from 'react';
import {
  forceSimulation,
  forceCollide,
  forceManyBody,
  forceCenter,
  forceLink,
  forceY,
} from 'd3-force';
import gsap from 'gsap';
import {
  computeAffinityScores,
  getPhaseZone,
  getVerticalBias,
} from '../utils/archiveAffinity.js';
import archiveData from '../data/json/20260618180331.json';

const DATA = archiveData.results;

const NODE_W = 88;
const NODE_H = 66;
const HALF_W = NODE_W / 2;
const HALF_H = NODE_H / 2;
const COLLISION_R = Math.hypot(HALF_W + 8, HALF_H + 8);
const TOP_N = 15;

const PHASE_COLORS = {
  'Drilling & Well Creation':        '#c45c3a',
  'Topographic/Seismic Exploration': '#a07040',
  'Processing & Separation':         '#3a7d5c',
  'Testing':                         '#c4a03a',
};

const PHASE_SHORT = {
  'Drilling & Well Creation':        'Drilling',
  'Topographic/Seismic Exploration': 'Seismic',
  'Processing & Separation':         'Processing',
  'Testing':                         'Testing',
};

function phaseZoneY(extractive_phase, h) {
  return getPhaseZone(extractive_phase) === 'subsurface' ? h * 0.72 : h * 0.28;
}

function materialSplitY(image, h) {
  const bias = getVerticalBias(image);
  if (bias > 0.2)  return h * 0.80;
  if (bias < -0.2) return h * 0.20;
  return h * 0.50;
}

const BTN = {
  background: 'rgba(255,255,255,0.07)',
  border: '1px solid rgba(255,255,255,0.15)',
  color: '#f0ece6',
  fontFamily: 'monospace',
  fontSize: 11,
  padding: '5px 10px',
  cursor: 'pointer',
  borderRadius: 3,
  letterSpacing: '0.05em',
};

const BTN_ACTIVE = {
  ...BTN,
  background: 'rgba(58,125,92,0.4)',
  borderColor: 'rgba(58,125,92,0.8)',
};

export default function ArchiveNetwork() {
  const containerRef       = useRef(null);
  const svgRef             = useRef(null);
  const simRef             = useRef(null);
  const nodeGroupsRef      = useRef({});
  const nodeScaleGroupsRef = useRef({});
  const linkElemsRef       = useRef({});
  const dimsRef            = useRef({ w: 800, h: 600 });
  const mountedRef         = useRef(false);
  const tooltipRef         = useRef(null);

  const [dims, setDims]             = useState({ w: 0, h: 0 });
  const [seedId, setSeedId]         = useState(null);
  const [splitActive, setSplitActive] = useState(false);
  const [links, setLinks]           = useState([]);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [mousePos, setMousePos]     = useState({ x: 0, y: 0 });
  const [infoOpen, setInfoOpen]     = useState(true);

  // ── Init simulation ──────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const w = container.clientWidth  || window.innerWidth;
    const h = container.clientHeight || window.innerHeight - 44;
    dimsRef.current = { w, h };
    setDims({ w, h });

    const nodes = DATA.map(img => ({
      id:   img.image_path,
      data: img,
      x: w * 0.1 + Math.random() * w * 0.8,
      y: getPhaseZone(img.extractive_phase) === 'subsurface'
        ? h * 0.45 + Math.random() * h * 0.40
        : h * 0.05 + Math.random() * h * 0.40,
    }));

    const sim = forceSimulation(nodes)
      .force('collide', forceCollide(COLLISION_R).strength(0.88))
      .force('charge',  forceManyBody().strength(-55))
      .force('center',  forceCenter(w / 2, h / 2).strength(0.012))
      .force('y', forceY(d => phaseZoneY(d.data.extractive_phase, h)).strength(0.07))
      .force('link', forceLink([]).id(d => d.id).strength(0).distance(70))
      .alphaDecay(0.018);

    sim.on('tick', () => {
      const { w: cw, h: ch } = dimsRef.current;
      nodes.forEach(n => {
        n.x = Math.max(HALF_W + 2,  Math.min(cw - HALF_W - 2,  n.x));
        n.y = Math.max(HALF_H + 26, Math.min(ch - HALF_H + 26, n.y));
        const el = nodeGroupsRef.current[n.id];
        if (el) el.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
      });

      sim.force('link').links().forEach(link => {
        const key = `${link.source.id}|${link.target.id}`;
        const el  = linkElemsRef.current[key];
        if (el) {
          el.setAttribute('x1', link.source.x.toFixed(1));
          el.setAttribute('y1', link.source.y.toFixed(1));
          el.setAttribute('x2', link.target.x.toFixed(1));
          el.setAttribute('y2', link.target.y.toFixed(1));
        }
      });
    });

    simRef.current = sim;
    return () => { sim.stop(); };
  }, []);

  // ── Respond to seed changes ──────────────────────────────────────────
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }

    const sim = simRef.current;
    if (!sim) return;
    const { h } = dimsRef.current;

    if (!seedId) {
      setLinks([]);
      sim.force('link').links([]);
      sim.force('y').y(d => phaseZoneY(d.data.extractive_phase, h)).strength(0.07);
      sim.alpha(0.45).restart();
      return;
    }

    const seed = DATA.find(d => d.image_path === seedId);
    if (!seed) return;

    const scores    = computeAffinityScores(seed, DATA);
    const maxScore  = scores[0]?.score || 1;
    const topScores = scores.filter(s => s.score > 0).slice(0, TOP_N);

    const stateLinks = topScores.map(s => ({
      source: seedId,
      target: s.target,
      score:  s.score,
      key:    `${seedId}|${s.target}`,
    }));
    setLinks(stateLinks);

    const d3Links = topScores.map(s => ({
      source:   seedId,
      target:   s.target,
      strength: (s.score / maxScore) * 0.65,
      distance: 80 - (s.score / maxScore) * 50,
    }));
    sim.force('link')
      .links(d3Links)
      .strength(d => d.strength)
      .distance(d => d.distance);
    sim.alpha(0.55).restart();

    const seedInner = nodeScaleGroupsRef.current[seedId];
    if (seedInner) {
      gsap.fromTo(seedInner,
        { scale: 1 },
        { scale: 1.18, duration: 0.3, ease: 'back.out(1.7)', transformOrigin: '50% 50%' }
      );
    }

    const linkedIds = new Set(topScores.map(s => s.target));
    linkedIds.add(seedId);
    DATA.forEach(img => {
      const el = nodeGroupsRef.current[img.image_path];
      if (!el) return;
      gsap.to(el, { opacity: linkedIds.has(img.image_path) ? 1 : 0.28, duration: 0.35 });
    });
  }, [seedId]);

  // ── Respond to split toggle ──────────────────────────────────────────
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    const { h } = dimsRef.current;

    const fy = sim.force('y');
    if (splitActive) {
      fy.y(d => materialSplitY(d.data, h)).strength(0.20);
    } else {
      fy.y(d => phaseZoneY(d.data.extractive_phase, h)).strength(0.07);
    }
    sim.alpha(0.5).restart();
  }, [splitActive]);

  // ── Event handlers ───────────────────────────────────────────────────
  const handleNodeClick = useCallback((id) => {
    setSeedId(prev => {
      if (prev && prev !== id) {
        const prevInner = nodeScaleGroupsRef.current[prev];
        if (prevInner) gsap.to(prevInner, { scale: 1, duration: 0.2, transformOrigin: '50% 50%' });
      }
      return id;
    });
  }, []);

  const handleReset = useCallback(() => {
    DATA.forEach(img => {
      const outer = nodeGroupsRef.current[img.image_path];
      const inner = nodeScaleGroupsRef.current[img.image_path];
      if (outer) gsap.to(outer, { opacity: 1, duration: 0.3 });
      if (inner) gsap.to(inner, { scale: 1, duration: 0.25, transformOrigin: '50% 50%' });
    });
    setSeedId(null);
    setSplitActive(false);
  }, []);

  const handleMouseEnter = useCallback((img, e) => {
    setHoveredNode(img);
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    if (tooltipRef.current) {
      gsap.killTweensOf(tooltipRef.current);
      gsap.fromTo(tooltipRef.current, { opacity: 0, y: -5 }, { opacity: 1, y: 0, duration: 0.18 });
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (tooltipRef.current) {
      gsap.to(tooltipRef.current, {
        opacity: 0, duration: 0.15,
        onComplete: () => setHoveredNode(null),
      });
    }
  }, []);

  const maxLinkScore = links.length > 0 ? Math.max(...links.map(l => l.score)) : 1;

  const TOOLTIP_W = 300;
  const txRaw = mousePos.x + 16;
  const tx    = txRaw + TOOLTIP_W > dims.w ? mousePos.x - TOOLTIP_W - 8 : txRaw;
  const ty    = mousePos.y > dims.h * 0.72  ? mousePos.y - 140 : mousePos.y + 16;

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: '#0a0e0d' }}
      onMouseMove={(e) => {
        if (!hoveredNode) return;
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      }}
    >
      {/* Zone overlays when Split is active */}
      {splitActive && (
        <>
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '30%', background: 'linear-gradient(to bottom, rgba(74,170,122,0.08), transparent)', pointerEvents: 'none' }} />
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '30%', background: 'linear-gradient(to top, rgba(196,92,58,0.12), transparent)', pointerEvents: 'none' }} />
          <div style={{ position: 'absolute', top: 28, left: '50%', transform: 'translateX(-50%)', fontSize: 9, color: 'rgba(74,170,122,0.65)', fontFamily: 'monospace', letterSpacing: '0.1em', pointerEvents: 'none' }}>
            ▲ VOLATILE / SURFACE WASTE
          </div>
          <div style={{ position: 'absolute', bottom: 18, left: '50%', transform: 'translateX(-50%)', fontSize: 9, color: 'rgba(196,92,58,0.65)', fontFamily: 'monospace', letterSpacing: '0.1em', pointerEvents: 'none' }}>
            ▼ HEAVY WASTE / SUBSURFACE RESIDUES
          </div>
        </>
      )}

      <svg ref={svgRef} style={{ width: '100%', height: '100%', display: 'block' }}>
        <defs>
          <linearGradient id="archive-bg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#081512" />
            <stop offset="100%" stopColor="#150a05" />
          </linearGradient>
          <clipPath id="node-img-clip">
            <rect x={-HALF_W} y={-HALF_H} width={NODE_W} height={NODE_H - 18} />
          </clipPath>
        </defs>

        <rect width="100%" height="100%" fill="url(#archive-bg)" />

        {/* Dashed midline */}
        {dims.h > 0 && (
          <line
            x1={0} y1={dims.h * 0.5} x2={dims.w} y2={dims.h * 0.5}
            stroke="rgba(255,255,255,0.04)" strokeWidth={1} strokeDasharray="3 8"
          />
        )}

        {/* Top anchor */}
        <text
          x="50%" y={17}
          textAnchor="middle" fill="#4aaa7a" fontSize="10"
          fontFamily="monospace" letterSpacing="0.12em"
          style={{ cursor: 'pointer', userSelect: 'none' }}
          onClick={() => { window.location.href = '/lakes'; }}
        >
          ↑ OIL LAKES SURFACE
        </text>

        {/* Bottom anchor */}
        {dims.h > 0 && (
          <text
            x="50%" y={dims.h - 8}
            textAnchor="middle" fill="#c45c3a" fontSize="10"
            fontFamily="monospace" letterSpacing="0.12em"
            style={{ cursor: 'pointer', userSelect: 'none' }}
            onClick={() => { window.location.href = '/isopay'; }}
          >
            ↓ SUBSURFACE STRATIGRAPHY
          </text>
        )}

        {/* Affinity links layer */}
        <g>
          {links.map(link => {
            const sourcePhase = DATA.find(d => d.image_path === link.source)?.extractive_phase;
            return (
              <line
                key={link.key}
                ref={el => {
                  if (el) linkElemsRef.current[link.key] = el;
                  else    delete linkElemsRef.current[link.key];
                }}
                stroke={PHASE_COLORS[sourcePhase] || '#888'}
                strokeOpacity={0.1 + (link.score / maxLinkScore) * 0.42}
                strokeWidth={0.6 + (link.score / maxLinkScore) * 1.8}
              />
            );
          })}
        </g>

        {/* Node cards */}
        <g>
          {DATA.map(img => {
            const phaseColor = PHASE_COLORS[img.extractive_phase] || '#888';
            const isSeed     = img.image_path === seedId;
            return (
              <g
                key={img.image_path}
                ref={el => { nodeGroupsRef.current[img.image_path] = el; }}
              >
                <g
                  ref={el => { nodeScaleGroupsRef.current[img.image_path] = el; }}
                  style={{ cursor: 'pointer' }}
                  onClick={() => handleNodeClick(img.image_path)}
                  onMouseEnter={e => handleMouseEnter(img, e)}
                  onMouseLeave={handleMouseLeave}
                >
                  <rect
                    x={-HALF_W} y={-HALF_H} width={NODE_W} height={NODE_H} rx={3}
                    fill="#0c0c0c"
                    stroke={isSeed ? '#ffffff' : phaseColor}
                    strokeWidth={isSeed ? 2 : 1}
                    strokeOpacity={isSeed ? 1 : 0.55}
                  />
                  <image
                    href={`/sources/eni/${img.image_path}`}
                    x={-HALF_W} y={-HALF_H}
                    width={NODE_W} height={NODE_H - 18}
                    preserveAspectRatio="xMidYMid slice"
                    clipPath="url(#node-img-clip)"
                  />
                  <rect
                    x={-HALF_W} y={HALF_H - 18}
                    width={NODE_W} height={18}
                    fill="rgba(0,0,0,0.82)"
                  />
                  <text
                    y={HALF_H - 6}
                    textAnchor="middle"
                    fill={phaseColor}
                    fontSize="8"
                    fontFamily="monospace"
                    letterSpacing="0.05em"
                  >
                    {PHASE_SHORT[img.extractive_phase]}
                  </text>
                </g>
              </g>
            );
          })}
        </g>
      </svg>

      {/* Control bar */}
      {seedId && (
        <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 6, zIndex: 20 }}>
          <button
            style={splitActive ? BTN_ACTIVE : BTN}
            onClick={() => setSplitActive(v => !v)}
          >
            {splitActive ? '▲▼ Collapse Split' : '▲▼ Split by Material'}
          </button>
          <button style={BTN} onClick={handleReset}>
            Reset
          </button>
        </div>
      )}

      {/* Instruction panel — bottom left */}
      <div style={{
        position: 'absolute', bottom: 20, left: 16,
        width: infoOpen ? 230 : 'auto',
        background: 'rgba(8,8,8,0.88)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 4,
        fontFamily: 'monospace',
        zIndex: 25,
        backdropFilter: 'blur(10px)',
        overflow: 'hidden',
        transition: 'width 0.2s',
      }}>
        {/* Header row */}
        <button
          onClick={() => setInfoOpen(v => !v)}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            width: '100%', background: 'none', border: 'none',
            color: 'rgba(240,236,230,0.55)', fontSize: 9,
            letterSpacing: '0.12em', textTransform: 'uppercase',
            padding: '7px 10px', cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          <span>How to read</span>
          <span style={{ marginLeft: 8, opacity: 0.5 }}>{infoOpen ? '▾' : '▸'}</span>
        </button>

        {infoOpen && (
          <div style={{ padding: '0 10px 10px' }}>
            {/* Phase legend */}
            <div style={{ marginBottom: 10 }}>
              {Object.entries(PHASE_COLORS).map(([phase, color]) => (
                <div key={phase} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 1, background: color, flexShrink: 0 }} />
                  <span style={{ fontSize: 9, color: 'rgba(240,236,230,0.5)', letterSpacing: '0.04em' }}>
                    {PHASE_SHORT[phase]}
                  </span>
                </div>
              ))}
            </div>

            <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 9 }}>
              {/* Step 1 */}
              <div style={{
                display: 'flex', gap: 7, marginBottom: 8,
                opacity: !seedId ? 1 : 0.38,
                transition: 'opacity 0.3s',
              }}>
                <span style={{ fontSize: 9, color: !seedId ? '#f0ece6' : 'rgba(240,236,230,0.4)', fontWeight: 'bold', flexShrink: 0 }}>1</span>
                <span style={{ fontSize: 9, color: 'rgba(240,236,230,0.65)', lineHeight: 1.5 }}>
                  Click any photograph to set it as a <em style={{ color: '#f0ece6', fontStyle: 'normal' }}>seed</em>. The 15 most materially similar images cluster around it.
                </span>
              </div>
              {/* Step 2 */}
              <div style={{
                display: 'flex', gap: 7, marginBottom: 8,
                opacity: seedId && !splitActive ? 1 : 0.38,
                transition: 'opacity 0.3s',
              }}>
                <span style={{ fontSize: 9, color: seedId && !splitActive ? '#f0ece6' : 'rgba(240,236,230,0.4)', fontWeight: 'bold', flexShrink: 0 }}>2</span>
                <span style={{ fontSize: 9, color: 'rgba(240,236,230,0.65)', lineHeight: 1.5 }}>
                  Press <em style={{ color: '#f0ece6', fontStyle: 'normal' }}>Split by Material</em> to separate images by substance type.
                </span>
              </div>
              {/* Step 3 */}
              <div style={{
                display: 'flex', gap: 7, marginBottom: 8,
                opacity: splitActive ? 1 : 0.38,
                transition: 'opacity 0.3s',
              }}>
                <span style={{ fontSize: 9, color: splitActive ? '#4aaa7a' : 'rgba(240,236,230,0.4)', fontWeight: 'bold', flexShrink: 0 }}>3</span>
                <span style={{ fontSize: 9, color: 'rgba(240,236,230,0.65)', lineHeight: 1.5 }}>
                  <em style={{ color: '#c45c3a', fontStyle: 'normal' }}>Heavy residues</em> (drilling mud, waste) sink. <em style={{ color: '#4aaa7a', fontStyle: 'normal' }}>Volatile matter</em> (smoke, flames) rises.
                </span>
              </div>
              {/* Hover tip */}
              <div style={{ display: 'flex', gap: 7 }}>
                <span style={{ fontSize: 9, color: 'rgba(240,236,230,0.25)', flexShrink: 0 }}>→</span>
                <span style={{ fontSize: 9, color: 'rgba(240,236,230,0.35)', lineHeight: 1.5 }}>
                  Hover any image for a field description.
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Hover tooltip */}
      <div
        ref={tooltipRef}
        style={{
          position: 'absolute',
          left: tx, top: ty,
          width: TOOLTIP_W,
          background: 'rgba(8,8,8,0.94)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 4,
          padding: '10px 12px',
          pointerEvents: 'none',
          opacity: 0,
          zIndex: 30,
          backdropFilter: 'blur(10px)',
        }}
      >
        {hoveredNode && (
          <>
            <p style={{
              fontSize: 9,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: PHASE_COLORS[hoveredNode.extractive_phase] || '#888',
              marginBottom: 7,
              fontFamily: 'monospace',
            }}>
              {hoveredNode.extractive_phase}
            </p>
            <p style={{
              fontSize: 11,
              color: 'rgba(240,236,230,0.82)',
              lineHeight: 1.58,
              fontFamily: 'monospace',
            }}>
              {hoveredNode.relational_description}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * DecaySimulationChart — Interactive timeline chart for decay simulation.
 *
 * Visualizes:
 *   1. Weight change over event time (blue line)
 *   2. Shield value over time (purple fill area)
 *   3. Shield active/inactive regions (colored backgrounds)
 *   4. Reinforcement events as vertical markers
 *   5. Interactive timeline slider to scrub through events
 *   6. Hover tooltip showing exact values at any point
 *
 * Uses HTML5 Canvas for performance with large event ranges.
 * Pure client-side simulation — no API calls needed.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';

// ─── Constants (mirror backend) ──────────────────────────────

const WEIGHT_CAP = 100;
const BASE_SHIELD_CAP = 50;
const SALIENCE_MULTIPLIER = 50;
const DEFAULT_SHIELD_DECAY_RATE = 0.5;
const BASE_SHIELD_GAIN = 1.0;

// ─── Chart Colors ────────────────────────────────────────────

const COLORS = {
  weightLine: '#4a9eff',
  weightFill: 'rgba(74, 158, 255, 0.10)',
  shieldLine: '#6c5ce7',
  shieldFill: 'rgba(108, 92, 231, 0.15)',
  shieldActiveRegion: 'rgba(108, 92, 231, 0.06)',
  shieldInactiveRegion: 'rgba(255, 118, 117, 0.04)',
  reinforceMarker: '#00b894',
  reinforceMarkerDim: 'rgba(0, 184, 148, 0.25)',
  deadZone: 'rgba(225, 112, 85, 0.08)',
  gridLine: 'rgba(255, 255, 255, 0.06)',
  gridLineMinor: 'rgba(255, 255, 255, 0.03)',
  axisText: '#8b8b9e',
  cursor: '#fdcb6e',
  cursorLine: 'rgba(253, 203, 110, 0.4)',
  bg: '#1a1a2e',
  surface: '#16213e',
};

// ─── Simulation Types ────────────────────────────────────────

export interface DecaySimParams {
  /** Initial weight [0, 100] */
  initialWeight: number;
  /** Initial shield [0, shieldCap] */
  initialShield: number;
  /** Weight decay rate per event */
  decayRate: number;
  /** Shield decay rate per event */
  shieldDecayRate: number;
  /** Importance [0, 1] for shield cap */
  importance: number;
  /** Learning rate for reinforcements */
  learningRate: number;
  /** Total event range to simulate */
  totalEvents: number;
  /** Event indices where reinforcement occurs */
  reinforceEvents: number[];
}

interface SimPoint {
  event: number;
  weight: number;
  shield: number;
  shieldCap: number;
  effectiveWeight: number;
  effectiveShield: number;
  rawDecay: number;
  overflow: number;
  shieldActive: boolean;
  reinforced: boolean;
}

const DEFAULT_PARAMS: DecaySimParams = {
  initialWeight: 50,
  initialShield: 10,
  decayRate: 0.5,
  shieldDecayRate: DEFAULT_SHIELD_DECAY_RATE,
  importance: 0.5,
  learningRate: 0.1,
  totalEvents: 200,
  reinforceEvents: [30, 60, 100, 150],
};

// ─── Simulation Engine ───────────────────────────────────────

function runSimulation(params: DecaySimParams): SimPoint[] {
  const shieldCap = BASE_SHIELD_CAP + params.importance * SALIENCE_MULTIPLIER;
  const reinforceSet = new Set(params.reinforceEvents);
  const points: SimPoint[] = [];

  let weight = Math.min(params.initialWeight, WEIGHT_CAP);
  let shield = Math.min(params.initialShield, shieldCap);
  let lastActivatedAtEvent = 0;

  for (let ev = 0; ev <= params.totalEvents; ev++) {
    // Check if this event is a reinforcement
    const reinforced = reinforceSet.has(ev);

    if (reinforced) {
      // Reinforce: apply Hebbian learning w_new = w_old + lr * (WEIGHT_CAP - w_old)
      const delta = params.learningRate * (WEIGHT_CAP - weight);
      const newWeight = weight + delta;

      if (newWeight > WEIGHT_CAP) {
        const overflow = newWeight - WEIGHT_CAP;
        weight = WEIGHT_CAP;
        shield = Math.min(shieldCap, shield + overflow + BASE_SHIELD_GAIN);
      } else {
        weight = newWeight;
        // Still apply base shield gain on reinforcement
        shield = Math.min(shieldCap, shield + BASE_SHIELD_GAIN);
      }
      lastActivatedAtEvent = ev;
    }

    // Compute effective values via lazy decay
    const gap = ev - lastActivatedAtEvent;
    const effectiveShield = Math.max(0, shield - gap * params.shieldDecayRate);
    const rawDecay = gap * params.decayRate;
    const overflow = Math.max(0, rawDecay - effectiveShield);
    const effectiveWeight = Math.max(0, weight - overflow);
    const shieldActive = effectiveShield > 0;

    points.push({
      event: ev,
      weight,
      shield,
      shieldCap,
      effectiveWeight,
      effectiveShield,
      rawDecay,
      overflow,
      shieldActive,
      reinforced,
    });
  }

  return points;
}

// ─── Canvas Chart Renderer ───────────────────────────────────

interface ChartDimensions {
  width: number;
  height: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  plotWidth: number;
  plotHeight: number;
}

function getDimensions(canvas: HTMLCanvasElement): ChartDimensions {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = rect.width * dpr;
  const height = rect.height * dpr;
  const paddingTop = 24 * dpr;
  const paddingRight = 16 * dpr;
  const paddingBottom = 36 * dpr;
  const paddingLeft = 48 * dpr;

  return {
    width, height,
    paddingTop, paddingRight, paddingBottom, paddingLeft,
    plotWidth: width - paddingLeft - paddingRight,
    plotHeight: height - paddingTop - paddingBottom,
  };
}

function xScale(event: number, totalEvents: number, dim: ChartDimensions): number {
  return dim.paddingLeft + (event / totalEvents) * dim.plotWidth;
}

function yScale(value: number, maxY: number, dim: ChartDimensions): number {
  return dim.paddingTop + dim.plotHeight - (value / maxY) * dim.plotHeight;
}

function renderChart(
  canvas: HTMLCanvasElement,
  points: SimPoint[],
  params: DecaySimParams,
  cursorEvent: number | null,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  const pt = 24, pr = 16, pb = 36, pl = 48;
  const pw = w - pl - pr;
  const ph = h - pt - pb;
  const maxY = WEIGHT_CAP;
  const totalEv = params.totalEvents;

  const sx = (ev: number) => pl + (ev / totalEv) * pw;
  const sy = (val: number) => pt + ph - (val / maxY) * ph;

  // Background
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);

  // ── Shield active/inactive background regions ──
  let regionStart = 0;
  let regionActive = points[0]?.shieldActive ?? false;

  for (let i = 1; i <= points.length; i++) {
    const active = i < points.length ? points[i].shieldActive : !regionActive;
    if (active !== regionActive || i === points.length) {
      const x0 = sx(regionStart);
      const x1 = sx(Math.min(i, totalEv));
      ctx.fillStyle = regionActive ? COLORS.shieldActiveRegion : COLORS.shieldInactiveRegion;
      ctx.fillRect(x0, pt, x1 - x0, ph);
      regionStart = i;
      regionActive = active;
    }
  }

  // ── Grid lines ──
  ctx.strokeStyle = COLORS.gridLine;
  ctx.lineWidth = 0.5;
  ctx.setLineDash([]);

  // Y-axis grid
  for (let v = 0; v <= maxY; v += 20) {
    const y = sy(v);
    ctx.beginPath();
    ctx.moveTo(pl, y);
    ctx.lineTo(w - pr, y);
    ctx.stroke();
  }

  // X-axis grid
  const evStep = totalEv <= 100 ? 10 : totalEv <= 500 ? 50 : 100;
  for (let ev = 0; ev <= totalEv; ev += evStep) {
    const x = sx(ev);
    ctx.beginPath();
    ctx.moveTo(x, pt);
    ctx.lineTo(x, pt + ph);
    ctx.stroke();
  }

  // ── Axis labels ──
  ctx.fillStyle = COLORS.axisText;
  ctx.font = '10px monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = 0; v <= maxY; v += 20) {
    ctx.fillText(String(v), pl - 4, sy(v));
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let ev = 0; ev <= totalEv; ev += evStep) {
    ctx.fillText(String(ev), sx(ev), pt + ph + 4);
  }

  // ── Shield filled area ──
  ctx.beginPath();
  ctx.moveTo(sx(0), sy(0));
  for (const p of points) {
    ctx.lineTo(sx(p.event), sy(p.effectiveShield));
  }
  ctx.lineTo(sx(totalEv), sy(0));
  ctx.closePath();
  ctx.fillStyle = COLORS.shieldFill;
  ctx.fill();

  // Shield line
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const x = sx(points[i].event);
    const y = sy(points[i].effectiveShield);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = COLORS.shieldLine;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 2]);
  ctx.stroke();
  ctx.setLineDash([]);

  // ── Weight filled area ──
  ctx.beginPath();
  ctx.moveTo(sx(0), sy(0));
  for (const p of points) {
    ctx.lineTo(sx(p.event), sy(p.effectiveWeight));
  }
  ctx.lineTo(sx(totalEv), sy(0));
  ctx.closePath();
  ctx.fillStyle = COLORS.weightFill;
  ctx.fill();

  // Weight line
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const x = sx(points[i].event);
    const y = sy(points[i].effectiveWeight);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = COLORS.weightLine;
  ctx.lineWidth = 2;
  ctx.stroke();

  // ── Reinforcement markers ──
  for (const p of points) {
    if (!p.reinforced) continue;
    const x = sx(p.event);
    // Vertical line
    ctx.beginPath();
    ctx.moveTo(x, pt);
    ctx.lineTo(x, pt + ph);
    ctx.strokeStyle = COLORS.reinforceMarkerDim;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Triangle marker at top
    ctx.beginPath();
    ctx.moveTo(x - 4, pt + 2);
    ctx.lineTo(x + 4, pt + 2);
    ctx.lineTo(x, pt + 10);
    ctx.closePath();
    ctx.fillStyle = COLORS.reinforceMarker;
    ctx.fill();
  }

  // ── Cursor line ──
  if (cursorEvent != null && cursorEvent >= 0 && cursorEvent <= totalEv) {
    const cx = sx(cursorEvent);
    ctx.beginPath();
    ctx.moveTo(cx, pt);
    ctx.lineTo(cx, pt + ph);
    ctx.strokeStyle = COLORS.cursorLine;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Cursor dot on weight line
    const cp = points[Math.min(cursorEvent, points.length - 1)];
    if (cp) {
      // Weight dot
      ctx.beginPath();
      ctx.arc(cx, sy(cp.effectiveWeight), 4, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.weightLine;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Shield dot
      ctx.beginPath();
      ctx.arc(cx, sy(cp.effectiveShield), 3, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.shieldLine;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // ── Axis titles ──
  ctx.fillStyle = COLORS.axisText;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Event', pl + pw / 2, h - 4);

  ctx.save();
  ctx.translate(10, pt + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Value', 0, 0);
  ctx.restore();
}

// ─── Parameter Input Row ─────────────────────────────────────

interface ParamRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  unit?: string;
  description?: string;
}

function ParamRow({ label, value, min, max, step, onChange, unit, description }: ParamRowProps) {
  return (
    <div className="decay-sim-param-row" title={description}>
      <label className="decay-sim-param-label">{label}</label>
      <input
        type="range"
        className="decay-sim-param-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <span className="decay-sim-param-value">
        {value.toFixed(step < 1 ? (step < 0.01 ? 3 : 2) : 0)}
        {unit && <span className="decay-sim-param-unit">{unit}</span>}
      </span>
    </div>
  );
}

// ─── Tooltip Component ───────────────────────────────────────

interface TooltipData {
  x: number;
  y: number;
  point: SimPoint;
}

function ChartTooltip({ data }: { data: TooltipData }) {
  const { point: p } = data;
  return (
    <div
      className="decay-sim-tooltip"
      style={{
        left: `${data.x}px`,
        top: `${data.y}px`,
      }}
    >
      <div className="decay-sim-tooltip-header">Event #{p.event}</div>
      <div className="decay-sim-tooltip-row">
        <span className="decay-sim-tooltip-dot" style={{ background: COLORS.weightLine }} />
        <span>Weight: <b>{p.effectiveWeight.toFixed(2)}</b></span>
      </div>
      <div className="decay-sim-tooltip-row">
        <span className="decay-sim-tooltip-dot" style={{ background: COLORS.shieldLine }} />
        <span>Shield: <b>{p.effectiveShield.toFixed(2)}</b></span>
      </div>
      <div className="decay-sim-tooltip-row decay-sim-tooltip-sub">
        Raw Decay: {p.rawDecay.toFixed(2)} | Overflow: {p.overflow.toFixed(2)}
      </div>
      {p.reinforced && (
        <div className="decay-sim-tooltip-row" style={{ color: COLORS.reinforceMarker }}>
          ⚡ Reinforced at this event
        </div>
      )}
      {!p.shieldActive && (
        <div className="decay-sim-tooltip-row" style={{ color: '#e17055' }}>
          🛡 Shield depleted
        </div>
      )}
    </div>
  );
}

// ─── Reinforce Events Editor ─────────────────────────────────

interface ReinforceEditorProps {
  events: number[];
  totalEvents: number;
  onChange: (events: number[]) => void;
}

function ReinforceEditor({ events, totalEvents, onChange }: ReinforceEditorProps) {
  const [inputValue, setInputValue] = useState('');

  const handleAdd = () => {
    const num = parseInt(inputValue, 10);
    if (!isNaN(num) && num >= 0 && num <= totalEvents && !events.includes(num)) {
      onChange([...events, num].sort((a, b) => a - b));
      setInputValue('');
    }
  };

  const handleRemove = (ev: number) => {
    onChange(events.filter((e) => e !== ev));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <div className="decay-sim-reinforce-editor">
      <label className="decay-sim-param-label">Reinforce Events (강화 이벤트)</label>
      <div className="decay-sim-reinforce-input-row">
        <input
          type="number"
          className="decay-sim-reinforce-input"
          placeholder="Event #"
          min={0}
          max={totalEvents}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button className="decay-sim-reinforce-add" onClick={handleAdd}>+</button>
      </div>
      <div className="decay-sim-reinforce-tags">
        {events.map((ev) => (
          <span key={ev} className="decay-sim-reinforce-tag">
            #{ev}
            <button className="decay-sim-reinforce-remove" onClick={() => handleRemove(ev)}>×</button>
          </span>
        ))}
        {events.length === 0 && (
          <span className="decay-sim-reinforce-empty">No reinforcement events (강화 없음)</span>
        )}
      </div>
    </div>
  );
}

// ─── Legend ───────────────────────────────────────────────────

function ChartLegend() {
  return (
    <div className="decay-sim-legend">
      <span className="decay-sim-legend-item">
        <span className="decay-sim-legend-line" style={{ background: COLORS.weightLine }} />
        Weight (가중치)
      </span>
      <span className="decay-sim-legend-item">
        <span className="decay-sim-legend-line decay-sim-legend-dashed" style={{ background: COLORS.shieldLine }} />
        Shield (방패)
      </span>
      <span className="decay-sim-legend-item">
        <span className="decay-sim-legend-marker" style={{ background: COLORS.reinforceMarker }} />
        Reinforce (강화)
      </span>
      <span className="decay-sim-legend-item">
        <span className="decay-sim-legend-region" style={{ background: COLORS.shieldActiveRegion, borderColor: COLORS.shieldLine }} />
        Shield Active
      </span>
      <span className="decay-sim-legend-item">
        <span className="decay-sim-legend-region" style={{ background: COLORS.shieldInactiveRegion, borderColor: '#e17055' }} />
        Shield Depleted
      </span>
    </div>
  );
}

// ─── Stats Summary ───────────────────────────────────────────

function StatsSummary({ points, params }: { points: SimPoint[]; params: DecaySimParams }) {
  const shieldCap = BASE_SHIELD_CAP + params.importance * SALIENCE_MULTIPLIER;
  const last = points[points.length - 1];
  const minWeight = Math.min(...points.map((p) => p.effectiveWeight));
  const maxWeight = Math.max(...points.map((p) => p.effectiveWeight));
  const shieldDepleted = points.findIndex((p) => !p.shieldActive && p.event > 0);
  const deathEvent = points.findIndex((p) => p.effectiveWeight <= 0 && p.event > 0);
  const shieldActiveCount = points.filter((p) => p.shieldActive).length;
  const shieldActiveRatio = points.length > 0 ? shieldActiveCount / points.length : 0;

  return (
    <div className="decay-sim-stats">
      <div className="decay-sim-stat">
        <span className="decay-sim-stat-label">Final Weight</span>
        <span className="decay-sim-stat-value" style={{ color: COLORS.weightLine }}>
          {last?.effectiveWeight.toFixed(2) ?? '—'}
        </span>
      </div>
      <div className="decay-sim-stat">
        <span className="decay-sim-stat-label">Final Shield</span>
        <span className="decay-sim-stat-value" style={{ color: COLORS.shieldLine }}>
          {last?.effectiveShield.toFixed(2) ?? '—'}
        </span>
      </div>
      <div className="decay-sim-stat">
        <span className="decay-sim-stat-label">Shield Cap</span>
        <span className="decay-sim-stat-value">{shieldCap.toFixed(0)}</span>
      </div>
      <div className="decay-sim-stat">
        <span className="decay-sim-stat-label">Weight Range</span>
        <span className="decay-sim-stat-value">{minWeight.toFixed(1)} — {maxWeight.toFixed(1)}</span>
      </div>
      <div className="decay-sim-stat">
        <span className="decay-sim-stat-label">Shield Active</span>
        <span className="decay-sim-stat-value">{(shieldActiveRatio * 100).toFixed(0)}%</span>
      </div>
      <div className="decay-sim-stat">
        <span className="decay-sim-stat-label">First Shield Depletion</span>
        <span className="decay-sim-stat-value" style={{ color: shieldDepleted > 0 ? '#e17055' : '#00b894' }}>
          {shieldDepleted > 0 ? `Event #${shieldDepleted}` : 'Never'}
        </span>
      </div>
      <div className="decay-sim-stat">
        <span className="decay-sim-stat-label">Death Event</span>
        <span className="decay-sim-stat-value" style={{ color: deathEvent > 0 ? '#e17055' : '#00b894' }}>
          {deathEvent > 0 ? `Event #${deathEvent}` : 'Survived'}
        </span>
      </div>
    </div>
  );
}

// ─── Presets ─────────────────────────────────────────────────

interface Preset {
  name: string;
  nameKo: string;
  params: Partial<DecaySimParams>;
}

const PRESETS: Preset[] = [
  {
    name: 'Default',
    nameKo: '기본',
    params: DEFAULT_PARAMS,
  },
  {
    name: 'High Shield',
    nameKo: '강한 방패',
    params: { initialWeight: 80, initialShield: 40, importance: 0.9, decayRate: 0.3, reinforceEvents: [50, 100] },
  },
  {
    name: 'Fast Decay',
    nameKo: '빠른 소멸',
    params: { initialWeight: 60, initialShield: 5, decayRate: 1.0, shieldDecayRate: 1.0, importance: 0.2, reinforceEvents: [] },
  },
  {
    name: 'Frequent Reinforce',
    nameKo: '빈번한 강화',
    params: {
      initialWeight: 30, initialShield: 0, decayRate: 0.5,
      reinforceEvents: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 120, 140, 160, 180],
    },
  },
  {
    name: 'Immortal',
    nameKo: '불멸',
    params: { initialWeight: 100, initialShield: 50, importance: 1.0, decayRate: 0.01, reinforceEvents: [50, 100, 150] },
  },
];

// ─── Main Component ──────────────────────────────────────────

export interface DecaySimulationChartProps {
  /** Pre-fill params from an edge's actual values */
  initialParams?: Partial<DecaySimParams>;
  /** Compact mode (smaller height, no param controls) */
  compact?: boolean;
  /** CSS class */
  className?: string;
}

export function DecaySimulationChart({
  initialParams,
  compact = false,
  className,
}: DecaySimulationChartProps) {
  // Params state
  const [params, setParams] = useState<DecaySimParams>(() => ({
    ...DEFAULT_PARAMS,
    ...initialParams,
  }));

  const [cursorEvent, setCursorEvent] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [showParams, setShowParams] = useState(!compact);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Run simulation
  const points = useMemo(() => runSimulation(params), [params]);

  // Update param helper
  const updateParam = useCallback(<K extends keyof DecaySimParams>(key: K, value: DecaySimParams[K]) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  }, []);

  // Apply preset
  const applyPreset = useCallback((preset: Preset) => {
    setParams({ ...DEFAULT_PARAMS, ...preset.params });
    setCursorEvent(null);
    setTooltip(null);
  }, []);

  // Render canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderChart(canvas, points, params, cursorEvent);
  }, [points, params, cursorEvent]);

  // Resize observer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const observer = new ResizeObserver(() => {
      renderChart(canvas, points, params, cursorEvent);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [points, params, cursorEvent]);

  // Mouse move → cursor + tooltip
  const handleCanvasMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pl = 48, pr = 16;
      const pw = rect.width - pl - pr;

      if (x < pl || x > rect.width - pr) {
        setCursorEvent(null);
        setTooltip(null);
        return;
      }

      const ratio = (x - pl) / pw;
      const ev = Math.round(ratio * params.totalEvents);
      const clampedEv = Math.max(0, Math.min(params.totalEvents, ev));
      setCursorEvent(clampedEv);

      const point = points[clampedEv];
      if (point) {
        // Position tooltip to the right of cursor, flip if near edge
        const tooltipX = x > rect.width * 0.7 ? x - 180 : x + 12;
        const tooltipY = Math.max(0, e.clientY - rect.top - 40);
        setTooltip({ x: tooltipX, y: tooltipY, point });
      }
    },
    [params.totalEvents, points],
  );

  const handleCanvasMouseLeave = useCallback(() => {
    setCursorEvent(null);
    setTooltip(null);
  }, []);

  // Slider cursor event
  const cursorPoint = cursorEvent != null ? points[Math.min(cursorEvent, points.length - 1)] : null;

  return (
    <div className={`decay-sim-chart ${compact ? 'decay-sim-compact' : ''} ${className ?? ''}`} ref={containerRef}>
      {/* ── Header ── */}
      <div className="decay-sim-header">
        <h4 className="decay-sim-title">
          <span className="decay-sim-title-icon">📉</span>
          Decay Simulation (감쇠 시뮬레이션)
        </h4>
        {!compact && (
          <button
            className="decay-sim-toggle-params"
            onClick={() => setShowParams(!showParams)}
          >
            {showParams ? '▲ Hide Params' : '▼ Show Params'}
          </button>
        )}
      </div>

      {/* ── Presets ── */}
      {showParams && (
        <div className="decay-sim-presets">
          {PRESETS.map((preset) => (
            <button
              key={preset.name}
              className="decay-sim-preset-btn"
              onClick={() => applyPreset(preset)}
              title={preset.name}
            >
              {preset.nameKo}
            </button>
          ))}
        </div>
      )}

      {/* ── Parameter Controls ── */}
      {showParams && (
        <div className="decay-sim-params">
          <div className="decay-sim-params-grid">
            <ParamRow
              label="Initial Weight (초기 가중치)"
              value={params.initialWeight}
              min={0} max={WEIGHT_CAP} step={1}
              onChange={(v) => updateParam('initialWeight', v)}
              description="Edge weight at creation"
            />
            <ParamRow
              label="Initial Shield (초기 방패)"
              value={params.initialShield}
              min={0} max={BASE_SHIELD_CAP + SALIENCE_MULTIPLIER} step={1}
              onChange={(v) => updateParam('initialShield', v)}
              description="Shield value at creation"
            />
            <ParamRow
              label="Decay Rate (감쇠율)"
              value={params.decayRate}
              min={0} max={2} step={0.01}
              onChange={(v) => updateParam('decayRate', v)}
              unit="/ev"
              description="Weight decay per event gap"
            />
            <ParamRow
              label="Shield Decay (방패 감쇠)"
              value={params.shieldDecayRate}
              min={0} max={2} step={0.01}
              onChange={(v) => updateParam('shieldDecayRate', v)}
              unit="/ev"
              description="Shield decay per event gap"
            />
            <ParamRow
              label="Importance (중요도)"
              value={params.importance}
              min={0} max={1} step={0.01}
              onChange={(v) => updateParam('importance', v)}
              description="Node importance [0,1] — affects shield cap"
            />
            <ParamRow
              label="Learning Rate (학습률)"
              value={params.learningRate}
              min={0.01} max={1} step={0.01}
              onChange={(v) => updateParam('learningRate', v)}
              description="Hebbian reinforcement rate"
            />
            <ParamRow
              label="Total Events (총 이벤트)"
              value={params.totalEvents}
              min={10} max={1000} step={10}
              onChange={(v) => updateParam('totalEvents', v)}
              description="Event range to simulate"
            />
          </div>
          <ReinforceEditor
            events={params.reinforceEvents}
            totalEvents={params.totalEvents}
            onChange={(events) => updateParam('reinforceEvents', events)}
          />
        </div>
      )}

      {/* ── Legend ── */}
      <ChartLegend />

      {/* ── Canvas Chart ── */}
      <div className="decay-sim-canvas-container">
        <canvas
          ref={canvasRef}
          className="decay-sim-canvas"
          onMouseMove={handleCanvasMouseMove}
          onMouseLeave={handleCanvasMouseLeave}
        />
        {tooltip && <ChartTooltip data={tooltip} />}
      </div>

      {/* ── Timeline Slider ── */}
      <div className="decay-sim-slider-section">
        <label className="decay-sim-slider-label">
          Timeline (타임라인): Event #{cursorEvent ?? 0}
        </label>
        <input
          type="range"
          className="decay-sim-slider"
          min={0}
          max={params.totalEvents}
          step={1}
          value={cursorEvent ?? 0}
          onChange={(e) => setCursorEvent(parseInt(e.target.value, 10))}
        />
        {cursorPoint && (
          <div className="decay-sim-slider-values">
            <span style={{ color: COLORS.weightLine }}>
              W: {cursorPoint.effectiveWeight.toFixed(2)}
            </span>
            <span style={{ color: COLORS.shieldLine }}>
              S: {cursorPoint.effectiveShield.toFixed(2)}
            </span>
            <span style={{ color: cursorPoint.shieldActive ? '#00b894' : '#e17055' }}>
              🛡 {cursorPoint.shieldActive ? 'Active' : 'Depleted'}
            </span>
            {cursorPoint.reinforced && (
              <span style={{ color: COLORS.reinforceMarker }}>⚡ Reinforced</span>
            )}
          </div>
        )}
      </div>

      {/* ── Stats ── */}
      {!compact && <StatsSummary points={points} params={params} />}
    </div>
  );
}

export default DecaySimulationChart;

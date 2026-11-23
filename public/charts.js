import { t as translateText, tr as translateTemplate } from './js/i18n.js';
import { setElementStyle } from './js/dynamic-style.js';
const weekdays = [translateText('周日'), translateText('周一'), translateText('周二'), translateText('周三'), translateText('周四'), translateText('周五'), translateText('周六')];

function themeColors() {
  const styles = getComputedStyle(document.documentElement);
  const read = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  return {
    grid: read('--chart-grid', 'rgba(148,163,184,0.09)'),
    baseline: read('--chart-baseline', 'rgba(148,163,184,0.22)'),
    axis: read('--chart-axis', '#7a869e'),
    track: read('--chart-track', 'rgba(255,255,255,0.07)'),
    highlight: read('--chart-highlight', 'rgba(125,211,252,0.08)'),
    crosshair: read('--chart-crosshair', 'rgba(125,211,252,0.55)'),
    avg: read('--chart-avg', 'rgba(94,234,212,0.45)'),
    surface: read('--surface-solid', '#0c0e15'),
    accent: read('--c-codex', '#2dd4bf'),
    accent2: read('--c-input', '#38bdf8'),
    isLight: document.documentElement.dataset.theme === 'light',
  };
}

function hexToRgba(color, alpha) {
  const hex = color.replace('#', '').trim();
  if (hex.length === 6) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

function beginCanvas(canvas) {
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return null;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  const context = canvas.getContext('2d');
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, pixelWidth, pixelHeight);
  context.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
  return { context, width, height };
}

function ceiling(value, minimum) {
  if (value < minimum) return minimum;
  const unit = 10 ** Math.floor(Math.log10(value));
  const factor = [1, 2, 2.5, 5, 10].find((candidate) => candidate * unit >= value) ?? 10;
  return factor * unit;
}

function shortDateWithDay(date) {
  const day = weekdays[new Date(`${date}T00:00:00Z`).getUTCDay()];
  return translateTemplate`${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日 · ${day}`;
}

function traceSmoothCurve(ctx, points) {
  if (!points.length) return;
  ctx.moveTo(points[0].x, points[0].y);
  if (points.length === 1) return;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const midX = (p0.x + p1.x) / 2;
    ctx.bezierCurveTo(midX, p0.y, midX, p1.y, p1.x, p1.y);
  }
}

/* Hero Momentum Sparkline */
export function createSparkline(canvas) {
  let values = [];
  function draw() {
    if (!canvas) return;
    const frame = beginCanvas(canvas);
    if (!frame) return;
    const { context, width, height } = frame;
    if (values.length < 2) return;
    const colors = themeColors();
    const max = Math.max(...values, 1);
    const padX = 5;
    const padY = 6;
    const pts = values.map((v, i) => ({
      x: padX + (i / (values.length - 1)) * (width - padX * 2),
      y: height - padY - (v / max) * (height - padY * 2),
    }));

    // Gradient area
    context.beginPath();
    traceSmoothCurve(context, pts);
    context.lineTo(pts.at(-1).x, height);
    context.lineTo(pts[0].x, height);
    context.closePath();
    const areaGrad = context.createLinearGradient(0, 0, 0, height);
    areaGrad.addColorStop(0, hexToRgba(colors.accent, 0.34));
    areaGrad.addColorStop(1, hexToRgba(colors.accent, 0.0));
    context.fillStyle = areaGrad;
    context.fill();

    // Glowing line
    const lineGrad = context.createLinearGradient(0, 0, width, 0);
    lineGrad.addColorStop(0, colors.accent2);
    lineGrad.addColorStop(1, colors.accent);
    context.beginPath();
    traceSmoothCurve(context, pts);
    context.strokeStyle = lineGrad;
    context.lineWidth = 2;
    if (!colors.isLight) {
      context.shadowColor = colors.accent;
      context.shadowBlur = 10;
    }
    context.stroke();
    context.shadowBlur = 0;

    // Glowing end node
    const last = pts.at(-1);
    context.beginPath();
    context.arc(last.x, last.y, 4.5, 0, Math.PI * 2);
    context.fillStyle = hexToRgba(colors.accent, 0.3);
    context.fill();
    context.beginPath();
    context.arc(last.x, last.y, 2.5, 0, Math.PI * 2);
    context.fillStyle = colors.accent;
    context.fill();
  }
  if (canvas) new ResizeObserver(draw).observe(canvas);
  return (nextValues) => { values = nextValues; draw(); };
}

export function createTrend(canvas, tooltip, { compact, full, money, percent, onDate }) {
  let buckets = [];
  let series = [];
  let chartStyle = 'area';
  let metric = 'token';
  let geometry;
  let selected = -1;
  const isCost = () => metric === 'cost';
  const hasUsage = (bucket) => isCost() ? bucket.records > 0 : bucket.total > 0;
  const formatAxis = (value) => isCost() ? money(value) : compact(value);
  const formatValue = (value) => isCost() ? money(value) : full(value);

  function draw() {
    const frame = beginCanvas(canvas);
    if (!frame) return;
    const { context, width, height } = frame;
    const colors = themeColors();
    const right = 12;
    const top = 22;
    const bottom = height - 28;
    const plotHeight = bottom - top;
    const maxTotal = chartStyle === 'line'
      ? Math.max(...buckets.flatMap((b) => series.map((s) => b.values[s.id] || 0)), 0)
      : Math.max(...buckets.map((bucket) => bucket.total), 0);
    context.font = '10.5px "Inter", system-ui, sans-serif';
    const max = ceiling(maxTotal, isCost() && maxTotal > 0 ? 0.000004 : 4);
    const labels = Array.from({ length: 5 }, (_, index) => formatAxis(max * (4 - index) / 4));
    const left = Math.max(48, Math.ceil(Math.max(...labels.map((label) => context.measureText(label).width))) + 12);
    const span = width - left - right;
    const slot = span / (buckets.length || 1);
    geometry = { left, right, top, bottom, slot, max };

    context.textBaseline = 'middle';
    context.textAlign = 'right';

    // Gridlines & Y-axis
    for (let index = 0; index <= 4; index++) {
      const y = Math.round(top + plotHeight * index / 4) + 0.5;
      context.beginPath();
      context.moveTo(left, y);
      context.lineTo(width - right, y);
      context.lineWidth = 1;
      context.strokeStyle = index === 4 ? colors.baseline : colors.grid;
      context.setLineDash(index === 4 ? [] : [2, 4]);
      context.stroke();
      context.fillStyle = colors.axis;
      context.fillText(labels[index], left - 10, y);
    }
    context.setLineDash([]);

    if (buckets.length > 0 && maxTotal > 0) {
      if (chartStyle === 'area') {
        drawAreaChart(context, { left, top, bottom, plotHeight, slot, max, colors });
      } else if (chartStyle === 'line') {
        drawLineChart(context, { left, top, bottom, plotHeight, slot, max, colors });
      } else {
        drawBarChart(context, { left, top, bottom, plotHeight, slot, max, colors });
      }
    }

    // Daily average reference line (bar/area)
    const activeDays = buckets.filter((bucket) => bucket.total > 0);
    if (chartStyle !== 'line' && activeDays.length >= 2 && maxTotal > 0) {
      const avg = buckets.reduce((sum, bucket) => sum + bucket.total, 0) / buckets.length;
      const avgY = bottom - (avg / max) * plotHeight;
      if (avgY > top + 8 && avgY < bottom - 8) {
        context.save();
        context.beginPath();
        context.moveTo(left, avgY);
        context.lineTo(width - right, avgY);
        context.lineWidth = 1;
        context.strokeStyle = colors.avg;
        context.setLineDash([4, 4]);
        context.stroke();
        context.setLineDash([]);
        context.restore();
      }
    }

    // Peak Callout Pin (when not hovering)
    if (selected < 0 && maxTotal > 0 && buckets.length > 2 && chartStyle !== 'line') {
      let peakIdx = 0;
      for (let i = 1; i < buckets.length; i++) {
        if (buckets[i].total > buckets[peakIdx].total) peakIdx = i;
      }
      const peakVal = buckets[peakIdx].total;
      const px = left + (peakIdx + 0.5) * slot;
      const py = bottom - (peakVal / max) * plotHeight;
      const label = translateTemplate`峰值 ${formatAxis(peakVal)}`;
      context.save();
      context.font = '600 10px "Inter", system-ui, sans-serif';
      const tw = context.measureText(label).width + 12;
      const lx = Math.max(left + 4, Math.min(width - right - tw, px - tw / 2));
      const ly = Math.max(2, py - 22);
      context.fillStyle = colors.isLight ? 'rgba(15,23,42,0.85)' : 'rgba(15,23,42,0.88)';
      context.strokeStyle = colors.avg;
      context.lineWidth = 1;
      context.beginPath();
      context.roundRect(lx, ly, tw, 17, 9);
      context.fill();
      context.stroke();
      context.fillStyle = '#f8fafc';
      context.textAlign = 'center';
      context.fillText(label, lx + tw / 2, ly + 9);
      context.restore();
    }

    // X-axis ticks
    if (buckets.length) {
      const tickCount = Math.min(buckets.length, Math.max(2, Math.floor(span / 82)));
      context.textAlign = 'center';
      context.fillStyle = colors.axis;
      for (let tick = 0; tick < tickCount; tick++) {
        const index = tickCount < 2 ? 0 : Math.round(tick * (buckets.length - 1) / (tickCount - 1));
        const date = buckets[index].date;
        const label = `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
        const x = Math.max(left + 12, Math.min(width - 14, left + (index + 0.5) * slot));
        context.fillText(label, x, bottom + 16);
      }
    }
  }

  function drawBarChart(context, { left, top, bottom, plotHeight, slot, max, colors }) {
    if (selected >= 0 && buckets[selected]) {
      const colX = left + selected * slot;
      const colGrad = context.createLinearGradient(0, top, 0, bottom);
      colGrad.addColorStop(0, 'transparent');
      colGrad.addColorStop(0.5, colors.highlight);
      colGrad.addColorStop(1, colors.highlight);
      context.fillStyle = colGrad;
      context.beginPath();
      context.roundRect(colX + 1, top, Math.max(2, slot - 2), plotHeight, 7);
      context.fill();
    }

    const barWidth = Math.min(26, Math.max(1.8, slot * 0.62));
    const segGap = barWidth > 5 ? 1.5 : 0;

    buckets.forEach((bucket, index) => {
      const x = left + (index + 0.5) * slot;
      let y = bottom;
      const activeSegments = series.filter((item) => (bucket.values[item.id] || 0) > 0);
      const isSelected = selected === index;
      const isDimmed = selected >= 0 && !isSelected;

      context.save();
      if (isDimmed) context.globalAlpha = 0.25;

      for (const [segIdx, item] of activeSegments.entries()) {
        const rawHeight = (bucket.values[item.id] / max) * plotHeight;
        const gap = segIdx > 0 && rawHeight > segGap + 1 ? segGap : 0;
        const drawHeight = Math.max(0, rawHeight - gap);
        if (drawHeight <= 0.2) continue;

        const isTop = segIdx === activeSegments.length - 1;
        const radius = isTop ? Math.min(barWidth / 2.4, drawHeight / 2, 5) : 0;
        const segTop = y - drawHeight - gap;

        const grad = context.createLinearGradient(0, segTop, 0, segTop + drawHeight);
        grad.addColorStop(0, item.color);
        grad.addColorStop(1, hexToRgba(item.color, colors.isLight ? 0.78 : 0.52));
        context.fillStyle = grad;

        if (isSelected && !colors.isLight) {
          context.shadowColor = item.color;
          context.shadowBlur = 18;
        }

        context.beginPath();
        context.roundRect(x - barWidth / 2, segTop, barWidth, drawHeight, [radius, radius, 0, 0]);
        context.fill();
        context.shadowBlur = 0;

        if (isTop && barWidth >= 6 && drawHeight >= 5) {
          context.fillStyle = colors.isLight ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.42)';
          context.beginPath();
          context.roundRect(x - barWidth / 2 + 1, segTop + 0.5, Math.max(1, barWidth - 2), 1.5, 1);
          context.fill();
        }

        y -= rawHeight;
      }
      context.restore();
    });
  }

  function drawCrosshairAndNodes(context, { left, top, bottom, slot, colors }, layers) {
    const activeIndex = buckets.length === 1 ? 0 : selected;
    if (activeIndex < 0 || !buckets[activeIndex]) return;
    const x = left + (activeIndex + 0.5) * slot;
    context.save();
    const beamGrad = context.createLinearGradient(0, top, 0, bottom);
    beamGrad.addColorStop(0, 'transparent');
    beamGrad.addColorStop(0.25, colors.crosshair);
    beamGrad.addColorStop(0.85, colors.crosshair);
    beamGrad.addColorStop(1, 'transparent');
    context.beginPath();
    context.moveTo(x, top);
    context.lineTo(x, bottom);
    context.lineWidth = 1.25;
    context.strokeStyle = beamGrad;
    context.stroke();

    for (const { item, topPts } of layers) {
      if ((buckets[activeIndex].values[item.id] || 0) <= 0) continue;
      const pt = topPts[activeIndex];
      context.beginPath();
      context.arc(pt.x, pt.y, 9, 0, Math.PI * 2);
      context.fillStyle = hexToRgba(item.color, 0.24);
      context.fill();
      context.beginPath();
      context.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2);
      context.fillStyle = colors.surface;
      context.fill();
      context.lineWidth = 2.4;
      context.strokeStyle = item.color;
      if (!colors.isLight) {
        context.shadowColor = item.color;
        context.shadowBlur = 12;
      }
      context.stroke();
      context.shadowBlur = 0;
    }
    context.restore();
  }

  function drawAreaChart(context, { left, top, bottom, plotHeight, slot, max, colors }) {
    const cumulative = buckets.map(() => 0);
    const layers = series.map((item) => {
      const topPts = [];
      const basePts = [];
      buckets.forEach((bucket, idx) => {
        const x = left + (idx + 0.5) * slot;
        const val = bucket.values[item.id] || 0;
        const prevCum = cumulative[idx];
        const nextCum = prevCum + val;
        cumulative[idx] = nextCum;
        basePts.push({ x, y: bottom - (prevCum / max) * plotHeight });
        topPts.push({ x, y: bottom - (nextCum / max) * plotHeight });
      });
      return { item, topPts, basePts };
    });

    for (const { item, topPts, basePts } of layers) {
      if (!topPts.length) continue;

      context.save();
      context.beginPath();
      traceSmoothCurve(context, topPts);
      const revBase = [...basePts].reverse();
      context.lineTo(revBase[0].x, revBase[0].y);
      for (let i = 0; i < revBase.length - 1; i++) {
        const p0 = revBase[i];
        const p1 = revBase[i + 1];
        const midX = (p0.x + p1.x) / 2;
        context.bezierCurveTo(midX, p0.y, midX, p1.y, p1.x, p1.y);
      }
      context.closePath();

      const grad = context.createLinearGradient(0, top, 0, bottom);
      grad.addColorStop(0, hexToRgba(item.color, colors.isLight ? 0.34 : 0.44));
      grad.addColorStop(0.65, hexToRgba(item.color, colors.isLight ? 0.08 : 0.14));
      grad.addColorStop(1, hexToRgba(item.color, 0.01));
      context.fillStyle = grad;
      context.fill();

      context.beginPath();
      traceSmoothCurve(context, topPts);
      context.strokeStyle = item.color;
      context.lineWidth = 2.2;
      if (!colors.isLight) {
        context.shadowColor = item.color;
        context.shadowBlur = 12;
      }
      context.stroke();
      context.restore();
    }

    drawCrosshairAndNodes(context, { left, top, bottom, slot, colors }, layers);
  }

  function drawLineChart(context, { left, top, bottom, plotHeight, slot, max, colors }) {
    const layers = series.map((item) => ({
      item,
      topPts: buckets.map((bucket, idx) => ({
        x: left + (idx + 0.5) * slot,
        y: bottom - ((bucket.values[item.id] || 0) / max) * plotHeight,
      })),
    }));

    for (const { item, topPts } of layers) {
      if (!topPts.length) continue;
      context.save();
      context.beginPath();
      traceSmoothCurve(context, topPts);
      context.strokeStyle = item.color;
      context.lineWidth = 2.4;
      if (!colors.isLight) {
        context.shadowColor = item.color;
        context.shadowBlur = 14;
      }
      context.stroke();
      context.restore();
    }

    drawCrosshairAndNodes(context, { left, top, bottom, slot, colors }, layers);
  }


  function hit(event) {
    if (!geometry || !series.length || !buckets.some(hasUsage)) return -1;
    const area = canvas.getBoundingClientRect();
    const { left, top, bottom, slot } = geometry;
    const x = event.clientX - area.left;
    const y = event.clientY - area.top;
    const index = Math.floor((x - left) / slot);
    return y >= top - 6 && y <= bottom + 4 && buckets[index] ? index : -1;
  }

  function showTooltip(index) {
    const bucket = buckets[index];
    if (!bucket) {
      tooltip.hidden = true;
      return;
    }

    const title = document.createElement('div');
    title.className = 'tt-title';
    title.textContent = shortDateWithDay(bucket.date);
    tooltip.replaceChildren(title);

    const active = series.filter((item) => (bucket.values[item.id] || 0) > 0);
    for (const item of active) {
      const value = bucket.values[item.id];
      const row = document.createElement('div');
      row.className = 'tt-row';

      const key = document.createElement('span');
      key.className = 'tt-key';
      const dot = document.createElement('i');
      dot.className = 'series-dot';
      setElementStyle(dot, { color: item.color });
      const name = document.createElement('span');
      name.textContent = item.name;
      key.append(dot, name);

      const num = document.createElement('span');
      num.className = 'tt-val';
      const pct = bucket.total ? Math.round((value / bucket.total) * 100) : 0;
      num.textContent = `${formatValue(value)}${active.length > 1 ? ` · ${pct}%` : ''}`;

      row.append(key, num);
      tooltip.append(row);
    }

    const totalRow = document.createElement('div');
    totalRow.className = 'tt-row tt-total';
    const totalKey = document.createElement('span');
    totalKey.textContent = translateText('总计');
    const totalVal = document.createElement('span');
    totalVal.className = 'tt-val';
    totalVal.textContent = isCost() && bucket.records > 0 && !bucket.pricedRecords ? '—' : formatValue(bucket.total);
    totalRow.append(totalKey, totalVal);
    tooltip.append(totalRow);

    if (isCost() && bucket.pricedRecords < bucket.records) {
      const note = document.createElement('div');
      note.className = 'tt-coverage';
      const coverage = bucket.totalTokens ? bucket.pricedTokens / bucket.totalTokens : bucket.pricedRecords / bucket.records;
      note.textContent = translateTemplate`计价覆盖 ${percent(Math.min(1, coverage))} · 含未计价记录`;
      tooltip.append(note);
    }

    if (hasUsage(bucket)) {
      const hint = document.createElement('div');
      hint.className = 'tt-hint';
      hint.textContent = translateText('点击查看当日明细 →');
      tooltip.append(hint);
    }

    tooltip.hidden = false;
    const anchor = geometry.left + (index + 0.5) * geometry.slot;
    const ttWidth = tooltip.offsetWidth;
    const canvasWidth = canvas.clientWidth;
    const placeRight = anchor + 16 + ttWidth <= canvasWidth;
    const leftPos = placeRight ? anchor + 16 : Math.max(4, anchor - 16 - ttWidth);
    setElementStyle(tooltip, { left: `${leftPos}px`, top: '8px' });
  }

  function select(index) {
    if (index === selected) return;
    selected = index;
    draw();
    showTooltip(index);
  }

  canvas.addEventListener('pointermove', (event) => select(hit(event)));
  canvas.addEventListener('pointerleave', () => select(-1));
  canvas.addEventListener('click', (event) => {
    const index = hit(event);
    if (index >= 0) onDate(buckets[index].date);
  });
  new ResizeObserver(() => {
    tooltip.hidden = true;
    selected = -1;
    draw();
  }).observe(canvas);

  return {
    update(data, nextSeries, style = 'area', nextMetric = 'token') {
      buckets = data;
      series = nextSeries;
      chartStyle = style;
      metric = nextMetric;
      selected = -1;
      tooltip.hidden = true;
      canvas.parentElement.classList.toggle('interactive', series.length > 0 && buckets.some(hasUsage));
      draw();
    },
    redraw() {
      draw();
    },
  };
}

export function createDonut(canvas, { onHover } = {}) {
  let parts = [];
  let arcs = [];
  let activeId = null;

  function draw() {
    const frame = beginCanvas(canvas);
    if (!frame) return;
    const { context, width, height } = frame;
    const colors = themeColors();
    const cx = width / 2;
    const cy = height / 2;
    const thickness = Math.max(11, width * 0.084);
    const baseRadius = (Math.min(width, height) - thickness - 22) * 0.46;
    const turn = Math.PI * 2;
    const start = -Math.PI / 2;
    const sum = parts.reduce((value, part) => value + part.total, 0);

    arcs = [];
    context.lineWidth = thickness;
    context.lineCap = 'round';

    context.beginPath();
    context.arc(cx, cy, baseRadius, 0, turn);
    context.strokeStyle = colors.track;
    context.stroke();
    if (!sum) return;

    const activeParts = parts.filter((part) => part.total > 0);
    let angle = start;
    const sweepTurn = turn;

    for (const part of activeParts) {
      const delta = (part.total / sum) * sweepTurn;
      const gap = activeParts.length > 1 ? Math.min(0.06, delta * 0.2) : 0;
      const segStart = angle + gap;
      const segEnd = angle + delta - gap;
      const isHovered = activeId === part.id;
      const isDimmed = activeId !== null && !isHovered;

      if (segEnd > segStart) {
        const radius = isHovered ? baseRadius + 5.5 : baseRadius;
        context.save();
        if (isDimmed) context.globalAlpha = 0.24;
        if (!colors.isLight) {
          context.shadowColor = part.color;
          context.shadowBlur = isHovered ? 24 : 10;
        }
        context.lineWidth = isHovered ? thickness + 3 : thickness;
        context.beginPath();
        context.arc(cx, cy, radius, segStart, segEnd);
        context.strokeStyle = part.color;
        context.stroke();
        context.restore();
      }

      arcs.push({ part, start: angle, end: angle + delta, cx, cy, inner: baseRadius - thickness * 0.9, outer: baseRadius + thickness * 0.9 + 8 });
      angle += delta;
    }
  }


  function hit(event) {
    if (!arcs.length) return null;
    const area = canvas.getBoundingClientRect();
    const x = event.clientX - area.left;
    const y = event.clientY - area.top;
    const { cx, cy, inner, outer } = arcs[0];
    const dist = Math.hypot(x - cx, y - cy);
    if (dist < inner || dist > outer) return null;
    let angle = Math.atan2(y - cy, x - cx);
    if (angle < -Math.PI / 2) angle += Math.PI * 2;
    return arcs.find((arc) => angle >= arc.start && angle <= arc.end)?.part ?? null;
  }

  canvas.addEventListener('pointermove', (event) => {
    const found = hit(event);
    const nextId = found?.id ?? null;
    if (nextId !== activeId) {
      activeId = nextId;
      draw();
      onHover?.(found);
    }
  });
  canvas.addEventListener('pointerleave', () => {
    if (activeId !== null) {
      activeId = null;
      draw();
      onHover?.(null);
    }
  });

  new ResizeObserver(draw).observe(canvas);

  return {
    update(data) {
      parts = data;
      activeId = null;
      const hasData = parts.some((part) => part.total > 0);
      canvas.parentElement.classList.toggle('interactive', hasData);
      draw();
    },
    setActive(id) {
      if (activeId === id) return;
      activeId = id;
      draw();
    },
    redraw() {
      draw();
    },
  };
}

import { t as translateText, tr as translateTemplate } from './i18n.js';
import { reportSummary } from './overview-data.js';
import { compact, displayDate, full, money, percent } from './state.js';

const width = 1200;
const height = 800;
const fontFamily = 'system-ui, "Noto Sans CJK SC", sans-serif';

function panel(context, x, y, w, h) {
  context.beginPath();
  context.roundRect(x, y, w, h, 18);
  context.fillStyle = '#111c30';
  context.strokeStyle = '#27364e';
  context.fill();
  context.stroke();
}

function text(context, value, x, y, { size = 20, weight = 500, color = '#eef4ff', align = 'left', maxWidth } = {}) {
  context.font = `${weight} ${size}px ${fontFamily}`;
  context.fillStyle = color;
  context.textAlign = align;
  if (maxWidth && context.measureText(value).width > maxWidth) {
    const characters = Array.from(value);
    while (context.measureText(characters.join('') + '…').width > maxWidth) characters.pop();
    value = `${characters.join('')}…`;
  }
  context.fillText(value, x, y);
}

function drawTrend(context, values, start, end) {
  panel(context, 52, 305, 568, 412);
  text(context, translateText('周期 Token 趋势'), 78, 352, { size: 23, weight: 650 });
  const plot = { x: 78, width: 516, top: 384, bottom: 638 };
  const max = Math.max(1, ...values);
  for (let index = 0; index < 5; index++) {
    const y = plot.top + (plot.bottom - plot.top) * index / 4;
    context.strokeStyle = '#263751';
    context.beginPath();
    context.moveTo(plot.x, y);
    context.lineTo(plot.x + plot.width, y);
    context.stroke();
  }
  const points = values.map((value, index) => ({
    x: plot.x + (values.length === 1 ? 0.5 : index / (values.length - 1)) * plot.width,
    y: plot.bottom - value / max * (plot.bottom - plot.top),
  }));
  function trace() {
    context.beginPath();
    for (const { x, y } of points) context.lineTo(x, y);
  }
  trace();
  context.lineTo(points.at(-1).x, plot.bottom);
  context.lineTo(points[0].x, plot.bottom);
  context.closePath();
  const area = context.createLinearGradient(0, plot.top, 0, plot.bottom);
  area.addColorStop(0, '#2dd4bf65');
  area.addColorStop(1, '#2dd4bf05');
  context.fillStyle = area;
  context.fill();
  trace();
  context.strokeStyle = '#68e7df';
  context.lineJoin = context.lineCap = 'round';
  context.lineWidth = 3;
  context.stroke();
  const last = points.at(-1);
  context.fillStyle = '#d9fffc';
  context.beginPath();
  context.arc(last.x, last.y, 4, 0, 2 * Math.PI);
  context.fill();
  context.lineWidth = 1;
  text(context, start, plot.x, 676, { size: 16, color: '#a7bad6' });
  text(context, end, plot.x + plot.width, 676, { size: 16, color: '#a7bad6', align: 'right' });
}

function drawRanking(context, title, ranks, tools, y, includeModels) {
  text(context, title, 670, y, { size: 23, weight: 650 });
  ranks.forEach((item, index) => {
    const row = y + 36 + index * 34;
    const tool = tools.get(item.provider);
    const label = includeModels ? item.name ?? translateText('模型未记录') : tool?.name ?? translateText('其他');
    context.fillStyle = tool?.color ?? '#94a3b8';
    context.beginPath();
    context.arc(675, row - 6, 4, 0, 2 * Math.PI);
    context.fill();
    text(context, label, 690, row, { size: 19, maxWidth: 342 });
    text(context, compact(item.total), 1122, row, { size: 18, weight: 650, align: 'right', color: '#bdeef5' });
  });
}

export async function exportReportCard({ start, end, entries, tools, demo }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Canvas 2D unavailable');
  const summary = reportSummary(entries, start, end);
  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, '#142842');
  background.addColorStop(0.65, '#0b1221');
  background.addColorStop(1, '#182536');
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  text(context, translateText('用量报告'), 52, 82, { size: 50, weight: 750 });
  text(context, `${displayDate(start)} – ${displayDate(end)}`, 54, 121, { size: 22, color: '#b5cae5' });
  text(context, demo ? translateText('示例数据') : 'TokenStat', 1148, 81, { size: 22, weight: 700, color: '#68e7df', align: 'right' });

  const metrics = [
    [translateText('总 Token'), full(summary.total), '', '#68e7df'],
    [translateText('估算费用'), summary.estimatedCost == null ? '—' : money.format(summary.estimatedCost),
      summary.total && summary.pricedTokens < summary.total ? translateTemplate`计价覆盖 ${percent.format(summary.pricedTokens / summary.total)}` : '', '#a5c4ff'],
    [translateText('净缓存节省'), summary.cacheSavings == null ? '—' : money.format(summary.cacheSavings), '', '#d6b5ff'],
  ];
  for (const [index, [label, value, detail, color]] of metrics.entries()) {
    const x = 52 + index * 372;
    panel(context, x, 150, 352, 130);
    text(context, label, x + 22, 184, { size: 18, weight: 650, color: '#b5cae5' });
    text(context, value, x + 22, 236, { size: 36, weight: 730, color, maxWidth: 308 });
    if (detail) text(context, detail, x + 22, 260, { size: 15, color: '#a7bad6' });
  }

  const toolMap = new Map(tools.map((tool) => [tool.id, tool]));
  drawTrend(context, summary.daily, start, end);
  panel(context, 644, 305, 504, 412);
  drawRanking(context, translateText('工具前三'), summary.tools, toolMap, 352, false);
  context.strokeStyle = '#27364e';
  context.beginPath();
  context.moveTo(670, 507);
  context.lineTo(1122, 507);
  context.stroke();
  drawRanking(context, translateText('模型前三'), summary.models, toolMap, 548, true);
  text(context, 'TokenStat', 1148, 754, { size: 17, weight: 700, color: '#a7bad6', align: 'right' });

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG encoding failed');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tokenstat-report-${start}_${end}.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
}

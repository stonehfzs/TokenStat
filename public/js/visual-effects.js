export function bindVisualEffects() {
  const root = document.documentElement;
  const canvas = document.getElementById('fx-canvas');
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const tiltCards = [...document.querySelectorAll('.hero-card')];
  const particles = Array.from({ length: 36 }, () => ({
    x: Math.random(), y: Math.random(), speed: 0.002 + Math.random() * 0.007,
    radius: 0.6 + Math.random() * 1.1, opacity: 0.08 + Math.random() * 0.2,
  }));
  let focus = document.hasFocus();
  let requested = root.dataset.visualEffects ?? 'full';
  let frame = 0;
  let last = 0;
  let width = 0;
  let height = 0;

  function resize() {
    if (canvas.hidden || !ctx) return;
    width = window.innerWidth;
    height = window.innerHeight;
    const scale = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
  }

  function draw(time) {
    const elapsed = last ? (time - last) / 1000 : 0;
    if (!last || elapsed >= 1 / 30) {
      last = time;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = root.dataset.theme === 'light' ? '#2563eb' : '#8dd8fc';
      for (const particle of particles) {
        particle.y = (particle.y + particle.speed * Math.min(elapsed, 0.05)) % 1;
        ctx.globalAlpha = particle.opacity;
        ctx.beginPath();
        ctx.arc(particle.x * width, particle.y * height, particle.radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    frame = requestAnimationFrame(draw);
  }

  function resetTilt(card) {
    delete card.dataset.tiltX;
    delete card.dataset.tiltY;
  }

  function update() {
    const full = requested === 'full' && !reduced.matches;
    root.dataset.visualEffects = full ? 'full' : 'lite';
    const animate = full && focus && !document.hidden;
    root.toggleAttribute('data-fx-paused', !animate);
    const show = Boolean(full && ctx);
    if (canvas.hidden === show) {
      canvas.hidden = !show;
      if (show) resize();
    }
    if (animate && ctx && !frame) frame = requestAnimationFrame(draw);
    else if (!animate) {
      cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
      for (const card of tiltCards) resetTilt(card);
    }
  }

  window.addEventListener('resize', resize);
  window.addEventListener('blur', () => { focus = false; update(); });
  window.addEventListener('focus', () => { focus = true; update(); });
  document.addEventListener('visibilitychange', update);
  reduced.addEventListener('change', update);
  for (const card of tiltCards) {
    card.addEventListener('pointerleave', () => resetTilt(card));
    card.addEventListener('pointermove', (event) => {
      if (root.hasAttribute('data-fx-paused') || event.pointerType !== 'mouse') return;
      const { left, top, width: cardWidth, height: cardHeight } = card.getBoundingClientRect();
      const x = (event.clientX - left) / cardWidth;
      const y = (event.clientY - top) / cardHeight;
      card.dataset.tiltX = x < 0.33 ? 'left' : x > 0.67 ? 'right' : '';
      card.dataset.tiltY = y < 0.33 ? 'top' : y > 0.67 ? 'bottom' : '';
    });
  }
  update();
  return (selected) => {
    const mode = selected === 'lite' ? 'lite' : 'full';
    if (requested === mode) return;
    requested = mode;
    update();
  };
}

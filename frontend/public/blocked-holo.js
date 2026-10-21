// Cyberpunk/hologram backdrop for the branded block page.
//
// External file (CSP script-src 'self'): the block page is served under a
// strict Content-Security-Policy, so no inline <script> is allowed. Plain
// canvas 2D, no dependencies; honours prefers-reduced-motion and pauses while
// the tab is hidden. Mirrors frontend/src/components/HoloBackground.tsx.
(function () {
  'use strict';
  var canvas = document.getElementById('holo');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  var CYAN = '34, 211, 238';
  var TEAL = '45, 212, 191';
  var MAGENTA = '232, 121, 249';
  var GLYPHS = '0123456789ABCDEF<>/\\|=+*';

  var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var reduced = !!(mq && mq.matches);

  var width = 0, height = 0, motes = [], rain = [];
  var raf = 0, start = 0, last = 0, running = true, visible = true;

  function seeded(seed) {
    var x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  function buildScene() {
    motes = [];
    for (var i = 0; i < 64; i++) {
      motes.push({
        x: seeded(i + 1) * width,
        y: seeded(i + 101) * height,
        speed: 6 + seeded(i + 201) * 18,
        size: 0.8 + seeded(i + 301) * 1.7,
        phase: seeded(i + 401) * Math.PI * 2,
        magenta: seeded(i + 501) > 0.78
      });
    }
    var columns = Math.max(8, Math.min(20, Math.round(width / 90)));
    rain = [];
    for (var c = 0; c < columns; c++) {
      var glyphs = [];
      for (var g = 0; g < 34; g++) {
        glyphs.push(GLYPHS[Math.floor(seeded(c * 97 + g * 13 + 7) * GLYPHS.length)]);
      }
      rain.push({
        x: (c + 0.5) * (width / columns) + (seeded(c + 61) - 0.5) * 26,
        speed: 18 + seeded(c + 71) * 46,
        offset: seeded(c + 81) * height,
        glyphs: glyphs,
        bright: seeded(c + 91) > 0.72
      });
    }
  }

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth || window.innerWidth;
    height = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildScene();
    if (reduced) draw(0);
  }

  function glowLine(x1, y1, x2, y2, color, alpha, blur) {
    ctx.save();
    ctx.strokeStyle = 'rgba(' + color + ',' + alpha + ')';
    ctx.shadowColor = 'rgba(' + color + ',' + Math.min(1, alpha + 0.25) + ')';
    ctx.shadowBlur = blur;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  function draw(t) {
    var horizon = height * 0.6;
    ctx.clearRect(0, 0, width, height);

    var bg = ctx.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, '#04060c');
    bg.addColorStop(0.55, '#060b14');
    bg.addColorStop(1, '#04070c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    var haze = ctx.createRadialGradient(width / 2, horizon, 0, width / 2, horizon, Math.max(width, height) * 0.62);
    haze.addColorStop(0, 'rgba(' + CYAN + ',0.16)');
    haze.addColorStop(0.45, 'rgba(' + TEAL + ',0.05)');
    haze.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = haze;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'top';
    for (var r = 0; r < rain.length; r++) {
      var column = rain[r];
      var drift = (column.offset + t * column.speed) % (height + 260);
      for (var g = 0; g < column.glyphs.length; g++) {
        var y = drift - g * 18;
        if (y < -18 || y > height) continue;
        var fade = 1 - g / column.glyphs.length;
        var flicker = 0.55 + 0.45 * Math.sin(t * 2.2 + g * 0.7 + column.x);
        var alpha = (g === 0 ? 0.3 : 0.11) * fade * flicker;
        ctx.fillStyle = (column.bright && g === 0)
          ? 'rgba(' + MAGENTA + ',' + alpha + ')'
          : 'rgba(' + CYAN + ',' + alpha + ')';
        ctx.fillText(column.glyphs[g], column.x, y);
      }
    }
    ctx.restore();

    ctx.save();
    ctx.lineWidth = 1;
    var vanishX = width / 2;
    var scroll = (t * 0.055) % 1;
    for (var k = 0; k < 20; k++) {
      var p = (k + scroll) / 20;
      var gy = horizon + (height - horizon) * Math.pow(p, 2.15);
      ctx.strokeStyle = 'rgba(' + CYAN + ',' + (0.028 + p * 0.16) + ')';
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(width, gy);
      ctx.stroke();
    }
    for (var i = -26; i <= 26; i++) {
      var bottomX = vanishX + i * (width * 0.11);
      ctx.strokeStyle = i % 6 === 0 ? 'rgba(' + MAGENTA + ',0.10)' : 'rgba(' + CYAN + ',0.075)';
      ctx.beginPath();
      ctx.moveTo(vanishX + i * 3, horizon);
      ctx.lineTo(bottomX, height + 40);
      ctx.stroke();
    }
    glowLine(0, horizon, width, horizon, CYAN, 0.22, 14);
    ctx.restore();

    var hubX = width / 2, hubY = height * 0.42, unit = Math.min(width, height);
    ctx.save();
    ctx.translate(hubX, hubY);
    var radarRadius = unit * 0.62;
    var radarAngle = t * 0.32;
    var radar = ctx.createRadialGradient(0, 0, 0, 0, 0, radarRadius);
    radar.addColorStop(0, 'rgba(' + CYAN + ',0.055)');
    radar.addColorStop(0.65, 'rgba(' + TEAL + ',0.03)');
    radar.addColorStop(1, 'rgba(' + CYAN + ',0)');
    ctx.fillStyle = radar;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radarRadius, radarAngle, radarAngle + 0.5);
    ctx.closePath();
    ctx.fill();
    for (var ring = 0; ring < 3; ring++) {
      var radius = unit * (0.27 + ring * 0.105);
      var spin = t * (ring % 2 === 0 ? 0.12 : -0.09) + ring * 1.7;
      ctx.save();
      ctx.rotate(spin);
      ctx.setLineDash(ring === 0 ? [2, 11] : [1, 17]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(' + CYAN + ',' + (0.14 - ring * 0.03) + ')';
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(' + MAGENTA + ',' + (0.22 - ring * 0.05) + ')';
      ctx.beginPath();
      ctx.arc(0, 0, radius, spin * 0.6, spin * 0.6 + 0.55);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(' + TEAL + ',' + (0.10 - ring * 0.02) + ')';
      for (var tick = 0; tick < 36; tick++) {
        var a = (tick / 36) * Math.PI * 2;
        var inner = radius - (tick % 9 === 0 ? 7 : 3);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
        ctx.lineTo(Math.cos(a) * radius, Math.sin(a) * radius);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();

    var sweepP = (Math.sin(t * 0.24) + 1) / 2;
    var sweepY = height * 0.12 + sweepP * height * 0.72;
    var sweep = ctx.createLinearGradient(0, sweepY - 60, 0, sweepY + 12);
    sweep.addColorStop(0, 'rgba(' + CYAN + ',0)');
    sweep.addColorStop(0.82, 'rgba(' + CYAN + ',0.05)');
    sweep.addColorStop(1, 'rgba(' + CYAN + ',0)');
    ctx.fillStyle = sweep;
    ctx.fillRect(0, sweepY - 60, width, 72);
    glowLine(0, sweepY, width, sweepY, TEAL, 0.1, 8);

    for (var m = 0; m < motes.length; m++) {
      var mote = motes[m];
      var my = (mote.y - t * mote.speed) % (height + 20);
      if (my < 0) my += height + 20;
      var twinkle = 0.35 + 0.65 * Math.abs(Math.sin(t * 1.3 + mote.phase));
      var color = mote.magenta ? MAGENTA : CYAN;
      ctx.fillStyle = 'rgba(' + color + ',' + (0.16 * twinkle) + ')';
      ctx.fillRect(mote.x, my, mote.size, mote.size);
    }

    if (!reduced) {
      var cycle = t % 7.4;
      if (cycle < 0.16) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (var gl = 0; gl < 3; gl++) {
          var gy2 = seeded(Math.floor(t * 20) + gl * 17) * height;
          var gh = 1 + seeded(gl * 31 + 5) * 4;
          var shift = (seeded(gl * 67 + 3) - 0.5) * 36;
          ctx.fillStyle = gl % 2 === 0 ? 'rgba(' + CYAN + ',0.10)' : 'rgba(' + MAGENTA + ',0.08)';
          ctx.fillRect(shift, gy2, width, gh);
        }
        ctx.restore();
      }
    }
  }

  function frame(now) {
    if (!running) return;
    if (!start) start = now;
    var t = (now - start) / 1000;
    if (now - last >= 22) {
      last = now;
      if (visible) draw(t);
    }
    raf = window.requestAnimationFrame(frame);
  }

  function onVisibility() {
    visible = !document.hidden;
    if (visible) last = 0;
  }

  resize();
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resize).observe(canvas);
  }
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', onVisibility);

  if (reduced) {
    draw(0);
  } else {
    raf = window.requestAnimationFrame(frame);
  }
})();

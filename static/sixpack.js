/* Six-pack gauges, drawn as SVG and driven by /api/stream (Server-Sent Events).
 *
 * Every gauge is built once into its <svg>, and returns an update(state)
 * function that only touches transforms and text -- no DOM churn per frame.
 *
 * Angles are measured in degrees from 12 o'clock, positive clockwise, which is
 * how instrument faces are laid out. pt() converts that to SVG coordinates.
 */

/* Anything that throws in here used to leave the page sitting at
 * "connecting…" with no clue why -- especially on an iPad, where there is no
 * console to look at. Report it on screen and into the bridge's terminal. */
function beacon(m) { if (window.__log) window.__log(m); }          // ?debug only

function report(what) {
  if (window.__log) window.__log('report: ' + what, true);          // always
  try {
    const box = document.getElementById('overlay');
    const msg = document.getElementById('overlay-msg');
    if (box && msg) {
      msg.innerHTML = 'Page error<br><small style="color:#e2a0a0">'
        + String(what).replace(/[<>&]/g, '') + '</small>';
      box.hidden = false;
    }
    const s = document.getElementById('status');
    if (s) s.textContent = 'page error';
  } catch (e) { /* nothing left to do */ }
}


/* ---------------------------------------------------------------- config -- */

const CONFIG = {
  // Airspeed dial. These Cessna 172 values are only the fallback: when
  // X-Plane reports the loaded aircraft's own V-speeds they replace them, and
  // anything in profiles.json overrides both. See configureFor().
  asi: {
    min: 40, max: 200, a0: 30, a1: 330,
    vso: 41,    // stall, flaps down   -> bottom of the white arc
    vs1: 48,    // stall, flaps up     -> bottom of the green arc
    vfe: 85,    // max flaps extended  -> top of the white arc
    vno: 129,   // max structural cruise -> green/yellow boundary
    vne: 163,   // never exceed        -> red radial
    step: { minor: 5, major: 10, label: 20 }
  },
  ai:  { pxPerDeg: 2.6 },
  alt: { },
  vsi: { max: 2000, sweep: 170 },
  tc:  {
    stdRateDeg: 20,      // symbol bank shown for a standard-rate (3 deg/s) turn
    source: 'derived',   // 'derived' = turn rate from heading, 'dataref' = X-Plane deflection
    dataRefScale: 1.0,
    slipSign: 1,
    slipFullScale: 10    // deg of slip at the edge of the ball cage
  },
  // Display smoothing, seconds. Larger = calmer needle, more lag.
  tau: {
    ias: 0.12, alt_ft: 0.10, vsi_fpm: 0.30, baro_inhg: 0.0,
    pitch_deg: 0.07, roll_deg: 0.07, hdg_deg: 0.10, hdg_bug_deg: 0.10,
    slip_deg: 0.20, turn_dps: 0.25
  }
};

const COL = {
  ink: '#e9edf2', dim: '#9aa4af', face: '#0c0e11',
  green: '#1f9d4d', yellow: '#d9bb12', red: '#c62b2b', white: '#e9edf2',
  sky: '#2f6fc4', ground: '#7a5230', symbol: '#ffc832', bug: '#e05fd8',
  digits: '#5ef08a'
};

/* --------------------------------------------------------------- helpers -- */

const NS = 'http://www.w3.org/2000/svg';
const now_ms = () => (window.performance && performance.now)
  ? performance.now() : (new Date()).getTime();
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const wrap180 = d => ((d + 180) % 360 + 360) % 360 - 180;

function add(parent, tag, attrs, text) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (tag === 'text') {
    // Vertical centring via dy: `dominant-baseline` is ignored by old WebKit.
    if (!(attrs && 'dy' in attrs)) e.setAttribute('dy', '.35em');
    if (!(attrs && 'text-anchor' in attrs)) e.setAttribute('text-anchor', 'middle');
    if (!(attrs && 'fill' in attrs)) e.setAttribute('fill', COL.ink);
  }
  if (text !== undefined) e.textContent = text;
  parent.appendChild(e);
  return e;
}

function pt(r, deg) {
  const a = deg * Math.PI / 180;
  return [r * Math.sin(a), -r * Math.cos(a)];
}

function tick(g, deg, r1, r2, w, color) {
  const [x1, y1] = pt(r1, deg), [x2, y2] = pt(r2, deg);
  return add(g, 'line', { x1, y1, x2, y2, stroke: color || COL.ink,
                          'stroke-width': w || 1.5, 'stroke-linecap': 'butt' });
}

function label(g, r, deg, str, size, color, rotate) {
  const [x, y] = pt(r, deg);
  const a = { x, y, 'font-size': size || 13, fill: color || COL.ink };
  if (rotate) a.transform = `rotate(${deg} ${x} ${y})`;
  return add(g, 'text', a, str);
}

function arcPath(r, d0, d1) {
  const [x0, y0] = pt(r, d0), [x1, y1] = pt(r, d1);
  const large = (((d1 - d0) % 360) + 360) % 360 > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

/** Bezel + face. Returns a <g> to draw the instrument into. */
function shell(svg, id) {
  const defs = add(svg, 'defs');
  const bg = add(defs, 'linearGradient', { id: `bez-${id}`, x1: 0, y1: 0, x2: 0, y2: 1 });
  add(bg, 'stop', { offset: 0, 'stop-color': '#4a5058' });
  add(bg, 'stop', { offset: 1, 'stop-color': '#15181c' });
  const fg = add(defs, 'radialGradient', { id: `fac-${id}`, cx: '38%', cy: '30%', r: '85%' });
  add(fg, 'stop', { offset: 0, 'stop-color': '#171b20' });
  add(fg, 'stop', { offset: 1, 'stop-color': '#08090b' });

  add(svg, 'circle', { cx: 0, cy: 0, r: 99, fill: `url(#bez-${id})` });
  add(svg, 'circle', { cx: 0, cy: 0, r: 93, fill: '#0a0c0f', stroke: '#000', 'stroke-width': 2 });
  add(svg, 'circle', { cx: 0, cy: 0, r: 91, fill: `url(#fac-${id})` });
  return add(svg, 'g', {});
}

/** Classic tapered needle, drawn pointing up; rotate the returned <g>. */
function needle(parent, len, w, tail, color) {
  const g = add(parent, 'g', {});
  add(g, 'path', {
    d: `M 0 ${tail} L ${-w} 2 L ${-w * 0.32} ${-len} L 0 ${-len - 5}
        L ${w * 0.32} ${-len} L ${w} 2 Z`,
    fill: color || COL.white
  });
  return g;
}

/** Small dark readout box with centred text. Returns the <text>. */
function readout(parent, cx, cy, w, h, size, opaque) {
  const g = add(parent, 'g', { class: 'digits' });
  add(g, 'rect', { x: cx - w / 2, y: cy - h / 2, width: w, height: h, rx: 3,
                   fill: opaque ? '#04060a' : 'rgba(4,6,8,.80)',
                   stroke: '#333a42', 'stroke-width': 1 });
  return add(g, 'text', { x: cx, y: cy + 0.5, 'font-size': size || 13,
                          fill: COL.digits, 'font-family': 'ui-monospace, Menlo, monospace' }, '--');
}

function faceText(g, x, y, str, size, color, spacing) {
  return add(g, 'text', { x, y, 'font-size': size, fill: color || COL.dim,
                          'letter-spacing': spacing === undefined ? 0.6 : spacing }, str);
}

/* --------------------------------------------------- airspeed indicator -- */

function buildASI(svg) {
  const C = CONFIG.asi;
  const g = shell(svg, 'asi');
  const ang = kt => C.a0 + (clamp(kt, C.min, C.max) - C.min) / (C.max - C.min) * (C.a1 - C.a0);

  // Green runs to Vno where the aircraft has one, otherwise all the way to
  // Vne -- jets and many turboprops leave Vno at zero.
  const hasCaution = C.vno > C.vs1;
  const greenTop = hasCaution ? C.vno : C.vne;
  if (C.vs1 > 0 && greenTop > C.vs1) {
    add(g, 'path', { d: arcPath(75, ang(C.vs1), ang(greenTop)), stroke: COL.green,
                     'stroke-width': 6, fill: 'none' });
  }
  if (hasCaution && C.vne > C.vno) {
    add(g, 'path', { d: arcPath(75, ang(C.vno), ang(C.vne)), stroke: COL.yellow,
                     'stroke-width': 6, fill: 'none' });
  }
  if (C.vso > 0 && C.vfe > C.vso) {
    add(g, 'path', { d: arcPath(53, ang(C.vso), ang(C.vfe)), stroke: COL.white,
                     'stroke-width': 4, fill: 'none' });
  }
  if (C.vne > 0) tick(g, ang(C.vne), 72, 90, 5, COL.red);

  const st = C.step;
  const nTicks = Math.round((C.max - C.min) / st.minor);
  for (let i = 0; i <= nTicks; i++) {
    const kt = C.min + i * st.minor;
    const major = Math.abs(kt / st.major - Math.round(kt / st.major)) < 1e-6;
    tick(g, ang(kt), major ? 76 : 82, 90, major ? 2.6 : 1.4);
  }
  const first = Math.ceil(C.min / st.label) * st.label;
  const nLabels = Math.floor((C.max - first) / st.label);
  for (let i = 0; i <= nLabels; i++) {
    const kt = first + i * st.label;
    label(g, 64, ang(kt), String(kt), nLabels > 9 ? 12 : 14);
  }

  faceText(g, 0, -42, 'AIRSPEED', 8);
  faceText(g, 0, -30, 'KNOTS', 7);

  const txt = readout(g, 0, 30, 62, 19, 14);
  const nd = needle(g, 80, 4.2, 20);
  add(g, 'circle', { cx: 0, cy: 0, r: 6, fill: '#22262c', stroke: '#555c66' });

  return s => {
    nd.setAttribute('transform', `rotate(${ang(s.ias)})`);
    txt.textContent = `${Math.round(s.ias)} kt`;
  };
}

/* -------------------------------------------------- attitude indicator -- */

function buildAI(svg) {
  const px = CONFIG.ai.pxPerDeg;
  const g = shell(svg, 'ai');
  const defs = add(svg, 'defs');
  const cp = add(defs, 'clipPath', { id: 'ai-clip' });
  add(cp, 'circle', { cx: 0, cy: 0, r: 88 });

  const clipped = add(g, 'g', { 'clip-path': 'url(#ai-clip)' });
  const roll = add(clipped, 'g', {});
  const pitch = add(roll, 'g', {});

  add(pitch, 'rect', { x: -300, y: -420, width: 600, height: 420, fill: COL.sky });
  add(pitch, 'rect', { x: -300, y: 0, width: 600, height: 420, fill: COL.ground });
  add(pitch, 'line', { x1: -300, y1: 0, x2: 300, y2: 0, stroke: '#fff', 'stroke-width': 2 });

  for (let d = -30; d <= 30; d += 5) {
    if (d === 0) continue;
    const major = d % 10 === 0;
    const w = major ? 34 : 15;
    const y = -d * px;
    add(pitch, 'line', { x1: -w, y1: y, x2: w, y2: y, stroke: '#fff',
                         'stroke-width': major ? 1.6 : 1.1 });
    if (major) {
      const t = Math.abs(d);
      add(pitch, 'text', { x: -w - 9, y, 'font-size': 9, fill: '#fff' }, t);
      add(pitch, 'text', { x: w + 9, y, 'font-size': 9, fill: '#fff' }, t);
    }
  }

  // Sky pointer rides the gyro card; the bank scale below is fixed to the case.
  const skyPtr = add(roll, 'path', { d: 'M 0 -72 L -7 -84 L 7 -84 Z', fill: '#fff' });

  const scale = add(g, 'g', {});
  add(scale, 'path', { d: arcPath(87, -65, 65), stroke: '#c9d1d9', 'stroke-width': 1.2, fill: 'none' });
  for (const d of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
    const big = Math.abs(d) === 30 || Math.abs(d) === 60;
    tick(scale, d, big ? 78 : 82, 88, big ? 2.4 : 1.6, '#e9edf2');
  }
  add(scale, 'path', { d: 'M 0 -88 L -7 -76 L 7 -76 Z', fill: 'none',
                       stroke: '#c9d1d9', 'stroke-width': 1.6, 'stroke-linejoin': 'round' });

  // Fixed aircraft symbol.
  const sym = add(g, 'g', {});
  add(sym, 'path', { d: 'M -66 0 L -22 0 L -22 8 L -16 8 L -16 0', fill: 'none',
                     stroke: COL.symbol, 'stroke-width': 4.5, 'stroke-linejoin': 'round' });
  add(sym, 'path', { d: 'M 66 0 L 22 0 L 22 8 L 16 8 L 16 0', fill: 'none',
                     stroke: COL.symbol, 'stroke-width': 4.5, 'stroke-linejoin': 'round' });
  add(sym, 'circle', { cx: 0, cy: 0, r: 3.6, fill: COL.symbol });

  const txt = readout(g, 0, 64, 84, 16, 11);

  return s => {
    roll.setAttribute('transform', `rotate(${-s.roll_deg})`);
    pitch.setAttribute('transform', `translate(0 ${clamp(s.pitch_deg, -90, 90) * px})`);
    skyPtr.setAttribute('fill', Math.abs(s.roll_deg) > 45 ? COL.yellow : '#fff');
    const r = Math.abs(s.roll_deg) < 0.5 ? 0 : s.roll_deg;
    txt.textContent = `${s.pitch_deg >= 0 ? '+' : '-'}${Math.abs(s.pitch_deg).toFixed(1)}°  `
                    + `${r > 0 ? 'R' : r < 0 ? 'L' : ''}${Math.abs(r).toFixed(0)}°`;
  };
}

/* ---------------------------------------------------------- altimeter -- */

function buildALT(svg) {
  const g = shell(svg, 'alt');

  for (let i = 0; i < 50; i++) {
    const deg = i * 7.2;              // one tick per 20 ft
    const major = i % 5 === 0;
    tick(g, deg, major ? 76 : 83, 90, major ? 2.8 : 1.3);
  }
  for (let n = 0; n <= 9; n++) {
    if (n === 3) continue;            // the Kollsman window lives at 3 o'clock
    label(g, 62, n * 36, String(n), 17);
  }

  faceText(g, 0, -44, 'ALT', 9);
  faceText(g, 0, -32, '100 FEET', 6.5);

  // Kollsman (barometric setting) window.
  const kw = add(g, 'g', {});
  add(kw, 'rect', { x: 30, y: -10, width: 50, height: 20, rx: 2.5,
                    fill: '#050709', stroke: '#616a75', 'stroke-width': 1.2 });
  const baro = add(kw, 'text', { x: 55, y: 0.5, 'font-size': 12, fill: COL.ink,
                                 'font-family': 'ui-monospace, Menlo, monospace' }, '29.92');

  const txt = readout(g, 0, 34, 78, 18, 13);

  // 10 000 ft pointer: thin stick with a triangle, drawn under the others.
  const n10k = add(g, 'g', {});
  add(n10k, 'path', { d: 'M 0 6 L -2 -62 L -6 -68 L 0 -88 L 6 -68 L 2 -62 Z',
                      fill: '#dfe4ea' });
  // 1 000 ft pointer: short and broad.
  const n1k = needle(g, 52, 8, 14);
  // 100 ft pointer: long and slim, on top.
  const n100 = needle(g, 84, 4.6, 18);
  add(g, 'circle', { cx: 0, cy: 0, r: 6, fill: '#22262c', stroke: '#555c66' });

  return s => {
    const a = s.alt_ft;
    n100.setAttribute('transform', `rotate(${(a % 1000) / 1000 * 360})`);
    n1k.setAttribute('transform', `rotate(${(a % 10000) / 10000 * 360})`);
    n10k.setAttribute('transform', `rotate(${(a % 100000) / 100000 * 360})`);
    baro.textContent = s.baro_inhg.toFixed(2);
    txt.textContent = `${Math.round(a).toLocaleString()} ft`;
  };
}

/* --------------------------------------------------- turn coordinator -- */

function buildTC(svg) {
  const C = CONFIG.tc;
  const g = shell(svg, 'tc');

  tick(g, 0, 80, 92, 3);
  for (const d of [90 + C.stdRateDeg, 270 - C.stdRateDeg]) tick(g, d, 74, 92, 3);
  // Offset the letters from the index marks: the wing sweeps straight through
  // the mark's bearing, so anything printed on it disappears in a turn.
  label(g, 76, 270 - C.stdRateDeg - 20, 'L', 13, COL.dim);
  label(g, 76, 90 + C.stdRateDeg + 20, 'R', 13, COL.dim);

  faceText(g, 0, -72, 'TURN COORDINATOR', 7);
  faceText(g, 0, 24, '2 MIN TURN', 6.5);
  faceText(g, 0, 42, 'NO PITCH INFORMATION', 6);

  // Miniature aircraft: banks with the rate of turn.
  const plane = add(g, 'g', {});
  add(plane, 'rect', { x: -74, y: -2.6, width: 148, height: 5.2, rx: 2.6, fill: COL.white });
  add(plane, 'rect', { x: -3.2, y: -27, width: 6.4, height: 27, rx: 2, fill: COL.white });
  add(plane, 'rect', { x: -15, y: -27, width: 30, height: 4.6, rx: 2.3, fill: COL.white });
  add(plane, 'circle', { cx: 0, cy: 0, r: 8.5, fill: COL.white });
  add(plane, 'circle', { cx: 0, cy: 0, r: 4.5, fill: '#0c0e11' });

  // Inclinometer: ball in a curved tube along the bottom.
  const CY = -60, R = 125;
  const ballPt = phi => [R * Math.sin(phi * Math.PI / 180),
                         CY + R * Math.cos(phi * Math.PI / 180)];
  const [ax, ay] = ballPt(-16), [bx, by] = ballPt(16);
  add(g, 'path', { d: `M ${ax} ${ay} A ${R} ${R} 0 0 1 ${bx} ${by}`,
                   stroke: '#3b424b', 'stroke-width': 17, 'stroke-linecap': 'round', fill: 'none' });
  add(g, 'path', { d: `M ${ax} ${ay} A ${R} ${R} 0 0 1 ${bx} ${by}`,
                   stroke: '#101418', 'stroke-width': 14, 'stroke-linecap': 'round', fill: 'none' });
  for (const s0 of [-5.2, 5.2]) {
    const [x1, y1] = ballPt(s0), c = Math.cos(s0 * Math.PI / 180), n = Math.sin(s0 * Math.PI / 180);
    add(g, 'line', { x1: x1 - n * 8, y1: y1 - c * 8, x2: x1 + n * 8, y2: y1 + c * 8,
                     stroke: '#aeb6bf', 'stroke-width': 1.4 });
  }
  const ball = add(g, 'circle', { cx: 0, cy: CY + R, r: 5.8, fill: '#e6eaef' });

  const txt = readout(g, 0, -52, 66, 17, 12);

  return s => {
    const rate = C.source === 'dataref'
      ? s.turn_defl_deg * C.dataRefScale / C.stdRateDeg * 3
      : s.turn_dps;
    const bank = clamp(rate / 3 * C.stdRateDeg, -32, 32);
    plane.setAttribute('transform', `rotate(${bank})`);
    const phi = clamp(C.slipSign * s.slip_deg / C.slipFullScale, -1, 1) * 13;
    const [bxx, byy] = ballPt(phi);
    ball.setAttribute('cx', bxx.toFixed(2));
    ball.setAttribute('cy', byy.toFixed(2));
    const r1 = Math.abs(rate) < 0.15 ? 0 : rate;
    txt.textContent = `${r1 > 0 ? 'R' : r1 < 0 ? 'L' : ' '} ${Math.abs(r1).toFixed(1)}°/s`;
  };
}

/* -------------------------------------------------- heading indicator -- */

function buildHI(svg) {
  const g = shell(svg, 'hi');
  const card = add(g, 'g', {});
  const NAMES = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };

  for (let d = 0; d < 360; d += 5) {
    const major = d % 10 === 0;
    tick(card, d, major ? 74 : 81, 89, major ? 2.4 : 1.4);
  }
  for (let d = 0; d < 360; d += 30) {
    if (NAMES[d]) label(card, 60, d, NAMES[d], 19, COL.ink, true);
    else label(card, 61, d, String(d / 10), 16, COL.ink, true);
  }

  // Heading bug rides the card, so it shows relative to the aircraft.
  const bug = add(card, 'g', {});
  add(bug, 'path', { d: 'M -8 -90 L 8 -90 L 8 -78 L 3 -74 L -3 -74 L -8 -78 Z', fill: COL.bug });

  // Fixed index marks and lubber line.
  for (const d of [45, 90, 135, 180, 225, 270, 315]) tick(g, d, 89, 97, 2, '#c9d1d9');
  add(g, 'path', { d: 'M 0 -74 L -7 -90 L 7 -90 Z', fill: COL.symbol });

  const sym = add(g, 'g', {});
  add(sym, 'rect', { x: -1.8, y: -30, width: 3.6, height: 56, rx: 1.5, fill: COL.symbol });
  add(sym, 'rect', { x: -26, y: -6, width: 52, height: 3.6, rx: 1.8, fill: COL.symbol });
  add(sym, 'rect', { x: -11, y: 20, width: 22, height: 3.2, rx: 1.6, fill: COL.symbol });

  const txt = readout(g, 0, -56, 54, 19, 14, true);

  return s => {
    card.setAttribute('transform', `rotate(${-s.hdg_deg})`);
    bug.setAttribute('transform', `rotate(${s.hdg_bug_deg})`);
    const h = Math.round(s.hdg_deg) % 360;
    let hs = String(h === 0 ? 360 : h);
    while (hs.length < 3) hs = '0' + hs;
    txt.textContent = hs + '°';
  };
}

/* --------------------------------------------- vertical speed indicator -- */

function buildVSI(svg) {
  const C = CONFIG.vsi;
  const g = shell(svg, 'vsi');
  const ang = f => -90 + clamp(f, -C.max, C.max) / C.max * C.sweep;

  const minorFpm = C.max / 20;
  for (let i = -20; i <= 20; i++) {
    const f = i * minorFpm;
    const major = i % 5 === 0;
    tick(g, ang(f), major ? 76 : 83, 90, major ? 2.6 : 1.3);
  }
  for (const f of [0, C.max / 2, C.max, -C.max / 2, -C.max]) {
    label(g, 62, ang(f), String(Math.round(Math.abs(f) / 100) / 10), 15);
  }

  faceText(g, 0, -44, 'VERTICAL SPEED', 7.5);
  faceText(g, 0, -32, '1000 FEET PER MIN', 6);   // numerals are thousands
  faceText(g, 50, -28, 'UP', 7.5, COL.dim);
  faceText(g, 50, 30, 'DOWN', 7.5, COL.dim);

  const txt = readout(g, 0, 34, 66, 18, 12);
  const nd = needle(g, 84, 4, 16);
  add(g, 'circle', { cx: 0, cy: 0, r: 6, fill: '#22262c', stroke: '#555c66' });

  return s => {
    nd.setAttribute('transform', `rotate(${ang(s.vsi_fpm)})`);
    const v = Math.round(s.vsi_fpm / 10) * 10;
    txt.textContent = `${v > 0 ? '+' : ''}${v} fpm`;
  };
}


/* ------------------------------------------------------------------ PFD -- */

/* A glass primary flight display drawn from exactly the same numbers as the
 * six-pack: attitude across the middle, speed and altitude tapes either side,
 * vertical speed on the right, compass arc along the bottom. */

const PFD = {
  att: { x: 150, y: 20, w: 600, h: 440, pxPerDeg: 9 },
  spd: { x: 40, y: 40, w: 100, h: 400, pxPerKt: 5 },
  alt: { x: 760, y: 40, w: 120, h: 400, pxPerFt: 0.33 },
  vsi: { x: 888, y: 40, w: 46, h: 400 },
  hdg: { cx: 450, cy: 820, r: 360 }
};

const PFD_SKY = '#1d6fc9';
const PFD_GND = '#6d4726';
const PFD_PANEL = 'rgba(8,11,15,.72)';
const PFD_EDGE = '#39424c';

function buildPFD(svg) {
  const A = PFD.att, S = PFD.spd, L = PFD.alt, V = PFD.vsi, H = PFD.hdg;
  const acx = A.x + A.w / 2, acy = A.y + A.h / 2;
  const scy = S.y + S.h / 2, lcy = L.y + L.h / 2, vcy = V.y + V.h / 2;
  const C = CONFIG.asi;

  add(svg, 'rect', { x: 0, y: 0, width: 1000, height: 640, fill: '#05070a' });

  const defs = add(svg, 'defs');
  const cA = add(defs, 'clipPath', { id: 'pfd-att' });
  add(cA, 'rect', { x: A.x, y: A.y, width: A.w, height: A.h });
  const cS = add(defs, 'clipPath', { id: 'pfd-spd' });
  add(cS, 'rect', { x: S.x, y: S.y, width: S.w, height: S.h });
  const cL = add(defs, 'clipPath', { id: 'pfd-alt' });
  add(cL, 'rect', { x: L.x, y: L.y, width: L.w, height: L.h });

  /* ---- attitude ---- */
  const attG = add(svg, 'g', { 'clip-path': 'url(#pfd-att)' });
  const frame = add(attG, 'g', { transform: 'translate(' + acx + ' ' + acy + ')' });
  const rollG = add(frame, 'g', {});
  const pitchG = add(rollG, 'g', {});
  add(pitchG, 'rect', { x: -900, y: -1500, width: 1800, height: 1500, fill: PFD_SKY });
  add(pitchG, 'rect', { x: -900, y: 0, width: 1800, height: 1500, fill: PFD_GND });
  add(pitchG, 'rect', { x: -900, y: -1.5, width: 1800, height: 3, fill: '#fff' });
  for (let h = -20; h <= 20; h += 2.5) {
    if (h === 0) continue;
    const y = -h * A.pxPerDeg;
    const ten = Math.abs(h % 10) < 0.01;
    const five = Math.abs(h % 5) < 0.01;
    const w = ten ? 88 : five ? 48 : 22;
    add(pitchG, 'rect', { x: -w, y: y - 1.2, width: 2 * w, height: 2.4, fill: '#fff' });
    if (ten) {
      const t = String(Math.abs(h));
      add(pitchG, 'text', { x: -w - 17, y: y, 'font-size': 17, fill: '#fff' }, t);
      add(pitchG, 'text', { x: w + 17, y: y, 'font-size': 17, fill: '#fff' }, t);
    }
  }

  /* ---- bank scale (fixed) and roll pointer (moves with the horizon) ---- */
  const scaleG = add(svg, 'g', { transform: 'translate(' + acx + ' ' + acy + ')' });
  for (const d of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
    const big = Math.abs(d) === 30 || Math.abs(d) === 60;
    tick(scaleG, d, big ? 194 : 203, 213, big ? 3 : 2, '#fff');
  }
  add(scaleG, 'path', { d: 'M 0 -213 L -11 -196 L 11 -196 Z', fill: 'none',
                        stroke: '#fff', 'stroke-width': 2 });
  const ptrHolder = add(svg, 'g', { transform: 'translate(' + acx + ' ' + acy + ')' });
  const ptrG = add(ptrHolder, 'g', {});
  add(ptrG, 'path', { d: 'M 0 -191 L -12 -172 L 12 -172 Z', fill: COL.symbol });
  const slipG = add(ptrG, 'g', {});
  add(slipG, 'path', { d: 'M -13 -168 L 13 -168 L 10 -159 L -10 -159 Z', fill: COL.symbol });

  /* ---- fixed aircraft symbol, outlined so it reads over sky and ground ---- */
  const wing = (dir) => 'M ' + (acx + dir * 132) + ' ' + acy
                      + ' L ' + (acx + dir * 62) + ' ' + acy
                      + ' L ' + (acx + dir * 62) + ' ' + (acy + 21);
  for (const st of [{ c: '#000', w: 12 }, { c: COL.symbol, w: 6 }]) {
    add(svg, 'path', { d: wing(-1), fill: 'none', stroke: st.c, 'stroke-width': st.w,
                       'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
    add(svg, 'path', { d: wing(1), fill: 'none', stroke: st.c, 'stroke-width': st.w,
                       'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  }
  add(svg, 'rect', { x: acx - 7, y: acy - 7, width: 14, height: 14,
                     fill: COL.symbol, stroke: '#000', 'stroke-width': 2 });

  /* ---- airspeed tape ---- */
  add(svg, 'rect', { x: S.x, y: S.y, width: S.w, height: S.h,
                     fill: PFD_PANEL, stroke: PFD_EDGE, 'stroke-width': 1 });
  const spdClip = add(svg, 'g', { 'clip-path': 'url(#pfd-spd)' });
  const spdTape = add(spdClip, 'g', {});
  const lo = Math.max(0, C.min - 40), hi = C.max + 40;
  const bandX = S.x + 3, bandW = 8;
  const band = (v0, v1, col, x, w) => {
    if (!(v1 > v0) || !(v0 > 0)) return;
    add(spdTape, 'rect', { x: x, y: -v1 * S.pxPerKt, width: w,
                           height: (v1 - v0) * S.pxPerKt, fill: col });
  };
  const hasCaution = C.vno > C.vs1;
  band(C.vs1, hasCaution ? C.vno : C.vne, COL.green, bandX, bandW);
  if (hasCaution) band(C.vno, C.vne, COL.yellow, bandX, bandW);
  band(C.vne, hi, COL.red, bandX, bandW);
  band(C.vso, C.vfe, COL.white, bandX + bandW + 2, 5);
  for (let kt = Math.ceil(lo / 5) * 5; kt <= hi; kt += 5) {
    const y = -kt * S.pxPerKt;
    const ten = kt % 10 === 0;
    add(spdTape, 'line', { x1: S.x + S.w - (ten ? 24 : 14), y1: y, x2: S.x + S.w - 4, y2: y,
                           stroke: '#cfd6dd', 'stroke-width': 2 });
    if (ten) {
      add(spdTape, 'text', { x: S.x + S.w - 30, y: y, 'font-size': 17, fill: '#fff',
                             'text-anchor': 'end' }, String(kt));
    }
  }
  add(svg, 'path', { d: 'M ' + S.x + ' ' + (scy - 21) + ' H ' + (S.x + S.w - 13)
                        + ' V ' + (scy - 10) + ' L ' + (S.x + S.w) + ' ' + scy
                        + ' L ' + (S.x + S.w - 13) + ' ' + (scy + 10)
                        + ' V ' + (scy + 21) + ' H ' + S.x + ' Z',
                     fill: '#05070a', stroke: '#fff', 'stroke-width': 2 });
  const spdTxt = add(svg, 'text', { x: S.x + S.w - 28, y: scy, 'font-size': 27, fill: '#fff',
                                    'text-anchor': 'end',
                                    'font-family': 'ui-monospace, Menlo, monospace' }, '---');

  /* ---- altitude tape: labels are recycled, so it costs nothing to scroll ---- */
  add(svg, 'rect', { x: L.x, y: L.y, width: L.w, height: L.h,
                     fill: PFD_PANEL, stroke: PFD_EDGE, 'stroke-width': 1 });
  const altClip = add(svg, 'g', { 'clip-path': 'url(#pfd-alt)' });
  const altTicks = [];
  for (let i = -6; i <= 6; i++) {
    const row = add(altClip, 'g', {});
    add(row, 'line', { x1: L.x + 5, y1: 0, x2: L.x + 24, y2: 0,
                       stroke: '#cfd6dd', 'stroke-width': 2 });
    const t = add(row, 'text', { x: L.x + 31, y: 0, 'font-size': 17, fill: '#fff',
                                 'text-anchor': 'start' }, '');
    altTicks.push({ row: row, txt: t, off: i, last: null });
  }
  add(svg, 'path', { d: 'M ' + (L.x + L.w) + ' ' + (lcy - 21) + ' H ' + (L.x + 13)
                        + ' V ' + (lcy - 10) + ' L ' + L.x + ' ' + lcy
                        + ' L ' + (L.x + 13) + ' ' + (lcy + 10)
                        + ' V ' + (lcy + 21) + ' H ' + (L.x + L.w) + ' Z',
                     fill: '#05070a', stroke: '#fff', 'stroke-width': 2 });
  const altTxt = add(svg, 'text', { x: L.x + L.w - 6, y: lcy, 'font-size': 25, fill: '#fff',
                                    'text-anchor': 'end',
                                    'font-family': 'ui-monospace, Menlo, monospace' }, '-----');
  const baroTxt = add(svg, 'text', { x: L.x + L.w / 2, y: L.y + L.h + 21, 'font-size': 19,
                                     fill: COL.digits,
                                     'font-family': 'ui-monospace, Menlo, monospace' }, '29.92');

  /* ---- vertical speed ---- */
  add(svg, 'rect', { x: V.x, y: V.y, width: V.w, height: V.h,
                     fill: 'rgba(8,11,15,.55)', stroke: PFD_EDGE, 'stroke-width': 1 });
  const vMax = CONFIG.vsi.max;
  const vspan = V.h / 2 - 16;
  const vy = f => vcy - clamp(f, -vMax, vMax) / vMax * vspan;
  for (let i = -4; i <= 4; i++) {
    const f = i * vMax / 4;
    const major = i % 2 === 0;
    add(svg, 'line', { x1: V.x + 2, y1: vy(f), x2: V.x + (major ? 16 : 10), y2: vy(f),
                       stroke: '#cfd6dd', 'stroke-width': major ? 2 : 1.4 });
    if (major && i !== 0) {
      add(svg, 'text', { x: V.x + 30, y: vy(f), 'font-size': 15, fill: '#fff' },
          String(Math.round(Math.abs(f) / 100) / 10));
    }
  }
  const vsiPtr = add(svg, 'g', {});
  add(vsiPtr, 'path', { d: 'M ' + V.x + ' 0 L ' + (V.x + 13) + ' -9 L ' + (V.x + V.w - 2)
                           + ' -9 L ' + (V.x + V.w - 2) + ' 9 L ' + (V.x + 13) + ' 9 Z',
                        fill: '#05070a', stroke: COL.digits, 'stroke-width': 2 });
  const vsiTxt = add(vsiPtr, 'text', { x: V.x + V.w / 2 + 5, y: 0, 'font-size': 14,
                                       fill: COL.digits,
                                       'font-family': 'ui-monospace, Menlo, monospace' }, '');

  /* ---- compass arc ---- */
  const cardHolder = add(svg, 'g', { transform: 'translate(' + H.cx + ' ' + H.cy + ')' });
  const card = add(cardHolder, 'g', {});
  const NAMES = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (let d = 0; d < 360; d += 5) {
    const ten = d % 10 === 0;
    tick(card, d, H.r - (ten ? 17 : 10), H.r, ten ? 3 : 2, '#cfd6dd');
  }
  for (let d = 0; d < 360; d += 30) {
    label(card, H.r - 38, d, NAMES[d] || String(d / 10), NAMES[d] ? 23 : 20, '#fff', true);
  }
  const bugG = add(card, 'g', {});
  add(bugG, 'path', { d: 'M -11 ' + (-H.r - 1) + ' L 11 ' + (-H.r - 1) + ' L 11 '
                         + (-H.r + 11) + ' L 4 ' + (-H.r + 16) + ' L -4 ' + (-H.r + 16)
                         + ' L -11 ' + (-H.r + 11) + ' Z', fill: COL.bug });
  // standard-rate marks and the turn-rate bar sit on the case, not the card
  for (const d of [-18, 18]) tick(cardHolder, d, H.r - 15, H.r - 1, 3, '#fff');
  const turnBar = add(cardHolder, 'path', { fill: 'none', stroke: COL.bug, 'stroke-width': 7 });
  add(svg, 'path', { d: 'M ' + H.cx + ' ' + (H.cy - H.r + 3) + ' L ' + (H.cx - 11) + ' '
                        + (H.cy - H.r - 15) + ' L ' + (H.cx + 11) + ' ' + (H.cy - H.r - 15)
                        + ' Z', fill: COL.symbol });
  add(svg, 'rect', { x: H.cx - 47, y: H.cy - H.r - 51, width: 94, height: 31, rx: 3,
                     fill: '#05070a', stroke: '#fff', 'stroke-width': 1.5 });
  const hdgTxt = add(svg, 'text', { x: H.cx, y: H.cy - H.r - 35, 'font-size': 23, fill: '#fff',
                                    'font-family': 'ui-monospace, Menlo, monospace' }, '---');

  return s => {
    rollG.setAttribute('transform', 'rotate(' + (-s.roll_deg) + ')');
    pitchG.setAttribute('transform',
                        'translate(0 ' + clamp(s.pitch_deg, -90, 90) * A.pxPerDeg + ')');
    ptrG.setAttribute('transform', 'rotate(' + (-s.roll_deg) + ')');
    slipG.setAttribute('transform', 'translate('
      + clamp(CONFIG.tc.slipSign * s.slip_deg / CONFIG.tc.slipFullScale, -1, 1) * 24 + ' 0)');

    spdTape.setAttribute('transform', 'translate(0 ' + (scy + s.ias * S.pxPerKt) + ')');
    spdTxt.textContent = String(Math.max(0, Math.round(s.ias)));

    const base = Math.round(s.alt_ft / 100) * 100;
    for (let i = 0; i < altTicks.length; i++) {
      const t = altTicks[i], v = base + t.off * 100;
      t.row.setAttribute('transform',
                         'translate(0 ' + (lcy + (s.alt_ft - v) * L.pxPerFt) + ')');
      if (t.last !== v) { t.last = v; t.txt.textContent = String(v); }
    }
    altTxt.textContent = String(Math.round(s.alt_ft / 10) * 10);
    baroTxt.textContent = s.baro_inhg.toFixed(2);

    vsiPtr.setAttribute('transform', 'translate(0 ' + vy(s.vsi_fpm) + ')');
    const v = Math.round(s.vsi_fpm / 50) * 50;
    vsiTxt.textContent = Math.abs(v) >= 100 ? String(v) : '';

    card.setAttribute('transform', 'rotate(' + (-s.hdg_deg) + ')');
    bugG.setAttribute('transform', 'rotate(' + s.hdg_bug_deg + ')');
    let h = Math.round(s.hdg_deg) % 360;
    let hs = String(h === 0 ? 360 : h);
    while (hs.length < 3) hs = '0' + hs;
    hdgTxt.textContent = hs + '°';

    const rate = clamp(s.turn_dps, -4.5, 4.5) * 6;
    turnBar.setAttribute('d', Math.abs(rate) < 1 ? ''
      : (rate > 0 ? arcPath(H.r - 8, 0, rate) : arcPath(H.r - 8, rate, 0)));
  };
}

/* ------------------------------------------------------ data + render -- */

const GAUGES = [];
const KEYS = ['ias', 'alt_ft', 'vsi_fpm', 'baro_inhg', 'pitch_deg', 'roll_deg',
              'hdg_deg', 'hdg_bug_deg', 'slip_deg', 'turn_dps', 'turn_defl_deg'];
const ANGULAR = { hdg_deg: 1, hdg_bug_deg: 1 };

const target = {};
const shown = {};
for (let i = 0; i < KEYS.length; i++) { target[KEYS[i]] = 0; shown[KEYS[i]] = 0; }
let lastFrame = 0, lastMsg = 0, gotAny = false, everConnected = false;
let srcName = '', transport = 'sse';

function applyPayload(d) {
  target.ias = d.ias;
  target.alt_ft = d.alt_ft;
  target.vsi_fpm = d.vsi_fpm;
  target.baro_inhg = d.baro_inhg || 29.92;
  target.pitch_deg = d.pitch_deg;
  target.roll_deg = d.roll_deg;
  target.hdg_deg = d.hdg_deg;
  target.hdg_bug_deg = d.hdg_bug_deg;
  target.slip_deg = d.slip_deg;
  target.turn_dps = d.turn_rate_dps;
  target.turn_defl_deg = d.turn_defl_deg;
  if (!!d.glass !== isGlass) {
    isGlass = !!d.glass;
    beacon('glass cockpit: ' + (isGlass ? 'yes (' + (d.glass_why || '?') + ')' : 'no'));
    if (panelMode === 'auto') { acfSig = null; }   // force a rebuild below
  }
  if (d.acf && d.acf.sig !== acfSig) {
    acfSig = d.acf.sig;
    acfEl.textContent = d.acf.name || d.acf.icao || '';
    configureFor(d.acf);
    beacon('aircraft: ' + (d.acf.name || d.acf.icao || '?')
           + ' -> ' + activeView() + ', ASI ' + CONFIG.asi.min + '-' + CONFIG.asi.max
           + ' kt, VSI +/-' + CONFIG.vsi.max);
    buildAll();
    panelSync();
  }
  srcName = d.src;
  lastMsg = now_ms();
  if (!gotAny) beacon('first data received over ' + transport);
  gotAny = true;
  setStatus(d.connected ? 'live' : 'nosim');
}

function frame(now) {
  const dt = Math.min((now - lastFrame) / 1000 || 0.016, 0.1);
  lastFrame = now;
  for (const k of KEYS) {
    const tau = k in CONFIG.tau ? CONFIG.tau[k] : 0.1;
    const kf = tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
    if (ANGULAR[k]) shown[k] = (shown[k] + wrap180(target[k] - shown[k]) * kf + 360) % 360;
    else shown[k] += (target[k] - shown[k]) * kf;
  }
  for (const u of GAUGES) u(shown);
  if (lastMsg && now - lastMsg > 2500) setStatus('offline');
  requestAnimationFrame(frame);
}

/* ---------------------------------------------------------- aircraft -- */

/* Per-type overrides, loaded from profiles.json and keyed by ICAO code.
 * Anything set there wins over what X-Plane reports. */
let PROFILES = {};
let acfSig = null;
let isGlass = false;          // what the bridge says this aircraft has
let panelMode = 'auto';       // 'auto' | 'sixpack' | 'pfd'

function activeView() {
  return panelMode === 'auto' ? (isGlass ? 'pfd' : 'sixpack') : panelMode;
}

const NICE = [5, 10, 20, 25, 50, 100];
function niceStep(x) {
  for (let i = 0; i < NICE.length; i++) if (x <= NICE[i]) return NICE[i];
  return NICE[NICE.length - 1];
}

/* Rebuild the airspeed and vertical speed dials around one aircraft's limits.
 * Returns false when there is nothing usable, leaving the defaults in place. */
function configureFor(acf) {
  const p = PROFILES[String(acf.icao || '').toUpperCase()] || {};
  const num = (a, b) => (typeof a === 'number' && a > 0) ? a : b;

  const vne = num(p.vne, acf.vne);
  if (!(vne > 0)) return false;              // aircraft has no speeds set
  const vso = num(p.vso, acf.vso);
  const vs1 = num(p.vs1, num(acf.vs1, vso));
  const vfe = num(p.vfe, acf.vfe);
  const vno = num(p.vno, acf.vno);

  const min = num(p.asiMin, Math.max(20, Math.floor((vso > 0 ? vso : 40) / 10) * 10));
  const max = num(p.asiMax, Math.ceil(vne * 1.12 / 20) * 20);
  const labelStep = niceStep((max - min) / 8);

  CONFIG.asi.min = min;
  CONFIG.asi.max = max;
  CONFIG.asi.vso = vso;
  CONFIG.asi.vs1 = vs1;
  CONFIG.asi.vfe = vfe;
  CONFIG.asi.vno = vno;
  CONFIG.asi.vne = vne;
  CONFIG.asi.step = { label: labelStep, major: labelStep / 2, minor: labelStep / 4 };

  // Light aircraft use a 2000 fpm dial; anything quick enough wants 6000.
  CONFIG.vsi.max = num(p.vsiMax, vne > 250 ? 6000 : 2000);
  return true;
}

function loadProfiles(done) {
  try {
    const x = new XMLHttpRequest();
    x.open('GET', 'profiles.json?t=' + (new Date()).getTime(), true);
    x.onreadystatechange = () => {
      if (x.readyState !== 4) return;
      if (x.status >= 200 && x.status < 300) {
        try {
          PROFILES = JSON.parse(x.responseText) || {};
          beacon('profiles loaded: ' + Object.keys(PROFILES).join(', '));
        } catch (e) { report('profiles.json is not valid JSON: ' + e); }
      }
      done();
    };
    x.send();
  } catch (e) { done(); }
}

/* ------------------------------------------------------------- layout -- */

/* Place the six dials and give each <svg> a pixel width and height.
 * Doing this in JS rather than CSS keeps it working on old WebKit, which
 * leaves a percentage-sized inline SVG with no height at all. */
let lastGeom = '';
let panelSync = () => {};

function layout() {
  const panel = document.getElementById('panel');
  const W = panel.clientWidth || window.innerWidth;
  const H = panel.clientHeight || (window.innerHeight - 30);
  if (!W || !H) return;

  if (activeView() === 'pfd') {
    const svg = document.getElementById('pfd');
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.style.left = '0px';
    svg.style.top = '0px';
    const geom = 'pfd ' + W + 'x' + H;
    if (geom !== lastGeom) { lastGeom = geom; beacon('layout: ' + geom); }
    return;
  }

  const cells = document.getElementsByClassName('cell');
  if (!cells.length) return;

  const portrait = H > W;
  const cols = portrait ? 2 : 3;
  const rows = portrait ? 3 : 2;
  const cw = Math.floor(W / cols);
  const ch = Math.floor(H / rows);
  const dia = Math.max(60, Math.min(cw, ch) - 6);

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    cell.style.left = (i % cols) * cw + 'px';
    cell.style.top = Math.floor(i / cols) * ch + 'px';
    cell.style.width = cw + 'px';
    cell.style.height = ch + 'px';
    const svg = cell.getElementsByTagName('svg')[0];
    if (!svg) continue;
    svg.setAttribute('width', dia);
    svg.setAttribute('height', dia);
    svg.style.left = Math.round((cw - dia) / 2) + 'px';
    svg.style.top = Math.round((ch - dia) / 2) + 'px';
  }

  const geom = W + 'x' + H + ' cells ' + cols + 'x' + rows + ' of '
             + cw + 'x' + ch + ', dial ' + dia + 'px';
  if (geom !== lastGeom) { lastGeom = geom; beacon('layout: ' + geom); }
}

/* ------------------------------------------------------------- status -- */

const dotEl = document.getElementById('dot');
const statusEl = document.getElementById('status');
const srcEl = document.getElementById('src');
const acfEl = document.getElementById('acf');
const overlayEl = document.getElementById('overlay');
const overlayMsg = document.getElementById('overlay-msg');
const SRC_TEXT = { vacuum: 'vacuum gyros', electric: 'electric gyros',
                   ahars: 'AHARS', model: 'flight model (no gyro instruments)' };

function setStatus(kind) {
  if (kind === 'live') {
    everConnected = true;
    dotEl.className = 'dot live';
    statusEl.textContent = transport === 'poll' ? 'live · polling' : 'live';
    overlayEl.hidden = true;
  } else if (kind === 'nosim') {
    dotEl.className = 'dot stale';
    statusEl.textContent = 'no data from X-Plane';
    overlayMsg.innerHTML = 'Waiting for X-Plane&hellip;<br><small>Start the sim and load an aircraft. '
      + 'If X-Plane is on another machine, check Settings &rsaquo; Network &rsaquo; '
      + 'Accept incoming connections.</small>';
    overlayEl.hidden = false;
  } else if (kind === 'unreachable') {
    dotEl.className = 'dot dead';
    statusEl.textContent = 'no reply from the bridge';
    overlayMsg.innerHTML = 'The page loaded, but ' + location.host
      + ' is not answering for data.<br><small>The bridge is reachable for files '
      + 'but not for the live feed — check that xpbridge.py is still running.</small>';
    overlayEl.hidden = false;
  } else {
    dotEl.className = 'dot dead';
    statusEl.textContent = 'bridge offline';
    overlayMsg.innerHTML = 'Lost the bridge&hellip;<br><small>Is xpbridge.py still running?</small>';
    overlayEl.hidden = false;
  }
  srcEl.textContent = srcName ? SRC_TEXT[srcName] || srcName : '';
}

/* ---------------------------------------------------------------- init -- */

const BUILDERS = [['asi', buildASI], ['ai', buildAI], ['alt', buildALT],
                  ['tc', buildTC], ['hi', buildHI], ['vsi', buildVSI]];

/* Draw all six from scratch. Called again whenever the aircraft changes, so
 * the dials pick up the new limits. */
function buildAll() {
  GAUGES.length = 0;
  const six = activeView() === 'sixpack';
  document.getElementById('panel').hidden = !six;
  document.getElementById('pfd-wrap').hidden = six;
  // A PFD is digital throughout, so the readout toggle has nothing to do.
  document.getElementById('digits-btn').hidden = !six;

  if (six) {
    for (let i = 0; i < BUILDERS.length; i++) {
      const svg = document.getElementById(BUILDERS[i][0]);
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      GAUGES.push(BUILDERS[i][1](svg));
    }
  } else {
    const svg = document.getElementById('pfd');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    GAUGES.push(buildPFD(svg));
  }
  // Raise every readout above the needles that sweep across it.
  const tops = document.querySelectorAll('svg .digits');
  for (let i = 0; i < tops.length; i++) tops[i].parentNode.appendChild(tops[i]);
  layout();
}

function boot() {
  buildAll();

  let digits = true;
  try { digits = localStorage.getItem('sixpack.digits') !== '0'; } catch (e) { /* private mode */ }
  const digitsBtn = document.getElementById('digits-btn');
  const applyDigits = () => {
    if (digits) { document.body.classList.add('show-digits'); digitsBtn.classList.add('on'); }
    else { document.body.classList.remove('show-digits'); digitsBtn.classList.remove('on'); }
    try { localStorage.setItem('sixpack.digits', digits ? '1' : '0'); } catch (e) { /* ignore */ }
  };
  digitsBtn.addEventListener('click', () => { digits = !digits; applyDigits(); });
  applyDigits();

  const panelBtn = document.getElementById('panel-btn');
  try {
    const saved = localStorage.getItem('sixpack.panel');
    if (saved === 'sixpack' || saved === 'pfd' || saved === 'auto') panelMode = saved;
  } catch (e) { /* private mode */ }
  const showMode = () => {
    panelBtn.textContent = panelMode === 'auto'
      ? 'auto: ' + (activeView() === 'pfd' ? 'PFD' : 'six-pack')
      : (panelMode === 'pfd' ? 'PFD' : 'six-pack');
    if (panelMode === 'auto') panelBtn.classList.remove('on');
    else panelBtn.classList.add('on');
  };
  panelBtn.addEventListener('click', () => {
    panelMode = panelMode === 'auto' ? 'sixpack' : panelMode === 'sixpack' ? 'pfd' : 'auto';
    try { localStorage.setItem('sixpack.panel', panelMode); } catch (e) { /* ignore */ }
    showMode();
    buildAll();
  });
  panelSync = showMode;
  showMode();

  const fullBtn = document.getElementById('full-btn');
  const req = document.documentElement.requestFullscreen
           || document.documentElement.webkitRequestFullscreen;
  if (!req) fullBtn.hidden = true;
  else fullBtn.addEventListener('click', () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      req.call(document.documentElement);
    }
  });

  // Streaming with a polling safety net: some browsers and proxies sit on an
  // event stream and deliver nothing, which used to leave the page saying
  // "connecting" forever. ?poll[=hz] forces polling from the start.
  let pollTimer = null;
  function startPolling(hz) {
    if (pollTimer) return;
    transport = 'poll';
    beacon('transport: polling at ' + hz + ' Hz');
    if (!gotAny) statusEl.textContent = 'connecting (polling)…';
    // XMLHttpRequest rather than fetch: fetch is missing on older tablets.
    const tickOnce = () => {
      try {
        const x = new XMLHttpRequest();
        x.open('GET', '/api/data?t=' + (new Date()).getTime(), true);
        x.onreadystatechange = () => {
          if (x.readyState !== 4) return;
          if (x.status >= 200 && x.status < 300) {
            try { applyPayload(JSON.parse(x.responseText)); }
            catch (e) { report('bad payload: ' + e); }
          } else {
            setStatus(gotAny ? 'offline' : 'unreachable');
          }
        };
        x.send();
      } catch (e) { report('poll failed: ' + e); }
    };
    tickOnce();
    pollTimer = setInterval(tickOnce, 1000 / hz);
  }

  // Load the overrides first so the first aircraft is configured with them.
  loadProfiles(() => { acfSig = null; });

  const forced = /[?&]poll(=([\d.]+))?/.exec(location.search);
  if (forced || !window.EventSource) {
    startPolling(forced ? (parseFloat(forced[2]) || 10) : 10);
  } else {
    const es = new EventSource('/api/stream');
    beacon('transport: opening event stream');
    es.onmessage = e => { try { applyPayload(JSON.parse(e.data)); } catch (err) { /* skip */ } };
    es.onerror = () => {
      if (gotAny) { if (everConnected) setStatus('offline'); }
      else { es.close(); startPolling(10); }
    };
    setTimeout(() => { if (!gotAny) { es.close(); startPolling(10); } }, 3000);
  }

  layout();
  // Report what the first dial actually measures, so a rendering failure is
  // distinguishable from a layout one without a console.
  try {
    const probe = document.getElementById('asi');
    const box = probe.getBoundingClientRect();
    beacon('asi svg ' + Math.round(box.width) + 'x' + Math.round(box.height)
           + ' at ' + Math.round(box.left) + ',' + Math.round(box.top)
           + ', ' + probe.childNodes.length + ' children');
  } catch (e) { beacon('probe failed: ' + e); }

  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', layout);
  // Older Safari reports a stale viewport straight after load and rotation.
  setTimeout(layout, 300);
  setTimeout(layout, 1200);

  beacon('boot complete');
  requestAnimationFrame(frame);
}

try {
  beacon('sixpack.js parsed, building gauges');
  boot();
} catch (err) {
  report(err && err.message ? err.message : err);
}

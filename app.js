/**
 * KSP Artemis Mission Control – Dashboard App
 * Polls /api/telemetry every 500ms, updates all station panels.
 */

'use strict';

const POLL_INTERVAL = 500; // ms
let lastData = null;
let metOffset = 0;
let metBase = Date.now();
let paoMessages = [];
let paoIdx = 0;

// ── Helpers ────────────────────────────────────────────────────────────────

function fmt(n, decimals = 0) {
  if (n === undefined || n === null || isNaN(n)) return '---';
  return Number(n).toFixed(decimals);
}

function fmtKm(m) {
  const km = m / 1000;
  if (Math.abs(km) >= 1000) return (km / 1000).toFixed(2) + ' Mm';
  if (Math.abs(km) >= 1) return km.toFixed(1) + ' km';
  return Math.round(m) + ' m';
}

function fmtTime(s) {
  if (!isFinite(s) || s === null || s === undefined) return '--:--:--';
  const neg = s < 0;
  s = Math.abs(Math.floor(s));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const hms = `${pad(h)}:${pad(m)}:${pad(sec)}`;
  if (d > 0) return (neg ? '-' : '') + `${d}d ${hms}`;
  return (neg ? '-' : '') + hms;
}

function pad(n) { return String(Math.floor(n)).padStart(2, '0'); }

function pct(val, max) {
  if (!max || max === 0) return 0;
  return Math.min(100, Math.max(0, (val / max) * 100));
}

function setBar(id, pctVal) {
  const el = document.getElementById(id);
  if (el) el.style.width = pctVal.toFixed(1) + '%';
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setClass(id, cls, toggle) {
  const el = document.getElementById(id);
  if (!el) return;
  if (toggle) el.classList.add(cls);
  else el.classList.remove(cls);
}

function setFlag(id, active) {
  const el = document.getElementById(id);
  if (!el) return;
  if (active) el.classList.add('active');
  else el.classList.remove('active');
}

function statusColor(id, status) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'panel-status ' + status;
  const labels = { nominal: 'NOMINAL', caution: 'CAUTION', warning: 'WARNING' };
  el.textContent = labels[status] || 'NOMINAL';
}

// ── Attitude Indicator Canvas ─────────────────────────────────────────────

function drawAttitude(pitch, roll) {
  const canvas = document.getElementById('attitude-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2, r = W / 2 - 2;

  ctx.clearRect(0, 0, W, H);

  // Clip to circle
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();

  // Sky / ground gradient based on pitch
  const pitchOffset = (pitch / 90) * r;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-roll * Math.PI / 180);

  // Sky
  ctx.fillStyle = '#0a2a4a';
  ctx.fillRect(-r, -r - pitchOffset, r * 2, r * 2);

  // Ground
  ctx.fillStyle = '#3a2010';
  ctx.fillRect(-r, -pitchOffset, r * 2, r * 2);

  // Horizon line
  ctx.strokeStyle = '#88ccff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-r, -pitchOffset);
  ctx.lineTo(r, -pitchOffset);
  ctx.stroke();

  // Pitch lines
  ctx.strokeStyle = 'rgba(136,204,255,0.4)';
  ctx.lineWidth = 0.8;
  for (let p = 10; p <= 60; p += 10) {
    const y1 = -pitchOffset - (p / 90) * r;
    const y2 = -pitchOffset + (p / 90) * r;
    const len = (p % 30 === 0) ? 20 : 12;
    ctx.beginPath(); ctx.moveTo(-len/2, y1); ctx.lineTo(len/2, y1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-len/2, y2); ctx.lineTo(len/2, y2); ctx.stroke();
  }

  ctx.restore();

  // Fixed aircraft symbol
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = 1.5;
  // wings
  ctx.beginPath();
  ctx.moveTo(cx - 22, cy); ctx.lineTo(cx - 10, cy);
  ctx.moveTo(cx + 10, cy); ctx.lineTo(cx + 22, cy);
  ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy);
  ctx.moveTo(cx, cy - 3); ctx.lineTo(cx, cy + 3);
  ctx.stroke();

  // Center dot
  ctx.fillStyle = '#00e5ff';
  ctx.beginPath();
  ctx.arc(cx, cy, 2, 0, Math.PI * 2);
  ctx.fill();

  // Roll arc indicator
  ctx.strokeStyle = '#00b4e6';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r - 4, -Math.PI * 0.7, -Math.PI * 0.3);
  ctx.stroke();

  // Roll pointer
  const rollRad = (roll - 90) * Math.PI / 180;
  const px = cx + (r - 4) * Math.cos(rollRad);
  const py = cy + (r - 4) * Math.sin(rollRad);
  ctx.fillStyle = '#00e5ff';
  ctx.beginPath();
  ctx.arc(px, py, 2.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  // Outer ring
  ctx.strokeStyle = '#1a4060';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
}

// ── PAO Ticker ──────────────────────────────────────────────────────────────

function buildPaoMessage(d) {
  if (!d || !d.connected) {
    return 'KSP MISSION CONTROL · ARTEMIS MCC · AWAITING kRPC CONNECTION · LAUNCH KSP AND START kRPC SERVER IN-GAME';
  }
  const parts = [
    `VESSEL: ${d.vessel_name}`,
    `SITUATION: ${d.situation}`,
    `ALTITUDE: ${fmtKm(d.altitude)}`,
    `ORB SPEED: ${fmt(d.orbital_speed, 0)} M/S`,
    `APOAPSIS: ${fmtKm(d.apoapsis)}`,
    `PERIAPSIS: ${fmtKm(d.periapsis)}`,
    `TWR: ${fmt(d.twr, 2)}`,
    `ΔV REMAIN: ${fmt(d.delta_v_total, 0)} M/S`,
    `MET: ${fmtTime(d.met)}`,
    `BODY: ${d.body_name}`,
    `PHASE: ${d.mission_phase}`,
    d.has_maneuver_node ? `NODE ΔV: ${fmt(d.node_delta_v, 1)} M/S IN ${fmtTime(d.time_to_node)}` : 'NO MANEUVER NODE PLANNED',
  ];
  return '· ' + parts.join('   ·   ') + '   · ';
}

// ── Main Update ─────────────────────────────────────────────────────────────

function update(d) {
  lastData = d;

  // ── Connection status
  const connected = d.connected;
  const connDot = document.getElementById('conn-dot');
  const connText = document.getElementById('conn-text');
  if (connDot) {
    if (connected) connDot.classList.add('connected');
    else connDot.classList.remove('connected');
  }
  if (connText) connText.textContent = connected ? 'LIVE' : 'OFFLINE';

  // Alert bar
  const alertBar = document.getElementById('alert-bar');
  const alertMsg = document.getElementById('alert-message');
  if (alertBar && alertMsg) {
    if (!connected) {
      alertBar.className = 'alert-bar';
      alertMsg.textContent = 'NO kRPC CONNECTION — ENSURE KSP IS RUNNING AND kRPC SERVER IS ACTIVE';
    } else if (d.periapsis < 0 && d.situation === 'ORBITING') {
      alertBar.className = 'alert-bar';
      alertMsg.textContent = `⚠ PERIAPSIS BELOW TERRAIN — TIME TO IMPACT: ${fmtTime(d.time_to_periapsis)}`;
    } else if (d.twr > 0 && d.twr < 1 && d.situation === 'ATMOSPHERIC FLIGHT') {
      alertBar.className = 'alert-bar';
      alertMsg.textContent = `⚠ LOW TWR — THRUST TO WEIGHT: ${fmt(d.twr, 2)}`;
    } else if (d.electric_charge_max > 0 && pct(d.electric_charge, d.electric_charge_max) < 10) {
      alertBar.className = 'alert-bar';
      alertMsg.textContent = `⚠ LOW ELECTRIC CHARGE — ${fmt(d.electric_charge, 0)} / ${fmt(d.electric_charge_max, 0)}`;
    } else {
      alertBar.className = 'alert-bar nominal';
      alertMsg.textContent = `ALL SYSTEMS NOMINAL — ${d.mission_phase} — VESSEL: ${d.vessel_name}`;
    }
  }

  // ── Header
  setText('vessel-name', d.vessel_name || 'NO ACTIVE VESSEL');
  setText('mission-phase', d.mission_phase || 'PRE-LAUNCH');
  setText('met-display', fmtTime(d.met));
  setText('ut-display', fmtTime(d.ut));
  setText('footer-server', `SERVER: ${connected ? 'ONLINE · kRPC ' + (d.ksp_version || '') : 'OFFLINE'}`);

  // ── FLIGHT Director
  setText('f-vessel', d.vessel_name || '---');
  setText('f-situation', d.situation || '---');
  setText('f-body', d.body_name || '---');
  setText('f-phase', d.mission_phase || '---');
  setText('f-crew', `${d.crew_count} / ${d.crew_capacity}`);
  setText('f-parts', d.part_count);

  // ── FDO – Flight Dynamics
  setText('fdo-apo', fmtKm(d.apoapsis));
  setText('fdo-peri', fmtKm(d.periapsis));
  setText('fdo-inc', fmt(d.inclination, 2) + '°');
  setText('fdo-ecc', fmt(d.eccentricity, 4));
  setText('fdo-alt', fmtKm(d.altitude));
  setText('fdo-spd', fmt(d.orbital_speed, 0) + ' m/s');
  setText('fdo-tapo', fmtTime(d.time_to_apoapsis));
  setText('fdo-period', fmtTime(d.orbital_period));

  // FDO status (warn if periapsis < 0 in orbit)
  if (d.periapsis < 0 && d.apoapsis > 0) statusColor('fdo-status', 'warning');
  else if (d.eccentricity > 1) statusColor('fdo-status', 'caution');
  else statusColor('fdo-status', 'nominal');

  // ── GNC
  const pitch = d.pitch || 0;
  const roll = d.roll || 0;
  const hdg = d.heading || 0;
  setText('gnc-pitch', fmt(pitch, 1) + '°');
  setText('gnc-roll', fmt(roll, 1) + '°');
  setText('gnc-hdg', pad(Math.round(Math.abs(hdg))) + '°');
  setText('gnc-spdS', fmt(d.surface_speed, 0) + ' m/s');
  setText('gnc-vert', (d.vertical_speed >= 0 ? '+' : '') + fmt(d.vertical_speed, 1) + ' m/s');
  setText('gnc-lat', fmt(d.latitude, 3) + '°');
  setText('gnc-lon', fmt(d.longitude, 3) + '°');
  drawAttitude(pitch, roll);

  // ── BOOSTER
  setText('boost-stage', d.current_stage);
  setText('boost-eng', `${d.engines_active} / ${d.engines_total}`);
  const thrPct = (d.throttle * 100);
  setText('boost-thr', fmt(thrPct, 0) + '%');
  setText('boost-thrust', fmt(d.thrust / 1000, 1) + ' kN');
  setText('boost-maxT', fmt(d.max_thrust / 1000, 1) + ' kN');
  setText('boost-isp', fmt(d.specific_impulse, 0) + ' s');
  setBar('thr-bar', thrPct);
  if (d.engines_active === 0 && d.throttle > 0.01) statusColor('booster-status', 'warning');
  else statusColor('booster-status', 'nominal');

  // ── PROP
  setText('prop-twr', fmt(d.twr, 2));
  setText('prop-dv', fmt(d.delta_v_total, 0) + ' m/s');
  setText('prop-mass', fmt(d.total_mass / 1000, 2) + ' t');
  setText('prop-dry', fmt(d.dry_mass / 1000, 2) + ' t');

  const lfPct = pct(d.fuel_lf, d.fuel_lf_max);
  const oxPct = pct(d.fuel_ox, d.fuel_ox_max);
  const monoPct = pct(d.fuel_mono, d.fuel_mono_max);
  setBar('lf-bar', lfPct);
  setBar('ox-bar', oxPct);
  setBar('mono-bar', monoPct);
  setText('lf-val', `${fmt(d.fuel_lf, 0)}/${fmt(d.fuel_lf_max, 0)}`);
  setText('ox-val', `${fmt(d.fuel_ox, 0)}/${fmt(d.fuel_ox_max, 0)}`);
  setText('mono-val', `${fmt(d.fuel_mono, 0)}/${fmt(d.fuel_mono_max, 0)}`);

  if (lfPct < 10 || oxPct < 10) statusColor('prop-status', 'warning');
  else if (lfPct < 20) statusColor('prop-status', 'caution');
  else statusColor('prop-status', 'nominal');

  // ── EECOM
  const sfPct = pct(d.solid_fuel, d.solid_fuel_max);
  const abPct = pct(d.ablator, d.ablator_max);
  const xePct = pct(d.xenon, d.xenon_max);
  setBar('sf-bar', sfPct);
  setBar('ab-bar', abPct);
  setBar('xe-bar', xePct);
  setText('sf-val', `${fmt(d.solid_fuel, 0)}/${fmt(d.solid_fuel_max, 0)}`);
  setText('ab-val', `${fmt(d.ablator, 0)}/${fmt(d.ablator_max, 0)}`);
  setText('xe-val', `${fmt(d.xenon, 1)}/${fmt(d.xenon_max, 1)}`);
  setText('eecom-crew', d.crew_count);
  setText('eecom-cap', d.crew_capacity);

  // ── MPO – Mechanical & Power
  const ecPct = pct(d.electric_charge, d.electric_charge_max);
  setText('mpo-parts', d.part_count);
  setText('mpo-ec', fmt(d.electric_charge, 0));
  setBar('ec-bar', ecPct);
  setText('ec-val', `${fmt(d.electric_charge, 0)}/${fmt(d.electric_charge_max, 0)}`);
  setFlag('flag-sas', d.sas_enabled);
  setFlag('flag-rcs', d.rcs_enabled);
  setFlag('flag-gear', d.gear_deployed);
  setFlag('flag-brakes', d.brakes_active);
  setFlag('flag-lights', d.lights_on);
  if (ecPct < 5) statusColor('mpo-status', 'warning');
  else if (ecPct < 20) statusColor('mpo-status', 'caution');
  else statusColor('mpo-status', 'nominal');

  // ── CONTROL
  setText('ctrl-salt', fmtKm(d.surface_altitude));
  setText('ctrl-spd', fmt(d.surface_speed, 0) + ' m/s');
  setText('ctrl-avx', fmt(d.angular_velocity_x, 3));
  setText('ctrl-avy', fmt(d.angular_velocity_y, 3));
  setText('ctrl-avz', fmt(d.angular_velocity_z, 3));

  // ── INCO – Comms
  const sigPct = (d.comms_signal || 0) * 100;
  setText('inco-sig', fmt(sigPct, 0) + '%');
  setText('inco-comm', d.comms_can_communicate ? 'YES' : 'NO');
  setBar('sig-bar', sigPct);
  setText('inco-tgt', d.target_name || 'None');
  setText('inco-tgtd', d.target_distance > 0 ? fmtKm(d.target_distance) : '---');
  if (!d.comms_can_communicate && d.situation !== 'PRE-LAUNCH') statusColor('inco-status', 'warning');
  else if (sigPct < 30) statusColor('inco-status', 'caution');
  else statusColor('inco-status', 'nominal');

  // ── FAO – Flight Activities
  setText('fao-tapo', fmtTime(d.time_to_apoapsis));
  setText('fao-tperi', fmtTime(d.time_to_periapsis));
  setText('fao-node', d.has_maneuver_node ? 'PLANNED' : 'NONE');
  setText('fao-ndv', d.has_maneuver_node ? fmt(d.node_delta_v, 1) + ' m/s' : '---');
  setText('fao-ntime', d.has_maneuver_node ? fmtTime(d.time_to_node) : '---');
  setText('fao-tgt', d.target_name || 'None');

  // ── GC – Ground Control
  setText('gc-body', d.body_name);
  setText('gc-radius', fmtKm(d.body_radius));
  setText('gc-lat', fmt(d.latitude, 3) + '°');
  setText('gc-lon', fmt(d.longitude, 3) + '°');
  setText('gc-sma', fmtKm(d.semi_major_axis));

  // ── C&DH
  setText('cdh-sas', d.sas_enabled ? 'ON' : 'OFF');
  setText('cdh-rcs', d.rcs_enabled ? 'ON' : 'OFF');
  setText('cdh-gear', d.gear_deployed ? 'DOWN' : 'UP');
  setText('cdh-brakes', d.brakes_active ? 'ON' : 'OFF');
  setText('cdh-lights', d.lights_on ? 'ON' : 'OFF');
  setText('cdh-thr', fmt(d.throttle * 100, 0) + '%');

  // ── FOD – Director Summary
  setText('fod-vessel', d.vessel_name || '---');
  setText('fod-sit', d.situation || '---');
  setText('fod-alt', fmtKm(d.altitude));
  setText('fod-spd', fmt(d.orbital_speed, 0) + ' m/s');
  setText('fod-twr', fmt(d.twr, 2));
  setText('fod-dv', fmt(d.delta_v_total, 0) + ' m/s');
  setText('fod-met', fmtTime(d.met));

  // ── PAO Ticker
  const ticker = document.getElementById('pao-ticker');
  if (ticker) ticker.textContent = buildPaoMessage(d);

  // ── Footer
  const now = new Date();
  setText('footer-time', `LOCAL: ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`);
}

// ── Polling ─────────────────────────────────────────────────────────────────

async function fetchTelemetry() {
  try {
    const resp = await fetch('/api/telemetry', { cache: 'no-store' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    update(data);
  } catch (e) {
    // Server offline – show disconnected state
    update({
      connected: false,
      vessel_name: 'Server Offline',
      mission_phase: 'OFFLINE',
      situation: 'UNKNOWN',
      met: 0, ut: 0,
      apoapsis: 0, periapsis: 0, inclination: 0, eccentricity: 0,
      orbital_speed: 0, orbital_period: 0, altitude: 0, surface_altitude: 0,
      time_to_apoapsis: 0, time_to_periapsis: 0, semi_major_axis: 0,
      pitch: 0, roll: 0, heading: 0,
      surface_speed: 0, vertical_speed: 0, latitude: 0, longitude: 0,
      angular_velocity_x: 0, angular_velocity_y: 0, angular_velocity_z: 0,
      twr: 0, thrust: 0, max_thrust: 0, specific_impulse: 0,
      total_mass: 0, dry_mass: 0,
      fuel_lf: 0, fuel_lf_max: 0, fuel_ox: 0, fuel_ox_max: 0,
      fuel_mono: 0, fuel_mono_max: 0, delta_v_total: 0,
      electric_charge: 0, electric_charge_max: 0,
      part_count: 0, crew_capacity: 0, crew_count: 0,
      solid_fuel: 0, solid_fuel_max: 0, ablator: 0, ablator_max: 0,
      xenon: 0, xenon_max: 0,
      throttle: 0, sas_enabled: false, rcs_enabled: false,
      gear_deployed: false, brakes_active: false, lights_on: false,
      comms_signal: 0, comms_can_communicate: false,
      current_stage: 0, engines_active: 0, engines_total: 0,
      has_maneuver_node: false, node_delta_v: 0, node_burn_time: 0, time_to_node: 0,
      target_name: 'None', target_distance: 0, target_relative_velocity: 0,
      body_name: 'Kerbin', body_radius: 600000, body_mu: 3.5316e12,
      ksp_version: '',
    });
  }
}

// ── Init ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  fetchTelemetry();
  setInterval(fetchTelemetry, POLL_INTERVAL);

  // Local clock update
  setInterval(() => {
    const now = new Date();
    setText('footer-time', `LOCAL: ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`);
  }, 1000);

  // Initial draw
  drawAttitude(0, 0);
});

const SLOTS = ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4'];

const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const presetsList = document.getElementById('presets-list');
const logEl = document.getElementById('log');

const rigDropdown = document.getElementById('rig-dropdown');
const rigTrigger = document.getElementById('rig-dropdown-trigger');
const rigMenu = document.getElementById('rig-dropdown-menu');
const rigNameEl = document.getElementById('rig-dropdown-name');
const rigMetaEl = document.getElementById('rig-dropdown-meta');
const rigStatusEl = document.getElementById('rig-status');
let selectedRigFile = null;

function log(message, kind) {
  const line = document.createElement('div');
  line.className = 'log-line' + (kind ? ' ' + kind : '');
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${message}`;
  logEl.prepend(line);
}

async function refreshStatus() {
  statusText.textContent = 'checking...';
  statusDot.className = 'dot';
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (data.connected) {
      statusDot.className = 'dot ok';
      statusText.textContent = 'Amp connected';
    } else {
      statusDot.className = 'dot err';
      statusText.textContent = 'Amp not found (check USB/power, and close any other MIDI client)';
    }
  } catch (err) {
    statusDot.className = 'dot err';
    statusText.textContent = 'Server error: ' + err.message;
  }
}

function slotSelectHtml(idPrefix, preferredSlot) {
  const options = SLOTS.map((s) => `<option value="${s}" ${s === preferredSlot ? 'selected' : ''}>${s}</option>`).join('');
  return `<select id="${idPrefix}-slot">${options}</select>`;
}

let loadedPresets = [];

async function loadPresets() {
  presetsList.innerHTML = '<p class="hint">Loading...</p>';
  rigNameEl.textContent = 'Loading...';
  rigMetaEl.textContent = '';
  const res = await fetch('/api/presets');
  const presets = await res.json();
  loadedPresets = presets;

  renderRigDropdown(presets);
  renderPresetsList(presets);
  return presets;
}

function presetMeta(preset) {
  return [preset.amplifier, preset.pedal1, preset.pedal2, preset.reverb].filter(Boolean).join(' · ');
}

function renderRigDropdown(presets) {
  const valid = presets.filter((p) => !p.error);

  if (valid.length === 0) {
    rigNameEl.textContent = 'No presets in presets/ yet';
    rigMetaEl.textContent = '';
    rigMenu.innerHTML = '';
    rigTrigger.disabled = true;
    selectedRigFile = null;
    return;
  }

  rigTrigger.disabled = false;

  // Keep the current selection if it still exists. Otherwise, unlike a
  // normal dropdown, we do NOT default to the first entry -- Current Rig is
  // supposed to reflect what's actually playing, and defaulting to some
  // arbitrary preset's name would claim that falsely. Leave the placeholder
  // up until either the user picks one or initCurrentRigFromAmp() detects
  // what's really on the amp.
  if (selectedRigFile && !valid.some((p) => p.file === selectedRigFile)) {
    selectedRigFile = null;
  }

  rigMenu.innerHTML = valid.map((preset) => `
    <div class="dropdown-option" data-file="${preset.file}">
      <div class="dropdown-option-name">${preset.programName}</div>
      <div class="dropdown-option-meta">${presetMeta(preset)}</div>
    </div>
  `).join('');

  rigMenu.querySelectorAll('.dropdown-option').forEach((el) => {
    el.addEventListener('click', () => {
      selectedRigFile = el.dataset.file;
      updateRigTriggerLabel(valid);
      closeRigDropdown();
      playSelectedRig();
    });
  });

  updateRigTriggerLabel(valid);
}

function updateRigTriggerLabel(presets) {
  if (!selectedRigFile) {
    rigNameEl.textContent = 'Select a preset...';
    rigMetaEl.textContent = '';
    return;
  }
  const preset = presets.find((p) => p.file === selectedRigFile);
  if (!preset) return;
  rigNameEl.textContent = preset.programName;
  rigMetaEl.textContent = presetMeta(preset);
}

function openRigDropdown() {
  rigMenu.hidden = false;
  rigTrigger.classList.add('open');
  document.addEventListener('click', onDocumentClickCloseRig);
}

function closeRigDropdown() {
  rigMenu.hidden = true;
  rigTrigger.classList.remove('open');
  document.removeEventListener('click', onDocumentClickCloseRig);
}

function onDocumentClickCloseRig(event) {
  if (!rigDropdown.contains(event.target)) closeRigDropdown();
}

rigTrigger.addEventListener('click', () => {
  if (rigMenu.hidden) openRigDropdown(); else closeRigDropdown();
});

function setRigStatus(text, kind) {
  rigStatusEl.textContent = text;
  rigStatusEl.className = 'rig-status' + (kind ? ' ' + kind : '');
}

// Shared by playSelectedRig and onWriteClick -- both apply a preset live
// (play only lives, write persists AND lives) and get back the same
// {volume, pedal1, pedal2, reverb, failed} shape to resync the UI from.
function syncKnobAndPedalsFromResult(result) {
  // Volume's knob/slider specifically, unless the amp didn't accept that
  // one field live (rare, but don't lie about it if so).
  const volumeApplied = !result.failed || !result.failed.includes('amplifier.volume');
  if (volumeApplied && typeof result.volume === 'number') {
    knobValue = clampKnobValue(result.volume);
    renderKnob(knobValue);
  }

  livePedalState = {
    pedal1: { ...result.pedal1, params: result.pedal1.params || {} },
    pedal2: { ...result.pedal2, params: result.pedal2.params || {} },
    reverb: { ...result.reverb, params: result.reverb.params || {} },
  };
  renderLivePedalRow();
}

// Selecting a preset from the dropdown IS the action -- no separate "Play
// Now" button. Current Rig always reflects what's actually sounding on the
// amp right now, not just a pending choice.
async function playSelectedRig() {
  const file = selectedRigFile;
  if (!file) return;

  rigTrigger.disabled = true;
  setRigStatus(`Playing "${rigNameEl.textContent}"...`);
  log(`Sending ${file} live to the amp's current rig (nothing will be saved)...`);
  try {
    const res = await fetch('/api/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    syncKnobAndPedalsFromResult(data.result);

    if (data.result.failed && data.result.failed.length > 0) {
      setRigStatus(`Now playing: "${data.result.programName}" -- ${data.result.failed.length} field(s) the amp didn't accept live (known hardware limitation): ${data.result.failed.join(', ')}`, 'ok');
    } else {
      setRigStatus(`Now playing: "${data.result.programName}"`, 'ok');
    }
    log(`Done: the amp should now sound like "${data.result.programName}" (${data.result.messageCount} live messages, nothing written).`, 'ok');
  } catch (err) {
    setRigStatus(`Failed to play: ${err.message}`, 'err');
    log(`Failed: ${err.message}`, 'err');
  } finally {
    rigTrigger.disabled = false;
  }
}

// --- Rotary knob (Volume) -------------------------------------------------
// Mirrors the real amp's own knob: min/max sit near the bottom with a gap,
// sweeping up and over the top, matching how vox-amp-librarian's own knobs
// (and the physical amp) work -- drag vertically to turn, release to commit.

const KNOB_MIN_ANGLE = -135;
const KNOB_MAX_ANGLE = 135;
const KNOB_RADIUS = 46;
const KNOB_DRAG_RANGE_PX = 160; // vertical px to sweep the full 0-10 range

const knobEl = document.getElementById('volume-knob');
const knobTrack = document.getElementById('knob-track');
const knobFill = document.getElementById('knob-fill');
const knobPointer = document.getElementById('knob-pointer');
const knobValueEl = document.getElementById('knob-value');
const volumeSlider = document.getElementById('volume-slider');

function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx, cy, r, startAngle, endAngle) {
  if (endAngle <= startAngle) return '';
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const largeArcFlag = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}

function valueToAngle(value) {
  return KNOB_MIN_ANGLE + (value / 10) * (KNOB_MAX_ANGLE - KNOB_MIN_ANGLE);
}

function renderKnob(value) {
  const angle = valueToAngle(value);
  knobFill.setAttribute('d', describeArc(60, 60, KNOB_RADIUS, KNOB_MIN_ANGLE, angle));
  knobPointer.style.transform = `rotate(${angle}deg)`;
  knobValueEl.textContent = value.toFixed(1);
  knobEl.setAttribute('aria-valuenow', value.toFixed(1));
  volumeSlider.value = value;
}

knobTrack.setAttribute('d', describeArc(60, 60, KNOB_RADIUS, KNOB_MIN_ANGLE, KNOB_MAX_ANGLE));

let knobValue = 5.0;
renderKnob(knobValue);

async function commitVolume(value) {
  try {
    const res = await fetch('/api/live-dial', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'volume', value }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    log(`Live Volume set to ${value.toFixed(1)}.`, 'ok');
  } catch (err) {
    log(`Failed to set live Volume: ${err.message}`, 'err');
  }
}

function clampKnobValue(v) {
  return Math.round(Math.max(0, Math.min(10, v)) * 10) / 10;
}

let dragStartY = null;
let dragStartValue = 5.0;

knobEl.addEventListener('pointerdown', (event) => {
  dragStartY = event.clientY;
  dragStartValue = knobValue;
  knobEl.setPointerCapture(event.pointerId);
  knobEl.focus();
});

knobEl.addEventListener('pointermove', (event) => {
  if (dragStartY === null) return;
  const deltaPx = dragStartY - event.clientY;
  knobValue = clampKnobValue(dragStartValue + (deltaPx / KNOB_DRAG_RANGE_PX) * 10);
  renderKnob(knobValue);
});

function endKnobDrag() {
  if (dragStartY === null) return;
  dragStartY = null;
  commitVolume(knobValue);
}

knobEl.addEventListener('pointerup', endKnobDrag);
knobEl.addEventListener('pointercancel', endKnobDrag);

let wheelCommitTimer = null;
knobEl.addEventListener('wheel', (event) => {
  event.preventDefault();
  knobValue = clampKnobValue(knobValue + (event.deltaY < 0 ? 0.1 : -0.1));
  renderKnob(knobValue);
  clearTimeout(wheelCommitTimer);
  wheelCommitTimer = setTimeout(() => commitVolume(knobValue), 300);
}, { passive: false });

knobEl.addEventListener('keydown', (event) => {
  let delta = 0;
  if (event.key === 'ArrowUp' || event.key === 'ArrowRight') delta = 0.1;
  if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') delta = -0.1;
  if (delta === 0) return;
  event.preventDefault();
  knobValue = clampKnobValue(knobValue + delta);
  renderKnob(knobValue);
  commitVolume(knobValue);
});

// Easier-to-grab alternative to the knob -- same value, same commit-on-
// release behavior, deliberately muted so the knob stays the visual focus.
volumeSlider.addEventListener('input', () => {
  knobValue = clampKnobValue(parseFloat(volumeSlider.value));
  renderKnob(knobValue);
});

volumeSlider.addEventListener('change', () => {
  commitVolume(knobValue);
});

// --- Live Pedal cards (Pedal 1 / Pedal 2 / Reverb) -------------------------
// One stompbox per fixed hardware slot -- no add/remove/reorder, unlike a
// freeform pedalboard -- colored by whichever effect "kind" the currently
// selected type counts as. Structure/coloring convention matches the
// ModularModeling project's stompbox cards.

const livePedalRow = document.getElementById('live-pedal-row');
let pedalSchema = null;

async function fetchPedalSchema() {
  try {
    const res = await fetch('/api/pedal-schema');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    pedalSchema = data.result;
  } catch (err) {
    log(`Couldn't load the pedal schema -- Live Pedal cards won't work: ${err.message}`, 'err');
  }
}

const SLOT_LABEL = { pedal1: 'PEDAL 1', pedal2: 'PEDAL 2', reverb: 'REVERB' };

function kindClassFor(slot, type) {
  const info = pedalSchema[slot].types.find((t) => t.type === type);
  return info ? info.kind : 'compressor';
}

function paramsSpecFor(slot, type) {
  return slot === 'reverb' ? pedalSchema.reverb.params.ALL : pedalSchema[slot].params[type];
}

function decimalsForKind(kind) {
  if (kind === 'unitless') return 1;
  if (kind === 'frequency') return 2;
  return 0; // duration / durationByte -- these are whole milliseconds
}

/**
 * One knob instance. Generalizes the Volume knob's exact interaction model
 * above (drag vertically / scroll / arrow keys, commit on release, debounced
 * commit on scroll) to an arbitrary min/max/decimals/label/onCommit, so
 * every pedal param can get its own knob without duplicating that logic.
 */
function createKnobControl({ min, max, decimals, label, value, onCommit }) {
  const wrap = document.createElement('div');
  wrap.className = 'knob-container';
  wrap.innerHTML = `
    <div class="knob knob-sm" tabindex="0" role="slider" aria-label="${label}" aria-valuemin="${min}" aria-valuemax="${max}">
      <svg viewBox="0 0 120 120" class="knob-svg">
        <path class="knob-track"></path>
        <path class="knob-fill"></path>
        <circle cx="60" cy="60" r="46" class="knob-body"></circle>
        <line class="knob-pointer" x1="60" y1="60" x2="60" y2="30"></line>
      </svg>
      <div class="knob-value"></div>
    </div>
    <div class="knob-label knob-label-sm">${label}</div>
  `;
  const knobEl = wrap.querySelector('.knob');
  const track = wrap.querySelector('.knob-track');
  const fill = wrap.querySelector('.knob-fill');
  const pointer = wrap.querySelector('.knob-pointer');
  const valueEl = wrap.querySelector('.knob-value');
  track.setAttribute('d', describeArc(60, 60, KNOB_RADIUS, KNOB_MIN_ANGLE, KNOB_MAX_ANGLE));

  const step = (max - min) / 100;
  let current = value;

  function angleFor(v) {
    return KNOB_MIN_ANGLE + ((v - min) / (max - min)) * (KNOB_MAX_ANGLE - KNOB_MIN_ANGLE);
  }
  function clamp(v) {
    return Math.round(Math.max(min, Math.min(max, v)) / step) * step;
  }
  function render(v) {
    current = v;
    const angle = angleFor(v);
    fill.setAttribute('d', describeArc(60, 60, KNOB_RADIUS, KNOB_MIN_ANGLE, angle));
    pointer.style.transform = `rotate(${angle}deg)`;
    valueEl.textContent = v.toFixed(decimals);
    knobEl.setAttribute('aria-valuenow', v.toFixed(decimals));
  }
  render(current);

  let dragStartY = null;
  let dragStartValue = current;
  knobEl.addEventListener('pointerdown', (event) => {
    dragStartY = event.clientY;
    dragStartValue = current;
    knobEl.setPointerCapture(event.pointerId);
    knobEl.focus();
  });
  knobEl.addEventListener('pointermove', (event) => {
    if (dragStartY === null) return;
    const deltaPx = dragStartY - event.clientY;
    render(clamp(dragStartValue + (deltaPx / KNOB_DRAG_RANGE_PX) * (max - min)));
  });
  function endDrag() {
    if (dragStartY === null) return;
    dragStartY = null;
    onCommit(current);
  }
  knobEl.addEventListener('pointerup', endDrag);
  knobEl.addEventListener('pointercancel', endDrag);

  let wheelTimer = null;
  knobEl.addEventListener('wheel', (event) => {
    event.preventDefault();
    render(clamp(current + (event.deltaY < 0 ? step : -step)));
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => onCommit(current), 300);
  }, { passive: false });

  knobEl.addEventListener('keydown', (event) => {
    let delta = 0;
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') delta = step;
    if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') delta = -step;
    if (delta === 0) return;
    event.preventDefault();
    render(clamp(current + delta));
    onCommit(current);
  });

  return wrap;
}

/** Builds one stompbox card for a slot ('pedal1'|'pedal2'|'reverb') from its current live state ({type, enabled, params}). */
function buildPedalCard(slot, state) {
  const spec = paramsSpecFor(slot, state.type);
  const kind = kindClassFor(slot, state.type);
  const values = { ...Object.fromEntries(Object.entries(spec).map(([k, s]) => [k, s.default])), ...(state.params || {}) };

  const card = document.createElement('div');
  card.className = `stompbox stompbox-${kind}`;

  const header = document.createElement('div');
  header.className = 'stompbox-header';
  header.innerHTML = `
    <div>
      <div class="stompbox-title">${state.type}</div>
      <div class="stompbox-kind">${SLOT_LABEL[slot]}</div>
    </div>
  `;
  card.appendChild(header);

  const typeLabel = document.createElement('label');
  typeLabel.className = 'control control-select';
  const types = pedalSchema[slot].types;
  typeLabel.innerHTML = `<span class="control-label">Type</span>
    <select>${types.map((t) => `<option value="${t.type}" ${t.type === state.type ? 'selected' : ''}>${t.type}</option>`).join('')}</select>`;
  typeLabel.querySelector('select').addEventListener('change', (event) => onPedalTypeChange(slot, event.target.value));
  card.appendChild(typeLabel);

  const knobsWrap = document.createElement('div');
  knobsWrap.className = 'panel-knobs';
  const togglesWrap = document.createElement('div');
  togglesWrap.className = 'panel-toggles';
  let hasToggles = false;

  for (const [name, paramSpec] of Object.entries(spec)) {
    const value = values[name];
    if (paramSpec.kind === 'boolean') {
      hasToggles = true;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'control-toggle' + (value ? ' on' : '');
      btn.textContent = `${name.toUpperCase()}: ${value ? 'ON' : 'OFF'}`;
      btn.addEventListener('click', () => onPedalParamCommit(slot, state.type, name, !value));
      togglesWrap.appendChild(btn);
    } else if (paramSpec.kind === 'discrete') {
      hasToggles = true;
      const sel = document.createElement('select');
      sel.style.width = 'auto';
      for (const choice of Object.keys(paramSpec.choices)) {
        const opt = document.createElement('option');
        opt.value = choice;
        opt.textContent = choice;
        if (choice === value) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => onPedalParamCommit(slot, state.type, name, sel.value));
      togglesWrap.appendChild(sel);
    } else {
      const knob = createKnobControl({
        min: paramSpec.min ?? 0,
        max: paramSpec.max ?? 10,
        decimals: decimalsForKind(paramSpec.kind),
        label: name.toUpperCase(),
        value: typeof value === 'number' ? value : paramSpec.default,
        onCommit: (v) => onPedalParamCommit(slot, state.type, name, v),
      });
      knobsWrap.appendChild(knob);
    }
  }

  card.appendChild(knobsWrap);
  if (hasToggles) card.appendChild(togglesWrap);

  const footer = document.createElement('div');
  footer.className = 'stompbox-footer';
  footer.innerHTML = `<span class="stompbox-slot-label">${SLOT_LABEL[slot]}</span>`;
  const footswitch = document.createElement('button');
  footswitch.type = 'button';
  footswitch.className = 'stompbox-footswitch' + (state.enabled ? ' on' : '');
  footswitch.addEventListener('click', () => onPedalEnabledToggle(slot, footswitch, !state.enabled));
  footer.appendChild(footswitch);
  card.appendChild(footer);

  return card;
}

let livePedalState = {
  pedal1: { type: 'COMP', enabled: false, params: {} },
  pedal2: { type: 'FLANGER', enabled: false, params: {} },
  reverb: { type: 'ROOM', enabled: false, params: {} },
};

function renderLivePedalRow() {
  if (!pedalSchema) return;
  livePedalRow.innerHTML = '';
  for (const slot of ['pedal1', 'pedal2', 'reverb']) {
    livePedalRow.appendChild(buildPedalCard(slot, livePedalState[slot]));
  }
}

async function onPedalParamCommit(slot, type, param, value) {
  try {
    const res = await fetch('/api/pedal-param', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot, type, param, value }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    if (!livePedalState[slot].params) livePedalState[slot].params = {};
    livePedalState[slot].params[param] = value;
    log(`Live ${SLOT_LABEL[slot]} ${param} set to ${value}.`, 'ok');
  } catch (err) {
    log(`Failed to set ${SLOT_LABEL[slot]} ${param}: ${err.message}`, 'err');
  }
}

async function onPedalEnabledToggle(slot, btn, enabled) {
  btn.disabled = true;
  try {
    const res = await fetch('/api/pedal-enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot, enabled }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    livePedalState[slot].enabled = enabled;
    btn.classList.toggle('on', enabled);
    log(`${SLOT_LABEL[slot]} ${enabled ? 'enabled' : 'disabled'} live.`, 'ok');
  } catch (err) {
    log(`Failed to toggle ${SLOT_LABEL[slot]}: ${err.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

// Switching a type resets that slot's params to the new type's defaults
// (both on the amp -- doSetPedalType does this server-side -- and in the
// card, which re-renders from those same schema defaults) since the old
// type's raw dial values don't mean anything for the new type.
async function onPedalTypeChange(slot, type) {
  log(`Switching ${SLOT_LABEL[slot]} to ${type} live...`);
  try {
    const res = await fetch('/api/pedal-type', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot, type }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    livePedalState[slot] = { type, enabled: livePedalState[slot].enabled, params: {} };
    renderLivePedalRow();
    if (data.result.failed && data.result.failed.length > 0) {
      log(`${SLOT_LABEL[slot]} switched to ${type}, with ${data.result.failed.length} field(s) the amp didn't accept live (known hardware limitation): ${data.result.failed.join(', ')}`, 'ok');
    } else {
      log(`${SLOT_LABEL[slot]} switched to ${type} live, params reset to defaults.`, 'ok');
    }
  } catch (err) {
    // The <select> itself already shows the user's failed pick (that's the
    // browser's own native behavior, not something we set) -- but nothing
    // underneath actually changed, so leaving it there would show FUZZ's
    // label over COMP's still-live knobs. Re-render from the untouched
    // state to put the dropdown back in sync with reality.
    renderLivePedalRow();
    log(`Failed to switch ${SLOT_LABEL[slot]} to ${type}: ${err.message}`, 'err');
  }
}

function renderPresetsList(presets) {
  if (presets.length === 0) {
    presetsList.innerHTML = '<p class="hint">No preset files in presets/ yet.</p>';
    return;
  }

  presetsList.innerHTML = '';
  for (const preset of presets) {
    const card = document.createElement('div');
    card.className = 'card';

    if (preset.error) {
      card.innerHTML = `
        <div class="card-info">
          <div class="card-name">${preset.file}</div>
          <div class="card-meta" style="color: var(--err)">Invalid JSON: ${preset.error}</div>
        </div>`;
      presetsList.appendChild(card);
      continue;
    }

    const safeId = preset.file.replace(/[^a-zA-Z0-9]/g, '_');
    const meta = [preset.amplifier, preset.pedal1, preset.pedal2, preset.reverb].filter(Boolean).join(' · ');
    card.innerHTML = `
      <div class="card-row">
        <div class="card-info">
          <div class="card-name">${preset.programName}</div>
          <div class="card-meta">${meta}</div>
          <div class="card-file">${preset.file}</div>
        </div>
        <div class="card-actions">
          <button class="preview-button secondary" data-file="${preset.file}" data-target="preview-${safeId}">Preview</button>
          ${slotSelectHtml('write-' + safeId, preset.targetSlot)}
          <button class="write-button" data-file="${preset.file}">Write to Amp</button>
        </div>
      </div>
      <pre class="preview-panel" id="preview-${safeId}" hidden></pre>`;
    presetsList.appendChild(card);
  }

  document.querySelectorAll('.write-button').forEach((btn) => {
    btn.addEventListener('click', onWriteClick);
  });
  document.querySelectorAll('.preview-button').forEach((btn) => {
    btn.addEventListener('click', onPreviewClick);
  });
}

async function onPreviewClick(event) {
  const btn = event.target;
  const file = btn.dataset.file;
  const panel = document.getElementById(btn.dataset.target);

  // toggle off if already open
  if (!panel.hidden) {
    panel.hidden = true;
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Loading...';
  try {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    panel.textContent = JSON.stringify(data.result, null, 2);
    panel.hidden = false;
    log(`Previewed ${file} -- no MIDI, nothing touched the amp.`);
  } catch (err) {
    log(`Preview failed for ${file}: ${err.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Preview';
  }
}

async function onWriteClick(event) {
  const btn = event.target;
  const file = btn.dataset.file;
  const slotSelect = document.getElementById('write-' + file.replace(/[^a-zA-Z0-9]/g, '_') + '-slot');
  const slot = slotSelect.value;

  if (!confirm(`Write "${file}" to slot ${slot}? This overwrites whatever is currently in that slot.`)) {
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Writing...';
  log(`Writing ${file} to ${slot}...`);
  try {
    const res = await fetch('/api/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, slot }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    syncKnobAndPedalsFromResult(data.result);
    selectedRigFile = file;
    updateRigTriggerLabel(loadedPresets.filter((p) => !p.error));
    setRigStatus(`Now playing: "${data.result.programName}" (just written to ${data.result.slot})`, 'ok');

    if (data.result.failed && data.result.failed.length > 0) {
      log(`Done: "${data.result.programName}" written to ${data.result.slot} and applied live, with ${data.result.failed.length} field(s) the amp didn't accept live (known hardware limitation): ${data.result.failed.join(', ')}`, 'ok');
    } else {
      log(`Done: "${data.result.programName}" written to ${data.result.slot} and applied live.`, 'ok');
    }
  } catch (err) {
    log(`Failed: ${err.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Write to Amp';
  }
}

document.getElementById('dump-button').addEventListener('click', async () => {
  const btn = document.getElementById('dump-button');
  const slot = document.getElementById('dump-slot').value;
  const saveAs = document.getElementById('dump-filename').value.trim();

  btn.disabled = true;
  btn.textContent = 'Dumping...';
  log(`Reading slot ${slot} from the amp...`);
  try {
    const res = await fetch('/api/dump', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot, saveAs: saveAs || undefined }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    if (data.result.saved) {
      log(`Saved as presets/${data.result.saved} ("${data.result.preset.programName}").`, 'ok');
      await loadPresets();
    } else {
      log(`Dumped "${data.result.preset.programName}" (no filename given, not saved). Enter a filename to save it.`, 'ok');
    }
  } catch (err) {
    log(`Failed: ${err.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Dump';
  }
});

document.getElementById('refresh-status').addEventListener('click', refreshStatus);

// On page load, Current Rig should reflect what's ACTUALLY playing on the
// amp right now -- from this GUI, the CLI, or the amp's own physical knobs
// -- rather than defaulting to nothing or to an arbitrary first preset.
// Also syncs the Volume knob either way, matched or not.
async function initCurrentRigFromAmp() {
  try {
    const res = await fetch('/api/current-rig');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'unknown error');
    const result = data.result;

    knobValue = clampKnobValue(result.volume);
    renderKnob(knobValue);

    // Live Pedal cards always reflect the amp's real current state,
    // matched-to-a-preset or not.
    livePedalState = { pedal1: result.pedal1, pedal2: result.pedal2, reverb: result.reverb };
    renderLivePedalRow();

    if (result.matched) {
      selectedRigFile = result.file;
      updateRigTriggerLabel(loadedPresets.filter((p) => !p.error));
      setRigStatus(`Now playing: "${result.programName}" (detected from the amp)`, 'ok');
      log(`Current Rig synced: the amp is currently sounding like "${result.programName}".`, 'ok');
    } else {
      const parts = [
        result.amplifier,
        result.pedal1.enabled ? result.pedal1.type : null,
        result.pedal2.enabled ? result.pedal2.type : null,
        result.reverb.enabled ? result.reverb.type : null,
      ].filter(Boolean).join(' · ');
      setRigStatus(`On the amp right now: ${parts || '(unknown)'} -- doesn't match any saved preset.`);
      log("Current Rig synced: the amp's sound doesn't match any saved preset (Volume knob and Live Pedal cards still synced).");
    }
  } catch (err) {
    // Amp not connected (or some other read failure) is a completely
    // normal state on page load -- just keep the defaults quietly, no
    // need to alarm anyone with red error text for this.
    log("Couldn't read the amp's current state (not connected?) -- Current Rig left at defaults.");
  }
}

refreshStatus();
(async () => {
  await Promise.all([loadPresets(), fetchPedalSchema()]);
  renderLivePedalRow(); // defaults, in case the amp read below fails
  await initCurrentRigFromAmp();
})();
log('GUI loaded. Only one client (this GUI, the CLI, or the browser librarian) can hold the MIDI connection at a time.');

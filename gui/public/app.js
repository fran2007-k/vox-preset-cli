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

async function loadPresets() {
  presetsList.innerHTML = '<p class="hint">Loading...</p>';
  rigNameEl.textContent = 'Loading...';
  rigMetaEl.textContent = '';
  const res = await fetch('/api/presets');
  const presets = await res.json();

  renderRigDropdown(presets);
  renderPresetsList(presets);
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

  // keep the current selection if it still exists, otherwise default to the first
  if (!valid.some((p) => p.file === selectedRigFile)) {
    selectedRigFile = valid[0].file;
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
    });
  });

  updateRigTriggerLabel(valid);
}

function updateRigTriggerLabel(presets) {
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

async function onRigPlayClick() {
  const btn = document.getElementById('rig-play-button');
  const file = selectedRigFile;
  if (!file) return;

  btn.disabled = true;
  btn.textContent = 'Playing...';
  log(`Sending ${file} live to the amp's current rig (nothing will be saved)...`);
  try {
    const res = await fetch('/api/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    if (data.result.failed && data.result.failed.length > 0) {
      log(`Done, with ${data.result.failed.length} field(s) the amp didn't accept live (known hardware limitation): ${data.result.failed.join(', ')}`, 'ok');
    } else {
      log(`Done: the amp should now sound like "${data.result.programName}" (${data.result.messageCount} live messages, nothing written).`, 'ok');
    }
  } catch (err) {
    log(`Failed: ${err.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Play Now';
  }
}

document.getElementById('rig-play-button').addEventListener('click', onRigPlayClick);

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
    log(`Done: "${data.result.programName}" written to ${data.result.slot}.`, 'ok');
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

refreshStatus();
loadPresets();
log('GUI loaded. Only one client (this GUI, the CLI, or the browser librarian) can hold the MIDI connection at a time.');

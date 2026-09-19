const SLOTS = ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4'];

const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const presetsList = document.getElementById('presets-list');
const rigList = document.getElementById('rig-list');
const logEl = document.getElementById('log');

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
  rigList.innerHTML = '<p class="hint">Loading...</p>';
  const res = await fetch('/api/presets');
  const presets = await res.json();

  renderRigList(presets);
  renderPresetsList(presets);
}

function renderRigList(presets) {
  if (presets.length === 0) {
    rigList.innerHTML = '<p class="hint">No preset files in presets/ yet.</p>';
    return;
  }

  rigList.innerHTML = '';
  for (const preset of presets) {
    if (preset.error) continue;
    const card = document.createElement('div');
    card.className = 'card';
    const meta = [preset.amplifier, preset.pedal1, preset.pedal2, preset.reverb].filter(Boolean).join(' · ');
    card.innerHTML = `
      <div class="card-row">
        <div class="card-info">
          <div class="card-name">${preset.programName}</div>
          <div class="card-meta">${meta}</div>
          <div class="card-file">${preset.file}</div>
        </div>
        <div class="card-actions">
          <button class="play-button" data-file="${preset.file}">Play Now</button>
        </div>
      </div>`;
    rigList.appendChild(card);
  }

  document.querySelectorAll('.play-button').forEach((btn) => {
    btn.addEventListener('click', onPlayClick);
  });
}

async function onPlayClick(event) {
  const btn = event.target;
  const file = btn.dataset.file;

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

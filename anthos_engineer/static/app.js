// ── Ollama model discovery ─────────────────────────────────────────────────
async function loadOllamaModels() {
  const status = document.getElementById('ollamaStatus');
  try {
    const res = await fetch('http://localhost:11434/api/tags');
    if (!res.ok) throw new Error('non-200');
    const { models } = await res.json();
    if (models && models.length) {
      const currentVal = modelSelect.value;
      modelSelect.innerHTML = '';
      models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.name;
        opt.textContent = m.name;
        modelSelect.appendChild(opt);
      });
      // Preserve selection if still available, else pick first
      const names = models.map(m => m.name);
      modelSelect.value = names.includes(currentVal) ? currentVal : names[0];
    }
    status.textContent = 'Ollama online';
    status.className = 'ollama-status online';
  } catch {
    status.textContent = 'Ollama offline';
    status.className = 'ollama-status offline';
  }
  modelLabel.textContent = `${modelSelect.value} · local`;
}

// ── State ──────────────────────────────────────────────────────────────────
let mode = 'amy';
let currentAmySessionId = null;
let amySessionDisplays = {};   // {session_id: [{role, content, tools}]}
let pendingAttachments = [];   // [{type, data, label}]
let amySending = false;

// ── DOM refs ───────────────────────────────────────────────────────────────
const goalInput        = document.getElementById('goalInput');
const runBtn           = document.getElementById('runBtn');
const sendBtn          = document.getElementById('sendBtn');
const attachBtn        = document.getElementById('attachBtn');
const fileInput        = document.getElementById('fileInput');
const attachPreview    = document.getElementById('attachPreview');
const modelSelect      = document.getElementById('modelSelect');
const modelLabel       = document.getElementById('modelLabel');
const tabAmy           = document.getElementById('tabAmy');
const tabEng           = document.getElementById('tabEng');
// Amy
const amyView          = document.getElementById('amyView');
const chatMessages     = document.getElementById('chatMessages');
const amyHistoryList   = document.getElementById('amyHistoryList');
const newChatBtn       = document.getElementById('newChatBtn');
const amySidebarSection= document.getElementById('amySidebarSection');
// Engineer
const homeView         = document.getElementById('homeView');
const sessionView      = document.getElementById('sessionView');
const sessionGoal      = document.getElementById('sessionGoal');
const sessionStatus    = document.getElementById('sessionStatus');
const planSection      = document.getElementById('planSection');
const planList         = document.getElementById('planList');
const logFeed          = document.getElementById('logFeed');
const filesSection     = document.getElementById('filesSection');
const filesList        = document.getElementById('filesList');
const workspacePath    = document.getElementById('workspacePath');
const historyList      = document.getElementById('historyList');
const engSidebarSection= document.getElementById('engSidebarSection');

// ── Mode switching ─────────────────────────────────────────────────────────
function switchMode(newMode) {
  mode = newMode;
  const isAmy = newMode === 'amy';

  tabAmy.classList.toggle('active', isAmy);
  tabEng.classList.toggle('active', !isAmy);

  amyView.hidden          = !isAmy;
  amySidebarSection.hidden= !isAmy;
  attachBtn.hidden        = !isAmy;
  sendBtn.hidden          = !isAmy;

  engSidebarSection.hidden= isAmy;
  runBtn.hidden           = isAmy;

  // Clear any pending attachments when switching
  pendingAttachments = [];
  attachPreview.hidden = true;
  attachPreview.innerHTML = '';

  if (isAmy) {
    homeView.hidden    = true;
    sessionView.hidden = true;
    goalInput.placeholder = `Message ${modelSelect.value}… (paste code, attach files, or just chat)`;
    if (!currentAmySessionId) initAmySession();
  } else {
    homeView.hidden    = false;
    sessionView.hidden = true;
    goalInput.placeholder = "Describe what you want to build… (e.g. 'Create a Flask REST API with SQLite')";
  }
  goalInput.style.height = 'auto';
}

tabAmy.addEventListener('click', () => switchMode('amy'));
tabEng.addEventListener('click', () => switchMode('engineer'));

// ── Shared input ───────────────────────────────────────────────────────────
modelSelect.addEventListener('change', () => {
  modelLabel.textContent = `${modelSelect.value} · local`;
  if (mode === 'amy') {
    goalInput.placeholder = `Message ${modelSelect.value}… (paste code, attach files, or just chat)`;
  }
});

goalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (mode === 'amy') sendBtn.click();
    else runBtn.click();
  }
});

goalInput.addEventListener('input', () => {
  goalInput.style.height = 'auto';
  goalInput.style.height = Math.min(goalInput.scrollHeight, 160) + 'px';
});

// ── Amy session management ─────────────────────────────────────────────────
newChatBtn.addEventListener('click', async () => {
  currentAmySessionId = null;
  resetChatView();
  await initAmySession();
});

async function initAmySession() {
  try {
    const res = await fetch('/api/amy/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const { session_id } = await res.json();
    currentAmySessionId = session_id;
    amySessionDisplays[session_id] = [];
    addAmySessionToSidebar(session_id, 'New conversation');
  } catch (err) {
    console.error('Amy session init failed:', err);
  }
}

function resetChatView() {
  chatMessages.innerHTML = `
    <div class="amy-welcome">
      <div class="welcome-icon">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="4 17 10 11 4 5"/>
          <line x1="12" y1="19" x2="20" y2="19"/>
        </svg>
      </div>
      <h2>Ready.</h2>
      <p>Drop a message, paste code, or attach a file.</p>
    </div>`;
}

function addAmySessionToSidebar(sessionId, label) {
  const existing = amyHistoryList.querySelector(`[data-session="${sessionId}"]`);
  if (existing) {
    existing.querySelector('.session-label').textContent = label;
    return;
  }
  const li = document.createElement('li');
  li.dataset.session = sessionId;
  li.classList.toggle('active', sessionId === currentAmySessionId);
  const span = document.createElement('span');
  span.className = 'session-label';
  span.textContent = label;
  li.appendChild(span);
  li.title = label;
  li.addEventListener('click', () => switchAmySession(sessionId));
  amyHistoryList.prepend(li);
}

function switchAmySession(sessionId) {
  currentAmySessionId = sessionId;
  amyHistoryList.querySelectorAll('li').forEach(li => {
    li.classList.toggle('active', li.dataset.session === sessionId);
  });
  chatMessages.innerHTML = '';
  const msgs = amySessionDisplays[sessionId] || [];
  if (!msgs.length) { resetChatView(); return; }
  msgs.forEach(m => _renderBubble(m.role, m.content, m.tools || []));
}

// ── Amy send ───────────────────────────────────────────────────────────────
sendBtn.addEventListener('click', sendAmyMessage);

async function sendAmyMessage() {
  const text = goalInput.value.trim();
  if (!text && !pendingAttachments.length) return;
  if (amySending) return;
  if (!currentAmySessionId) await initAmySession();

  amySending = true;
  sendBtn.disabled = true;

  const message = text;
  goalInput.value = '';
  goalInput.style.height = 'auto';

  // Separate attachment types
  const imageAtt = pendingAttachments.find(a => a.type === 'image');
  const textAtts = pendingAttachments.filter(a => a.type === 'text');
  const errAtts  = pendingAttachments.filter(a => a.type === 'error');

  const textBlock = textAtts.map(a => `[${a.label}]\n${a.data}`).join('\n\n---\n\n');
  const fullMessage = [message, textBlock].filter(Boolean).join('\n\n');

  // Display label for user bubble
  const attLabels = pendingAttachments.map(a => `📎 ${a.label}`).join('\n');
  const displayText = [message, attLabels].filter(Boolean).join('\n');

  // Remove welcome screen
  const welcome = chatMessages.querySelector('.amy-welcome');
  if (welcome) welcome.remove();

  appendBubble('user', displayText, []);
  errAtts.forEach(a => appendBubble('system', `⚠ ${a.data}`, []));

  // Clear attachments UI
  pendingAttachments = [];
  attachPreview.hidden = true;
  attachPreview.innerHTML = '';
  fileInput.value = '';

  const typingEl = appendTyping();

  try {
    const turnRes = await fetch('/api/amy/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: currentAmySessionId,
        message: fullMessage || message,
        model: modelSelect.value,
        image_b64: imageAtt ? imageAtt.data : null,
      }),
    });
    const { turn_id } = await turnRes.json();

    const es = new EventSource(`/api/amy/turn/${turn_id}/stream`);
    const toolNames = [];

    es.addEventListener('tool', (e) => {
      const { name } = JSON.parse(e.data);
      toolNames.push(name);
      updateTypingTools(typingEl, toolNames);
    });

    es.addEventListener('message', (e) => {
      const { content } = JSON.parse(e.data);
      typingEl.remove();
      appendBubble('amy', content, toolNames);
      // Store for session restore
      const store = amySessionDisplays[currentAmySessionId] || [];
      store.push({ role: 'user', content: displayText, tools: [] });
      store.push({ role: 'amy',  content,               tools: [...toolNames] });
      amySessionDisplays[currentAmySessionId] = store;
      // Update sidebar label on first message
      if (store.length === 2 && message) {
        const label = message.slice(0, 42) + (message.length > 42 ? '…' : '');
        addAmySessionToSidebar(currentAmySessionId, label);
      }
    });

    es.addEventListener('error_event', (e) => {
      const { message: errMsg } = JSON.parse(e.data);
      typingEl.remove();
      appendBubble('system', `⚠ ${errMsg}`, []);
    });

    es.addEventListener('done', () => {
      es.close();
      amySending = false;
      sendBtn.disabled = false;
    });

    es.onerror = () => {
      es.close();
      if (document.getElementById('typingIndicator')) typingEl.remove();
      appendBubble('system', '⚠ Connection lost — try again.', []);
      amySending = false;
      sendBtn.disabled = false;
    };
  } catch (err) {
    typingEl.remove();
    appendBubble('system', `⚠ ${err.message}`, []);
    amySending = false;
    sendBtn.disabled = false;
  }
}

// ── Chat bubble rendering ──────────────────────────────────────────────────
function appendBubble(role, content, tools) {
  _renderBubble(role, content, tools);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function _renderBubble(role, content, tools) {
  if (role === 'system') {
    const el = document.createElement('div');
    el.className = 'system-msg';
    el.textContent = content;
    chatMessages.appendChild(el);
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = `bubble-wrap ${role}`;

  if (tools && tools.length) {
    const row = document.createElement('div');
    row.className = 'tool-chips';
    tools.forEach(t => {
      const chip = document.createElement('span');
      chip.className = 'tool-chip';
      chip.textContent = `⚙ ${t}`;
      row.appendChild(chip);
    });
    wrap.appendChild(row);
  }

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';

  if (role === 'amy') {
    bubble.innerHTML = renderMarkdown(content);
  } else {
    bubble.textContent = content;
    bubble.style.whiteSpace = 'pre-wrap';
  }

  wrap.appendChild(bubble);
  chatMessages.appendChild(wrap);
}

function appendTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'bubble-wrap amy';
  wrap.id = 'typingIndicator';
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble typing';
  bubble.innerHTML = '<span></span><span></span><span></span>';
  wrap.appendChild(bubble);
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return wrap;
}

function updateTypingTools(typingEl, toolNames) {
  let row = typingEl.querySelector('.tool-chips');
  if (!row) {
    row = document.createElement('div');
    row.className = 'tool-chips';
    typingEl.insertBefore(row, typingEl.firstChild);
  }
  row.innerHTML = '';
  toolNames.forEach(t => {
    const chip = document.createElement('span');
    chip.className = 'tool-chip active';
    chip.textContent = `⚙ ${t}`;
    row.appendChild(chip);
  });
}

function renderMarkdown(raw) {
  // Escape HTML first
  let s = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Fenced code blocks — process before anything else
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) =>
    `<pre><code class="lang-${lang || 'text'}">${code.trimEnd()}</code></pre>`
  );

  // Inline code
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Bold
  s = s.replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/gs,     '<strong>$1</strong>');

  // Italic
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_\n]+)_/g,   '<em>$1</em>');

  // Unordered lists: lines starting with "- " or "* "
  s = s.replace(/^[*-] (.+)/gm, '<li>$1</li>');
  s = s.replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`);

  // Newlines to <br> (skip inside pre blocks)
  const parts = s.split(/(<pre>[\s\S]*?<\/pre>)/g);
  s = parts.map((p, i) => (i % 2 === 0 ? p.replace(/\n/g, '<br>') : p)).join('');

  return s;
}

// ── File attachments ───────────────────────────────────────────────────────
attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => handleFiles(fileInput.files));

async function handleFiles(fileList) {
  for (const file of Array.from(fileList)) {
    await uploadAndQueue(file);
  }
}

async function uploadAndQueue(file) {
  const chip = addAttachmentChip(file.name);
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/amy/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.type === 'error') {
      chip.classList.remove('loading');
      chip.classList.add('error');
      chip.title = data.data;
    } else {
      chip.classList.remove('loading');
      chip.classList.add('ready');
      pendingAttachments.push(data);
    }
  } catch (err) {
    chip.classList.remove('loading');
    chip.classList.add('error');
    chip.title = err.message;
  }
}

function addAttachmentChip(label) {
  attachPreview.hidden = false;
  const chip = document.createElement('span');
  chip.className = 'attach-chip loading';
  const name = document.createElement('span');
  name.className = 'chip-name';
  name.textContent = label;
  const rm = document.createElement('button');
  rm.className = 'chip-remove';
  rm.textContent = '×';
  rm.addEventListener('click', () => {
    const chips = [...attachPreview.querySelectorAll('.attach-chip')];
    const idx = chips.indexOf(chip);
    if (idx >= 0) pendingAttachments.splice(idx, 1);
    chip.remove();
    if (!attachPreview.querySelector('.attach-chip')) attachPreview.hidden = true;
  });
  chip.appendChild(name);
  chip.appendChild(rm);
  attachPreview.appendChild(chip);
  return chip;
}

// Clipboard paste — images
document.addEventListener('paste', async (e) => {
  if (mode !== 'amy') return;
  const items = [...(e.clipboardData?.items || [])];
  const img = items.find(it => it.type.startsWith('image/'));
  if (img) {
    e.preventDefault();
    const file = img.getAsFile();
    if (file) await uploadAndQueue(file);
  }
});

// Drag-and-drop onto chat area
chatMessages.addEventListener('dragover', (e) => {
  if (mode !== 'amy') return;
  e.preventDefault();
  chatMessages.classList.add('drag-over');
});
chatMessages.addEventListener('dragleave', () => {
  chatMessages.classList.remove('drag-over');
});
chatMessages.addEventListener('drop', async (e) => {
  if (mode !== 'amy') return;
  e.preventDefault();
  chatMessages.classList.remove('drag-over');
  await handleFiles(e.dataTransfer.files);
});

// ── Engineer mode ──────────────────────────────────────────────────────────
runBtn.addEventListener('click', async () => {
  const goal = goalInput.value.trim();
  if (!goal) return;
  await startSession(goal);
});

async function startSession(goal) {
  runBtn.disabled = true;
  goalInput.value = '';
  goalInput.style.height = 'auto';

  homeView.hidden    = true;
  sessionView.hidden = false;
  sessionGoal.textContent = goal;
  planSection.hidden = true;
  filesSection.hidden = true;
  planList.innerHTML = '';
  logFeed.innerHTML  = '';
  filesList.innerHTML= '';

  setStatus('planning');
  addLog('info', '⬡', `Planning: ${goal}`);

  try {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal, model: modelSelect.value }),
    });
    const { session_id } = await res.json();
    addToHistory(goal, session_id);
    streamSession(session_id);
  } catch (err) {
    addLog('fail', '✗', `Failed to start: ${err.message}`);
    setStatus('error');
    runBtn.disabled = false;
  }
}

function streamSession(sessionId) {
  const es = new EventSource(`/api/session/${sessionId}/stream`);
  const planItems = [];

  es.addEventListener('status', (e) => {
    const { message } = JSON.parse(e.data);
    addLog('info', '<span class="spinner"></span>', message);
  });

  es.addEventListener('chat', (e) => {
    const { message } = JSON.parse(e.data);
    const last = logFeed.lastElementChild;
    if (last) last.remove();
    addLog('ok', '⬡', message);
  });

  es.addEventListener('plan', (e) => {
    const { steps } = JSON.parse(e.data);
    planSection.hidden = false;
    planList.innerHTML = '';
    steps.forEach((step, i) => {
      const li = document.createElement('li');
      li.id = `plan-step-${i}`;
      li.innerHTML = `
        <span class="step-action">${step.action}</span>
        <span class="step-desc">${step.description}</span>
        <span class="step-target">${step.target}</span>
      `;
      planList.appendChild(li);
      planItems.push(li);
    });
    setStatus('executing');
    addLog('info', '✦', `${steps.length}-step plan ready — executing…`);
  });

  es.addEventListener('step_start', (e) => {
    const { index, action, target, description } = JSON.parse(e.data);
    if (planItems[index]) {
      planItems.forEach(li => li.classList.remove('active'));
      planItems[index].classList.add('active');
      planItems[index].scrollIntoView({ block: 'nearest' });
    }
    addLog('info', '<span class="spinner"></span>', `${action}: ${description}`, target);
  });

  es.addEventListener('step_done', (e) => {
    const { index, success, output } = JSON.parse(e.data);
    if (planItems[index]) {
      planItems[index].classList.remove('active');
      planItems[index].classList.add(success ? 'done-step' : 'failed-step');
    }
    const last = logFeed.lastElementChild;
    if (last) last.remove();
    addLog(
      success ? 'ok' : 'fail',
      success ? '✓' : '✗',
      planItems[index]?.querySelector('.step-desc')?.textContent || '',
      output,
    );
  });

  es.addEventListener('done', (e) => {
    const { files, workspace } = JSON.parse(e.data);
    setStatus('done');
    es.close();
    runBtn.disabled = false;

    if (files.length) {
      filesSection.hidden = false;
      filesList.innerHTML = '';
      files.forEach(f => {
        const li = document.createElement('li');
        li.textContent = f;
        filesList.appendChild(li);
      });
      workspacePath.textContent = `Workspace: ${workspace}`;
    }

    addLog('ok', '✦', `Done — ${files.length} file${files.length !== 1 ? 's' : ''} created`);
  });

  es.onerror = () => {
    es.close();
    setStatus('error');
    runBtn.disabled = false;
    addLog('fail', '✗', 'Connection lost');
  };
}

function setStatus(state) {
  sessionStatus.className = `status-chip ${state}`;
  sessionStatus.textContent = state.charAt(0).toUpperCase() + state.slice(1);
}

function addLog(type, icon, text, output = '') {
  const el = document.createElement('div');
  el.className = `log-entry ${type}`;
  el.innerHTML = `
    <span class="log-icon">${icon}</span>
    <div class="log-text">
      ${text}
      ${output ? `<div class="log-output">${escHtml(output)}</div>` : ''}
    </div>
  `;
  logFeed.appendChild(el);
  el.scrollIntoView({ block: 'nearest' });
  return el;
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function addToHistory(goal, sessionId) {
  const li = document.createElement('li');
  li.textContent = goal;
  li.title = goal;
  li.addEventListener('click', () => {
    homeView.hidden    = true;
    sessionView.hidden = false;
    sessionGoal.textContent = goal;
    setStatus('done');
  });
  historyList.prepend(li);
}

// ── Init ───────────────────────────────────────────────────────────────────
loadOllamaModels().then(() => switchMode('amy'));

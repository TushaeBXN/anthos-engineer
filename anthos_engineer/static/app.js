const goalInput = document.getElementById('goalInput');
const runBtn = document.getElementById('runBtn');
const modelSelect = document.getElementById('modelSelect');
const modelLabel = document.getElementById('modelLabel');
const homeView = document.getElementById('homeView');
const sessionView = document.getElementById('sessionView');
const sessionGoal = document.getElementById('sessionGoal');
const sessionStatus = document.getElementById('sessionStatus');
const planSection = document.getElementById('planSection');
const planList = document.getElementById('planList');
const logFeed = document.getElementById('logFeed');
const filesSection = document.getElementById('filesSection');
const filesList = document.getElementById('filesList');
const workspacePath = document.getElementById('workspacePath');
const historyList = document.getElementById('historyList');

modelSelect.addEventListener('change', () => {
  modelLabel.textContent = `${modelSelect.value} · local`;
});

goalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    runBtn.click();
  }
});

goalInput.addEventListener('input', () => {
  goalInput.style.height = 'auto';
  goalInput.style.height = Math.min(goalInput.scrollHeight, 120) + 'px';
});

runBtn.addEventListener('click', async () => {
  const goal = goalInput.value.trim();
  if (!goal) return;
  await startSession(goal);
});

async function startSession(goal) {
  runBtn.disabled = true;
  goalInput.value = '';
  goalInput.style.height = 'auto';

  // Switch to session view
  homeView.hidden = true;
  sessionView.hidden = false;
  sessionGoal.textContent = goal;
  planSection.hidden = true;
  filesSection.hidden = true;
  planList.innerHTML = '';
  logFeed.innerHTML = '';
  filesList.innerHTML = '';

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
    // Replace last log entry (the spinner one) with result
    const last = logFeed.lastElementChild;
    if (last) last.remove();
    addLog(success ? 'ok' : 'fail', success ? '✓' : '✗',
      planItems[index]?.querySelector('.step-desc')?.textContent || '',
      output
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
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function addToHistory(goal, sessionId) {
  const li = document.createElement('li');
  li.textContent = goal;
  li.title = goal;
  li.addEventListener('click', () => {
    homeView.hidden = true;
    sessionView.hidden = false;
    sessionGoal.textContent = goal;
    setStatus('done');
  });
  historyList.prepend(li);
}

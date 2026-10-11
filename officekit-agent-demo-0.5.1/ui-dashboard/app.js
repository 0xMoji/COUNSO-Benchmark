'use strict';
(() => {
  const STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING', 'CLOSED'];
  const ACTIVE = STATUSES.slice(0, 3);
  const $ = id => document.getElementById(id);
  const boxes = [...document.querySelectorAll('#status-options input')];
  let source = null;
  let shown = null;
  let intent = 0;
  let phase = 'loading';
  let notice = '';
  let requested = null;

  function copyScope(scope) {
    return { team_ids: [...scope.team_ids], statuses: [...scope.statuses], created_from: scope.created_from, created_to: scope.created_to };
  }
  function controlsScope() {
    return { team_ids: $('team').value ? [$('team').value] : [], statuses: boxes.filter(x => x.checked).map(x => x.value), created_from: $('from').value, created_to: $('to').value };
  }
  function defaults(snapshot) {
    return { team_ids: [], statuses: [...STATUSES], created_from: snapshot.default_created_from, created_to: snapshot.default_created_to };
  }
  function writeControls(scope) {
    $('team').value = scope.team_ids[0] || '';
    $('from').value = scope.created_from;
    $('to').value = scope.created_to;
    boxes.forEach(x => { x.checked = scope.statuses.includes(x.value); });
  }
  function updateTeams(snapshot, scope) {
    $('team').replaceChildren(new Option('All teams', ''));
    for (const team of snapshot.teams) {
      $('team').add(new Option(`${team.display_name} · ${team.team_id}`, team.team_id));
    }
    $('team').value = scope.team_ids[0] || '';
  }
  function enableControls() {
    [$('team'), $('from'), $('to'), ...boxes, $('refresh'), $('reset')].forEach(x => { x.disabled = false; });
  }
  function dateValid(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  function validScope(scope) {
    return dateValid(scope.created_from) && dateValid(scope.created_to) && scope.created_from <= scope.created_to;
  }
  function sameScope(a, b) {
    return a && b && a.created_from === b.created_from && a.created_to === b.created_to &&
      JSON.stringify([...a.team_ids].sort()) === JSON.stringify([...b.team_ids].sort()) &&
      JSON.stringify([...a.statuses].sort()) === JSON.stringify([...b.statuses].sort());
  }
  function scopeWords(scope, snapshot) {
    const teams = scope.team_ids.length ? scope.team_ids.map(id => {
      const team = snapshot.teams.find(t => t.team_id === id);
      return team ? `${team.display_name} (${id})` : id;
    }).join(', ') : 'All teams';
    const statuses = scope.statuses.length ? scope.statuses.join(', ') : 'No statuses';
    return `${teams} · ${statuses} · UTC created [${scope.created_from}, ${scope.created_to})`;
  }
  function stateMessage(message, error = '') {
    $('message').textContent = message;
    $('error-text').textContent = error;
    $('failure').hidden = !error;
    $('invalidation').textContent = notice;
    $('invalidation').hidden = !notice;
    const prior = !!shown && phase !== 'ready';
    $('results').classList.toggle('prior', prior);
    $('displayed-scope').classList.toggle('prior', prior);
    $('results').setAttribute('aria-busy', phase === 'loading' ? 'true' : 'false');
    if (shown) {
      $('scope-text').textContent = `${prior ? 'Prior successful results, retained while the requested scope is pending or failed: ' : ''}${scopeWords(shown.scope, shown.snapshot)}`;
      $('revision').textContent = `Source revision: ${shown.snapshot.snapshot_revision} · Source as-of: ${shown.snapshot.as_of} · Due times are UTC`;
    }
  }
  async function read(path, args) {
    const options = args === undefined ? { method: 'GET', cache: 'no-store' } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args), cache: 'no-store'
    };
    const response = await fetch(path, options);
    const result = await response.json();
    if (!response.ok || result.ok !== true) {
      throw new Error(result.code || result.error?.code || `HTTP ${response.status}`);
    }
    if (!result.snapshot || !Array.isArray(result.snapshot.teams) || !Array.isArray(result.snapshot.tickets)) {
      throw new Error('Invalid source response');
    }
    return result;
  }
  function setMetric(id, value, unit) {
    $(id).textContent = `${value} ${unit}`;
  }
  function render(result) {
    shown = { scope: copyScope(result.scope), snapshot: result.snapshot, rows: result.rows };
    const rows = result.rows;
    const active = rows.filter(row => ACTIVE.includes(row.status));
    const asOf = Date.parse(result.snapshot.as_of);
    setMetric('ticket-count', rows.length, 'tickets');
    setMetric('active-count', active.length, 'tickets');
    setMetric('overdue-count', active.filter(row => Date.parse(row.due_at) < asOf).length, 'tickets');
    const minutes = active.reduce((sum, row) => sum + row.remaining_minutes, 0);
    const hours = minutes / 60;
    setMetric('effort', Number.isInteger(hours) ? String(hours) : hours.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''), 'hours');
    $('effort').title = `${minutes} active remaining minutes ÷ 60 = ${hours} hours`;
    $('effort').dataset.exactHours = String(hours);
    const counts = ACTIVE.map(status => active.filter(row => row.status === status).length);
    const maximum = Math.max(1, ...counts);
    $('chart-scale').textContent = `Scale: 0–${maximum} tickets`;
    $('chart').replaceChildren();
    ACTIVE.forEach((status, i) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'bar-button';
      button.setAttribute('aria-label', `Select ${status}`);
      button.setAttribute('aria-pressed', String(result.scope.statuses.length === 1 && result.scope.statuses[0] === status));
      const number = document.createElement('span'); number.className = 'bar-count'; number.setAttribute('aria-label', `${status} count`); number.textContent = counts[i];
      const plot = document.createElement('div'); plot.className = 'plot'; plot.setAttribute('aria-label', `${status} plot`);
      const glyph = document.createElement('div'); glyph.className = 'glyph'; glyph.setAttribute('aria-label', `${status} plotted count`); glyph.style.height = `${160 * counts[i] / maximum}px`;
      plot.append(glyph);
      const label = document.createElement('span'); label.className = 'bar-name'; label.textContent = status;
      button.append(number, plot, label);
      button.addEventListener('click', () => {
        boxes.forEach(box => { box.checked = box.value === status; });
        changeScope();
      });
      $('chart').append(button);
    });
    $('ticket-rows').replaceChildren();
    rows.forEach(row => {
      const tr = document.createElement('tr');
      const team = result.snapshot.teams.find(t => t.team_id === row.team_id);
      [row.ticket_id, row.team_id, team?.display_name || 'Unknown team', row.status, row.created_at, row.due_at, row.remaining_minutes].forEach((value, i) => {
        const cell = document.createElement('td');
        if (i === 3) { const pill = document.createElement('span'); pill.className = `status-pill ${row.status}`; pill.textContent = value; cell.append(pill); }
        else cell.textContent = String(value);
        if (i === 6) cell.className = 'numeric';
        tr.append(cell);
      });
      $('ticket-rows').append(tr);
    });
    $('row-count').textContent = `${rows.length} matching tickets`;
    $('empty').hidden = rows.length !== 0;
    $('results').hidden = false;
    phase = 'ready';
    stateMessage(rows.length ? 'Loaded successfully. All displayed results share the scope below.' : 'Loaded successfully. No records match the displayed scope.');
  }
  function fail(token, error) {
    if (token !== intent) return;
    phase = 'error';
    stateMessage('Read failed. Your requested filters are preserved.', `Could not load data (${error.message}). Retry reads the current requested scope.`);
  }
  async function load(scope, token) {
    if (token !== intent) return;
    requested = copyScope(scope);
    if (!validScope(scope)) {
      phase = 'invalid';
      stateMessage('Enter valid UTC dates before loading.', 'Created dates must be valid YYYY-MM-DD dates, with the end on or after the start. Your filters are preserved.');
      return;
    }
    phase = 'loading';
    stateMessage(`Loading requested scope: ${scopeWords(scope, source)}`);
    try {
      const result = await read('/api/dashboard-load', scope);
      if (token !== intent) return;
      if (!sameScope(result.scope, scope) || !Array.isArray(result.rows)) throw new Error('Response scope does not match the requested scope');
      source = result.snapshot;
      const missing = scope.team_ids.filter(id => !source.teams.some(team => team.team_id === id));
      if (missing.length) {
        notice = `Selected team ${missing.join(', ')} no longer exists in source revision ${source.snapshot_revision}. The team filter was reset to All teams; other filters are preserved.`;
        const revised = copyScope(scope); revised.team_ids = [];
        updateTeams(source, revised); writeControls(revised);
        await load(revised, token);
        return;
      }
      updateTeams(source, scope);
      writeControls(scope);
      render(result);
    } catch (error) { fail(token, error); }
  }
  function changeScope() {
    if (!source) return;
    notice = '';
    load(controlsScope(), ++intent);
  }
  async function initialize(reset = false) {
    const token = ++intent;
    notice = '';
    phase = 'loading';
    stateMessage(reset ? 'Reading current source defaults…' : 'Reading source…');
    try {
      const result = await read('/api/dashboard-source');
      if (token !== intent) return;
      source = result.snapshot;
      const scope = defaults(source);
      updateTeams(source, scope); writeControls(scope); enableControls();
      await load(scope, token);
    } catch (error) { fail(token, error); }
  }
  $('team').addEventListener('change', changeScope);
  $('from').addEventListener('change', changeScope);
  $('to').addEventListener('change', changeScope);
  boxes.forEach(box => box.addEventListener('change', changeScope));
  $('refresh').addEventListener('click', () => { if (source) load(controlsScope(), ++intent); else initialize(); });
  $('reset').addEventListener('click', () => initialize(true));
  $('retry').addEventListener('click', () => { if (source) load(controlsScope(), ++intent); else initialize(); });
  $('refresh').disabled = true; $('reset').disabled = true;
  initialize();
})();

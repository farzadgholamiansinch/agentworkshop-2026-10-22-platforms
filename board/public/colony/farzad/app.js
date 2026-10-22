'use strict';
(function () {
  const API = '/t/farzad/api';
  const INFLIGHT_LIMIT = 50;
  const POLL_MS = 1000;
  const STATES = ['reachable', 'initializing', 'restarting', 'unreachable', 'disabled'];
  const OOS_MARK = '\u00b1';

  let state = null;
  let selected = null;
  let timer = null;
  let polling = false;

  const $ = (id) => document.getElementById(id);

  function el(tag, opts, ...children) {
    const e = document.createElement(tag);
    if (opts) {
      if (opts.cls) e.className = opts.cls;
      if (opts.text != null) e.textContent = String(opts.text);
      if (opts.title) e.title = opts.title;
      if (opts.type) e.type = opts.type;
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }

  async function api(method, path, body) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const r = await fetch(API + path, init);
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { status: r.status, ok: r.ok, json, text };
  }

  function fmtMs(v) { return v == null ? '-' : `${v} ms`; }

  function ageText(ts) {
    if (ts == null) return 'never';
    const s = (Date.now() - ts) / 1000;
    return s < 0 ? 'just now' : `${s.toFixed(1)} s ago`;
  }

  // ---- header ----
  function renderSummary(s) {
    const m = s.metrics || {};
    const mesh = m.mesh || {};
    const gw = m.gateway || {};
    const item = (label, value, cls, title) => {
      const span = el('span', { title }, `${label} `);
      span.append(el('b', { text: value, cls }));
      return span;
    };
    $('summary').replaceChildren(
      item('mode', s.switching ? `${s.mode} (switching)` : s.mode, `mode-${s.mode}`),
      item('links open', `${s.openConnections ?? '-'}/${s.possibleLinks ?? '-'}`, null, 'openConnections / possibleLinks'),
      item('detect mesh', fmtMs(mesh.detectMs), null, `latest; average ${fmtMs(mesh.detectMsAvg)}`),
      item('detect gateway', fmtMs(gw.detectMs), null, `latest; average ${fmtMs(gw.detectMsAvg)}`),
      item('nodes', String((s.nodes || []).length))
    );
  }

  // ---- link matrix ----
  function matrixColumns(s) {
    const nodes = s.nodes || [];
    const links = s.links || [];
    const hasGw = links.some((l) => l.to === 'gateway');
    if (s.mode === 'gateway') return ['gateway'];
    const cols = nodes.filter((n) => !n.external).map((n) => n.nodeId);
    for (const l of links) if (l.to !== 'gateway' && !cols.includes(l.to)) cols.push(l.to);
    if (hasGw) cols.push('gateway');
    return cols;
  }

  function linkTitle(l) {
    const parts = [`${l.from} \u2192 ${l.to}: ${l.state}`];
    if (l.clockSync != null) parts.push(`clock ${l.clockSync} sync, offset ${l.offsetMs ?? '-'} ms`);
    parts.push(`last heartbeat ${ageText(l.lastHeartbeatTs)}`);
    return parts.join('\n');
  }

  function renderMatrix(s) {
    const nodes = s.nodes || [];
    const byPair = new Map();
    for (const l of s.links || []) byPair.set(`${l.from}\u0000${l.to}`, l);
    const cols = matrixColumns(s);

    const headRow = el('tr', null, el('th', { text: 'from \\ to', cls: 'corner' }));
    for (const c of cols) headRow.append(el('th', { text: c === 'gateway' ? 'gw' : c, title: c }));
    const thead = el('thead', null, headRow);

    const tbody = el('tbody');
    for (const n of nodes) {
      const btn = el('button', { type: 'button', text: n.nodeId, title: `${n.nodeId}: ${n.status}, messaging ${n.messaging}` });
      btn.addEventListener('click', () => { selected = n.nodeId; render(); });
      const th = el('th', { cls: `row st-${n.status}${selected === n.nodeId ? ' sel' : ''}` }, btn);
      if (n.external) th.append(el('span', { cls: 'ext', text: 'ext', title: 'external node' }));
      const tr = el('tr', null, th);
      for (const c of cols) {
        const td = el('td');
        if (c === 'gateway') td.className = 'gw';
        const l = byPair.get(`${n.nodeId}\u0000${c}`);
        if (c === n.nodeId) {
          td.classList.add('s-self');
        } else if (!l) {
          td.classList.add('s-none');
          td.title = `${n.nodeId} \u2192 ${c}: no link`;
        } else {
          td.classList.add(STATES.includes(l.state) ? `s-${l.state}` : 's-unknown');
          td.title = linkTitle(l);
          if (l.clockSync === 'out') {
            td.classList.add('oos');
            td.textContent = OOS_MARK;
          }
        }
        tr.append(td);
      }
      tbody.append(tr);
    }
    $('matrix').replaceChildren(thead, tbody);
  }

  function renderLegend() {
    const items = STATES.map((st) => el('span', null, el('span', { cls: `sw s-${st}` }), st));
    const oos = el('span', { cls: 'sw s-reachable oos', text: OOS_MARK });
    items.push(el('span', { title: '|offsetMs| > 100' }, oos, 'clock out of sync'));
    items.push(el('span', null, el('span', { cls: 'sw s-none' }), 'no link'));
    $('legend').replaceChildren(...items);
  }

  // ---- node panel ----
  function renderNode() {
    const panel = $('nodePanel');
    const n = state && (state.nodes || []).find((x) => x.nodeId === selected);
    if (!n) {
      $('nodeTitle').textContent = selected ? `${selected} is gone` : 'pick a row in the matrix';
      panel.replaceChildren();
      return;
    }
    $('nodeTitle').textContent = `${n.nodeId}${n.external ? ' (external)' : ''}`;
    const statusCls = n.status === 'up' ? 'ok' : n.status === 'down' ? 'bad' : 'warn';
    const pct = Math.min(100, Math.round(((n.inflight || 0) / INFLIGHT_LIMIT) * 100));
    const bar = el('span', { cls: `bar${pct >= 80 ? ' hot' : ''}` }, el('i'));
    bar.firstChild.style.width = `${pct}%`;
    const ch = n.chaos || {};
    const kv = el('dl', { cls: 'kv' },
      el('dt', { text: 'status' }), el('dd', { text: n.status, cls: statusCls }),
      el('dt', { text: 'messaging' }), el('dd', { text: n.messaging, cls: n.messaging === 'enabled' ? 'ok' : 'warn' }),
      el('dt', { text: 'inflight' }), el('dd', null, bar, `${n.inflight ?? 0} / ${INFLIGHT_LIMIT}`),
      el('dt', { text: 'chaos' }), el('dd', { text: `delay ${ch.delayMs ?? 0} ms, drop ${ch.dropPercent ?? 0}%, skew ${ch.skewMs ?? 0} ms` }));

    const apps = el('ul', { cls: 'apps' });
    for (const a of n.apps || []) {
      const li = el('li', null, el('b', { text: a.appId }));
      const types = Object.entries(a.msgTypes || {}).map(([k, v]) => `${k}=${v}`);
      if (types.length) li.append(` types ${types.join(', ')}`);
      for (const lid of a.listenerIds || []) li.append(el('div', { cls: 'lid', text: `listener ${lid}` }));
      apps.append(li);
    }
    if (!(n.apps || []).length) apps.append(el('li', { cls: 'hint', text: 'no apps' }));

    panel.replaceChildren(kv, el('h3', { text: 'apps and listeners' }), apps);
  }

  // ---- send console ----
  function setOptions(select, values, fallback) {
    const key = values.join('\u0000');
    if (select.dataset.key === key) return;
    const prev = select.value || fallback;
    select.replaceChildren(...values.map((v) => { const o = el('option', { text: v }); o.value = v; return o; }));
    select.dataset.key = key;
    if (values.includes(prev)) select.value = prev;
    else if (fallback && values.includes(fallback)) select.value = fallback;
  }

  function appsOf(nodeId) {
    const n = state && (state.nodes || []).find((x) => x.nodeId === nodeId);
    return n ? n.apps || [] : [];
  }

  function fillSendForm() {
    if (!state) return;
    const nodes = (state.nodes || []).map((n) => n.nodeId);
    setOptions($('fFrom'), nodes, nodes[0]);
    const fromApps = appsOf($('fFrom').value).map((a) => a.appId);
    setOptions($('fFromApp'), fromApps, 'echo');
    setOptions($('fToNode'), nodes.concat('*'), nodes[1] || nodes[0]);
    const allApps = [];
    const listeners = [];
    for (const n of state.nodes || []) {
      for (const a of n.apps || []) {
        if (!allApps.includes(a.appId)) allApps.push(a.appId);
        for (const lid of a.listenerIds || []) if (!listeners.includes(lid)) listeners.push(lid);
      }
    }
    setOptions($('fToApp'), allApps.concat('*'), 'echo');
    const dl = $('listenerList');
    const lkey = listeners.join('\u0000');
    if (dl.dataset.key !== lkey) {
      dl.replaceChildren(...listeners.map((v) => { const o = el('option'); o.value = v; return o; }));
      dl.dataset.key = lkey;
    }
    syncTypeFields();
  }

  function syncTypeFields() {
    $('fScope').disabled = $('fType').value !== 'broadcast';
  }

  function buildSendBody() {
    const type = $('fType').value;
    const listener = $('fListener').value.trim();
    const body = {
      from: { nodeId: $('fFrom').value, appId: $('fFromApp').value },
      type,
      to: { nodeId: $('fToNode').value, appId: $('fToApp').value, listenerId: listener || null },
    };
    if (type === 'broadcast') body.scope = $('fScope').value;
    const mt = $('fMsgType').value.trim();
    if (mt !== '') body.msgTypeId = Number(mt);
    const raw = $('fPayload').value.trim();
    body.payload = raw === '' ? {} : JSON.parse(raw);
    const ttl = $('fTtl').value.trim();
    if (ttl !== '') body.ttlMs = Number(ttl);
    return body;
  }

  function renderJson(pre, value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const lines = text.split('\n');
    const nodes = [];
    lines.forEach((line, i) => {
      if (/^\s*"(code|at)":/.test(line)) nodes.push(el('span', { cls: 'hl', text: line }));
      else nodes.push(line);
      if (i < lines.length - 1) nodes.push('\n');
    });
    pre.replaceChildren(...nodes);
  }

  function collectErrors(j) {
    const out = [];
    if (!j || typeof j !== 'object') return out;
    if (j.error && typeof j.error === 'object') out.push({ code: j.error.code, at: j.error.at });
    for (const f of Array.isArray(j.failed) ? j.failed : []) out.push({ code: f.code, at: f.at || f.nodeId });
    return out;
  }

  function renderResponse(r) {
    $('respStatus').textContent = `HTTP ${r.status}`;
    const badges = [];
    if (r.json && r.json.outcome) badges.push(el('span', { cls: `badge out ${r.json.outcome}`, text: `outcome ${r.json.outcome}` }));
    if (r.json && r.json.latencyMs != null) badges.push(el('span', { cls: 'hint', text: `${r.json.latencyMs} ms` }));
    for (const e of collectErrors(r.json)) {
      if (e.code) badges.push(el('span', { cls: 'badge code', text: e.code }));
      if (e.at) badges.push(el('span', { cls: 'badge at', text: `at ${e.at}` }));
    }
    $('respBadges').replaceChildren(...badges);
    renderJson($('respOut'), r.json != null ? r.json : r.text || '(empty body)');
  }

  async function onSend(ev) {
    ev.preventDefault();
    let body;
    try {
      body = buildSendBody();
    } catch (e) {
      $('sendNote').textContent = `payload is not valid JSON: ${e.message}`;
      return;
    }
    $('sendNote').textContent = 'sending\u2026';
    $('fSubmit').disabled = true;
    renderJson($('reqOut'), body);
    $('respBadges').replaceChildren();
    $('respStatus').textContent = '';
    $('respOut').replaceChildren();
    try {
      const r = await api('POST', '/send', body);
      renderResponse(r);
      $('sendNote').textContent = '';
    } catch (e) {
      $('sendNote').textContent = `send failed: ${e.message}`;
    } finally {
      $('fSubmit').disabled = false;
    }
  }

  // ---- polling ----
  function render() {
    if (!state) return;
    renderSummary(state);
    renderMatrix(state);
    renderNode();
    fillSendForm();
  }

  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      const r = await api('GET', '/state');
      if (!r.ok || !r.json) throw new Error(r.json && r.json.error ? r.json.error.code : `HTTP ${r.status}`);
      state = r.json;
      $('stateErr').textContent = '';
      render();
    } catch (e) {
      $('stateErr').textContent = `state: ${e.message}`;
    } finally {
      polling = false;
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (document.hidden) return;
    timer = setTimeout(async () => { await refresh(); schedule(); }, POLL_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(timer); timer = null; } else { refresh().then(schedule); }
  });
  $('sendForm').addEventListener('submit', onSend);
  $('fType').addEventListener('change', () => {
    syncTypeFields();
    if ($('fType').value === 'broadcast') { $('fToNode').value = '*'; $('fListener').value = ''; }
  });
  $('fFrom').addEventListener('change', () => fillSendForm());

  renderLegend();
  refresh().then(schedule);
})();

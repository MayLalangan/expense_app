/* Shared Expenses – single-page frontend (no build step).
 * All user-provided text is inserted with textContent via h(); never innerHTML. */
(() => {
  'use strict';

  const Money = window.Money;
  const state = { user: null, csrf: null, groups: [], group: null, unread: 0 };
  const main = document.getElementById('main');
  const topbar = document.getElementById('topbar');
  const sidenav = document.getElementById('sidenav');
  const dialog = document.getElementById('dialog');
  let routeSeq = 0;

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (['value', 'checked', 'selected', 'disabled', 'hidden', 'multiple', 'required'].includes(k)) el[k] = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(el, children);
    return el;
  }
  /** Appends a node, a string, or a (nested) array of them. */
  function append(el, children) {
    for (const c of [children].flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  function render(...nodes) {
    main.replaceChildren(...nodes.flat());
  }
  function focusMain() {
    const heading = main.querySelector('h1');
    (heading || main).setAttribute('tabindex', '-1');
    (heading || main).focus({ preventScroll: false });
  }

  function toast(message, kind = '') {
    const el = h('div', { class: `toast ${kind}` }, message);
    document.getElementById('toasts').append(el);
    setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4000);
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  const currency = () => state.group?.currency || Money.DEFAULT_CURRENCY;
  const money = (minor) => (minor === null || minor === undefined ? '—' : Money.format(minor, currency()));
  const dateFmt = new Intl.DateTimeFormat(Money.DEFAULT_LOCALE, { dateStyle: 'medium', timeZone: 'UTC' });
  const dateTimeFmt = new Intl.DateTimeFormat(Money.DEFAULT_LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
  // Calendar dates (YYYY-MM-DD) are days, not instants: format in UTC so they never shift.
  const fmtDate = (d) => (d ? dateFmt.format(new Date(`${d}T00:00:00Z`)) : '—');
  // Server timestamps are UTC instants: show them in the viewer's local time zone.
  const fmtDateTime = (iso) => (iso ? dateTimeFmt.format(new Date(iso)) : '—');
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const fmtSize = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // Suggestions use "purchased" internally; on the checklist that means "Done".
  const statusLabel = (st) => (st === 'purchased' ? 'Done' : cap(st));

  function badge(status, label) {
    return h('span', { class: `badge ${status}` }, label || cap(status));
  }

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------
  async function api(path, { method = 'GET', body } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) headers['X-CSRF-Token'] = state.csrf;
    let res;
    try {
      res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
    } catch {
      throw Object.assign(new Error('Network error. Check your connection and try again.'), { status: 0 });
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.startsWith('/auth/')) {
      state.user = null;
      toast(data.error || 'Please sign in.', 'error');
      go(`#/signin?next=${encodeURIComponent(location.hash)}`);
      throw Object.assign(new Error(data.error || 'Please sign in.'), { status: 401, handled: true });
    }
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { status: res.status, details: data.details });
    return data;
  }

  /** Multipart upload with progress (fetch has no upload progress). */
  function uploadFiles(path, files, { replacesId, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      if (replacesId) fd.append('replacesId', String(replacesId));
      for (const f of files) fd.append('files', f, f.name);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api${path}`);
      xhr.setRequestHeader('X-CSRF-Token', state.csrf);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(Object.assign(new Error(data.error || `Upload failed (${xhr.status}).`), { status: xhr.status }));
      };
      xhr.onerror = () => reject(new Error('Network error during upload.'));
      xhr.send(fd);
    });
  }

  // ---------------------------------------------------------------------------
  // Record type definitions (mirror src/records.js)
  // ---------------------------------------------------------------------------
  const SUGGESTION_STATUSES = ['suggested', 'approved', 'planned', 'purchased', 'cancelled'];
  const TYPES = {
    'budget-entries': {
      key: 'budget_entry', label: 'Budget entry', plural: 'Budget entries', nav: 'Budget',
      titleKey: 'source', amountKey: 'amountMinor', dateKey: 'receivedDate', dateLabel: 'Received',
      blurb: 'Money received into or allocated to the shared budget.',
      fields: [
        { key: 'source', label: 'Source / name', required: true, max: 200, full: true, placeholder: 'e.g. Monthly contribution – May' },
        { key: 'amountMinor', input: 'amount', label: 'Amount', kind: 'money', required: true },
        { key: 'receivedDate', label: 'Received date', kind: 'date', required: true, default: today },
        { key: 'description', label: 'Description', kind: 'textarea', max: 2000, full: true },
      ],
    },
    expenses: {
      key: 'expense', label: 'Expense', plural: 'Expenses', nav: 'Expenses',
      titleKey: 'title', amountKey: 'amountMinor', dateKey: 'expenseDate', dateLabel: 'Date',
      blurb: 'Money actually spent from the shared budget.',
      fields: [
        { key: 'title', label: 'Title', required: true, max: 200, full: true, placeholder: 'e.g. Groceries' },
        { key: 'amountMinor', input: 'amount', label: 'Amount', kind: 'money', required: true },
        { key: 'expenseDate', label: 'Expense date', kind: 'date', required: true, default: today },
        { key: 'category', label: 'Category', max: 60, list: 'category-list', placeholder: 'e.g. Food' },
        { key: 'description', label: 'Description', kind: 'textarea', max: 2000, full: true },
      ],
    },
    suggestions: {
      key: 'suggested_purchase', label: 'Suggested purchase', plural: 'Suggested purchases', nav: 'Suggestions',
      titleKey: 'itemName', amountKey: 'expectedPriceMinor', dateKey: 'targetDate', dateLabel: 'Target',
      blurb: 'A shared checklist of things to buy. Prices are optional estimates and never affect the budget or balance.',
      fields: [
        { key: 'itemName', label: 'Item / product', required: true, max: 200, full: true },
        { key: 'expectedPriceMinor', input: 'expectedPrice', label: 'Expected price', kind: 'money', help: 'Optional.' },
        { key: 'targetDate', label: 'Target date', kind: 'date' },
        { key: 'productUrl', label: 'Product link', kind: 'url', full: true, placeholder: 'https://…' },
        { key: 'notes', label: 'Notes', kind: 'textarea', max: 2000, full: true },
        { key: 'purchaseStatus', label: 'Status', kind: 'select', options: ['suggested', 'approved', 'planned', 'cancelled'], editOnly: true },
      ],
    },
  };
  const TYPE_BY_KEY = Object.fromEntries(Object.entries(TYPES).map(([path, t]) => [t.key, { ...t, path }]));
  const FIELD_LABELS = Object.fromEntries(Object.values(TYPES).flatMap((t) => t.fields.map((f) => [f.key, f.label])));
  FIELD_LABELS.purchaseStatus = 'Status';

  // ---------------------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------------------
  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [pathPart, queryPart = ''] = raw.split('?');
    return { parts: pathPart.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(queryPart) };
  }

  async function route() {
    const seq = ++routeSeq;
    const { parts, query } = parseHash();
    const isCurrent = () => seq === routeSeq;
    dialog.open && dialog.close();

    if (!state.user && !['signin', 'signup'].includes(parts[0])) {
      try {
        const me = await api('/auth/me');
        state.user = me.user;
        state.csrf = me.csrfToken;
      } catch {
        const next = location.hash && !location.hash.startsWith('#/sign') ? `?next=${encodeURIComponent(location.hash)}` : '';
        return go(`#/signin${next}`);
      }
    }
    if (!isCurrent()) return;

    try {
      if (parts[0] === 'signin' || parts[0] === 'signup') return renderAuth(parts[0], query);
      await loadGroups();
      if (!isCurrent()) return;
      if (parts[0] === 'invite') return await renderInvite(parts[1], isCurrent);
      if (parts[0] !== 'g' || !parts[1]) {
        if (!parts[0] && state.groups.length === 1) return go(`#/g/${state.groups[0].id}`);
        return renderGroups();
      }
      const gid = Number(parts[1]);
      await loadGroup(gid);
      if (!isCurrent()) return;
      renderChrome(parts[2] || 'dashboard');
      const [, , section, id, action] = parts;
      if (!section) return await renderDashboard(isCurrent);
      if (section === 'deletions') return await renderDeletions(query, isCurrent);
      if (section === 'members') return await renderMembers(isCurrent);
      if (section === 'activity') return await renderActivity(isCurrent);
      const type = TYPES[section];
      if (!type) return renderNotFound();
      if (!id && section === 'suggestions' && query.get('view') !== 'table') return await renderChecklist(query, isCurrent);
      if (!id) return await renderList(section, query, isCurrent);
      if (id === 'new') return await renderForm(section, null, isCurrent);
      if (action === 'edit') return await renderForm(section, Number(id), isCurrent);
      return await renderDetail(section, Number(id), isCurrent);
    } catch (err) {
      if (err.handled || !isCurrent()) return;
      renderError(err);
    }
  }

  async function loadGroups() {
    state.groups = (await api('/groups')).groups;
    refreshNotifications();
  }
  async function loadGroup(gid) {
    if (state.group?.id !== gid) state.group = null;
    state.group = (await api(`/groups/${gid}`)).group;
  }
  async function refreshNotifications() {
    try {
      const n = await api('/notifications');
      state.unread = n.unread;
      state.notifications = n.notifications;
      const el = document.getElementById('bell-count');
      if (el) { el.textContent = n.unread; el.hidden = !n.unread; }
    } catch { /* non-critical */ }
  }

  // ---------------------------------------------------------------------------
  // Chrome (top bar + section nav)
  // ---------------------------------------------------------------------------
  function renderTopbar() {
    if (!state.user) { topbar.hidden = true; return; }
    topbar.hidden = false;
    const switcher = state.groups.length
      ? h('select', {
        'aria-label': 'Switch group',
        onchange: (e) => go(e.target.value ? `#/g/${e.target.value}` : '#/groups'),
      },
      h('option', { value: '' }, 'All groups…'),
      state.groups.map((g) => h('option', { value: g.id, selected: state.group?.id === g.id }, g.name)))
      : null;
    topbar.replaceChildren(
      h('a', { class: 'brand', href: '#/groups' }, 'Shared Expenses'),
      switcher,
      h('span', { class: 'spacer' }),
      h('button', { class: 'bell small', type: 'button', onclick: openNotifications, 'aria-label': 'Notifications' },
        'Notifications', h('span', { class: 'count', id: 'bell-count', hidden: !state.unread }, String(state.unread))),
      h('span', { class: 'user-name muted small' }, state.user.name),
      h('button', { class: 'small', type: 'button', onclick: signOut }, 'Sign out'),
    );
  }

  function renderChrome(active) {
    renderTopbar();
    if (!state.group) { sidenav.hidden = true; return; }
    sidenav.hidden = false;
    const g = state.group;
    const link = (section, label) => h('a', { href: `#/g/${g.id}${section ? `/${section}` : ''}`, 'aria-current': active === (section || 'dashboard') ? 'page' : null }, label);
    sidenav.replaceChildren(
      link('', 'Dashboard'),
      link('budget-entries', 'Budget'),
      link('expenses', 'Expenses'),
      link('suggestions', 'Suggestions'),
      link('deletions', 'Deletion requests'),
      link('activity', 'Activity'),
      link('members', 'Members'),
    );
  }

  function hideChrome() {
    sidenav.hidden = true;
    state.group = null;
    renderTopbar();
  }

  async function openNotifications() {
    await refreshNotifications();
    const list = state.notifications || [];
    dialog.replaceChildren(
      h('h2', null, 'Notifications'),
      list.length
        ? h('ul', { class: 'notif-list' }, list.map((n) => h('li', { class: n.readAt ? '' : 'unread' },
          n.link ? h('a', { href: n.link, onclick: () => dialog.close() }, n.message) : n.message,
          h('div', { class: 'muted small' }, fmtDateTime(n.createdAt)))))
        : h('p', { class: 'muted' }, 'No notifications yet.'),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', onclick: () => dialog.close() }, 'Close')),
    );
    dialog.showModal();
    if (state.unread) {
      await api('/notifications/read', { method: 'POST', body: {} }).catch(() => {});
      refreshNotifications();
    }
  }

  async function signOut() {
    await api('/auth/signout', { method: 'POST', body: {} }).catch(() => {});
    Object.assign(state, { user: null, csrf: null, groups: [], group: null });
    topbar.hidden = true;
    sidenav.hidden = true;
    go('#/signin');
  }

  // ---------------------------------------------------------------------------
  // Generic states
  // ---------------------------------------------------------------------------
  function loading(label = 'Loading…') {
    render(h('p', { class: 'muted pad' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' ', label));
  }
  function renderError(err) {
    const notFound = err.status === 404;
    render(h('div', { class: 'card' },
      h('h1', null, notFound ? 'Not found' : 'Something went wrong'),
      h('p', null, err.message),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: route }, 'Try again'),
        h('a', { class: 'btn', href: '#/groups' }, 'Go to my groups'))));
    focusMain();
  }
  function renderNotFound() {
    renderError({ status: 404, message: 'That page does not exist.' });
  }

  // ---------------------------------------------------------------------------
  // Forms
  // ---------------------------------------------------------------------------
  /** Builds a labelled input with an error slot. */
  function field(def, value, { idPrefix = 'f' } = {}) {
    const id = `${idPrefix}-${def.key}`;
    const errId = `${id}-err`;
    const name = def.input || def.key;
    let control;
    const common = { id, name, 'aria-describedby': errId, required: !!def.required };
    if (def.kind === 'textarea') control = h('textarea', { ...common, maxlength: def.max }, value ?? '');
    else if (def.kind === 'select') {
      control = h('select', common, def.options.map((o) => h('option', { value: o, selected: o === value }, cap(o))));
    } else {
      const type = { date: 'date', url: 'url', password: 'password' }[def.kind] || 'text';
      control = h('input', {
        ...common, type, value: value ?? '', maxlength: def.max, placeholder: def.placeholder, list: def.list,
        inputmode: def.kind === 'money' ? 'decimal' : null, autocomplete: def.autocomplete || 'off',
      });
    }
    return h('div', { class: `field ${def.full ? 'full' : ''}` },
      h('label', { for: id }, def.label, def.required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null),
      control,
      def.help ? h('div', { class: 'help' }, def.help) : null,
      h('div', { class: 'error', id: errId, 'aria-live': 'polite' }));
  }

  function showFieldErrors(form, details) {
    form.querySelectorAll('.field .error').forEach((e) => { e.textContent = ''; });
    form.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
    let first = null;
    for (const [name, msg] of Object.entries(details || {})) {
      const input = form.elements[name];
      if (!input || !input.id) continue;
      input.setAttribute('aria-invalid', 'true');
      const err = document.getElementById(`${input.id}-err`);
      if (err) err.textContent = Array.isArray(msg) ? msg.join(' ') : msg;
      first = first || input;
    }
    first?.focus();
  }

  function formNotice(form) {
    let n = form.querySelector('.form-notice');
    if (!n) { n = h('div', { class: 'form-notice', role: 'alert' }); form.prepend(n); }
    return {
      show(msg, kind = 'error', extra) { n.className = `form-notice notice ${kind}`; n.replaceChildren(msg, extra || ''); },
      clear() { n.className = 'form-notice'; n.replaceChildren(); },
    };
  }

  /** Disables the submit button while `fn` runs; prevents double submission. */
  async function busy(button, label, fn) {
    if (button.disabled) return undefined;
    const original = [...button.childNodes];
    button.disabled = true;
    button.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), ` ${label}`);
    try { return await fn(); } finally { button.disabled = false; button.replaceChildren(...original); }
  }

  /** Accessible modal confirmation, optionally collecting a reason. */
  function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, reason = null }) {
    return new Promise((resolve) => {
      const reasonField = reason ? field({ key: 'reason', label: reason.label, kind: 'textarea', max: 1000, required: reason.required }, '', { idPrefix: 'dlg' }) : null;
      const form = h('form', { method: 'dialog' },
        h('h2', null, title),
        message ? h('p', null, message) : null,
        reasonField,
        h('div', { class: 'row' },
          h('button', { type: 'submit', class: danger ? 'danger solid' : 'primary', value: 'ok' }, confirmLabel),
          h('button', { type: 'button', onclick: () => { dialog.close(); } }, 'Cancel')));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = form.elements.reason ? form.elements.reason.value.trim() : '';
        if (reason?.required && !text) return showFieldErrors(form, { reason: 'Please give a reason.' });
        dialog.returnValue = 'ok';
        dialog.close();
        resolve({ reason: text });
      });
      dialog.onclose = () => { if (dialog.returnValue !== 'ok') resolve(null); dialog.returnValue = ''; dialog.onclose = null; };
      dialog.replaceChildren(form);
      dialog.showModal();
      (form.elements.reason || form.querySelector('button')).focus();
    });
  }

  // ---------------------------------------------------------------------------
  // Auth screens
  // ---------------------------------------------------------------------------
  function renderAuth(mode, query) {
    topbar.hidden = true;
    sidenav.hidden = true;
    const signup = mode === 'signup';
    const next = query.get('next') || '';
    const form = h('form', { novalidate: true },
      field({ key: 'name', label: 'Name', required: true, max: 40, autocomplete: 'username', help: signup ? 'This is how others will see you, and what you use to sign in.' : null }),
      field({ key: 'password', label: 'Password', kind: 'password', required: true, autocomplete: signup ? 'new-password' : 'current-password', help: signup ? 'At least 10 characters.' : null }),
      h('button', { type: 'submit', class: 'primary' }, signup ? 'Create account' : 'Sign in'));
    const notice = formNotice(form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      notice.clear();
      const button = form.querySelector('button[type=submit]');
      await busy(button, signup ? 'Creating…' : 'Signing in…', async () => {
        try {
          const res = await api(`/auth/${mode}`, { method: 'POST', body: { name: form.elements.name.value, password: form.elements.password.value } });
          state.user = res.user;
          state.csrf = res.csrfToken;
          go(next && next.startsWith('#/') ? next : '#/');
        } catch (err) {
          notice.show(err.message);
          showFieldErrors(form, err.details);
        }
      });
    });
    render(h('div', { class: 'auth-wrap' },
      h('div', { class: 'brand-big' }, 'Shared Expenses'),
      h('div', { class: 'card' },
        h('h1', null, signup ? 'Create an account' : 'Sign in'),
        form,
        h('p', { class: 'small muted', style: 'margin-top:1rem' },
          signup ? 'Already have an account? ' : 'New here? ',
          h('a', { href: `#/${signup ? 'signin' : 'signup'}${next ? `?next=${encodeURIComponent(next)}` : ''}` }, signup ? 'Sign in' : 'Create an account')))));
    form.elements.name.focus();
  }

  // ---------------------------------------------------------------------------
  // Groups & invitations
  // ---------------------------------------------------------------------------
  function renderGroups() {
    hideChrome();
    const form = h('form', { novalidate: true },
      h('div', { class: 'form-grid' },
        field({ key: 'name', label: 'Group name', required: true, max: 100, placeholder: 'e.g. Household, Trip to Rome' }),
        field({ key: 'currency', label: 'Currency', kind: 'select', options: Money.CURRENCIES }, Money.DEFAULT_CURRENCY)),
      h('button', { type: 'submit', class: 'primary' }, 'Create group'));
    form.elements.currency.querySelectorAll('option').forEach((o) => { o.textContent = o.value; });
    const notice = formNotice(form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await busy(form.querySelector('[type=submit]'), 'Creating…', async () => {
        try {
          const { group } = await api('/groups', { method: 'POST', body: { name: form.elements.name.value, currency: form.elements.currency.value } });
          toast(`Created “${group.name}”.`);
          go(`#/g/${group.id}`);
        } catch (err) { notice.show(err.message); showFieldErrors(form, err.details); }
      });
    });
    render(
      h('div', { class: 'page-head' }, h('h1', null, 'Your groups')),
      h('div', { class: 'card' },
        state.groups.length
          ? h('ul', { class: 'attachments' }, state.groups.map((g) => h('li', null,
            h('a', { class: 'name', href: `#/g/${g.id}` }, g.name), h('span', { class: 'muted small' }, g.currency), badge('active', cap(g.role)))))
          : h('div', { class: 'empty' }, h('p', null, 'You are not in any group yet. Create one below, or open an invite link someone sent you.'))),
      h('div', { class: 'card' }, h('h2', null, 'Create a new group'), form));
    focusMain();
  }

  async function renderInvite(token, isCurrent) {
    hideChrome();
    loading();
    let inv;
    try { inv = (await api(`/invitations/${encodeURIComponent(token || '')}`)).invitation; } catch (err) {
      if (isCurrent()) renderError(err);
      return;
    }
    if (!isCurrent()) return;
    const btn = h('button', { type: 'button', class: 'primary' }, `Join ${inv.groupName}`);
    btn.addEventListener('click', () => busy(btn, 'Joining…', async () => {
      try {
        const { groupId } = await api(`/invitations/${encodeURIComponent(token)}/accept`, { method: 'POST', body: {} });
        toast(`You joined ${inv.groupName}.`);
        go(`#/g/${groupId}`);
      } catch (err) { toast(err.message, 'error'); }
    }));
    render(h('div', { class: 'card', style: 'max-width:520px' },
      h('h1', null, 'You have been invited'),
      h('p', null, `${inv.invitedBy} invited you to join “${inv.groupName}” as ${inv.role}.`),
      h('p', { class: 'muted small' }, `This link expires ${fmtDateTime(inv.expiresAt)} and can be used once.`),
      h('div', { class: 'row' }, btn, h('a', { class: 'btn', href: '#/groups' }, 'Not now'))));
    focusMain();
  }

  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------
  function stat(label, value, hint, cls = '', extra = null) {
    return h('div', { class: `stat ${cls}` }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), extra, hint ? h('div', { class: 'hint' }, hint) : null);
  }

  async function renderDashboard(isCurrent) {
    loading();
    const d = await api(`/groups/${state.group.id}/dashboard`);
    if (!isCurrent()) return;
    const g = state.group;
    const can = g.permissions;
    const util = d.utilizationPercent;
    const meter = util === null ? null : h('div', { class: `meter ${util > 100 ? 'over' : ''}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.min(util, 100), 'aria-label': 'Budget used' },
      h('span', { style: `width:${Math.min(util, 100)}%` }));

    const pendingHint = [];
    if (d.pendingDeletionExpenseMinor) pendingHint.push(`${money(d.pendingDeletionExpenseMinor)} of expenses`);
    if (d.pendingDeletionBudgetMinor) pendingHint.push(`${money(d.pendingDeletionBudgetMinor)} of budget`);

    render(
      h('div', { class: 'page-head' },
        h('h1', null, g.name),
        can.write ? h('div', { class: 'row' },
          h('a', { class: 'btn primary', href: `#/g/${g.id}/expenses/new` }, '+ Expense'),
          h('a', { class: 'btn', href: `#/g/${g.id}/budget-entries/new` }, '+ Budget entry'),
          h('a', { class: 'btn', href: `#/g/${g.id}/suggestions` }, '+ Checklist item')) : null),
      d.awaitingMyDecision ? h('div', { class: 'notice warn' },
        `${d.awaitingMyDecision} deletion request${d.awaitingMyDecision > 1 ? 's are' : ' is'} waiting for your decision. `,
        h('a', { href: `#/g/${g.id}/deletions` }, 'Review now')) : null,
      h('section', { 'aria-label': 'Totals', class: 'grid-stats' },
        stat('Budget received', money(d.budgetTotalMinor), `${d.budgetCount} active entr${d.budgetCount === 1 ? 'y' : 'ies'}`),
        stat('Expenses', money(d.expenseTotalMinor), `${d.expenseCount} active expense${d.expenseCount === 1 ? '' : 's'}`),
        stat('Available balance', money(d.balanceMinor), d.balanceMinor < 0 ? 'Over budget' : 'Budget received − expenses', d.balanceMinor < 0 ? 'negative' : ''),
        stat('Budget used', util === null ? '—' : `${util.toLocaleString(Money.DEFAULT_LOCALE)}%`, util === null ? 'No budget received yet' : null, '', meter),
        stat('Pending deletions', String(d.pendingDeletionCount), pendingHint.length ? `Still counted: ${pendingHint.join(', ')}` : 'Nothing awaiting approval'),
        stat('Checklist estimate', money(d.suggestionEstimateMinor),
          `${d.suggestionCount} open item${d.suggestionCount === 1 ? '' : 's'}${d.suggestionUnpricedCount ? `, ${d.suggestionUnpricedCount} without a price` : ''} – not included in totals`)),
      h('details', { class: 'card small' },
        h('summary', null, 'How are these totals calculated?'),
        h('ul', null,
          h('li', null, 'Budget received and Expenses include all active (non-archived) records.'),
          h('li', null, 'Records with a pending deletion request still count until the request is approved; approved deletions are archived and excluded.'),
          h('li', null, 'Available balance = Budget received − Expenses.'),
          h('li', null, 'Checklist (suggested purchase) prices are optional estimates and never change the balance. The estimate covers open items that have a price. Checking an item off does not spend money; only an expense linked to it counts.'))),
      h('div', { class: 'two-col' },
        h('section', { class: 'card' },
          h('h2', null, 'Recent activity'),
          d.recentActivity.length ? activityList(d.recentActivity) : h('p', { class: 'muted' }, 'No activity yet.'),
          h('a', { href: `#/g/${g.id}/activity` }, 'View all activity')),
        h('section', { class: 'card' },
          h('h2', null, 'Your deletion requests'),
          h('p', null, d.myOpenRequests ? `You have ${d.myOpenRequests} pending request${d.myOpenRequests > 1 ? 's' : ''}.` : 'You have no pending requests.'),
          d.recentDecisions.length
            ? h('ul', { class: 'notif-list' }, d.recentDecisions.map((n) => h('li', { class: n.readAt ? '' : 'unread' },
              h('a', { href: n.link }, n.message), h('div', { class: 'muted small' }, fmtDateTime(n.createdAt)))))
            : h('p', { class: 'muted small' }, 'Decisions on your requests will appear here.'),
          h('a', { href: `#/g/${g.id}/deletions` }, 'All deletion requests'))),
    );
    focusMain();
  }

  // ---------------------------------------------------------------------------
  // Activity / audit
  // ---------------------------------------------------------------------------
  const ACTION_TEXT = {
    created: 'created', updated: 'edited', deletion_requested: 'requested deletion of', deletion_approved: 'approved deletion of',
    deletion_rejected: 'rejected deletion of', deletion_cancelled: 'cancelled the deletion request for', archived: 'archived',
    attachment_added: 'added an attachment to', attachment_replaced: 'replaced an attachment on', attachment_removed: 'removed an attachment from',
    checked: 'checked off', unchecked: 'unchecked', linked_expense: 'linked an expense to', unlinked_expense: 'unlinked the expense from', linked_suggestion: 'linked a suggestion to',
    unlinked_suggestion: 'unlinked the suggestion from', group_created: 'created the group', member_added: 'added a member',
    member_role_changed: 'changed a member’s role', member_revoked: 'removed a member', member_left: 'left the group',
    invitation_created: 'created an invite link', invitation_revoked: 'revoked an invite link', invitation_accepted: 'joined via an invite link',
  };

  function formatChangeValue(key, v) {
    if (v === null || v === undefined || v === '') return '(empty)';
    if (/Minor$/.test(key)) return money(v);
    if (/Date$/.test(key)) return fmtDate(v);
    if (key === 'purchaseStatus') return statusLabel(v);
    if (key === 'role') return cap(v);
    return String(v);
  }

  function describeEntry(a, { withRecord = true } = {}) {
    const actor = a.actor?.name || 'System';
    const verb = ACTION_TEXT[a.action] || a.action.replace(/_/g, ' ');
    const t = TYPE_BY_KEY[a.recordType];
    const parts = [h('strong', null, actor), ` ${verb}`];
    if (withRecord && t) {
      const title = a.details?.values?.[t.titleKey];
      parts.push(' ', t.label.toLowerCase(), ' ', h('a', { href: `#/g/${state.group.id}/${t.path}/${a.recordId}` }, title ? `“${title}”` : `#${a.recordId}`));
    } else if (a.details?.name && a.action.startsWith('member')) parts.push(` (${a.details.name})`);
    const extra = [];
    if (a.details?.changes) {
      for (const [k, c] of Object.entries(a.details.changes)) {
        extra.push(h('li', null, `${FIELD_LABELS[k] || k}: ${formatChangeValue(k, c.old)} → ${formatChangeValue(k, c.new)}`));
      }
    }
    if (a.details?.reason) extra.push(h('li', null, `Reason: ${a.details.reason}`));
    if (a.details?.name && a.action.startsWith('attachment')) extra.push(h('li', null, `File: ${a.details.name}`));
    return [h('div', null, parts), extra.length ? h('ul', { class: 'changes' }, extra) : null];
  }

  function activityList(entries, opts) {
    return h('ol', { class: 'timeline' }, entries.map((a) => h('li', null,
      describeEntry(a, opts), h('div', { class: 'when' }, h('time', { datetime: a.createdAt }, fmtDateTime(a.createdAt))))));
  }

  async function renderActivity(isCurrent) {
    loading();
    const g = state.group;
    const entries = (await api(`/groups/${g.id}/activity?limit=50`)).activity;
    if (!isCurrent()) return;
    const listWrap = h('div', null, entries.length ? activityList(entries) : h('p', { class: 'empty' }, 'No activity yet.'));
    const more = h('button', { type: 'button', hidden: entries.length < 50 }, 'Load more');
    more.addEventListener('click', () => busy(more, 'Loading…', async () => {
      const next = (await api(`/groups/${g.id}/activity?limit=50&beforeId=${entries[entries.length - 1].id}`)).activity;
      entries.push(...next);
      listWrap.replaceChildren(activityList(entries));
      more.hidden = next.length < 50;
    }));
    render(h('div', { class: 'page-head' }, h('h1', null, 'Activity')),
      h('p', { class: 'muted' }, 'A permanent, append-only history of changes in this group. Entries cannot be edited or deleted.'),
      h('div', { class: 'card' }, listWrap, more));
    focusMain();
  }

  // ---------------------------------------------------------------------------
  // Suggestions checklist
  // ---------------------------------------------------------------------------
  async function renderChecklist(query, isCurrent) {
    const g = state.group;
    const can = g.permissions;
    const base = `/groups/${g.id}/suggestions`;
    loading();
    const q = query.get('q') || '';
    const list = (st, sort) => api(`${base}?state=${st}&pageSize=100&${sort}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    const [open, done, cancelled] = await Promise.all([
      list('open', 'sort=created&order=asc'),
      list('done', 'sort=updated&order=desc'),
      list('cancelled', 'sort=updated&order=desc'),
    ]);
    if (!isCurrent()) return;

    async function toggle(r, cb) {
      cb.disabled = true;
      try {
        await api(`${base}/${r.id}/done`, { method: 'POST', body: { version: r.version, done: cb.checked } });
        state.focusAfterRender = `chk-${r.id}`;
        await route();
      } catch (err) {
        toast(err.message, 'error');
        cb.checked = !cb.checked;
        cb.disabled = false;
      }
    }

    function item(r) {
      const isDone = r.purchaseStatus === 'purchased';
      let lockReason = null;
      if (!can.write) lockReason = 'View-only access';
      else if (r.pendingDeletion) lockReason = 'Deletion pending';
      else if (isDone && r.expenseId) lockReason = 'Linked to an expense – unlink it on the details page to uncheck';
      const id = `chk-${r.id}`;
      const cb = h('input', { type: 'checkbox', id, checked: isDone, disabled: !!lockReason, title: lockReason, onchange: (e) => toggle(r, e.target) });
      const meta = [];
      if (['approved', 'planned'].includes(r.purchaseStatus)) meta.push(badge(r.purchaseStatus));
      if (r.pendingDeletion) meta.push(badge('pending', 'Deletion pending'));
      if (r.targetDate) meta.push(h('span', null, `Target ${fmtDate(r.targetDate)}`));
      if (r.expenseId) meta.push(h('span', null, 'Expense recorded'));
      if (r.attachmentCount) meta.push(h('span', null, `${r.attachmentCount} file${r.attachmentCount > 1 ? 's' : ''}`));
      return h('li', { class: `check-item ${isDone ? 'done' : ''}` },
        cb,
        h('div', { class: 'check-body' },
          h('label', { for: id, class: 'item-name' }, r.itemName),
          meta.length ? h('div', { class: 'check-meta' }, meta.map((m, i) => [i ? ' · ' : '', m])) : null),
        h('span', { class: 'num price' }, r.expectedPriceMinor ? money(r.expectedPriceMinor) : '—'),
        h('a', { class: 'small', href: `#/g/${g.id}/suggestions/${r.id}`, 'aria-label': `Details for ${r.itemName}` }, 'Details'));
    }

    const section = (data, emptyText) => [
      data.items.length ? h('ul', { class: 'checklist' }, data.items.map(item)) : h('p', { class: 'muted empty' }, emptyText),
      data.total > data.items.length ? h('p', { class: 'small muted' }, `Showing ${data.items.length} of ${data.total}. `,
        h('a', { href: `#/g/${g.id}/suggestions?view=table` }, 'Open the table view'), ' to page through all.') : null,
    ];

    let quickAdd = null;
    if (can.write) {
      const clientRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
      quickAdd = h('form', { class: 'quick-add', novalidate: true },
        h('div', null, h('label', { for: 'qa-name', class: 'visually-hidden' }, 'New item'),
          h('input', { id: 'qa-name', name: 'itemName', placeholder: 'Add an item…', maxlength: 200, autocomplete: 'off', 'aria-describedby': 'qa-name-err' }),
          h('div', { class: 'error', id: 'qa-name-err' })),
        h('div', null, h('label', { for: 'qa-price', class: 'visually-hidden' }, 'Price (optional)'),
          h('input', { id: 'qa-price', name: 'expectedPrice', placeholder: 'Price (optional)', inputmode: 'decimal', autocomplete: 'off', 'aria-describedby': 'qa-price-err' }),
          h('div', { class: 'error', id: 'qa-price-err' })),
        h('button', { type: 'submit', class: 'primary' }, 'Add'));
      quickAdd.dataset.rid = clientRequestId();
      quickAdd.addEventListener('submit', async (e) => {
        e.preventDefault();
        const els = quickAdd.elements;
        const errors = {};
        if (!els.itemName.value.trim()) errors.itemName = 'Type an item to add.';
        if (els.expectedPrice.value.trim()) { const p = Money.parseAmount(els.expectedPrice.value); if (!p.ok) errors.expectedPrice = p.error; }
        if (Object.keys(errors).length) return showFieldErrors(quickAdd, errors);
        await busy(quickAdd.querySelector('[type=submit]'), 'Adding…', async () => {
          try {
            await api(base, { method: 'POST', body: { itemName: els.itemName.value, expectedPrice: els.expectedPrice.value, clientRequestId: quickAdd.dataset.rid } });
            state.focusAfterRender = 'qa-name';
            await route();
          } catch (err) { toast(err.message, 'error'); showFieldErrors(quickAdd, err.details); }
        });
      });
    }

    let searchTimer;
    const search = h('input', {
      id: 'chk-q', type: 'search', value: q, placeholder: 'Search the checklist…', 'aria-label': 'Search the checklist',
      oninput: (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => go(`#/g/${g.id}/suggestions${e.target.value ? `?q=${encodeURIComponent(e.target.value)}` : ''}`), 400); },
    });
    // Only exact when every open item is on this page; otherwise leave it out.
    const unpriced = open.total === open.items.length ? open.items.filter((r) => !r.expectedPriceMinor).length : 0;

    render(
      h('div', { class: 'page-head' },
        h('div', null, h('h1', null, 'Suggestions checklist'), h('p', { class: 'muted small', style: 'margin:0' }, TYPES.suggestions.blurb)),
        h('div', { class: 'row small' },
          h('a', { href: `#/g/${g.id}/suggestions?view=table` }, 'Table view (filter & sort)'), ' · ',
          h('a', { href: `#/g/${g.id}/suggestions?view=table&status=archived` }, 'Archived'))),
      h('div', { class: 'card' },
        quickAdd,
        h('div', { style: 'margin:.75rem 0' }, search),
        h('h2', null, `To get (${open.total})`),
        section(open, q ? 'No open items match your search.' : can.write ? 'Nothing on the list. Add an item above.' : 'Nothing on the list.'),
        open.total ? h('p', { class: 'small muted check-total' }, 'Estimated total: ', h('strong', { class: 'num' }, money(open.sumMinor)),
          unpriced ? ` · ${unpriced} item${unpriced > 1 ? 's' : ''} without a price` : '', ' · not included in the budget') : null),
      h('details', { class: 'card', open: true },
        h('summary', null, h('h2', { style: 'display:inline' }, `Done (${done.total})`)),
        section(done, 'Nothing checked off yet.')),
      cancelled.total ? h('details', { class: 'card' },
        h('summary', null, h('h2', { style: 'display:inline' }, `Cancelled (${cancelled.total})`)),
        section(cancelled, '')) : null);

    const focusId = state.focusAfterRender;
    state.focusAfterRender = null;
    const focusEl = focusId && document.getElementById(focusId);
    if (focusEl) focusEl.focus();
    else if (q) { search.focus(); search.setSelectionRange(q.length, q.length); } else focusMain();
  }

  // ---------------------------------------------------------------------------
  // Record lists
  // ---------------------------------------------------------------------------
  async function renderList(section, query, isCurrent) {
    const type = TYPES[section];
    const g = state.group;
    loading();
    const params = new URLSearchParams(query);
    if (!params.get('sort')) params.set('sort', 'date');
    const [data, cats] = await Promise.all([
      api(`/groups/${g.id}/${section}?${params}`),
      section === 'expenses' ? api(`/groups/${g.id}/expenses-categories`) : Promise.resolve(null),
    ]);
    if (!isCurrent()) return;

    const setQuery = (changes) => {
      const p = new URLSearchParams(query);
      for (const [k, v] of Object.entries(changes)) { if (v === '' || v === null) p.delete(k); else p.set(k, v); }
      if (!('page' in changes)) p.delete('page');
      go(`#/g/${g.id}/${section}${p.toString() ? `?${p}` : ''}`);
    };

    let searchTimer;
    const filterField = (label, control) => h('div', null, h('label', { for: control.id }, label), control);
    const search = h('input', { id: 'flt-q', type: 'search', value: query.get('q') || '', placeholder: 'Search…', oninput: (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => setQuery({ q: e.target.value }), 400); } });
    const sel = (id, key, options, current) => h('select', { id, onchange: (e) => setQuery({ [key]: e.target.value }) },
      options.map(([v, l]) => h('option', { value: v, selected: v === (current || '') }, l)));
    const filters = h('div', { class: 'filters', role: 'search' },
      filterField('Search', search),
      section === 'expenses' ? filterField('Category', sel('flt-cat', 'category', [['', 'All categories'], ...cats.categories.map((c) => [c, c])], query.get('category'))) : null,
      section === 'suggestions' ? filterField('Status', sel('flt-ps', 'purchaseStatus', [['', 'All statuses'], ...SUGGESTION_STATUSES.map((s) => [s, statusLabel(s)])], query.get('purchaseStatus'))) : null,
      filterField('From', h('input', { id: 'flt-from', type: 'date', value: query.get('from') || '', onchange: (e) => setQuery({ from: e.target.value }) })),
      filterField('To', h('input', { id: 'flt-to', type: 'date', value: query.get('to') || '', onchange: (e) => setQuery({ to: e.target.value }) })),
      filterField('Show', sel('flt-status', 'status', [['', 'Active'], ['archived', 'Archived'], ['all', 'All']], query.get('status'))),
      filterField('Sort by', sel('flt-sort', 'sort', [['', type.dateLabel], ['amount', 'Amount'], ['name', 'Name'], ['created', 'Created'], ['updated', 'Last edited']], query.get('sort'))),
      filterField('Order', sel('flt-order', 'order', [['', 'Newest / largest first'], ['asc', 'Oldest / smallest first']], query.get('order'))));

    const filtered = ['q', 'category', 'purchaseStatus', 'from', 'to', 'status', 'pendingDeletion'].some((k) => query.get(k));
    let body;
    if (!data.items.length) {
      body = h('div', { class: 'empty' },
        h('p', null, filtered ? 'No records match these filters.' : `No ${type.plural.toLowerCase()} yet.`),
        filtered ? h('button', { type: 'button', onclick: () => go(`#/g/${g.id}/${section}`) }, 'Clear filters')
          : g.permissions.write ? h('a', { class: 'btn primary', href: `#/g/${g.id}/${section}/new` }, `Add ${type.label.toLowerCase()}`) : null);
    } else {
      body = h('div', { class: 'table-wrap' }, h('table', { class: 'responsive' },
        h('caption', { class: 'visually-hidden' }, type.plural),
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, FIELD_LABELS[type.titleKey]),
          h('th', { scope: 'col' }, type.dateLabel),
          section === 'expenses' ? h('th', { scope: 'col' }, 'Category') : null,
          h('th', { scope: 'col' }, 'Status'),
          h('th', { scope: 'col' }, 'Added by'),
          h('th', { scope: 'col', class: 'right' }, 'Amount'))),
        h('tbody', null, data.items.map((r) => h('tr', { class: r.status === 'archived' ? 'archived' : '' },
          h('td', { 'data-label': FIELD_LABELS[type.titleKey] }, h('a', { href: `#/g/${g.id}/${section}/${r.id}` }, r[type.titleKey]),
            r.attachmentCount ? h('span', { class: 'muted small', title: 'Attachments' }, ` · ${r.attachmentCount} file${r.attachmentCount > 1 ? 's' : ''}`) : null),
          h('td', { 'data-label': type.dateLabel, class: 'num' }, fmtDate(r[type.dateKey])),
          section === 'expenses' ? h('td', { 'data-label': 'Category' }, r.category || '—') : null,
          h('td', { 'data-label': 'Status' }, statusBadges(r, section)),
          h('td', { 'data-label': 'Added by' }, r.createdBy.name),
          h('td', { 'data-label': 'Amount', class: 'num right' }, money(r[type.amountKey]))))),
        h('tfoot', null, h('tr', null,
          h('td', { colspan: section === 'expenses' ? 5 : 4 }, h('strong', null, `Total of ${data.total} matching`)),
          h('td', { class: 'num right' }, h('strong', null, money(data.sumMinor)))))));
    }

    const pager = data.pages > 1 ? h('nav', { class: 'pagination', 'aria-label': 'Pagination' },
      h('button', { type: 'button', disabled: data.page <= 1, onclick: () => setQuery({ page: data.page - 1 }) }, '← Previous'),
      h('span', { class: 'muted small' }, `Page ${data.page} of ${data.pages}`),
      h('button', { type: 'button', disabled: data.page >= data.pages, onclick: () => setQuery({ page: data.page + 1 }) }, 'Next →')) : null;

    render(
      h('div', { class: 'page-head' },
        h('div', null, h('h1', null, type.plural), h('p', { class: 'muted small', style: 'margin:0' }, type.blurb,
          section === 'suggestions' ? [' ', h('a', { href: `#/g/${g.id}/suggestions` }, 'Back to checklist')] : null)),
        g.permissions.write ? h('a', { class: 'btn primary', href: `#/g/${g.id}/${section}/new` }, `+ Add ${type.label.toLowerCase()}`) : null),
      h('div', { class: 'card' }, filters, body, pager));
    if (query.get('q')) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); } else focusMain();
  }

  function statusBadges(r, section) {
    const out = [];
    if (r.status === 'archived') out.push(badge('archived', 'Archived'));
    else if (section === 'suggestions') out.push(badge(r.purchaseStatus, statusLabel(r.purchaseStatus)));
    else out.push(badge('active', 'Active'));
    if (r.pendingDeletion) out.push(' ', badge('pending', 'Deletion pending'));
    return out;
  }

  // ---------------------------------------------------------------------------
  // Create / edit form
  // ---------------------------------------------------------------------------
  async function renderForm(section, id, isCurrent) {
    const type = TYPES[section];
    const g = state.group;
    if (!g.permissions.write) return renderError({ status: 403, message: 'You have view-only access to this group.' });
    loading();
    let record = null;
    let cats = [];
    if (id) record = (await api(`/groups/${g.id}/${section}/${id}`)).record;
    if (section === 'expenses') cats = (await api(`/groups/${g.id}/expenses-categories`)).categories;
    if (!isCurrent()) return;
    if (record && (record.status === 'archived' || record.pendingDeletion)) {
      return renderError({ status: 409, message: record.status === 'archived' ? 'Archived records cannot be edited.' : 'This record has a pending deletion request and cannot be edited until it is decided.' });
    }

    const defs = type.fields.filter((f) => !f.editOnly || record).map((f) => ({ ...f }));
    const statusDef = defs.find((f) => f.key === 'purchaseStatus');
    if (statusDef && record?.purchaseStatus === 'purchased') defs.splice(defs.indexOf(statusDef), 1);
    if (statusDef && !g.permissions.approveSuggestion && record?.purchaseStatus !== 'approved') {
      statusDef.options = statusDef.options.filter((o) => o !== 'approved');
    }
    const valueOf = (f) => {
      if (!record) return typeof f.default === 'function' ? f.default() : f.default;
      const v = record[f.key];
      return f.kind === 'money' ? Money.toInputString(v) : v;
    };
    const fileInput = !record ? h('input', { type: 'file', id: 'f-files', name: 'files', multiple: true, accept: '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png' }) : null;
    const clientRequestId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const form = h('form', { novalidate: true },
      h('div', { class: 'form-grid' }, defs.map((f) => field(f, valueOf(f)))),
      section === 'expenses' ? h('datalist', { id: 'category-list' }, cats.map((c) => h('option', { value: c }))) : null,
      fileInput ? h('div', { class: 'field' }, h('label', { for: 'f-files' }, section === 'suggestions' ? 'Attachments (optional)' : 'Receipts / attachments (optional)'), fileInput,
        h('div', { class: 'help' }, 'PDF, JPG or PNG, up to 10 MB each.')) : null,
      h('div', { class: 'row' },
        h('button', { type: 'submit', class: 'primary' }, record ? 'Save changes' : `Add ${type.label.toLowerCase()}`),
        h('a', { class: 'btn', href: record ? `#/g/${g.id}/${section}/${record.id}` : `#/g/${g.id}/${section}` }, 'Cancel')));
    const notice = formNotice(form);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      notice.clear();
      // Client-side check for fast feedback; the server re-validates everything.
      const errors = {};
      for (const f of defs) {
        const el = form.elements[f.input || f.key];
        if (f.required && !el.value.trim()) errors[el.name] = `${f.label} is required.`;
        else if (f.kind === 'money' && el.value.trim()) { const r = Money.parseAmount(el.value); if (!r.ok) errors[el.name] = r.error; }
      }
      if (Object.keys(errors).length) { notice.show('Please fix the highlighted fields.'); return showFieldErrors(form, errors); }
      const body = {};
      for (const f of defs) {
        const name = f.input || f.key;
        const v = form.elements[name].value;
        if (record) {
          const orig = valueOf(f) ?? '';
          if (v !== String(orig)) body[name] = v;
        } else body[name] = v;
      }
      await busy(form.querySelector('[type=submit]'), 'Saving…', async () => {
        try {
          let saved;
          if (record) {
            if (!Object.keys(body).length) { toast('No changes to save.'); return go(`#/g/${g.id}/${section}/${record.id}`); }
            saved = (await api(`/groups/${g.id}/${section}/${record.id}`, { method: 'PATCH', body: { ...body, version: record.version } })).record;
          } else {
            saved = (await api(`/groups/${g.id}/${section}`, { method: 'POST', body: { ...body, clientRequestId } })).record;
            if (fileInput.files.length) {
              try {
                await uploadFiles(`/groups/${g.id}/${section}/${saved.id}/attachments`, [...fileInput.files], { onProgress: (p) => notice.show(`Uploading attachments… ${p}%`, 'info') });
              } catch (err) {
                toast(`Saved, but the attachment upload failed: ${err.message}`, 'error');
              }
            }
          }
          toast(record ? 'Changes saved.' : `${type.label} added.`);
          go(`#/g/${g.id}/${section}/${saved.id}`);
        } catch (err) {
          if (err.status === 409) {
            notice.show(err.message, 'warn', h('button', { type: 'button', class: 'small', style: 'margin-left:.5rem', onclick: route }, 'Reload latest'));
          } else {
            notice.show(err.message);
            showFieldErrors(form, err.details);
          }
        }
      });
    });

    render(h('div', { class: 'page-head' }, h('h1', null, record ? `Edit ${type.label.toLowerCase()}` : `New ${type.label.toLowerCase()}`)),
      h('div', { class: 'card' }, form));
    form.elements[defs[0].input || defs[0].key].focus();
  }

  // ---------------------------------------------------------------------------
  // Record detail
  // ---------------------------------------------------------------------------
  async function renderDetail(section, id, isCurrent) {
    const type = TYPES[section];
    const g = state.group;
    const can = g.permissions;
    loading();
    const data = await api(`/groups/${g.id}/${section}/${id}`);
    if (!isCurrent()) return;
    const r = data.record;
    const base = `/groups/${g.id}/${section}/${r.id}`;
    const archived = r.status === 'archived';
    const pending = data.deletionRequests.find((d) => d.status === 'pending');
    const editable = !archived && !pending && can.write;

    // --- Header & actions
    const actions = h('div', { class: 'row' },
      editable ? h('a', { class: 'btn', href: `#/g/${g.id}/${section}/${r.id}/edit` }, 'Edit') : null,
      !archived && !pending && can.requestDeletion ? h('button', { type: 'button', class: 'danger', onclick: requestDeletion }, 'Request deletion') : null);

    async function requestDeletion() {
      const res = await confirmDialog({
        title: `Request deletion of “${r[type.titleKey]}”?`,
        message: 'Another approver must approve this. Until then the record stays visible and keeps counting in totals. Approved deletions are archived, not erased.',
        confirmLabel: 'Send request', danger: true, reason: { label: 'Reason', required: true },
      });
      if (!res) return;
      try {
        await api(`${base}/deletion-requests`, { method: 'POST', body: { reason: res.reason } });
        toast('Deletion request sent.');
        route();
      } catch (err) { toast(err.message, 'error'); }
    }

    // --- Banners
    const banners = [];
    if (archived) banners.push(h('div', { class: 'notice info' }, `Archived ${fmtDateTime(r.archivedAt)}${r.archivedBy ? ` by ${r.archivedBy.name}` : ''}. It no longer counts in totals; its history and attachments are kept.`));
    if (pending) banners.push(pendingBanner(pending));

    // --- Metadata
    const meta = h('dl', { class: 'meta' });
    const add = (k, v) => append(meta, [h('dt', null, k), h('dd', null, v)]);
    add(FIELD_LABELS[type.amountKey], h('strong', { class: 'num' }, money(r[type.amountKey])));
    for (const f of type.fields) {
      if (f.key === type.titleKey || f.key === type.amountKey) continue;
      let v = r[f.key];
      if (f.kind === 'date') v = fmtDate(v);
      else if (f.key === 'productUrl' && v) v = h('a', { href: v, target: '_blank', rel: 'noopener noreferrer nofollow' }, v);
      else if (f.key === 'purchaseStatus') v = badge(v, statusLabel(v));
      add(f.label, v ?? '—');
    }
    add('Created', `${fmtDateTime(r.createdAt)} by ${r.createdBy.name}`);
    add('Last edited', `${fmtDateTime(r.updatedAt)} by ${r.updatedBy.name}`);
    if (r.linkedSuggestion) add('From suggestion', h('a', { href: `#/g/${g.id}/suggestions/${r.linkedSuggestion.id}` }, r.linkedSuggestion.itemName));
    if (r.linkedExpense) {
      add('Linked expense', [h('a', { href: `#/g/${g.id}/expenses/${r.linkedExpense.id}` }, r.linkedExpense.title), ` · ${money(r.linkedExpense.amountMinor)}`,
        r.linkedExpense.status === 'archived' ? [' ', badge('archived')] : null]);
    }

    render(
      h('p', { class: 'small' }, h('a', { href: `#/g/${g.id}/${section}` }, `← ${type.plural}`)),
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, r[type.titleKey]), h('div', null, statusBadges(r, section))), actions),
      banners,
      h('div', { class: 'two-col' },
        h('div', null,
          h('section', { class: 'card' }, h('h2', null, 'Details'), meta),
          section === 'suggestions' ? purchaseSection() : null,
          attachmentsSection()),
        h('div', null,
          h('section', { class: 'card' }, h('h2', null, 'History'),
            data.history.length ? activityList(data.history, { withRecord: false }) : h('p', { class: 'muted' }, 'No history.')),
          data.deletionRequests.length ? h('section', { class: 'card' }, h('h2', null, 'Deletion requests'),
            h('ul', { class: 'notif-list' }, data.deletionRequests.map((d) => h('li', null,
              badge(d.status), ` ${d.requestedBy} on ${fmtDateTime(d.requestedAt)}: “${d.reason}”`,
              d.decidedAt && d.status !== 'cancelled' ? h('div', { class: 'small muted' }, `${cap(d.status)} by ${d.decidedBy} on ${fmtDateTime(d.decidedAt)}${d.decisionReason ? ` – “${d.decisionReason}”` : ''}`) : null)))) : null)));
    focusMain();

    function pendingBanner(p) {
      const mine = p.requestedById === state.user.id;
      const canDecide = !mine && can.decideDeletion;
      return h('div', { class: 'notice warn' },
        h('strong', null, 'Deletion requested'), ` by ${p.requestedBy} on ${fmtDateTime(p.requestedAt)}. Reason: “${p.reason}”. `,
        'The record stays visible and counted until the request is decided.',
        h('div', { class: 'row', style: 'margin-top:.5rem' },
          canDecide ? h('button', { type: 'button', class: 'danger solid small', onclick: () => decideDeletion(p.id, 'approve', r[type.titleKey]) }, 'Approve deletion') : null,
          canDecide ? h('button', { type: 'button', class: 'small', onclick: () => decideDeletion(p.id, 'reject', r[type.titleKey]) }, 'Reject') : null,
          mine ? h('button', { type: 'button', class: 'small', onclick: () => decideDeletion(p.id, 'cancel', r[type.titleKey]) }, 'Cancel my request') : null,
          !mine && !can.decideDeletion ? h('span', { class: 'small' }, 'An approver or admin (other than the requester) must decide.') : null));
    }

    function attachmentsSection() {
      const list = data.attachments;
      const active = list.filter((a) => !a.removedAt);
      const removed = list.filter((a) => a.removedAt);
      const preview = h('div', { class: 'preview', 'aria-live': 'polite' });
      const item = (a) => h('li', { class: a.removedAt ? 'removed' : '' },
        h('span', { class: 'name' }, a.name, h('div', { class: 'muted small' },
          `${fmtSize(a.sizeBytes)} · ${a.uploadedBy}, ${fmtDateTime(a.uploadedAt)}`,
          a.removedAt ? ` · removed by ${a.removedBy}, ${fmtDateTime(a.removedAt)}` : '')),
        h('button', { type: 'button', class: 'small', onclick: () => viewAttachment(a, preview) }, 'View'),
        h('button', { type: 'button', class: 'small', onclick: () => openAttachment(a, true) }, 'Download'),
        editable && !a.removedAt ? h('button', { type: 'button', class: 'small', onclick: () => pickFile((files) => doUpload(files, a.id)) }, 'Replace') : null,
        editable && !a.removedAt ? h('button', { type: 'button', class: 'small danger', onclick: () => removeAttachment(a) }, 'Remove') : null);
      const status = h('p', { class: 'small muted', 'aria-live': 'polite' });
      const uploadBtn = editable ? h('button', { type: 'button', onclick: () => pickFile((files) => doUpload(files)) }, '+ Add files') : null;

      async function doUpload(files, replacesId) {
        if (!files.length) return;
        uploadBtn && (uploadBtn.disabled = true);
        try {
          await uploadFiles(`${base}/attachments`, files, { replacesId, onProgress: (p) => { status.textContent = `Uploading… ${p}%`; } });
          toast(replacesId ? 'Attachment replaced.' : 'Uploaded.');
          route();
        } catch (err) {
          status.textContent = '';
          toast(err.message, 'error');
        } finally { uploadBtn && (uploadBtn.disabled = false); }
      }
      async function removeAttachment(a) {
        const ok = await confirmDialog({ title: `Remove “${a.name}”?`, message: 'The file is hidden from the record but kept in its history.', confirmLabel: 'Remove', danger: true });
        if (!ok) return;
        try { await api(`${base}/attachments/${a.id}/remove`, { method: 'POST', body: {} }); toast('Attachment removed.'); route(); } catch (err) { toast(err.message, 'error'); }
      }
      return h('section', { class: 'card' },
        h('div', { class: 'page-head', style: 'margin-bottom:.5rem' }, h('h2', { style: 'margin:0' }, section === 'expenses' ? 'Receipts & invoices' : 'Attachments'), uploadBtn),
        status,
        active.length ? h('ul', { class: 'attachments' }, active.map(item)) : h('p', { class: 'muted' }, 'No attachments.'),
        removed.length ? h('details', null, h('summary', { class: 'small' }, `Removed or replaced files (${removed.length})`), h('ul', { class: 'attachments' }, removed.map(item))) : null,
        preview);
    }

    function purchaseSection() {
      if (archived) return null;
      const isDone = r.purchaseStatus === 'purchased';
      const box = h('section', { class: 'card' }, h('h2', null, 'Checklist'));
      const lockedByExpense = isDone && !!r.expenseId;
      const cb = h('input', { type: 'checkbox', id: 'done-toggle', checked: isDone, disabled: !editable || lockedByExpense });
      cb.addEventListener('change', async () => {
        cb.disabled = true;
        try {
          await api(`${base}/done`, { method: 'POST', body: { version: r.version, done: cb.checked } });
          toast(cb.checked ? 'Checked off.' : 'Unchecked.');
          route();
        } catch (err) { toast(err.message, 'error'); cb.checked = isDone; cb.disabled = false; }
      });
      append(box, h('div', { class: 'check-row' }, cb, h('label', { for: 'done-toggle' }, isDone ? 'Done' : 'Mark as done')));

      if (lockedByExpense) {
        append(box, [h('p', { class: 'small muted' }, 'Linked to an actual expense, which is what counts in the budget. Unlink it to uncheck this item.'),
          editable ? h('button', { type: 'button', class: 'small', onclick: unlink }, 'Unlink expense') : null]);
        return box;
      }
      if (!editable) return box;

      const form = h('form', { novalidate: true },
        h('p', { class: 'small muted' }, isDone
          ? 'Optional: record what it actually cost as an expense, so it counts in the budget.'
          : 'Bought it? You can check it off and record the actual expense in one step (optional).'),
        h('div', { class: 'form-grid' },
          field({ key: 'title', label: 'Expense title', required: true, max: 200 }, r.itemName, { idPrefix: 'pe' }),
          field({ key: 'amount', label: 'Actual amount', kind: 'money', required: true }, r.expectedPriceMinor ? Money.toInputString(r.expectedPriceMinor) : '', { idPrefix: 'pe' }),
          field({ key: 'expenseDate', label: 'Expense date', kind: 'date', required: true }, today(), { idPrefix: 'pe' }),
          field({ key: 'category', label: 'Category', max: 60 }, '', { idPrefix: 'pe' })),
        h('div', { class: 'row' }, h('button', { type: 'submit' }, isDone ? 'Create & link expense' : 'Check off & create expense')));
      const notice = formNotice(form);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const els = form.elements;
        const amt = Money.parseAmount(els.amount.value);
        if (!amt.ok) return showFieldErrors(form, { amount: amt.error });
        await busy(form.querySelector('[type=submit]'), 'Saving…', async () => {
          try {
            const res = await api(`${base}/link-expense`, { method: 'POST', body: { version: r.version, createExpense: { title: els.title.value, amount: els.amount.value, expenseDate: els.expenseDate.value, category: els.category.value } } });
            toast('Expense created and linked. Attach the receipt to the expense.');
            go(`#/g/${g.id}/expenses/${res.expenseId}`);
          } catch (err) { notice.show(err.message); showFieldErrors(form, err.details); }
        });
      });
      const linkExisting = h('button', { type: 'button', class: 'link small', onclick: chooseExisting }, 'Or link an existing expense…');
      append(box, h('details', { class: 'small', style: 'margin-top:.75rem' }, h('summary', null, isDone ? 'Record the actual expense' : 'Record the actual expense too'),
        form, h('p', { style: 'margin-top:.5rem' }, linkExisting)));
      return box;
    }

    async function chooseExisting() {
      const list = (await api(`/groups/${g.id}/expenses?pageSize=100&sort=date`)).items;
      const select = h('select', { id: 'link-exp', name: 'expense' }, list.map((e) => h('option', { value: e.id }, `${e.title} – ${money(e.amountMinor)} – ${fmtDate(e.expenseDate)}`)));
      const form = h('form', null, h('h2', null, 'Link an existing expense'),
        list.length ? h('div', { class: 'field' }, h('label', { for: 'link-exp' }, 'Expense'), select) : h('p', null, 'There are no active expenses to link.'),
        h('div', { class: 'row' }, list.length ? h('button', { type: 'submit', class: 'primary' }, 'Link') : null, h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancel')));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api(`${base}/link-expense`, { method: 'POST', body: { version: r.version, expenseId: Number(select.value) } });
          dialog.close();
          toast('Linked.');
          route();
        } catch (err) { toast(err.message, 'error'); }
      });
      dialog.replaceChildren(form);
      dialog.showModal();
    }

    async function unlink() {
      const ok = await confirmDialog({ title: 'Unlink the expense?', message: 'The item stays checked off. The expense itself is not changed.', confirmLabel: 'Unlink' });
      if (!ok) return;
      try { await api(`${base}/unlink-expense`, { method: 'POST', body: { version: r.version } }); toast('Unlinked.'); route(); } catch (err) { toast(err.message, 'error'); }
    }

    async function getLink(a) {
      return (await api(`${base}/attachments/${a.id}/link`)).url;
    }
    async function viewAttachment(a, preview) {
      try {
        const url = await getLink(a);
        preview.replaceChildren(h('div', { class: 'row', style: 'justify-content:space-between' }, h('strong', null, a.name), h('button', { type: 'button', class: 'small', onclick: () => preview.replaceChildren() }, 'Close preview')),
          a.mimeType.startsWith('image/') ? h('img', { src: url, alt: `Preview of ${a.name}` }) : h('iframe', { src: url, title: `PDF preview of ${a.name}` }));
        preview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (err) { toast(err.message, 'error'); }
    }
    async function openAttachment(a, download) {
      try {
        const url = await getLink(a);
        const link = h('a', { href: download ? `${url}?download=1` : url, rel: 'noopener' });
        document.body.append(link); link.click(); link.remove();
      } catch (err) { toast(err.message, 'error'); }
    }
  }

  function pickFile(onPick) {
    const input = h('input', { type: 'file', multiple: true, accept: '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png', hidden: true });
    input.addEventListener('change', () => { onPick([...input.files]); input.remove(); });
    document.body.append(input);
    input.click();
  }

  async function decideDeletion(id, action, title) {
    const cfg = {
      approve: { title: `Approve deletion of “${title}”?`, message: 'The record will be archived and excluded from totals. Its history and attachments are kept.', confirmLabel: 'Approve deletion', danger: true, reason: { label: 'Comment (optional)' } },
      reject: { title: `Reject deletion of “${title}”?`, message: 'The record stays as it is. The requester will be notified.', confirmLabel: 'Reject request', reason: { label: 'Reason (optional)' } },
      cancel: { title: 'Cancel your deletion request?', confirmLabel: 'Cancel request' },
    }[action];
    const res = await confirmDialog(cfg);
    if (!res) return;
    try {
      await api(`/groups/${state.group.id}/deletion-requests/${id}/${action}`, { method: 'POST', body: { reason: res.reason || undefined } });
      toast({ approve: 'Approved – record archived.', reject: 'Request rejected.', cancel: 'Request cancelled.' }[action]);
      route();
    } catch (err) { toast(err.message, 'error'); }
  }

  // ---------------------------------------------------------------------------
  // Deletion requests page
  // ---------------------------------------------------------------------------
  async function renderDeletions(query, isCurrent) {
    const g = state.group;
    const status = query.get('status') || 'pending';
    loading();
    const { requests } = await api(`/groups/${g.id}/deletion-requests?status=${encodeURIComponent(status)}`);
    if (!isCurrent()) return;
    const tabs = h('div', { class: 'row', role: 'tablist', 'aria-label': 'Filter by status', style: 'margin-bottom:1rem' },
      ['pending', 'approved', 'rejected', 'cancelled', 'all'].map((s) => h('a', {
        class: `btn small ${s === status ? 'primary' : ''}`, role: 'tab', 'aria-selected': String(s === status), href: `#/g/${g.id}/deletions?status=${s}`,
      }, cap(s))));
    const body = requests.length
      ? h('ul', { class: 'attachments' }, requests.map((d) => {
        const t = TYPES[d.recordPath];
        return h('li', null,
          h('div', { class: 'name' },
            h('div', null, badge(d.status), ' ', t.label, ': ', h('a', { href: `#/g/${g.id}/${d.recordPath}/${d.recordId}` }, d.recordTitle), ' · ', h('span', { class: 'num' }, money(d.amountMinor))),
            h('div', { class: 'small' }, `Requested by ${d.requestedBy}, ${fmtDateTime(d.requestedAt)} – “${d.reason}”`),
            d.decidedAt && d.status !== 'cancelled' ? h('div', { class: 'small muted' }, `${cap(d.status)} by ${d.decidedBy}, ${fmtDateTime(d.decidedAt)}${d.decisionReason ? ` – “${d.decisionReason}”` : ''}`) : null,
            d.status === 'cancelled' ? h('div', { class: 'small muted' }, `Cancelled by requester, ${fmtDateTime(d.decidedAt)}`) : null),
          d.canDecide ? h('button', { type: 'button', class: 'danger solid small', onclick: () => decideDeletion(d.id, 'approve', d.recordTitle) }, 'Approve') : null,
          d.canDecide ? h('button', { type: 'button', class: 'small', onclick: () => decideDeletion(d.id, 'reject', d.recordTitle) }, 'Reject') : null,
          d.status === 'pending' && d.requestedById === state.user.id ? h('button', { type: 'button', class: 'small', onclick: () => decideDeletion(d.id, 'cancel', d.recordTitle) }, 'Cancel') : null,
          d.status === 'pending' && !d.canDecide && d.requestedById !== state.user.id ? h('span', { class: 'small muted' }, 'Awaiting an approver') : null);
      }))
      : h('div', { class: 'empty' }, h('p', null, status === 'pending' ? 'No pending deletion requests.' : `No ${status === 'all' ? '' : `${status} `}requests.`));
    render(h('div', { class: 'page-head' }, h('h1', null, 'Deletion requests')),
      h('p', { class: 'muted small' }, 'Deleting a record needs approval from an approver or admin other than the requester. Approved records are archived, never erased.'),
      tabs, h('div', { class: 'card' }, body));
    focusMain();
  }

  // ---------------------------------------------------------------------------
  // Members page
  // ---------------------------------------------------------------------------
  const ROLE_HELP = {
    viewer: 'Can view everything',
    editor: 'Can add and edit records, request deletions',
    approver: 'Editor + approve others’ deletion requests',
    admin: 'Approver + manage members',
  };

  async function renderMembers(isCurrent) {
    const g = state.group;
    const isAdmin = g.permissions.manageMembers;
    loading();
    const [{ members }, inv] = await Promise.all([
      api(`/groups/${g.id}/members`),
      isAdmin ? api(`/groups/${g.id}/invitations`) : Promise.resolve({ invitations: [] }),
    ]);
    if (!isCurrent()) return;
    const roleOptions = (current) => Object.keys(ROLE_HELP).map((r) => h('option', { value: r, selected: r === current }, cap(r)));

    const rows = members.map((m) => h('tr', { class: m.status === 'revoked' ? 'archived' : '' },
      h('td', { 'data-label': 'Name' }, m.name, m.id === state.user.id ? h('span', { class: 'muted small' }, ' (you)') : null),
      h('td', { 'data-label': 'Role' }, isAdmin && m.status === 'active'
        ? h('select', { 'aria-label': `Role for ${m.name}`, onchange: (e) => changeRole(m, e.target) }, roleOptions(m.role))
        : cap(m.role)),
      h('td', { 'data-label': 'Status' }, m.status === 'active' ? badge('active') : badge('archived', 'Removed')),
      h('td', { 'data-label': '' }, m.status === 'active' && (isAdmin || m.id === state.user.id)
        ? h('button', { type: 'button', class: 'small danger', onclick: () => revoke(m) }, m.id === state.user.id ? 'Leave group' : 'Remove') : null)));

    async function changeRole(m, select) {
      try { await api(`/groups/${g.id}/members/${m.id}`, { method: 'PATCH', body: { role: select.value } }); toast(`${m.name} is now ${select.value}.`); route(); } catch (err) { toast(err.message, 'error'); select.value = m.role; }
    }
    async function revoke(m) {
      const self = m.id === state.user.id;
      const ok = await confirmDialog({ title: self ? `Leave ${g.name}?` : `Remove ${m.name}?`, message: self ? 'You will lose access immediately.' : 'They lose access immediately. Their past records and history are kept.', confirmLabel: self ? 'Leave' : 'Remove', danger: true });
      if (!ok) return;
      try {
        await api(`/groups/${g.id}/members/${m.id}/revoke`, { method: 'POST', body: {} });
        toast(self ? 'You left the group.' : `${m.name} was removed.`);
        go(self ? '#/groups' : location.hash);
      } catch (err) { toast(err.message, 'error'); }
    }

    let adminCards = null;
    if (isAdmin) {
      const addForm = h('form', { novalidate: true },
        h('div', { class: 'form-grid' },
          field({ key: 'name', label: 'Their name', required: true, max: 40, help: 'They need an account already.' }, '', { idPrefix: 'am' }),
          h('div', { class: 'field' }, h('label', { for: 'am-role' }, 'Role'), h('select', { id: 'am-role', name: 'role' }, roleOptions('editor')))),
        h('button', { type: 'submit', class: 'primary' }, 'Add member'));
      const addNotice = formNotice(addForm);
      addForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await busy(addForm.querySelector('[type=submit]'), 'Adding…', async () => {
          try { await api(`/groups/${g.id}/members`, { method: 'POST', body: { name: addForm.elements.name.value, role: addForm.elements.role.value } }); toast('Member added.'); route(); } catch (err) { addNotice.show(err.message); showFieldErrors(addForm, err.details); }
        });
      });

      const linkOut = h('div', { 'aria-live': 'polite' });
      const invForm = h('form', null,
        h('div', { class: 'field' }, h('label', { for: 'inv-role' }, 'Role for the new member'), h('select', { id: 'inv-role', name: 'role' }, roleOptions('editor'))),
        h('button', { type: 'submit', class: 'primary' }, 'Create invite link'), linkOut);
      invForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await busy(invForm.querySelector('[type=submit]'), 'Creating…', async () => {
          try {
            const { invitation } = await api(`/groups/${g.id}/invitations`, { method: 'POST', body: { role: invForm.elements.role.value } });
            const url = `${location.origin}/#/invite/${invitation.token}`;
            const input = h('input', { type: 'text', readonly: true, value: url, 'aria-label': 'Invite link', onfocus: (ev) => ev.target.select() });
            linkOut.replaceChildren(h('div', { class: 'notice ok', style: 'margin-top:1rem' },
              h('p', null, 'Copy this link and send it privately. It works once and expires ', fmtDateTime(invitation.expiresAt), '. It will not be shown again.'),
              input,
              h('button', { type: 'button', class: 'small', style: 'margin-top:.5rem', onclick: async () => { try { await navigator.clipboard.writeText(url); toast('Link copied.'); } catch { input.select(); } } }, 'Copy link')));
            input.focus();
          } catch (err) { toast(err.message, 'error'); }
        });
      });

      const invRows = inv.invitations.map((i) => {
        const st = i.acceptedAt ? `Used by ${i.acceptedBy}` : i.revokedAt ? 'Revoked' : Date.parse(i.expiresAt) < Date.now() ? 'Expired' : 'Open';
        return h('li', null,
          h('span', { class: 'name' }, `${cap(i.role)} · created by ${i.invitedBy}, ${fmtDateTime(i.createdAt)}`, h('div', { class: 'small muted' }, st)),
          st === 'Open' ? h('button', { type: 'button', class: 'small danger', onclick: async () => {
            try { await api(`/groups/${g.id}/invitations/${i.id}/revoke`, { method: 'POST', body: {} }); toast('Invite revoked.'); route(); } catch (err) { toast(err.message, 'error'); }
          } }, 'Revoke') : null);
      });

      adminCards = [
        h('div', { class: 'two-col' },
          h('section', { class: 'card' }, h('h2', null, 'Invite with a link'), h('p', { class: 'small muted' }, 'Anyone who opens the link while signed in can join, so share it only with the right person.'), invForm),
          h('section', { class: 'card' }, h('h2', null, 'Add an existing user'), addForm)),
        invRows.length ? h('section', { class: 'card' }, h('h2', null, 'Invite links'), h('ul', { class: 'attachments' }, invRows)) : null,
      ];
    }

    render(h('div', { class: 'page-head' }, h('h1', null, 'Members')),
      h('section', { class: 'card' },
        h('div', { class: 'table-wrap' }, h('table', { class: 'responsive' },
          h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Role'), h('th', null, 'Status'), h('th', null, h('span', { class: 'visually-hidden' }, 'Actions')))),
          h('tbody', null, rows))),
        h('details', { class: 'small', style: 'margin-top:.75rem' }, h('summary', null, 'What can each role do?'),
          h('ul', null, Object.entries(ROLE_HELP).map(([r, t]) => h('li', null, h('strong', null, cap(r)), ` – ${t}`))))),
      adminCards);
    focusMain();
  }

  // ---------------------------------------------------------------------------
  window.addEventListener('hashchange', route);
  route();
})();

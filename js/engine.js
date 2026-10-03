// Generic form engine: renders form definitions, keeps state, validates, builds JSON, import/export.
(function () {
  const STORE_KEY = 'vcf9-json-generator';
  const PROJECT_APP = 'vcf9-json-generator';

  const App = window.App = {
    forms: {},
    order: [],
    states: {},
    imported: {},
    cur: null,
    focused: null,
    issues: [],
    files: [],
    touched: new Set(),
    showAll: false,
    fileIdx: 0,
  };

  // ---------- DOM helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const $ = (sel, el) => (el || document).querySelector(sel);
  App.h = h;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ---------- form registration / state ----------
  App.register = function (form) {
    App.forms[form.id] = form;
    App.order.push(form.id);
  };

  function allFields(form) {
    const out = [];
    for (const sec of form.sections) for (const f of sec.fields) out.push([sec, f]);
    return out;
  }

  function defaultRow(f) {
    const row = {};
    for (const c of f.columns) row[c.id] = c.def !== undefined ? c.def : '';
    return row;
  }

  function defaultState(form) {
    const s = {};
    for (const [, f] of allFields(form)) {
      if (f.type === 'note') continue;
      if (f.type === 'rows') {
        s[f.id] = [];
        for (let i = 0; i < (f.initial || f.min || 1); i++) s[f.id].push(defaultRow(f));
      } else {
        s[f.id] = f.def !== undefined ? f.def : (f.type === 'checkbox' ? false : (f.type === 'select' ? f.options[0].v : ''));
      }
    }
    return s;
  }
  App.defaultState = defaultState;

  function normalizeState(form, s) {
    const d = defaultState(form);
    for (const k of Object.keys(d)) if (s[k] === undefined) s[k] = d[k];
    for (const [, f] of allFields(form)) {
      if (f.type === 'rows' && Array.isArray(s[f.id])) {
        s[f.id] = s[f.id].map(r => Object.assign(defaultRow(f), r));
      }
    }
    return s;
  }
  App.normalizeState = normalizeState;

  function isEmpty(v) {
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  }

  // Accessor used by builders: trimmed value, or auto-derived value when empty.
  function makeGetter(form, s) {
    const map = {};
    for (const [, f] of allFields(form)) map[f.id] = f;
    const get = function (id) {
      const f = map[id];
      const v = s[id];
      if (f && f.type === 'rows') return v;
      if (typeof v === 'string' && v.trim() !== '') return v.trim();
      if (f && f.auto && (typeof v !== 'string' || v.trim() === '')) {
        const a = f.auto(s, get);
        if (!isEmpty(a)) return a;
      }
      return v;
    };
    get.cell = function (rowsId, i, colId) {
      const f = map[rowsId];
      const row = s[rowsId][i];
      const v = row[colId];
      if (typeof v === 'string' && v.trim() !== '') return v.trim();
      const col = f.columns.find(c => c.id === colId);
      if (col && col.auto) {
        const a = col.auto(s, get, i);
        if (!isEmpty(a)) return a;
      }
      return v;
    };
    get.s = s;
    return get;
  }
  App.makeGetter = makeGetter;

  function visible(item, s, get) {
    return !item.show || item.show(s, get);
  }

  // ---------- validation ----------
  const FMT = {
    ipv4: v => Net.isIPv4(v) || 'Must be an IPv4 address, e.g. 10.11.11.10',
    ipv6: v => Net.isIPv6(v) || 'Must be an IPv6 address',
    gwcidr: v => {
      const c = Net.parseCidr(v);
      if (!c) return 'Use gateway in CIDR notation, e.g. 10.11.11.1/24';
      if (c.prefix > 30) return 'Prefix must be /30 or larger network';
      if (c.ip === c.network) return 'Enter the gateway address, not the network address (e.g. 10.11.11.1/24)';
      if (Net.toInt(c.ip) === c.broadcastInt) return 'Gateway cannot be the broadcast address';
      return true;
    },
    gwcidr6: v => Net.isIPv6Cidr(v) || 'Use IPv6 gateway in CIDR notation, e.g. 2001:db8::1/64',
    netcidr: v => {
      const c = Net.parseCidr(v);
      if (!c) return 'Use network CIDR notation, e.g. 10.11.11.0/24';
      if (c.ip !== c.network) return 'Use the network address: ' + c.cidr;
      return true;
    },
    fqdn: v => Net.isFqdn(v) || 'Must be a fully qualified domain name, e.g. sfo-m01-vc01.sfo.rainpole.io',
    host: v => Net.isHostLabel(v) || 'Letters, digits and hyphens only (max 63), no dots',
    domain: v => Net.isDomain(v) || 'Must be a DNS domain, e.g. sfo.rainpole.io',
    ipOrFqdn: v => Net.isIPv4(v) || Net.isFqdn(v) || 'Must be an IPv4 address or FQDN',
    vlan: v => (/^\d+$/.test(v) && Number(v) >= 0 && Number(v) <= 4094) || 'VLAN ID 0-4094 (0 = untagged)',
    mtu: v => (/^\d+$/.test(v) && Number(v) >= 1280 && Number(v) <= 9000) || 'MTU 1280-9000',
    int: v => /^\d+$/.test(v) || 'Must be a whole number',
    mask: v => Net.maskToPrefix(v) !== null || 'Must be a subnet mask, e.g. 255.255.255.0',
    thumb: v => /^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/.test(v) || /^SHA256:/.test(v) || 'SHA-256 thumbprint, e.g. 3D:D0:...:B8 (32 hex pairs)',
    vmnic: v => /^vmnic\d+$/.test(v) || 'Physical NIC name, e.g. vmnic0',
  };
  App.FMT = FMT;

  const SPECIALS = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

  function checkPassword(v, rule) {
    const errs = [];
    if (rule.min && v.length < rule.min) errs.push('at least ' + rule.min + ' characters');
    if (rule.max && v.length > rule.max) errs.push('at most ' + rule.max + ' characters');
    if (rule.complex !== false) {
      if (!/[A-Z]/.test(v)) errs.push('1 uppercase');
      if (!/[a-z]/.test(v)) errs.push('1 lowercase');
      if (!/\d/.test(v)) errs.push('1 digit');
      const set = rule.special || SPECIALS;
      if (![...v].some(c => set.includes(c))) errs.push('1 special character from ' + set);
    }
    if (/\s/.test(v)) errs.push('no spaces');
    if (/[^\x20-\x7e]/.test(v)) errs.push('ASCII only');
    if (rule.norepeat && /(.)\1\1/.test(v)) errs.push('no character repeated 3 times in a row');
    return errs.length ? 'Password needs ' + errs.join(', ') : true;
  }

  function fieldCheck(f, raw, s, get, extra) {
    const v = typeof raw === 'string' ? raw.trim() : raw;
    const required = typeof f.req === 'function' ? f.req(s, get, extra) : !!f.req;
    const autoVal = f.auto ? f.auto(s, get, extra) : null;
    if (f.type === 'checkbox' || f.type === 'select') return null;
    if (isEmpty(v)) {
      if (required && isEmpty(autoVal)) return { level: 'error', msg: 'Required' };
      return null;
    }
    if (f.fmt) {
      const fmts = Array.isArray(f.fmt) ? f.fmt : [f.fmt];
      if (f.list) {
        for (const item of String(v).split(/[\s,]+/).filter(Boolean)) {
          for (const fm of fmts) {
            const r = FMT[fm](item);
            if (r !== true) return { level: 'error', msg: item + ': ' + r };
          }
        }
      } else {
        for (const fm of fmts) {
          const r = FMT[fm](v);
          if (r !== true) return { level: 'error', msg: r };
        }
      }
    }
    if (f.pw) {
      const r = checkPassword(v, f.pw);
      if (r !== true) return { level: 'error', msg: r };
    }
    if (f.pattern && !new RegExp(f.pattern).test(v)) return { level: 'error', msg: f.patternMsg || 'Invalid format' };
    if (f.minLen && v.length < f.minLen) return { level: 'error', msg: 'At least ' + f.minLen + ' characters' };
    if (f.maxLen && v.length > f.maxLen) return { level: 'error', msg: 'At most ' + f.maxLen + ' characters' };
    if (f.check) {
      const r = f.check(v, s, get, extra);
      if (typeof r === 'string') return { level: 'error', msg: r };
      if (r && r.msg) return r;
    }
    return null;
  }

  function validateForm(form, s) {
    const get = makeGetter(form, s);
    const issues = [];
    for (const sec of form.sections) {
      if (!visible(sec, s, get)) continue;
      for (const f of sec.fields) {
        if (!visible(f, s, get)) continue;
        if (f.type === 'rows') {
          const rows = s[f.id] || [];
          if (f.min && rows.length < f.min) issues.push({ level: 'error', msg: f.label + ': at least ' + f.min + ' entries required', field: f.id, section: sec.id });
          if (f.max && rows.length > f.max) issues.push({ level: 'error', msg: f.label + ': at most ' + f.max + ' entries', field: f.id, section: sec.id });
          rows.forEach((row, i) => {
            for (const c of f.columns) {
              if (!visible(c, s, get)) continue;
              const r = fieldCheck(c, row[c.id], s, get, i);
              if (r) issues.push(Object.assign(r, { msg: f.label + ' #' + (i + 1) + ' ' + c.label + ': ' + r.msg, field: f.id + '.' + i + '.' + c.id, section: sec.id }));
            }
          });
        } else if (f.type !== 'note') {
          const r = fieldCheck(f, s[f.id], s, get);
          if (r) issues.push(Object.assign(r, { msg: f.label + ': ' + r.msg, field: f.id, section: sec.id }));
        }
      }
    }
    if (form.rules) {
      const secOf = {};
      for (const [sec, f] of allFields(form)) secOf[f.id] = sec.id;
      for (const r of form.rules(s, get) || []) {
        const base = r.field ? r.field.split('.')[0] : null;
        issues.push(Object.assign({ section: base ? secOf[base] : null }, r));
      }
    }
    return issues;
  }

  // ---------- schema validation (official API data structures) ----------
  function schemaDef(api, type) {
    return window.VCF_SCHEMA && VCF_SCHEMA[api] && VCF_SCHEMA[api][type];
  }

  function validateSchema(obj, api, type, path, out) {
    const def = schemaDef(api, type);
    if (!def) return;
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      out.push({ level: 'error', msg: path + ': expected an object (' + type + ')' });
      return;
    }
    for (const [k, f] of Object.entries(def)) {
      if (f.req && (obj[k] === undefined || obj[k] === null || obj[k] === '')) {
        out.push({ level: 'error', msg: path + '.' + k + ' is required by ' + type });
      }
    }
    for (const [k, val] of Object.entries(obj)) {
      const f = def[k];
      if (!f) {
        out.push({ level: 'warn', msg: path + '.' + k + ' is not a known field of ' + type + ' (9.1.1 API)' });
        continue;
      }
      if (val === null) continue;
      if (f.t === 'array') {
        if (!Array.isArray(val)) out.push({ level: 'error', msg: path + '.' + k + ': expected an array' });
        else val.forEach((x, i) => checkValue(x, f.items, f, api, path + '.' + k + '[' + i + ']', out));
      } else {
        checkValue(val, f.t, f, api, path + '.' + k, out);
      }
    }
  }

  function checkValue(val, t, f, api, path, out) {
    if (schemaDef(api, t)) return validateSchema(val, api, t, path, out);
    if (t === 'string') {
      if (typeof val !== 'string') {
        out.push({ level: 'error', msg: path + ': expected a string' });
        return;
      }
      if (f.enum && val !== '' && !f.enum.some(e => e.toLowerCase() === val.toLowerCase())) out.push({ level: 'error', msg: path + ': "' + val + '" is not one of ' + f.enum.join(', ') });
      if (f.pattern && val !== '') {
        let re = null;
        try { re = new RegExp(f.pattern); } catch (e) { re = null; }
        if (re && !re.test(val)) out.push({ level: 'error', msg: path + ': "' + val + '" does not match the required format' });
      }
      if (f.minLength && val !== '' && val.length < f.minLength) out.push({ level: 'error', msg: path + ': shorter than ' + f.minLength });
      if (f.maxLength && val.length > f.maxLength) out.push({ level: 'error', msg: path + ': longer than ' + f.maxLength });
    } else if (t === 'integer' || t === 'number') {
      if (typeof val === 'string' && /^-?\d+$/.test(val)) {
        out.push({ level: 'warn', msg: path + ': number given as string "' + val + '"' });
        val = Number(val);
      } else if (typeof val !== 'number') {
        out.push({ level: 'error', msg: path + ': expected a number' });
        return;
      }
      if (f.minimum !== undefined && val < f.minimum) out.push({ level: 'error', msg: path + ': below minimum ' + f.minimum });
      if (f.maximum !== undefined && val > f.maximum) out.push({ level: 'error', msg: path + ': above maximum ' + f.maximum });
    } else if (t === 'boolean') {
      if (val === 'true' || val === 'false') out.push({ level: 'warn', msg: path + ': boolean given as string' });
      else if (typeof val !== 'boolean') out.push({ level: 'error', msg: path + ': expected true/false' });
    }
  }

  App.validateJson = function (obj, api, type) {
    const out = [];
    if (Array.isArray(obj)) obj.forEach((x, i) => validateSchema(x, api, type, '[' + i + ']', out));
    else validateSchema(obj, api, type, '$', out);
    return out;
  };

  // Resolve official API description for a JSON path like "vcenterSpec.vcenterHostname".
  function apiDoc(form, path) {
    if (!path || !form.schema) return null;
    let type = form.schema.root;
    let f = null;
    const clean = path.replace(/\[[^\]]*\]/g, '').split(' ')[0];
    for (const part of clean.split('.')) {
      const def = schemaDef(form.schema.api, type);
      if (!def || !def[part]) return null;
      f = def[part];
      type = f.t === 'array' ? f.items : f.t;
    }
    return f;
  }

  // ---------- rendering ----------
  function optionOf(f, v) {
    return (f.options || []).find(o => String(o.v) === String(v));
  }

  function placeholderFor(f, s, get, i) {
    if (f.auto) {
      const a = f.auto(s, get, i);
      if (!isEmpty(a)) return 'Auto: ' + a;
    }
    if (f.ph) return 'e.g. ' + (typeof f.ph === 'function' ? f.ph(s, get, i) : f.ph);
    return '';
  }

  function inputFor(f, value, key, s, get, rowIdx, change) {
    const onChange = (v, r) => { App.touched.add(key); change(v, r); };
    const common = {
      id: 'f-' + key,
      'data-key': key,
      onfocus: () => showHelp(f, key),
    };
    if (f.type === 'select') {
      const sel = h('select', Object.assign(common, {
        onchange: e => onChange(e.target.value, true),
      }), (f.options || []).map(o => h('option', { value: o.v, selected: String(o.v) === String(value) }, o.l)));
      return sel;
    }
    if (f.type === 'checkbox') {
      return h('input', Object.assign(common, {
        type: 'checkbox', checked: !!value,
        onchange: e => onChange(e.target.checked, true),
      }));
    }
    if (f.type === 'textarea') {
      return h('textarea', Object.assign(common, {
        rows: f.rows || 3, placeholder: placeholderFor(f, s, get, rowIdx),
        oninput: e => onChange(e.target.value, false),
      }), value || '');
    }
    const inp = h('input', Object.assign(common, {
      type: f.type === 'password' ? 'password' : 'text',
      value: value === undefined || value === null ? '' : value,
      placeholder: placeholderFor(f, s, get, rowIdx),
      autocomplete: f.type === 'password' ? 'new-password' : 'off',
      spellcheck: 'false',
      oninput: e => onChange(e.target.value, false),
      onchange: () => { if (f.rerender) render(); },
    }));
    if (f.type === 'password') {
      const wrap = h('div', { class: 'pw' }, inp,
        h('button', { type: 'button', class: 'icon', title: 'Show/hide', tabindex: '-1', onclick: () => { inp.type = inp.type === 'password' ? 'text' : 'password'; } }, 'show'));
      return wrap;
    }
    return inp;
  }

  function renderField(f, s, get, sec) {
    if (f.type === 'note') {
      return h('div', { class: 'note' + (f.kind ? ' ' + f.kind : ''), html: typeof f.text === 'function' ? f.text(s, get) : f.text });
    }
    if (f.type === 'rows') return renderRows(f, s, get);
    const key = f.id;
    const ctrl = inputFor(f, s[f.id], key, s, get, undefined, (val, rerender) => {
      s[f.id] = val;
      changed(rerender || f.rerender === 'input');
    });
    const req = typeof f.req === 'function' ? f.req(s, get) : f.req;
    const label = h('label', { for: 'f-' + key }, f.label, req ? h('span', { class: 'req', title: 'Required' }, '*') : null);
    const helpBtn = h('button', { type: 'button', class: 'help-btn', tabindex: '-1', title: 'Explain', onclick: () => { showHelp(f, key); } }, '?');
    const kids = [h('div', { class: 'lbl' }, label, helpBtn), h('div', { class: 'ctl' }, ctrl)];
    if (f.type === 'select') {
      const o = optionOf(f, s[f.id]);
      if (o && o.d) kids.push(h('div', { class: 'optdesc' }, o.d));
    } else if (f.hint) {
      kids.push(h('div', { class: 'hint' }, typeof f.hint === 'function' ? f.hint(s, get) : f.hint));
    }
    kids.push(h('div', { class: 'err', id: 'e-' + key }));
    return h('div', { class: 'field' + (f.type === 'checkbox' ? ' cb' : '') + (f.wide ? ' wide' : ''), 'data-field': key }, kids);
  }

  function renderRows(f, s, get) {
    const rows = s[f.id];
    const cols = f.columns.filter(c => visible(c, s, get));
    const table = h('table', { class: 'rows' },
      h('thead', {}, h('tr', {}, h('th', {}, '#'), cols.map(c => h('th', {},
        c.label, (typeof c.req === 'function' ? c.req(s, get) : c.req) ? h('span', { class: 'req' }, '*') : null,
        h('button', { type: 'button', class: 'help-btn', tabindex: '-1', onclick: () => showHelp(c, f.id + '.0.' + c.id) }, '?'))), h('th', {}))),
      h('tbody', {}, rows.map((row, i) => h('tr', {},
        h('td', { class: 'idx' }, String(i + 1)),
        cols.map(c => {
          const key = f.id + '.' + i + '.' + c.id;
          return h('td', { 'data-field': key }, inputFor(c, row[c.id], key, s, get, i, (val, rerender) => {
            row[c.id] = val;
            changed(rerender);
          }), h('div', { class: 'err', id: 'e-' + key }));
        }),
        h('td', {}, h('button', {
          type: 'button', class: 'icon danger', title: 'Remove row', disabled: rows.length <= (f.min || 0),
          onclick: () => { rows.splice(i, 1); changed(true); },
        }, 'x'))))));
    const add = h('button', {
      type: 'button', class: 'btn small', disabled: f.max && rows.length >= f.max,
      onclick: () => { rows.push(defaultRow(f)); changed(true); },
    }, '+ ' + (f.addLabel || 'Add row'));
    const extra = f.tools ? f.tools(s, get, changed) : null;
    return h('div', { class: 'field wide rowsfield', 'data-field': f.id },
      h('div', { class: 'lbl' }, h('label', {}, f.label), h('button', { type: 'button', class: 'help-btn', tabindex: '-1', onclick: () => showHelp(f, f.id) }, '?')),
      f.hint ? h('div', { class: 'hint' }, typeof f.hint === 'function' ? f.hint(s, get) : f.hint) : null,
      h('div', { class: 'tablewrap' }, table),
      h('div', { class: 'rowtools' }, add, extra),
      h('div', { class: 'err', id: 'e-' + f.id }));
  }

  function render() {
    const form = App.forms[App.cur];
    const s = App.states[App.cur];
    const get = makeGetter(form, s);
    const main = $('#form');
    const nav = $('#sections');
    const scroll = main.scrollTop;
    const winScroll = window.scrollY;
    const active = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
    main.innerHTML = '';
    nav.innerHTML = '';
    main.append(h('div', { class: 'form-intro' }, h('h2', {}, form.title), h('p', { html: form.intro })));
    for (const sec of form.sections) {
      if (!visible(sec, s, get)) continue;
      nav.append(h('a', { href: '#sec-' + sec.id, 'data-sec': sec.id, onclick: e => { e.preventDefault(); $('#sec-' + sec.id).scrollIntoView({ behavior: 'smooth', block: 'start' }); } },
        h('span', { class: 'dot' }), sec.title));
      const body = h('div', { class: 'grid' });
      for (const f of sec.fields) if (visible(f, s, get)) body.append(renderField(f, s, get, sec));
      main.append(h('section', { class: 'card', id: 'sec-' + sec.id },
        h('h3', {}, sec.title),
        sec.intro ? h('p', { class: 'intro', html: typeof sec.intro === 'function' ? sec.intro(s, get) : sec.intro }) : null,
        body));
    }
    main.scrollTop = scroll;
    window.scrollTo(0, winScroll);
    if (active) {
      const el = document.querySelector('[data-key="' + active + '"]');
      if (el) el.focus({ preventScroll: true });
    }
    recompute();
  }
  App.render = render;

  let timer = null;
  function changed(rerender) {
    save();
    if (rerender) render();
    else {
      clearTimeout(timer);
      timer = setTimeout(recompute, 250);
    }
  }
  App.changed = changed;

  // ---------- compute issues + JSON ----------
  function recompute() {
    const form = App.forms[App.cur];
    const s = App.states[App.cur];
    const get = makeGetter(form, s);
    let issues = validateForm(form, s);
    let files = [];
    try {
      files = form.build(s, get).filter(Boolean);
    } catch (e) {
      console.error(e);
      issues.push({ level: 'error', msg: 'JSON build failed: ' + e.message });
    }
    for (const file of files) {
      if (file.json && file.schema) {
        const extra = s.__extra && file.main ? s.__extra : null;
        if (extra) for (const k of Object.keys(extra)) if (file.json[k] === undefined) file.json[k] = extra[k];
        for (const r of App.validateJson(file.json, file.schema.api, file.schema.type)) {
          issues.push(Object.assign(r, { msg: '[' + file.name + '] ' + r.msg, section: 'json' }));
        }
      }
    }
    if (App.imported[App.cur]) {
      for (const r of App.imported[App.cur]) issues.push(Object.assign({}, r, { section: 'import' }));
    }
    App.issues = issues;
    App.files = files;
    if (App.fileIdx >= files.length) App.fileIdx = 0;
    paintIssues();
    paintJson();
  }
  App.recompute = recompute;

  function paintIssues() {
    document.querySelectorAll('.err').forEach(e => { e.textContent = ''; });
    document.querySelectorAll('.has-err,.has-warn').forEach(e => e.classList.remove('has-err', 'has-warn'));
    const bySec = {};
    for (const is of App.issues) {
      const quiet = /: Required$/.test(is.msg) && !App.showAll && !App.touched.has(is.field);
      if (is.field && is.level !== 'info' && !quiet) {
        const el = document.getElementById('e-' + is.field);
        const box = document.querySelector('[data-field="' + is.field + '"]');
        if (el && !el.textContent) el.textContent = is.msg.replace(/^.*?: /, '');
        if (box) box.classList.add(is.level === 'error' ? 'has-err' : 'has-warn');
      }
      if (is.section && is.level !== 'info') {
        bySec[is.section] = bySec[is.section] || { error: 0, warn: 0 };
        if (is.level === 'error') bySec[is.section].error++;
        else if (is.level === 'warn') bySec[is.section].warn++;
      }
    }
    document.querySelectorAll('#sections a').forEach(a => {
      const c = bySec[a.dataset.sec];
      a.classList.toggle('bad', !!(c && c.error));
      a.classList.toggle('warnish', !!(c && !c.error && c.warn));
      a.classList.toggle('ok', !c);
    });
    const errs = App.issues.filter(i => i.level === 'error').length;
    const warns = App.issues.filter(i => i.level === 'warn').length;
    $('#issue-count').textContent = errs + warns ? String(errs + warns) : '';
    $('#issue-count').className = 'badge' + (errs ? ' bad' : warns ? ' warnish' : '');
    const status = $('#status');
    status.textContent = errs ? errs + ' error(s), ' + warns + ' warning(s)' : warns ? 'No errors, ' + warns + ' warning(s)' : 'Valid';
    status.className = 'status ' + (errs ? 'bad' : warns ? 'warnish' : 'ok');

    const list = $('#issues');
    list.innerHTML = '';
    if (!App.issues.length) {
      list.append(h('p', { class: 'muted' }, 'No issues found. Generated JSON matches the form rules and the official API schema.'));
      return;
    }
    const groups = [['error', 'Errors'], ['warn', 'Warnings'], ['info', 'Notes']];
    for (const [lvl, title] of groups) {
      const items = App.issues.filter(i => i.level === lvl);
      if (!items.length) continue;
      list.append(h('h4', { class: lvl }, title + ' (' + items.length + ')'));
      list.append(h('ul', { class: 'issues ' + lvl }, items.map(i => h('li', {
        class: i.field ? 'link' : '',
        onclick: () => i.field && jumpTo(i.field),
      }, i.section === 'import' ? h('span', { class: 'tag' }, 'imported file') : null, i.msg))));
    }
  }

  function jumpTo(key) {
    const el = document.querySelector('[data-key="' + key + '"]') || document.querySelector('[data-field="' + key + '"]');
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (el.focus) setTimeout(() => el.focus({ preventScroll: true }), 300);
  }

  function paintJson() {
    const sel = $('#file-select');
    sel.innerHTML = '';
    App.files.forEach((f, i) => sel.append(h('option', { value: i, selected: i === App.fileIdx }, (i + 1) + '. ' + f.title)));
    const f = App.files[App.fileIdx];
    $('#file-info').innerHTML = f ? (f.endpoint ? '<code>' + esc(f.method || 'POST') + ' ' + esc(f.endpoint) + '</code>' : '') + (f.note ? '<div>' + f.note + '</div>' : '') : '';
    $('#json-out').textContent = f ? JSON.stringify(f.json, null, 2) : '';
  }

  // ---------- help panel ----------
  function showHelp(f, key) {
    const form = App.forms[App.cur];
    const s = App.states[App.cur];
    const get = makeGetter(form, s);
    App.focused = key;
    const box = $('#help');
    box.innerHTML = '';
    box.append(h('h4', {}, f.label));
    if (f.help) box.append(h('div', { class: 'helptext', html: typeof f.help === 'function' ? f.help(s, get) : f.help }));
    if (f.options) {
      const cur = key && key.indexOf('.') > 0 ? null : s[f.id];
      box.append(h('div', { class: 'opts' }, f.options.map(o => h('div', { class: 'opt' + (String(o.v) === String(cur) ? ' sel' : '') },
        h('b', {}, o.l), o.d ? h('div', {}, o.d) : null))));
    }
    if (f.ph && !f.options) box.append(h('p', { class: 'muted' }, 'Workbook sample: ', h('code', {}, typeof f.ph === 'function' ? f.ph(s, get) : f.ph)));
    if (f.pw) box.append(h('p', { class: 'muted' }, 'Rules: ' + [f.pw.min ? 'min ' + f.pw.min : '', f.pw.max ? 'max ' + f.pw.max : '', 'upper + lower + digit + special' + (f.pw.special ? ' (' + f.pw.special + ')' : ''), f.pw.norepeat ? 'no 3 identical in a row' : ''].filter(Boolean).join(', ')));
    const paths = [].concat(f.api || []);
    if (paths.length) {
      box.append(h('div', { class: 'apipath' }, 'JSON: ', paths.map(p => h('code', {}, p))));
      const doc = apiDoc(form, paths[0]);
      if (doc && doc.d) box.append(h('details', { class: 'apidoc' }, h('summary', {}, 'Official API description'), h('p', {}, doc.d)));
    }
    switchSide('help');
  }
  App.showHelp = showHelp;

  function switchSide(tab) {
    document.querySelectorAll('.side-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.side-pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + tab));
  }
  App.switchSide = switchSide;

  // ---------- persistence ----------
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ cur: App.cur, states: App.states }));
    } catch (e) { /* storage unavailable */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  // ---------- import / export ----------
  function download(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2) + '\n'], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function redact(obj) {
    if (Array.isArray(obj)) return obj.map(redact);
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (/password/i.test(k)) continue;
        out[k] = redact(v);
      }
      return out;
    }
    return obj;
  }
  App.redact = redact;

  function detectForm(json) {
    for (const id of App.order) {
      const f = App.forms[id];
      if (f.detect && f.detect(json)) return id;
    }
    return null;
  }

  function importJson(text) {
    let json;
    try { json = JSON.parse(text); } catch (e) { return { error: 'Not valid JSON: ' + e.message }; }
    if (json && json.app === PROJECT_APP && json.forms) {
      for (const id of App.order) {
        if (json.forms[id]) App.states[id] = normalizeState(App.forms[id], json.forms[id]);
        delete App.imported[id];
      }
      return { project: true };
    }
    const id = detectForm(json);
    if (!id) return { error: 'Could not recognise this JSON. Supported: VCF Installer spec (SddcSpec), workload domain spec (DomainCreationSpec), cluster stretch spec (ClusterUpdateSpec / ClusterStretchSpec), or a project file saved from this tool.' };
    const form = App.forms[id];
    const raw = form.rawSchema ? form.rawSchema(json) : null;
    const rawIssues = raw ? App.validateJson(json, raw.api, raw.type) : [];
    const res = form.fromJson(json);
    const st = normalizeState(form, Object.assign(defaultState(form), res.state));
    if (res.extra && Object.keys(res.extra).length) st.__extra = res.extra;
    App.states[id] = st;
    App.imported[id] = rawIssues.concat((res.notes || []).map(n => ({ level: 'info', msg: n })));
    return { id, rawIssues, notes: res.notes || [], extra: res.extra };
  }
  App.importJson = importJson;

  function validateOnly(text) {
    let json;
    try { json = JSON.parse(text); } catch (e) { return { error: 'Not valid JSON: ' + e.message }; }
    const id = detectForm(json);
    if (!id) return { error: 'Unknown JSON type.' };
    const raw = App.forms[id].rawSchema(json);
    return { id, issues: App.validateJson(json, raw.api, raw.type), type: raw.type };
  }

  // ---------- shell wiring ----------
  function selectForm(id) {
    App.cur = id;
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.form === id));
    App.fileIdx = 0;
    save();
    render();
    $('#help').innerHTML = '<h4>Help</h4><p>Click a field or the <b>?</b> button next to it to see what to enter, what each drop-down alternative means, and which JSON property it maps to.</p>';
    switchSide('help');
    window.scrollTo(0, 0);
  }
  App.selectForm = selectForm;

  function openDialog() {
    const dlg = $('#open-dialog');
    $('#open-text').value = '';
    $('#open-result').innerHTML = '';
    dlg.showModal();
  }

  function showResult(html) { $('#open-result').innerHTML = html; }

  function issuesHtml(list) {
    if (!list.length) return '<p class="ok">No schema issues found.</p>';
    return '<ul class="issues">' + list.map(i => '<li class="' + i.level + '">' + esc(i.msg) + '</li>').join('') + '</ul>';
  }

  App.init = function () {
    const saved = load();
    for (const id of App.order) {
      const form = App.forms[id];
      App.states[id] = saved && saved.states && saved.states[id] ? normalizeState(form, saved.states[id]) : defaultState(form);
    }
    const tabs = $('#tabs');
    for (const id of App.order) {
      tabs.append(h('button', { type: 'button', 'data-form': id, onclick: () => selectForm(id) }, App.forms[id].tab));
    }
    document.querySelectorAll('.side-tabs button').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.tab === 'issues' && !App.showAll) { App.showAll = true; recompute(); }
      switchSide(b.dataset.tab);
    }));

    $('#btn-open').onclick = openDialog;
    $('#open-file').onchange = e => {
      const file = e.target.files[0];
      if (!file) return;
      file.text().then(t => { $('#open-text').value = t; });
      e.target.value = '';
    };
    $('#open-validate').onclick = () => {
      const r = validateOnly($('#open-text').value);
      if (r.error) return showResult('<p class="bad">' + esc(r.error) + '</p>');
      showResult('<p>Detected <b>' + esc(App.forms[r.id].tab) + '</b> (' + esc(r.type) + '): ' +
        r.issues.filter(i => i.level === 'error').length + ' error(s), ' + r.issues.filter(i => i.level === 'warn').length + ' warning(s).</p>' + issuesHtml(r.issues));
    };
    $('#open-load').onclick = () => {
      const r = importJson($('#open-text').value);
      if (r.error) return showResult('<p class="bad">' + esc(r.error) + '</p>');
      $('#open-dialog').close();
      App.showAll = true;
      selectForm(r.project ? App.cur : r.id);
      if (!r.project) switchSide('issues');
    };
    $('#btn-save-project').onclick = () => {
      download('vcf9-plan-' + new Date().toISOString().slice(0, 10) + '.json', { app: PROJECT_APP, version: 1, saved: new Date().toISOString(), forms: App.states });
    };
    $('#btn-reset').onclick = () => {
      if (!confirm('Clear all values in "' + App.forms[App.cur].tab + '"?')) return;
      App.states[App.cur] = defaultState(App.forms[App.cur]);
      delete App.imported[App.cur];
      save();
      render();
    };
    $('#btn-sample').onclick = () => {
      const form = App.forms[App.cur];
      if (!form.sample) return;
      if (!confirm('Replace current values with the workbook sample values?')) return;
      App.states[App.cur] = normalizeState(form, Object.assign(defaultState(form), form.sample()));
      App.showAll = true;
      delete App.imported[App.cur];
      save();
      render();
    };
    $('#file-select').onchange = e => { App.fileIdx = Number(e.target.value); paintJson(); };
    const cur = () => App.files[App.fileIdx];
    $('#btn-copy').onclick = () => {
      if (!cur()) return;
      navigator.clipboard.writeText(JSON.stringify(cur().json, null, 2)).then(() => flash('#btn-copy', 'Copied'));
    };
    $('#btn-dl').onclick = () => { if (cur()) download(cur().name, cur().json); };
    $('#btn-dl-redacted').onclick = () => { if (cur()) download(cur().name.replace(/\.json$/, '') + '-no-passwords.json', redact(cur().json)); };
    $('#btn-dl-all').onclick = () => {
      App.files.forEach((f, i) => setTimeout(() => download(f.name, f.json), i * 400));
    };
    $('#btn-validate').onclick = () => { App.showAll = true; recompute(); switchSide('issues'); };

    const start = saved && saved.cur && App.forms[saved.cur] ? saved.cur : App.order[0];
    selectForm(start);

    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        document.querySelectorAll('#sections a').forEach(a => a.classList.toggle('current', 'sec-' + a.dataset.sec === e.target.id));
      }
    }, { rootMargin: '-20% 0px -70% 0px' });
    new MutationObserver(() => document.querySelectorAll('#form section.card').forEach(sec => io.observe(sec)))
      .observe($('#form'), { childList: true });
    document.querySelectorAll('#form section.card').forEach(sec => io.observe(sec));
  };

  function flash(sel, text) {
    const b = $(sel);
    const old = b.textContent;
    b.textContent = text;
    setTimeout(() => { b.textContent = old; }, 1200);
  }
})();

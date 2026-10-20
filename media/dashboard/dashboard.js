/*
 * Claude Code Orchestrator - dashboard page.
 *
 * Plain ES2020, no bundler, no dependencies. Loaded by the extension's webview (see
 * src/dashboard.ts) and, unchanged, by media/dashboard/preview.html in a plain browser.
 *
 * Rules this file holds (contract section 7.2):
 *  - The DOM is built with createElement / textContent / setAttribute only. No markup-string
 *    API is used anywhere, so no value from the model can ever become markup.
 *  - The model is treated as UNTRUSTED even though the host has already projected it: it is
 *    normalized once, in section 2, into a shape the rest of the file can rely on. A field of
 *    the wrong type becomes null and renders as an em dash.
 *  - Components are RETAINED. A card, a row or a control is created once per key and then
 *    updated in place, so a refresh never replaces a button between press and release and
 *    never steals focus from something the user is using.
 *  - Relative times are computed here from timestamps and tick once a second.
 *  - Every visible string comes from the table the host assigns to window.__CCO_STRINGS__.
 */
(function () {
  'use strict';

  /* ======================================================================= *
   * 0. Bootstrap
   * ======================================================================= */

  const vscode =
    typeof acquireVsCodeApi === 'function'
      ? acquireVsCodeApi()
      : { postMessage() {}, getState() { return null; }, setState() {} };

  const STRINGS = typeof window.__CCO_STRINGS__ === 'object' && window.__CCO_STRINGS__ !== null ? window.__CCO_STRINGS__ : {};
  const LANG = document.documentElement.lang || undefined;
  const DASH = '\u2014';
  const SCHEMA = 2;

  /** Localized text for `key`, with positional {0} {1} ... arguments. A missing key shows itself. */
  function t(key) {
    const raw = typeof STRINGS[key] === 'string' ? STRINGS[key] : key;
    if (arguments.length === 1) {
      return raw;
    }
    const args = arguments;
    return raw.replace(/\{(\d+)\}/g, function (_m, i) {
      const v = args[Number(i) + 1];
      return v === undefined || v === null ? DASH : String(v);
    });
  }

  function post(message) {
    try {
      vscode.postMessage(message);
    } catch (e) {
      /* the host went away; nothing useful to do from here */
    }
  }

  /** The OS setting, or VS Code's own `workbench.reduceMotion` (a class on <body>). */
  function reducedMotion() {
    return (
      document.body.classList.contains('vscode-reduce-motion') ||
      (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    );
  }

  /* ======================================================================= *
   * 1. Utilities: DOM, icons, formatting
   * ======================================================================= */

  let uidSeq = 0;
  function uid(prefix) {
    uidSeq += 1;
    return 'cco-' + prefix + '-' + uidSeq;
  }

  /**
   * Create an element. `attrs` are set as attributes, except `class` and `text`. `style` and
   * `on*` are refused on purpose: sizes go through the CSSOM (setVar below) and handlers
   * through addEventListener, which is what lets the page run under a CSP with no inline
   * style and no inline script.
   */
  function h(tag, attrs, kids) {
    const node = document.createElement(tag);
    if (attrs) {
      setAttrs(node, attrs);
    }
    if (kids !== undefined) {
      append(node, kids);
    }
    return node;
  }

  function setAttrs(node, attrs) {
    const names = Object.keys(attrs);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const value = attrs[name];
      if (name === 'style' || name.slice(0, 2) === 'on') {
        continue;
      }
      if (name === 'class') {
        node.className = value;
      } else if (name === 'text') {
        node.textContent = value;
      } else {
        attr(node, name, value);
      }
    }
  }

  /** Set, or (for false / null / undefined) remove, one attribute - only when it changes. */
  function attr(node, name, value) {
    if (value === false || value === null || value === undefined) {
      if (node.hasAttribute(name)) {
        node.removeAttribute(name);
      }
      return;
    }
    const next = value === true ? '' : String(value);
    if (node.getAttribute(name) !== next) {
      node.setAttribute(name, next);
    }
  }

  function append(node, kids) {
    if (Array.isArray(kids)) {
      for (let i = 0; i < kids.length; i++) {
        append(node, kids[i]);
      }
    } else if (kids === null || kids === undefined || kids === false) {
      /* nothing */
    } else if (typeof kids === 'string' || typeof kids === 'number') {
      node.appendChild(document.createTextNode(String(kids)));
    } else {
      node.appendChild(kids);
    }
  }

  function clear(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function setText(node, text) {
    if (node.textContent !== text) {
      node.textContent = text;
    }
  }

  function show(node, visible) {
    const hide = !visible;
    if (node.hidden !== hide) {
      node.hidden = hide;
    }
  }

  function toggleClass(node, name, on) {
    if (node.classList.contains(name) !== Boolean(on)) {
      node.classList.toggle(name, Boolean(on));
    }
  }

  /** A dynamic size, through the CSSOM (allowed by the CSP; an inline style attribute is not). */
  function setVar(node, name, value) {
    node.style.setProperty(name, value);
  }

  function on(node, type, handler, options) {
    node.addEventListener(type, handler, options);
  }

  /* ---- icons: small inline SVG built with createElementNS (24-unit grid, stroked) ---- */

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const circle = function (cx, cy, r) {
    return 'M' + cx + ' ' + (cy - r) + 'a' + r + ' ' + r + ' 0 1 0 0 ' + 2 * r + 'a' + r + ' ' + r + ' 0 1 0 0 ' + -2 * r + 'z';
  };
  const RING = circle(12, 12, 10);
  const ICONS = {
    blank: [],
    check: ['M20 6L9 17l-5-5'],
    x: ['M18 6L6 18', 'M6 6l12 12'],
    done: [RING, 'M16.5 9l-5.6 6-3.4-3.3'],
    failed: [RING, 'M15 9l-6 6', 'M9 9l6 6'],
    cancelled: [RING, 'M4.93 4.93l14.14 14.14'],
    orphaned: [[RING, 'dashed'], 'M12 8v4', 'M12 16h.01'],
    unknown: [RING, 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3', 'M12 17h.01'],
    spin: ['M21 12a9 9 0 1 1-6.22-8.56'],
    warn: ['M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z', 'M12 9v4', 'M12 17h.01'],
    alert: [RING, 'M12 8v4', 'M12 16h.01'],
    info: [RING, 'M12 16v-4', 'M12 8h.01'],
    clock: [RING, 'M12 6v6l4 2'],
    pause: [RING, 'M10 15V9', 'M14 15V9'],
    refresh: ['M23 4v6h-6', 'M1 20v-6h6', 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10', 'M1 14l4.64 4.36A9 9 0 0 0 20.49 15'],
    gear: [
      circle(12, 12, 3),
      'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z',
    ],
    star: ['M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z'],
    home: ['M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9 22V12h6v10'],
    more: [circle(12, 12, 1), circle(19, 12, 1), circle(5, 12, 1)],
    terminal: ['M4 17l6-6-6-6', 'M12 19h8'],
    logs: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
    branch: ['M6 3v12', circle(18, 6, 3), circle(6, 18, 3), 'M18 9a9 9 0 0 1-9 9'],
    diff: ['M12 4v9', 'M7.5 8.5h9', 'M7.5 19h9'],
    stop: ['M7 7h10v10H7z'],
    copy: ['M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
    chevronDown: ['M6 9l6 6 6-6'],
    chevronRight: ['M9 18l6-6-6-6'],
    users: ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', circle(9, 7, 4), 'M23 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
    user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', circle(12, 7, 4)],
    link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
    plus: ['M12 5v14', 'M5 12h14'],
    search: [circle(11, 11, 8), 'M21 21l-4.35-4.35'],
    login: ['M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4', 'M10 17l5-5-5-5', 'M15 12H3'],
    zap: ['M13 2L3 14h9l-1 8 10-12h-9l1-8z'],
    cpu: ['M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M9 9h6v6H9z', 'M9 1v3', 'M15 1v3', 'M9 20v3', 'M15 20v3', 'M20 9h3', 'M20 14h3', 'M1 9h3', 'M1 14h3'],
    trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
    folder: ['M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'],
    activity: ['M22 12h-4l-3 9L9 3l-3 9H2'],
    external: ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14L21 3'],
    // Provider sigils: one plain shape per CLI, told apart by outline AND by fill - never by
    // colour, which this page keeps for state. `provX` is a CLI the settings do not list.
    prov0: [['M5 5h14v14H5z', 'solid']],
    prov1: [[circle(12, 12, 7.5), 'heavy']],
    prov2: [['M12 4l9.5 16h-19z', 'solid']],
    prov3: [['M12 2.5l9.5 9.5-9.5 9.5L2.5 12z', 'heavy']],
    prov4: [['M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5z', 'solid']],
    prov5: [['M12 3.5v17', 'heavy'], ['M3.5 12h17', 'heavy']],
    provX: [[circle(12, 12, 7.5), 'heavy dashed']],
  };

  function icon(name, extraClass) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'ico' + (extraClass ? ' ' + extraClass : ''));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    // An own entry of the table only: a name that is not one is the "unknown" mark, and never
    // something an object happens to answer to (`constructor`, `toString`).
    const parts = Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : ICONS.unknown;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const path = document.createElementNS(SVG_NS, 'path');
      if (Array.isArray(part)) {
        path.setAttribute('d', part[0]);
        path.setAttribute('class', part[1]);
      } else {
        path.setAttribute('d', part);
      }
      svg.appendChild(path);
    }
    return svg;
  }

  /** Swap the icon held in `slot` (a span) only when its name changes. */
  function setIcon(slot, name) {
    if (slot.getAttribute('data-icon') === name) {
      return;
    }
    slot.setAttribute('data-icon', name);
    clear(slot);
    slot.appendChild(icon(name));
  }

  function iconSlot(name, extraClass) {
    const slot = h('span', { class: 'ico-slot' + (extraClass ? ' ' + extraClass : '') });
    setIcon(slot, name);
    return slot;
  }

  /* ---- buttons ---- */

  const buttonLabels = new WeakMap();

  /** A real <button>. `opts`: label, icon, cls, title, iconOnly, trailing (icon after label). */
  function button(opts, onClick) {
    const node = h('button', { type: 'button', class: 'btn' + (opts.cls ? ' ' + opts.cls : '') });
    if (opts.icon) {
      node.appendChild(icon(opts.icon));
    }
    const label = h('span', { class: opts.iconOnly ? 'vh' : 'btn-label', text: opts.label || '' });
    node.appendChild(label);
    if (opts.trailing) {
      node.appendChild(icon(opts.trailing, 'ico-trail'));
    }
    if (opts.iconOnly) {
      node.classList.add('btn-icon');
    }
    if (opts.title || opts.iconOnly) {
      node.title = opts.title || opts.label || '';
    }
    buttonLabels.set(node, label);
    if (onClick) {
      on(node, 'click', onClick);
    }
    return node;
  }

  function setButtonLabel(node, text) {
    const label = buttonLabels.get(node);
    if (label) {
      setText(label, text);
      if (node.classList.contains('btn-icon')) {
        node.title = text;
      }
    }
  }

  /**
   * Two-step button for an action that cannot be undone and that the host does not confirm:
   * the first press arms it (the label changes), a second press within four seconds runs it.
   * An action the host asks about in a dialog of its own gets a plain button instead - asked
   * twice, the second question is the one people stop reading.
   */
  function armable(node, idleLabel, armedLabel, action) {
    let timer = null;
    function disarm() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      node.classList.remove('is-armed');
      setButtonLabel(node, idleLabel);
    }
    on(node, 'click', function () {
      if (timer !== null) {
        disarm();
        action();
        return;
      }
      node.classList.add('is-armed');
      setButtonLabel(node, armedLabel);
      announce(armedLabel);
      timer = setTimeout(disarm, 4000);
    });
    on(node, 'blur', disarm);
    return disarm;
  }

  /* ---- formatting ---- */

  function intl(make) {
    try {
      return make(LANG);
    } catch (e) {
      try {
        return make(undefined);
      } catch (e2) {
        return null;
      }
    }
  }
  const nfInt = intl(function (l) { return new Intl.NumberFormat(l, { maximumFractionDigits: 0 }); });
  const nfCompact = intl(function (l) { return new Intl.NumberFormat(l, { notation: 'compact', maximumFractionDigits: 1 }); });
  const nfUsd = intl(function (l) {
    return new Intl.NumberFormat(l, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  });
  const lfNames = intl(function (l) { return new Intl.ListFormat(l, { style: 'short', type: 'unit' }); });
  const dfTime = intl(function (l) { return new Intl.DateTimeFormat(l, { hour: '2-digit', minute: '2-digit' }); });
  const dfDate = intl(function (l) { return new Intl.DateTimeFormat(l, { month: 'short', day: 'numeric' }); });

  function fmtInt(n) {
    return n === null ? DASH : nfInt ? nfInt.format(n) : String(Math.round(n));
  }
  function fmtCompact(n) {
    return n === null ? DASH : nfCompact ? nfCompact.format(n) : String(Math.round(n));
  }
  /** A count in full while it is readable at a glance, compact once it is not. */
  function fmtCount(n) {
    return n !== null && n >= 100000 ? fmtCompact(n) : fmtInt(n);
  }
  const TOKEN_UNITS = ['k', 'M', 'B', 'T', 'Q'];
  /**
   * A token count: exact below 10,000, then one decimal and a unit - 10.0k, 642.8k, 17.9M.
   * The page's twin of the host's formatTokenCount (src/usage.ts), so a count reads the same
   * on a card as in the Workers tree. The unit is taken from the ROUNDED figure, so a count
   * just under a boundary reads 1.0M and never 1000.0k; a value that is not a count is 0.
   */
  function fmtTokens(n) {
    if (n === null) {
      return DASH;
    }
    if (!(n > 0) || n > Number.MAX_SAFE_INTEGER) {
      return fmtInt(0);
    }
    const count = Math.round(n);
    if (count < 10000) {
      return fmtInt(count);
    }
    let scaled = count / 1000;
    let unit = 0;
    while (unit < TOKEN_UNITS.length - 1 && Number(scaled.toFixed(1)) >= 1000) {
      scaled /= 1000;
      unit += 1;
    }
    return scaled.toFixed(1) + TOKEN_UNITS[unit];
  }
  function fmtUsd(n) {
    return n === null ? DASH : nfUsd ? nfUsd.format(n) : '$' + n.toFixed(2);
  }
  function fmtPct(n) {
    return n === null ? DASH : t('pct', Math.round(n));
  }
  /** "A, B, C" as the UI language writes a plain list. */
  function fmtList(items) {
    if (lfNames) {
      try {
        return lfNames.format(items);
      } catch (e) {
        /* fall through to the plain join */
      }
    }
    return items.join(', ');
  }
  function fmtClock(ts) {
    if (ts === null || !dfTime) {
      return DASH;
    }
    try {
      return dfTime.format(new Date(ts));
    } catch (e) {
      return DASH;
    }
  }
  function fmtDay(ts) {
    if (ts === null || !dfDate) {
      return DASH;
    }
    try {
      return dfDate.format(new Date(ts));
    } catch (e) {
      return DASH;
    }
  }
  function sameDay(a, b) {
    const x = new Date(a);
    const y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  }
  /** Clock time today, date + clock time on any other day. */
  function fmtWhen(ts, now) {
    if (ts === null) {
      return DASH;
    }
    return sameDay(ts, now) ? fmtClock(ts) : t('dateTime', fmtDay(ts), fmtClock(ts));
  }
  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }
  /** A length of time. `fine` keeps seconds under an hour (for something that is running). */
  function fmtSpan(ms, fine) {
    if (ms === null || !Number.isFinite(ms) || ms < 0) {
      return DASH;
    }
    const s = Math.floor(ms / 1000);
    if (s < 60) {
      return t('unitS', s);
    }
    const m = Math.floor(s / 60);
    if (m < 60) {
      return fine ? t('unitMS', m, pad2(s % 60)) : t('unitM', m);
    }
    const hours = Math.floor(m / 60);
    if (hours < 24) {
      return t('unitHM', hours, pad2(m % 60));
    }
    return t('unitDH', Math.floor(hours / 24), hours % 24);
  }
  /** One coarse unit, for "... ago". */
  function fmtAge(ms) {
    if (ms === null || !Number.isFinite(ms) || ms < 0) {
      return DASH;
    }
    const s = Math.floor(ms / 1000);
    if (s < 60) {
      return t('unitS', s);
    }
    if (s < 3600) {
      return t('unitM', Math.floor(s / 60));
    }
    if (s < 86400) {
      return t('unitH', Math.floor(s / 3600));
    }
    return t('unitD', Math.floor(s / 86400));
  }
  function fmtAgo(ts, now) {
    if (ts === null) {
      return DASH;
    }
    const delta = now - ts;
    return delta < 10000 ? t('justNow') : t('ago', fmtAge(delta));
  }

  /* ======================================================================= *
   * 2. Model normalization (untrusted input -> a shape the renderers can rely on)
   * ======================================================================= */

  const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
  const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

  function isObj(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }
  function list(v, max) {
    if (!Array.isArray(v)) {
      return [];
    }
    return v.length > max ? v.slice(0, max) : v;
  }
  /** Display text: a string, bidi and control characters removed, cut to `max`; else null. */
  function str(v, max) {
    if (typeof v !== 'string') {
      return null;
    }
    let s = v.length > max * 4 ? v.slice(0, max * 4) : v;
    s = s.replace(BIDI_CONTROLS, '').replace(CONTROL_CHARS, ' ').trim();
    if (s.length > max) {
      s = s.slice(0, max - 1);
      const last = s.charCodeAt(s.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        s = s.slice(0, -1);
      }
      s += '\u2026';
    }
    return s === '' ? null : s;
  }
  function fin(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  /** A count: finite and not negative, floored. */
  function cnt(v) {
    const n = fin(v);
    return n !== null && n >= 0 ? Math.floor(n) : null;
  }
  /** An amount: finite and not negative. */
  function amt(v) {
    const n = fin(v);
    return n !== null && n >= 0 ? n : null;
  }
  function pct(v) {
    const n = fin(v);
    return n === null ? null : Math.min(100, Math.max(0, n));
  }
  /** Epoch milliseconds inside the range a Date can represent. */
  function when(v) {
    const n = fin(v);
    return n !== null && n > 0 && n < 8.64e15 ? n : null;
  }
  function tri(v) {
    return v === true ? true : v === false ? false : null;
  }
  function pick(v, allowed, fallback) {
    return typeof v === 'string' && allowed.indexOf(v) !== -1 ? v : fallback;
  }

  /**
   * Values the page SENDS BACK (a model id, a permission mode): kept only when they are
   * already clean and short enough, never repaired. A cut or re-spaced id would be posted as
   * a choice the host never offered.
   */
  function exact(v, maxItems, maxLen) {
    const out = [];
    list(v, maxItems).forEach(function (x) {
      if (typeof x === 'string' && x.length <= maxLen && str(x, maxLen) === x && out.indexOf(x) === -1) {
        out.push(x);
      }
    });
    return out;
  }

  /** Give every item a unique DOM key, even when the data repeats or lacks its own. */
  function assignDomKeys(items, field) {
    const seen = new Set();
    for (let i = 0; i < items.length; i++) {
      let key = items[i][field] === null ? '#' + i : '=' + items[i][field];
      while (seen.has(key)) {
        key += '~';
      }
      seen.add(key);
      items[i].dom = key;
    }
    return items;
  }

  function normStats(raw) {
    const o = isObj(raw) ? raw : {};
    return { tasks: cnt(o.tasks), inputTokens: cnt(o.inputTokens), outputTokens: cnt(o.outputTokens), costUsd: amt(o.costUsd) };
  }

  function normAccount(raw) {
    const o = isObj(raw) ? raw : {};
    const allTime = normStats(o.allTime);
    allTime.errors = cnt(isObj(o.allTime) ? o.allTime.errors : null);
    return {
      key: str(o.key, 128),
      name: str(o.name, 64) || DASH,
      isMain: o.isMain === true,
      isWorker: o.isWorker === true,
      preferred: o.preferred === true,
      defaultModel: str(o.defaultModel, 64),
      provider: str(o.provider, 64),
      providerLabel: str(o.providerLabel, 32),
      sessionWorkers: o.sessionWorkers === true,
      permissionMode: str(o.permissionMode, 32),
      modelRanAs: str(o.modelRanAs, 64),
      login: pick(o.login, ['ok', 'expired', 'no-plan-limits', 'error', 'refreshing'], 'unknown'),
      loginDetail: str(o.loginDetail, 200),
      // A Claude Code account's login state (Login state (CA)); null for another CLI's account.
      loginCheck: isObj(o.loginCheck)
        ? {
            state: pick(o.loginCheck.state, ['ok', 'unconfirmed', 'checking', 'loggedOut', 'probeFailed'], 'unconfirmed'),
            since: when(o.loginCheck.since),
            checkedAt: when(o.loginCheck.checkedAt),
            reason: str(o.loginCheck.reason, 200) || '',
          }
        : null,
      plan: str(o.plan, 24),
      planLabel: str(o.planLabel, 40),
      // Names of the other accounts here on the same claude.ai account; anything else is dropped.
      sameAccountAs: list(o.sameAccountAs, 8)
        .map(function (n) { return str(n, 64); })
        .filter(function (n) { return n !== null && n !== ''; }),
      windows: list(o.windows, 8)
        .filter(isObj)
        .map(function (w) {
          return {
            kind: pick(w.kind, ['session', 'weekly_all', 'weekly_scoped', 'other'], 'other'),
            label: str(w.label, 40) || DASH,
            percent: pct(w.percent),
            severity: pick(w.severity, ['normal', 'warning', 'critical'], 'normal'),
            resetsAt: when(w.resetsAt),
          };
        }),
      windowsStaleSince: when(o.windowsStaleSince),
      lastGoodWindowsAt: when(o.lastGoodWindowsAt),
      usageFetchedAt: when(o.usageFetchedAt),
      overage: isObj(o.overage)
        ? { enabled: o.overage.enabled === true, percent: pct(o.overage.percent), spendLabel: str(o.overage.spendLabel, 48) }
        : null,
      cooldownUntil: when(o.cooldownUntil),
      session5h: normStats(o.session5h),
      week: normStats(o.week),
      allTime: allTime,
      lastError: str(o.lastError, 200),
      running: cnt(o.running) || 0,
    };
  }

  const TASK_STATUSES = ['running', 'done', 'failed', 'cancelled', 'orphaned'];

  function normTask(raw) {
    const o = isObj(raw) ? raw : {};
    return {
      id: typeof o.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(o.id) ? o.id : null,
      title: str(o.title, 160) || DASH,
      status: pick(o.status, TASK_STATUSES, 'unknown'),
      mode: pick(o.mode, ['oneshot', 'detached', 'session'], null),
      worker: str(o.worker, 120) || DASH,
      model: str(o.model, 64) || DASH,
      startedAt: when(o.startedAt),
      endedAt: when(o.endedAt),
      inputTokens: cnt(o.inputTokens),
      outputTokens: cnt(o.outputTokens),
      costUsd: amt(o.costUsd),
      error: str(o.error, 240),
      promptPreview: str(o.promptPreview, 300),
      inWorkspace: o.inWorkspace === true,
      hasOutput: o.hasOutput === true,
      sessionWorker: str(o.sessionWorker, 80),
      branch: str(o.branch, 120),
      unmerged: o.unmerged === true,
      provider: str(o.provider, 64),
      // What the CLI reported it ran, and where the requested model came from. Absent (a
      // host that does not send them) and null both mean "not known".
      modelUsed: str(o.modelUsed, 64),
      modelSource: pick(o.modelSource, ['dispatch', 'worker', 'cli'], null),
    };
  }

  function normSession(raw) {
    const o = isObj(raw) ? raw : {};
    return {
      key: str(o.key, 200),
      source: pick(o.source, ['worker', 'teammate', 'peer'], 'peer'),
      name: str(o.name, 80) || DASH,
      accountKey: str(o.accountKey, 128),
      accountName: str(o.accountName, 64) || DASH,
      kind: pick(o.kind, ['background', 'interactive', 'teammate'], null),
      status: pick(o.status, ['busy', 'waiting', 'idle', 'stopped', 'unknown'], 'unknown'),
      detail: str(o.detail, 160),
      taskId: str(o.taskId, 64),
      taskTitle: str(o.taskTitle, 160),
      model: str(o.model, 64),
      startedAt: when(o.startedAt),
      updatedAt: when(o.updatedAt),
      location: str(o.location, 120),
      branch: str(o.branch, 120),
      unmerged: o.unmerged === true,
      settled: o.settled === true,
      inWorkspace: o.inWorkspace === true,
      canAttach: o.canAttach === true,
      canStop: o.canStop === true,
      team: str(o.team, 64),
      role: str(o.role, 64),
    };
  }

  function normGuard(raw) {
    const o = isObj(raw) ? raw : {};
    return {
      value: pick(o.value, ['block', 'allow'], null),
      effective: pick(o.effective, ['block', 'allow'], null),
      setBy: str(o.setBy, 64),
    };
  }

  function normSettings(raw) {
    const o = isObj(raw) ? raw : {};
    const names = function (v) {
      return list(v, 16)
        .map(function (x) { return str(x, 64); })
        .filter(function (x) { return x !== null; });
    };
    return {
      workerPermissionMode: str(o.workerPermissionMode, 64),
      permissionModes: names(o.permissionModes),
      claudePath: typeof o.claudePath === 'string' ? o.claudePath.replace(CONTROL_CHARS, '').replace(BIDI_CONTROLS, '').slice(0, 1024) : null,
      quotaCooldownMinutes: cnt(o.quotaCooldownMinutes),
      workerTimeoutMinutes: cnt(o.workerTimeoutMinutes),
      frontierWorkerDispatch: normGuard(o.frontierWorkerDispatch),
      overageWorkerDispatch: normGuard(o.overageWorkerDispatch),
      meshMode: tri(o.meshMode),
      meshMaxLiveWorkers: cnt(o.meshMaxLiveWorkers),
      meshHistoryLimit: cnt(o.meshHistoryLimit),
      sessionKeepalive: tri(o.sessionKeepalive),
      workerModels: exact(o.workerModels, 16, 64),
      providerUsagePolling: tri(o.providerUsagePolling),
      providers: normProviders(o.providers),
    };
  }

  /** The CLIs a worker can run on. An entry without an id is not one; a repeated id is the first. */
  function normProviders(raw) {
    const seen = new Set();
    const out = [];
    list(raw, 16)
      .filter(isObj)
      .forEach(function (p) {
        const id = str(p.id, 64);
        if (id === null || seen.has(id)) {
          return;
        }
        seen.add(id);
        out.push({
          id: id,
          label: str(p.label, 32),
          models: exact(p.models, 24, 120),
          permissionModes: exact(p.permissionModes, 12, 32),
          isolation: pick(p.isolation, ['env', 'none'], null),
          isolationVerified: p.isolationVerified === true,
          sessionWorkers: p.sessionWorkers === true,
        });
      });
    return out;
  }

  function normModel(raw) {
    const health = isObj(raw.health) ? raw.health : {};
    const running = isObj(raw.running) ? raw.running : {};
    const orch = isObj(raw.orchestrator) ? raw.orchestrator : null;
    return {
      workspace: str(raw.workspace, 80),
      scope: pick(raw.scope, ['workspace', 'all'], 'workspace'),
      orchestrator: orch
        ? { model: str(orch.model, 64), calibrated: orch.calibrated === true, briefedAt: when(orch.briefedAt), lastSeenAt: when(orch.lastSeenAt) }
        : null,
      health: {
        claudeVersion: str(health.claudeVersion, 40),
        sessionWorkersSupported: tri(health.sessionWorkersSupported),
        sessionWorkersMinVersion: str(health.sessionWorkersMinVersion, 24) || DASH,
        taskLogProblem: str(health.taskLogProblem, 160),
        // Absent (a host that does not send it) and null both mean "nothing wrong".
        registryProblem: str(health.registryProblem, 200),
        mcpInstalled: tri(health.mcpInstalled),
        policyInstalled: tri(health.policyInstalled),
        // true: a policy block is there and is not this version's text.
        policyOutdated: tri(health.policyOutdated),
        teamAgentInstalled: tri(health.teamAgentInstalled),
        // false: the session here can neither run cco with this version's policy nor use the
        // MCP server - the one state the setup chip is shown in.
        canDispatch: tri(health.canDispatch),
        // The command that fixes it; a value the page does not know is the default one.
        dispatchFix: pick(health.dispatchFix, ['updateWorkspaceSetup', 'installMcp'], 'updateWorkspaceSetup'),
      },
      accounts: assignDomKeys(list(raw.accounts, 200).filter(isObj).map(normAccount), 'key'),
      // Registry entries this version cannot use. Absent means none; a name that is empty (or
      // is no text at all) is an entry without one.
      unsupportedAccounts: list(raw.unsupportedAccounts, 20)
        .filter(isObj)
        .map(function (u) {
          return { name: str(u.name, 64), detail: str(u.detail, 80) };
        }),
      tasks: assignDomKeys(list(raw.tasks, 300).filter(isObj).map(normTask), 'id'),
      taskTotal: cnt(raw.taskTotal),
      running: { workspace: cnt(running.workspace), all: cnt(running.all) },
      daily: list(raw.daily, 400)
        .filter(isObj)
        .slice(-14)
        .map(function (d) {
          return { day: when(d.day), done: cnt(d.done) || 0, failed: cnt(d.failed) || 0, cancelled: cnt(d.cancelled) || 0 };
        }),
      sessions: assignDomKeys(list(raw.sessions, 500).filter(isObj).map(normSession), 'key'),
      settings: normSettings(raw.settings),
    };
  }

  /* ======================================================================= *
   * 3. Shared page state
   * ======================================================================= */

  const saved = (function () {
    try {
      const s = vscode.getState();
      return isObj(s) ? s : {};
    } catch (e) {
      return {};
    }
  })();

  const state = {
    model: null,
    filterStatus: pick(saved.filterStatus, ['all'].concat(TASK_STATUSES), 'all'),
    filterText: typeof saved.filterText === 'string' ? saved.filterText.slice(0, 120) : '',
    /** A provider id, or null for "every CLI". Dropped when that CLI has no task in the list. */
    filterProvider: typeof saved.filterProvider === 'string' ? saved.filterProvider.slice(0, 64) : null,
    taskLimit: 50,
    expandedTasks: new Set(),
    usageRefreshAt: null,
  };

  function persist() {
    try {
      vscode.setState({ filterStatus: state.filterStatus, filterText: state.filterText, filterProvider: state.filterProvider });
    } catch (e) {
      /* state is a convenience only */
    }
  }

  /* ---- providers: which CLI an account or a task runs on ---- */

  /**
   * The CLI the hosting editor session itself runs on. Its workers share ONE permission mode
   * (a setting, in the drawer) and always have a default model; a worker on any other CLI is
   * configured per account. A task whose `provider` is null ran on this one. Nothing about
   * USAGE is decided from this id: gauges are drawn whenever a reading carries windows.
   */
  const HOME_PROVIDER = 'claude';
  /**
   * The `loginDetail` the host sets on an account that is logged out BECAUSE A RUN FAILED ON
   * LOGIN (src/uiModel.ts holds the same literal). A marker to recognize, never text to show.
   */
  const RUN_LOGIN_FAILURE_DETAIL = 'the last run failed on login';
  const SIGILS = ['prov0', 'prov1', 'prov2', 'prov3', 'prov4', 'prov5'];

  /**
   * id -> { entry, rank, label } for the model being rendered: the providers the settings
   * list, in their order, then every other id an account or a task carries, in the order
   * met. A Map, not an object: an id is data and may be "__proto__".
   */
  let providerIndex = new Map();

  function indexProviders(m) {
    const index = new Map();
    m.settings.providers.forEach(function (p, i) {
      index.set(p.id, { entry: p, rank: i, label: p.label });
    });
    let next = m.settings.providers.length;
    const meet = function (id, label) {
      // No id at all is not "one CLI": such items share a place in the order, never a name.
      const name = id === null ? null : label;
      const hit = index.get(id);
      if (!hit) {
        index.set(id, { entry: null, rank: next, label: name });
        next += 1;
      } else if (hit.label === null) {
        hit.label = name;
      }
    };
    m.accounts.forEach(function (a) {
      meet(a.provider, a.providerLabel);
    });
    m.tasks.forEach(function (tk) {
      meet(taskProvider(tk), null);
    });
    return index;
  }
  function taskProvider(tk) {
    return tk.provider === null ? HOME_PROVIDER : tk.provider;
  }
  function providerEntry(id) {
    const hit = providerIndex.get(id);
    return hit ? hit.entry : null;
  }
  function providerRank(id) {
    const hit = providerIndex.get(id);
    return hit ? hit.rank : Infinity;
  }
  /** The product name to show for a provider id; `own` is a label the item carries itself. */
  function providerName(id, own) {
    if (own) {
      return own;
    }
    const hit = providerIndex.get(id);
    if (hit && hit.label !== null) {
      return hit.label;
    }
    return id === HOME_PROVIDER ? t('provHome') : id === null ? DASH : id;
  }
  /** One shape per LISTED provider, by its position; anything unlisted shares the open ring. */
  function providerSigil(id) {
    const hit = providerIndex.get(id);
    return hit && hit.entry !== null ? SIGILS[hit.rank % SIGILS.length] : 'provX';
  }

  /* ---- once-a-second ticker for every relative time on the page ---- */

  const tickers = new Set();
  let tickFailureLogged = false;
  /** Changes when the local calendar day does ("14:02" becomes "Oct 12, 14:02" at midnight). */
  let dayStamp = dayStampOf(Date.now());
  function dayStampOf(ts) {
    const d = new Date(ts);
    return d.getFullYear() * 372 + d.getMonth() * 31 + d.getDate();
  }
  function tickAll() {
    if (document.hidden) {
      return;
    }
    const now = Date.now();
    dayStamp = dayStampOf(now);
    tickers.forEach(function (fn) {
      try {
        fn(now);
      } catch (e) {
        if (!tickFailureLogged) {
          tickFailureLogged = true;
          console.error('dashboard: a time update failed', e);
        }
      }
    });
  }

  /* ---- screen-reader announcements ---- */

  const announcer = h('div', { class: 'vh', 'aria-live': 'polite', role: 'status' });
  function announce(text) {
    announcer.textContent = '';
    // A changed text node is what assistive technology reads; clearing first makes a
    // repeated message ("Saved", "Saved") announce twice.
    setTimeout(function () {
      announcer.textContent = text;
    }, 30);
  }

  /* ---- settings: one pipeline for every control that writes a setting ---- */

  const SETTING_KEYS = [
    'workerPermissionMode',
    'claudePath',
    'quotaCooldownMinutes',
    'workerTimeoutMinutes',
    'frontierWorkerDispatch',
    'overageWorkerDispatch',
    'meshMode',
    'meshMaxLiveWorkers',
    'meshHistoryLimit',
    'sessionKeepalive',
    'providerUsagePolling',
  ];
  /** How long a save may go unanswered before the control says so. */
  const SETTING_ANSWER_MS = 10000;
  const pendingSettings = new Map(); // key -> { value, timer } (timer null: the host is asking the user)
  const settingWatchers = new Map(); // key -> Set<fn(status)>

  function watchSetting(key, fn) {
    if (!settingWatchers.has(key)) {
      settingWatchers.set(key, new Set());
    }
    settingWatchers.get(key).add(fn);
  }
  function emitSetting(key, status) {
    const watchers = settingWatchers.get(key);
    if (watchers) {
      watchers.forEach(function (fn) {
        fn(status);
      });
    }
  }
  /** Ask the host to save. Nothing is shown as saved until the host says so. */
  function sendSetting(key, value) {
    const previous = pendingSettings.get(key);
    if (previous) {
      clearTimeout(previous.timer);
    }
    const timer = setTimeout(function () {
      if (pendingSettings.get(key) && pendingSettings.get(key).timer === timer) {
        pendingSettings.delete(key);
        emitSetting(key, { state: 'failed', text: t('saveNoAnswer'), value: undefined });
      }
    }, SETTING_ANSWER_MS);
    pendingSettings.set(key, { value: value, timer: timer });
    emitSetting(key, { state: 'saving', text: t('saving'), value: value });
    post({ type: 'setSetting', key: key, value: value });
  }
  /**
   * The host is asking the user to confirm this save in a dialog of its own. Which values need
   * that is the host's knowledge, so it says so; from here the answer takes as long as the
   * user does, and the "no answer" clock - which is about a host that went silent - stops.
   * The host sends the real result when the dialog closes.
   */
  function onSettingPending(msg) {
    const key = pick(msg.key, SETTING_KEYS, null);
    const pending = key === null ? undefined : pendingSettings.get(key);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    pending.timer = null;
    const text = t('saveConfirming');
    emitSetting(key, { state: 'saving', text: text, value: pending.value });
    announce(text);
  }
  function onSettingResult(msg) {
    const key = pick(msg.key, SETTING_KEYS, null);
    if (key === null) {
      return;
    }
    const pending = pendingSettings.get(key);
    if (pending) {
      clearTimeout(pending.timer);
      pendingSettings.delete(key);
    }
    const value = typeof msg.value === 'string' || typeof msg.value === 'number' || typeof msg.value === 'boolean' ? msg.value : undefined;
    // Room for a refusal that names a file and a process and says what to do about it: cut
    // short, it would lose exactly the part the user needs.
    const note = str(msg.error, 700);
    const status =
      msg.ok === true
        ? { state: 'saved', text: t('saved'), value: value }
        : { state: 'failed', text: t('saveFailed', note || t('saveFailedUnknown')), value: value };
    emitSetting(key, status);
    announce(status.text);
  }

  /* ---- focus-preserving DOM moves ---- */

  function moveBefore(parent, node, ref) {
    if (typeof parent.moveBefore === 'function' && node.parentNode) {
      try {
        parent.moveBefore(node, ref);
        return;
      } catch (e) {
        /* not movable in place (different parent tree, older engine): fall through */
      }
    }
    parent.insertBefore(node, ref);
  }

  /** Put `roots` in this order inside `parent`, moving as few nodes as possible. */
  function orderChildren(parent, roots) {
    const wanted = new Set(roots);
    let cursor = parent.firstChild;
    for (let i = 0; i < roots.length; i++) {
      while (cursor && !wanted.has(cursor)) {
        cursor = cursor.nextSibling;
      }
      if (roots[i] === cursor) {
        cursor = cursor.nextSibling;
      } else {
        moveBefore(parent, roots[i], cursor);
      }
    }
  }

  /** Run a DOM update; if it moved the focused element, give the focus back to it. */
  function keepFocus(fn) {
    const active = document.activeElement;
    fn();
    if (active && active !== document.body && active.isConnected && document.activeElement !== active) {
      try {
        active.focus({ preventScroll: true });
      } catch (e) {
        /* it is no longer focusable; the browser has already picked a sensible place */
      }
    }
  }

  /**
   * Keyed list: `pool` maps a DOM key to a retained component ({ root, update, destroy? }).
   * Components whose key disappeared are destroyed; the rest are updated and reordered.
   */
  function syncList(parent, pool, items, create) {
    const live = new Set();
    for (let i = 0; i < items.length; i++) {
      live.add(items[i].dom);
    }
    pool.forEach(function (comp, key) {
      if (!live.has(key)) {
        if (comp.destroy) {
          comp.destroy();
        }
        if (comp.root.parentNode) {
          comp.root.parentNode.removeChild(comp.root);
        }
        pool.delete(key);
      }
    });
    const roots = [];
    for (let i = 0; i < items.length; i++) {
      let comp = pool.get(items[i].dom);
      if (!comp) {
        comp = create(items[i]);
        pool.set(items[i].dom, comp);
      }
      comp.update(items[i]);
      roots.push(comp.root);
    }
    orderChildren(parent, roots);
  }

  /* ======================================================================= *
   * 4. Small shared components
   * ======================================================================= */

  /** A segmented control backed by native radio inputs (arrow keys and focus come for free). */
  function Segmented(legend, options, onPick) {
    const name = uid('seg');
    const root = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': legend });
    const inputs = new Map();
    options.forEach(function (option) {
      const id = uid('opt');
      const input = h('input', { type: 'radio', class: 'seg-input', name: name, id: id, value: option.value });
      on(input, 'change', function () {
        if (input.checked) {
          onPick(option.value);
        }
      });
      inputs.set(option.value, input);
      root.appendChild(input);
      root.appendChild(h('label', { class: 'seg-label', for: id, title: option.title || null, text: option.label }));
    });
    return {
      root: root,
      set: function (value) {
        inputs.forEach(function (input, v) {
          const want = v === value;
          if (input.checked !== want) {
            input.checked = want;
          }
        });
      },
    };
  }

  /** A status / attention block: icon, title, body, optional actions. */
  function Callout(level) {
    const titleEl = h('strong', { class: 'callout-title' });
    const bodyEl = h('p', { class: 'callout-body' });
    const actions = h('div', { class: 'callout-actions' });
    const slot = iconSlot(level === 'error' ? 'alert' : level === 'warning' ? 'warn' : 'info');
    const root = h('div', { class: 'callout is-' + level, role: level === 'error' ? 'alert' : 'status' }, [
      slot,
      h('div', { class: 'callout-text' }, [titleEl, bodyEl]),
      actions,
    ]);
    return {
      root: root,
      actions: actions,
      set: function (title, body) {
        setText(titleEl, title);
        setText(bodyEl, body || '');
        show(bodyEl, Boolean(body));
      },
    };
  }

  function Tag(iconName, extraClass) {
    const slot = iconName ? iconSlot(iconName) : null;
    const label = h('span', { class: 'tag-text' });
    const root = h('span', { class: 'tag' + (extraClass ? ' ' + extraClass : '') }, [slot, label]);
    return {
      root: root,
      set: function (text, title) {
        setText(label, text);
        attr(root, 'title', title || null);
      },
      setIcon: function (name) {
        if (slot) {
          setIcon(slot, name);
        }
      },
    };
  }

  /* ---- popup menu (one open at a time) ---- */

  let openMenu = null;

  /**
   * Attach a menu to `anchor`. `build()` returns the entries at the moment of opening:
   *   { label, icon?, danger?, checked?, disabled?, mono?, title?, run }
   *                                                        an action (checked makes it a radio item;
   *                                                        mono marks a literal id, not prose)
   *   { group: 'text' }                                    a non-interactive heading
   *   { separator: true }
   * The open menu is not re-rendered while it is open, so an item is never replaced under
   * the pointer or the keyboard focus.
   */
  function Menu(anchor, wrap, build) {
    let pop = null;
    let items = [];
    attr(anchor, 'aria-haspopup', 'menu');
    attr(anchor, 'aria-expanded', 'false');

    function close(refocus) {
      if (!pop) {
        return;
      }
      wrap.removeChild(pop);
      pop = null;
      items = [];
      attr(anchor, 'aria-expanded', 'false');
      if (openMenu === api) {
        openMenu = null;
      }
      if (refocus) {
        anchor.focus();
      }
    }

    function focusItem(index) {
      const enabled = items.filter(function (b) { return !b.disabled; });
      if (enabled.length === 0) {
        return;
      }
      const next = enabled[((index % enabled.length) + enabled.length) % enabled.length];
      next.focus();
    }

    function open() {
      if (openMenu) {
        openMenu.close(false);
      }
      pop = h('div', { class: 'menu', role: 'menu', 'aria-label': anchor.title || anchor.textContent || '' });
      items = [];
      build().forEach(function (entry) {
        if (entry.separator) {
          pop.appendChild(h('div', { class: 'menu-sep', role: 'separator' }));
          return;
        }
        if (entry.group) {
          pop.appendChild(h('div', { class: 'menu-group', role: 'presentation', text: entry.group }));
          return;
        }
        const isRadio = entry.checked !== undefined;
        const item = h('button', {
          type: 'button',
          class: 'menu-item' + (entry.danger ? ' is-danger' : ''),
          role: isRadio ? 'menuitemradio' : 'menuitem',
          tabindex: '-1',
          'aria-checked': isRadio ? String(entry.checked === true) : null,
          disabled: entry.disabled === true,
          title: entry.title || null,
        });
        item.appendChild(isRadio ? iconSlot(entry.checked ? 'check' : 'blank', 'menu-check') : iconSlot(entry.icon || 'blank'));
        item.appendChild(h('span', { class: 'menu-label' + (entry.mono ? ' is-mono' : ''), text: entry.label }));
        on(item, 'click', function () {
          close(true);
          entry.run();
        });
        items.push(item);
        pop.appendChild(item);
      });
      on(pop, 'keydown', function (event) {
        const enabled = items.filter(function (b) { return !b.disabled; });
        const at = enabled.indexOf(document.activeElement);
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          focusItem(at + 1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          focusItem(at - 1);
        } else if (event.key === 'Home') {
          event.preventDefault();
          focusItem(0);
        } else if (event.key === 'End') {
          event.preventDefault();
          focusItem(-1);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        } else if (event.key === 'Tab') {
          close(false);
        }
      });
      wrap.appendChild(pop);
      attr(anchor, 'aria-expanded', 'true');
      openMenu = api;
      // Open upward when there is no room below the anchor.
      const box = pop.getBoundingClientRect();
      toggleClass(pop, 'is-up', box.bottom > window.innerHeight - 8 && box.height < anchor.getBoundingClientRect().top);
      focusItem(0);
    }

    const api = { close: close };
    on(anchor, 'click', function () {
      if (pop) {
        close(true);
      } else {
        open();
      }
    });
    on(anchor, 'keydown', function (event) {
      if (!pop && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        open();
      }
    });
    return api;
  }

  on(document, 'mousedown', function (event) {
    // A press inside any menu wrapper is that menu's own business (its anchor toggles it).
    if (openMenu && !closestMenuWrap(event.target)) {
      openMenu.close(false);
    }
  });
  function closestMenuWrap(node) {
    let cur = node;
    while (cur && cur !== document.body) {
      if (cur.classList && cur.classList.contains('menu-wrap')) {
        return cur;
      }
      cur = cur.parentNode;
    }
    return null;
  }

  /* ---- section heading ---- */

  function SectionHead(title) {
    const count = h('span', { class: 'sec-count' });
    const scope = h('span', { class: 'sec-scope' });
    const summary = h('span', { class: 'sec-summary' });
    const tools = h('div', { class: 'sec-tools' });
    const id = uid('sec');
    const root = h('header', { class: 'sec-head' }, [
      h('h2', { class: 'sec-title', id: id, text: title }),
      count,
      scope,
      summary,
      h('span', { class: 'sec-rule', 'aria-hidden': 'true' }),
      tools,
    ]);
    return {
      root: root,
      id: id,
      tools: tools,
      set: function (countText, scopeText, summaryText) {
        setText(count, countText || '');
        show(count, Boolean(countText));
        setText(scope, scopeText || '');
        show(scope, Boolean(scopeText));
        setText(summary, summaryText || '');
        show(summary, Boolean(summaryText));
      },
    };
  }

  function scopeText(m) {
    return m.scope === 'all' ? t('scopeNoteAll') : t('scopeNoteWorkspace');
  }

  /* ======================================================================= *
   * 5. Header, health chips, page banners
   * ======================================================================= */

  function Header() {
    const title = h('h1', { class: 'hd-title' });
    const liveDot = h('span', { class: 'live-dot', 'aria-hidden': 'true' });
    const liveText = h('span', { class: 'hd-live-text' });
    const live = h('p', { class: 'hd-live' }, [liveDot, liveText]);
    const orchModel = Tag('activity', 'tag-strong');
    const orchCal = Tag('check');
    const orchTimes = h('span', { class: 'hd-orch-times' });
    const orch = h('div', { class: 'hd-orch' }, [orchModel.root, orchCal.root, orchTimes]);

    const scope = Segmented(
      t('scopeLabel'),
      [
        { value: 'workspace', label: t('scopeWorkspace'), title: t('scopeWorkspaceTip') },
        { value: 'all', label: t('scopeAll'), title: t('scopeAllTip') },
      ],
      function (value) {
        scopeAsked = { value: value, at: Date.now() };
        post({ type: 'setScope', scope: value });
      },
    );
    // A model built just before the host handled the switch still carries the old scope;
    // for a moment after a click, such a model must not flip the control back.
    let scopeAsked = null;
    const refresh = button({ label: t('refreshUsage'), icon: 'refresh', title: t('refreshUsageTip') }, function () {
      state.usageRefreshAt = Date.now();
      paintRefresh();
      post({ type: 'command', id: 'refreshUsage' });
    });
    const settings = button({ label: t('settings'), icon: 'gear', cls: 'btn-settings' }, function () {
      app.drawer.open(settings);
    });
    attr(settings, 'aria-haspopup', 'dialog');

    const root = h('header', { class: 'hd' }, [
      h('div', { class: 'hd-main' }, [
        h('p', { class: 'hd-eyebrow', text: t('appName') }),
        title,
        h('div', { class: 'hd-sub' }, [orch, live]),
      ]),
      h('div', { class: 'hd-controls' }, [scope.root, refresh, settings]),
    ]);

    let orchData = null;
    function paintTimes(now) {
      if (!orchData) {
        setText(orchTimes, '');
        return;
      }
      const parts = [];
      if (orchData.briefedAt !== null) {
        parts.push(t('orchBriefed', fmtAgo(orchData.briefedAt, now)));
      }
      if (orchData.lastSeenAt !== null) {
        parts.push(t('orchSeen', fmtAgo(orchData.lastSeenAt, now)));
      }
      setText(orchTimes, parts.join(t('sep')));
    }
    function paintRefresh() {
      const busy = state.usageRefreshAt !== null;
      toggleClass(refresh, 'is-busy', busy);
      attr(refresh, 'aria-busy', busy ? 'true' : null);
      setButtonLabel(refresh, busy ? t('refreshingUsage') : t('refreshUsage'));
    }
    tickers.add(function (now) {
      paintTimes(now);
      if (state.usageRefreshAt !== null && now - state.usageRefreshAt > 45000) {
        state.usageRefreshAt = null;
        paintRefresh();
      }
    });

    return {
      root: root,
      update: function (m) {
        setText(title, m.workspace === null ? t('noWorkspaceName') : m.workspace);
        toggleClass(title, 'is-empty', m.workspace === null);
        if (scopeAsked !== null && (m.scope === scopeAsked.value || Date.now() - scopeAsked.at > 3000)) {
          scopeAsked = null;
        }
        if (scopeAsked === null) {
          scope.set(m.scope);
        }

        orchData = m.orchestrator;
        if (m.orchestrator === null) {
          orchModel.set(t('orchNone'), t('orchNoneTip'));
          show(orchCal.root, false);
        } else if (m.orchestrator.model === null) {
          orchModel.set(t('orchPending'), t('orchPendingTip'));
          show(orchCal.root, false);
        } else {
          orchModel.set(t('orchModel', m.orchestrator.model), t('orchModelTip'));
          show(orchCal.root, true);
          orchCal.setIcon(m.orchestrator.calibrated ? 'check' : 'zap');
          orchCal.set(
            m.orchestrator.calibrated ? t('orchCalibrated') : t('orchFrontier'),
            m.orchestrator.calibrated ? t('orchCalibratedTip') : t('orchFrontierTip'),
          );
        }
        paintTimes(Date.now());

        const here = m.running.workspace;
        const everywhere = m.running.all;
        const shown = m.scope === 'all' ? everywhere : here;
        toggleClass(live, 'is-live', (shown || 0) > 0);
        if (m.scope === 'all' || m.workspace === null) {
          setText(liveText, t('runningAll', fmtInt(everywhere)));
        } else if (everywhere !== null && here !== null && everywhere > here) {
          setText(liveText, t('runningHereAndElsewhere', fmtInt(here), fmtInt(everywhere - here)));
        } else {
          setText(liveText, t('runningHere', fmtInt(here)));
        }

        // A usage refresh is done once some account reports a reading newer than the click.
        if (state.usageRefreshAt !== null) {
          const settled = m.accounts.every(function (a) {
            return a.usageFetchedAt !== null && a.usageFetchedAt >= state.usageRefreshAt;
          });
          if (settled) {
            state.usageRefreshAt = null;
          }
        }
        paintRefresh();
      },
    };
  }

  /** Chips that appear only when something needs attention. Each one is a button. */
  function HealthBar() {
    const listEl = h('ul', { class: 'health-list' });
    const root = h('nav', { class: 'health', 'aria-label': t('healthLabel') }, [listEl]);
    const pool = new Map();

    function create(chip) {
      const label = h('span', { class: 'chip-text' });
      const slot = iconSlot(chip.icon);
      const node = h('button', { type: 'button', class: 'chip-btn' }, [slot, label, icon('chevronRight', 'ico-trail')]);
      const item = h('li', null, [node]);
      let current = chip;
      on(node, 'click', function () {
        current.run();
      });
      return {
        root: item,
        update: function (next) {
          current = next;
          setIcon(slot, next.icon);
          setText(label, next.text);
          node.className = 'chip-btn is-' + next.level;
          attr(node, 'title', next.title || null);
        },
      };
    }

    return {
      root: root,
      update: function (m) {
        const chips = healthChips(m);
        syncList(listEl, pool, chips, create);
        show(root, chips.length > 0);
      },
    };
  }

  /**
   * The ONE state an account is in. The card's state word and the heading's tally are both
   * read off this answer, so a card and the count it is in cannot disagree.
   */
  function accountState(a, now) {
    if (a.login === 'expired') {
      return 'expired';
    }
    if (a.login === 'error') {
      return 'error';
    }
    if (a.login === 'refreshing') {
      return 'refreshing';
    }
    if (a.login !== 'ok' && a.login !== 'no-plan-limits') {
      return 'unknown';
    }
    // Logged in. A cooldown keeps automatic selection away whether or not there is a usage
    // reading, so it is asked before "no reading" is.
    if (a.cooldownUntil !== null && a.cooldownUntil > now) {
      return 'cooling';
    }
    if (a.login === 'no-plan-limits') {
      return 'nolimits';
    }
    const atLimit = a.windows.some(function (w) {
      return w.severity === 'critical' || (w.percent !== null && w.percent >= 100);
    });
    return atLimit ? 'limit' : 'ok';
  }

  /**
   * The part of the Accounts heading each state is counted under. Every state has exactly one,
   * so the parts add up to the number of accounts. Logged in and free to take a dispatch is
   * "ready" with or without a plan-usage reading - the card says when there is none.
   */
  const STATE_BUCKET = {
    ok: 'accountsReady',
    nolimits: 'accountsReady',
    expired: 'accountsExpired',
    limit: 'accountsLimit',
    cooling: 'accountsCooling',
    error: 'accountsError',
    refreshing: 'accountsChecking',
    unknown: 'accountsUnknown',
  };
  /** The order the parts are said in. */
  const BUCKET_ORDER = ['accountsReady', 'accountsExpired', 'accountsLimit', 'accountsCooling', 'accountsError', 'accountsChecking', 'accountsUnknown'];

  /** "3 ready · 1 logged out · ...": one part per bucket that holds an account, none for an empty one. */
  function accountTally(accounts, now) {
    const counts = new Map();
    accounts.forEach(function (a) {
      const bucket = STATE_BUCKET[accountState(a, now)];
      counts.set(bucket, (counts.get(bucket) || 0) + 1);
    });
    return BUCKET_ORDER.filter(function (bucket) { return counts.has(bucket); }).map(function (bucket) {
      return t(bucket, counts.get(bucket));
    });
  }

  function healthChips(m) {
    const now = Date.now();
    const chips = [];
    const byState = { expired: [], error: [], cooling: [], limit: [] };
    m.accounts.forEach(function (a) {
      const s = accountState(a, now);
      if (byState[s]) {
        byState[s].push(a);
      }
      // A cooldown can coexist with any login state; count it wherever it is in force.
      if (s !== 'cooling' && a.cooldownUntil !== null && a.cooldownUntil > now) {
        byState.cooling.push(a);
      }
    });
    const jump = function (accounts) {
      return function () {
        app.accounts.reveal(accounts[0].dom);
      };
    };
    if (byState.expired.length > 0) {
      chips.push({ dom: 'expired', level: 'error', icon: 'login', text: t('chipExpired', byState.expired.length), title: t('chipExpiredTip'), run: jump(byState.expired) });
    }
    if (m.health.taskLogProblem !== null) {
      chips.push({
        dom: 'tasklog',
        level: 'error',
        icon: 'alert',
        text: t('chipTaskLog'),
        run: function () {
          revealNode(app.activity.root);
        },
      });
    }
    if (m.health.claudeVersion === null) {
      chips.push({
        dom: 'cli-unknown',
        level: 'warning',
        icon: 'terminal',
        text: t('chipCliUnknown'),
        title: t('chipCliUnknownTip'),
        run: function () {
          app.drawer.open(null, 'claudePath');
        },
      });
    } else if (m.health.sessionWorkersSupported === false && m.settings.meshMode === true) {
      chips.push({
        dom: 'cli-old',
        level: 'warning',
        icon: 'terminal',
        text: t('chipCliOld', m.health.sessionWorkersMinVersion),
        run: function () {
          revealNode(app.team.root);
        },
      });
    }
    if (byState.error.length > 0) {
      chips.push({ dom: 'usage-error', level: 'warning', icon: 'warn', text: t('chipUsageError', byState.error.length), run: jump(byState.error) });
    }
    if (byState.limit.length > 0) {
      chips.push({ dom: 'limit', level: 'warning', icon: 'warn', text: t('chipLimit', byState.limit.length), title: t('chipLimitTip'), run: jump(byState.limit) });
    }
    if (byState.cooling.length > 0) {
      chips.push({ dom: 'cooling', level: 'info', icon: 'pause', text: t('chipCooling', byState.cooling.length), title: t('chipCoolingTip'), run: jump(byState.cooling) });
    }
    // Only a workspace that cannot dispatch at all: one with the cco command and this version's
    // policy, or with the MCP server, needs nothing. The fix is the host's choice (Update
    // Workspace Setup; Register MCP Server where cco does not run).
    if (m.health.canDispatch === false) {
      const fix = m.health.dispatchFix;
      chips.push({
        dom: 'mcp',
        level: 'warning',
        icon: 'plus',
        text: t('chipMcp'),
        title: t('chipMcpTip'),
        run: function () {
          post({ type: 'command', id: fix });
        },
      });
    }
    if (m.health.policyInstalled === false) {
      chips.push({
        dom: 'policy',
        level: 'info',
        icon: 'plus',
        text: t('chipPolicy'),
        title: t('chipPolicyTip'),
        run: function () {
          post({ type: 'command', id: 'addDispatchPolicy' });
        },
      });
    } else if (m.health.policyOutdated === true) {
      // Update Workspace Setup: it shows what it would replace before it replaces anything, and
      // brings the team agent and the permission rules up to date in the same step.
      chips.push({
        dom: 'policy-outdated',
        level: 'info',
        icon: 'refresh',
        text: t('chipPolicyOutdated'),
        title: t('chipPolicyOutdatedTip'),
        run: function () {
          post({ type: 'command', id: 'updateWorkspaceSetup' });
        },
      });
    }
    return chips;
  }

  function revealNode(node, focusTarget) {
    try {
      node.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    } catch (e) {
      node.scrollIntoView();
    }
    node.classList.remove('is-flash');
    // Reading a layout property restarts the highlight animation when it is re-added.
    void node.offsetWidth;
    node.classList.add('is-flash');
    setTimeout(function () {
      node.classList.remove('is-flash');
    }, 1600);
    if (focusTarget) {
      try {
        focusTarget.focus({ preventScroll: true });
      } catch (e) {
        /* not focusable right now */
      }
    }
  }

  /** Page-level statements: the registry cannot be read, no folder open, nobody can take a dispatch. */
  function Banners() {
    // The host decides which file "the registry" is; the page only asks for it to be opened.
    const registry = Callout('error');
    registry.actions.appendChild(
      button({ label: t('registryOpen'), icon: 'external' }, function () {
        post({ type: 'openRegistryFile' });
      }),
    );
    const noWorkspace = Callout('info');
    const showAll = button({ label: t('showAllWorkspaces') }, function () {
      post({ type: 'setScope', scope: 'all' });
    });
    noWorkspace.actions.appendChild(showAll);
    const allExpired = Callout('error');
    // Accounts that are one claude.ai account: one notice for all of them, information only.
    const sameAccount = Callout('info');
    const root = h('div', { class: 'banners' }, [registry.root, allExpired.root, sameAccount.root, noWorkspace.root]);
    return {
      root: root,
      update: function (m) {
        const broken = m.health.registryProblem !== null;
        show(registry.root, broken);
        if (broken) {
          registry.set(t('registryTitle'), t('registryBody', m.health.registryProblem));
        }
        const workers = m.accounts.filter(function (a) { return a.isWorker; });
        const dead = workers.length > 0 && workers.every(function (a) { return a.login === 'expired'; });
        show(allExpired.root, dead);
        if (dead) {
          allExpired.set(t('allExpiredTitle'), t('allExpiredBody'));
        }
        const groups = sameAccountGroups(m.accounts);
        show(sameAccount.root, groups.length > 0);
        if (groups.length > 0) {
          sameAccount.set(
            t('sameAccountTitle'),
            t('sameAccountBody', groups.map(function (g) { return g.join(t('nameSep')); }).join(t('sep'))),
          );
        }
        const none = m.workspace === null;
        show(noWorkspace.root, none);
        if (none) {
          noWorkspace.set(t('noWorkspaceTitle'), m.scope === 'all' ? t('noWorkspaceBodyAll') : t('noWorkspaceBody'));
          show(showAll, m.scope !== 'all');
        }
        show(root, broken || dead || groups.length > 0 || none);
      },
    };
  }

  /**
   * The groups of accounts that are signed in to one claude.ai account, from each account's
   * `sameAccountAs`: every name once, each group in list order, the groups in the order their
   * first account is listed.
   */
  function sameAccountGroups(accounts) {
    const placed = new Set();
    const groups = [];
    accounts.forEach(function (a) {
      if (a.sameAccountAs.length === 0 || placed.has(a.name)) {
        return;
      }
      const members = [a.name].concat(a.sameAccountAs.filter(function (n) { return !placed.has(n) && n !== a.name; }));
      members.forEach(function (n) { placed.add(n); });
      if (members.length > 1) {
        groups.push(members);
      }
    });
    return groups;
  }

  /* ======================================================================= *
   * 6. Accounts
   * ======================================================================= */

  /**
   * How long each KIND of window lasts - on the home CLI, where the kind is a statement about
   * the window. A reading from another CLI is given its kinds by position (first window,
   * second window), so there the length is not known and nothing may be derived from it.
   */
  const WINDOW_LENGTH_MS = { session: 5 * 3600 * 1000, weekly_all: 7 * 86400 * 1000, weekly_scoped: 7 * 86400 * 1000 };

  /**
   * The name a window is shown under. It is the label the reading carries - except for a bare
   * word some CLIs report in place of a name, which says nothing to a person and is given its
   * plain name from the string table: Cursor's three shares of the billing period ("total",
   * "auto", "api"), Codex's two unnamed limits ("primary", "secondary") and Antigravity's four
   * bucket ids ("gemini-weekly", "gemini-5h", "3p-weekly", "3p-5h").
   */
  function windowLabel(w) {
    const bare = w.label.trim().toLowerCase();
    if (bare === 'total') {
      return t('winTotal');
    }
    if (bare === 'auto') {
      return t('winAuto');
    }
    if (bare === 'api') {
      return t('winApi');
    }
    // Antigravity's four limits, by the bucket ids its CLI reports.
    const agy = { 'gemini-weekly': 'winGeminiWeekly', 'gemini-5h': 'winGemini5h', '3p-weekly': 'win3pWeekly', '3p-5h': 'win3p5h' };
    if (Object.prototype.hasOwnProperty.call(agy, bare)) {
      return t(agy[bare]);
    }
    return bare === 'primary' ? t('winPrimary') : bare === 'secondary' ? t('winSecondary') : w.label;
  }

  /** `paced`: the window's length is known, so the pace mark can be placed. */
  function Meter(w, paced) {
    const reset = h('span', { class: 'meter-reset' });
    const value = h('span', { class: 'meter-value' });
    const fill = h('span', { class: 'meter-fill' });
    const pace = h('span', { class: 'meter-pace', title: t('meterPaceTip') });
    const track = h('div', { class: 'meter-track', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100' }, [fill, pace]);
    const flag = iconSlot('warn', 'meter-flag');
    const root = h('div', { class: 'meter is-' + w.severity }, [
      h('div', { class: 'meter-head' }, [h('span', { class: 'meter-label', text: windowLabel(w) }), reset, flag, value]),
      track,
    ]);
    setText(value, fmtPct(w.percent));
    show(flag, w.severity !== 'normal');
    if (w.severity === 'critical') {
      setIcon(flag, 'alert');
    }
    setVar(fill, '--p', (w.percent === null ? 0 : w.percent) + '%');
    attr(track, 'aria-valuenow', w.percent === null ? null : String(Math.round(w.percent)));
    let lastPace = null;
    return {
      root: root,
      tick: function (now) {
        let resetText = '';
        if (w.resetsAt !== null) {
          resetText = w.resetsAt > now ? t('resetsIn', fmtSpan(w.resetsAt - now, false)) : t('resetsNow');
        }
        setText(reset, resetText);
        const severityText = w.severity === 'critical' ? t('severityCritical') : w.severity === 'warning' ? t('severityWarning') : '';
        attr(track, 'aria-label', [windowLabel(w), fmtPct(w.percent), severityText, resetText].filter(Boolean).join(t('sep')));
        // The notch marks how far through the window the clock is: usage ahead of it is
        // being spent faster than the window refills.
        const length = paced ? WINDOW_LENGTH_MS[w.kind] : undefined;
        let elapsed = null;
        if (length && w.resetsAt !== null) {
          const fraction = 1 - (w.resetsAt - now) / length;
          if (fraction >= 0 && fraction <= 1) {
            elapsed = Math.round(fraction * 200) / 2;
          }
        }
        if (elapsed !== lastPace) {
          lastPace = elapsed;
          show(pace, elapsed !== null);
          if (elapsed !== null) {
            setVar(pace, '--t', elapsed + '%');
          }
        }
      },
    };
  }

  function sameWord(a, b) {
    return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  }

  function StatCell(label) {
    const tasks = h('span', { class: 'stat-main' });
    const tokens = h('span', { class: 'stat-sub' });
    const cost = h('span', { class: 'stat-sub', title: t('statCostTip') });
    const root = h('div', { class: 'stat' }, [h('dt', { class: 'stat-label', text: label }), h('dd', { class: 'stat-value' }, [tasks, tokens, cost])]);
    return {
      root: root,
      set: function (s) {
        setText(tasks, t('statTasks', fmtCount(s.tasks)));
        const total = s.inputTokens === null || s.outputTokens === null ? null : s.inputTokens + s.outputTokens;
        // Finished dispatches and not one token: the CLI or the transport reported none.
        // "0 tokens" would be a measurement nobody took.
        const unreported = total === 0 && s.tasks !== null && s.tasks > 0;
        setText(tokens, unreported ? t('statTokensNA') : t('statTokens', fmtTokens(total)));
        attr(tokens, 'title', unreported ? t('statTokensNATip') : t('statTokensTip', fmtInt(s.inputTokens), fmtInt(s.outputTokens)));
        // A cost line only where the CLI reported one: subscription logins usually report none.
        const priced = s.costUsd !== null && s.costUsd > 0;
        setText(cost, priced ? fmtUsd(s.costUsd) : DASH);
        toggleClass(cost, 'is-blank', !priced);
      },
    };
  }

  function AccountCard(first) {
    const nameId = uid('acct');
    const name = h('h3', { class: 'acct-name', id: nameId });
    const tagMain = Tag('home');
    tagMain.set(t('tagMain'), t('tagMainTip'));
    const tagPref = Tag('star', 'tag-accent');
    tagPref.set(t('tagPreferred'), t('tagPreferredTip'));
    const runDot = h('span', { class: 'live-dot', 'aria-hidden': 'true' });
    const runText = h('span');
    const running = h('span', { class: 'pill pill-run' }, [runDot, runText]);
    const plan = h('span', { class: 'plan' });
    // The provider plate: which CLI this account runs on. A shape and a word, riveted to the
    // top edge of the card; on a page where every account runs on one CLI the word is kept
    // for assistive technology and the tooltip only (see .acct-grid.is-uniform).
    const provSlot = iconSlot('provX');
    const provLabel = h('span', { class: 'prov-label' });
    const prov = h('p', { class: 'prov' }, [provSlot, provLabel]);

    const stateSlot = iconSlot('check');
    const stateText = h('span', { class: 'acct-state-text' });
    const facts = h('span', { class: 'acct-facts' });
    const status = h('p', { class: 'acct-status' }, [h('span', { class: 'acct-state' }, [stateSlot, stateText]), facts]);

    const alertSlot = iconSlot('alert');
    const alertTitle = h('strong');
    const alertBody = h('span', { class: 'acct-alert-body' });
    const alertBox = h('div', { class: 'acct-alert' }, [alertSlot, h('div', { class: 'acct-alert-text' }, [alertTitle, alertBody])]);

    const meters = h('div', { class: 'acct-meters' });
    const note = h('p', { class: 'acct-note' });
    const noteSlot = iconSlot('clock');
    const noteText = h('span');
    append(note, [noteSlot, noteText]);
    // Where the gauges would be, for a logged-in account whose reading has no windows. It is
    // laid out like a gauge's heading - label left, value right - but the value is a word and
    // there is no track beneath it: an empty track would read as "0% used".
    const noReadWhy = h('p', { class: 'noread-why' });
    const noRead = h('div', { class: 'noread' }, [
      h('p', { class: 'noread-head' }, [
        h('span', { class: 'noread-label', text: t('acctUsageLabel') }),
        h('span', { class: 'noread-rule', 'aria-hidden': 'true' }),
        h('span', { class: 'noread-value', text: t('acctNoReading') }),
      ]),
      noReadWhy,
    ]);

    const cooldown = Tag('pause', 'tag-warn');
    const overage = Tag('zap', 'tag-warn');
    const oneShot = Tag(null, 'tag-quiet');
    // The login state of a Claude Code account, with its reason on hover. "Logged out" is never
    // said here: that is the alert below, shown for a confirmed logout only.
    const loginTag = Tag('login', 'tag-quiet');
    const chips = h('div', { class: 'acct-chips' }, [cooldown.root, overage.root, oneShot.root, loginTag.root]);

    const stat5h = StatCell(t('stat5h'));
    const stat7d = StatCell(t('stat7d'));
    const statAll = StatCell(t('statAll'));
    const stats = h('dl', { class: 'acct-stats', title: t('statsTip') }, [stat5h.root, stat7d.root, statAll.root]);
    const noStats = h('p', { class: 'acct-nostats' });
    const lastErrText = h('span', { class: 'acct-lasterr-text' });
    const lastErr = h('p', { class: 'acct-lasterr' }, [iconSlot('alert'), lastErrText]);
    // Another account shown here is signed in to the same claude.ai account: one plan's limits.
    const sameText = h('span');
    const same = h('p', { class: 'acct-same' }, [iconSlot('link'), sameText]);

    let account = first;
    let ctx = accountContext;
    let currentState = '';
    let meterComps = [];
    let metersSig = '';
    let noReadKind = '';

    function act(action, value) {
      if (account.key === null) {
        return;
      }
      const message = { type: 'account', action: action, account: account.key };
      if (value !== undefined) {
        message.value = value;
      }
      post(message);
    }

    const relogin = button({ label: t('relogin'), icon: 'login', cls: 'btn-primary' }, function () {
      act('relogin');
    });
    const openSession = button({ label: t('openSession'), icon: 'terminal', title: t('openSessionTip') }, function () {
      act('openSession');
    });
    const retry = button({ label: t('checkAgain'), icon: 'refresh' }, function () {
      state.usageRefreshAt = Date.now();
      post({ type: 'command', id: 'refreshUsage' });
    });
    // Check Login Now: one live login probe of this Claude Code account. Offered where the login
    // is not confirmed, and as "Check again" where the check itself failed — never "Re-login".
    const checkLogin = button({ label: t('checkLoginNow'), icon: 'refresh' }, function () {
      act('checkLogin');
    });
    const more = button({ label: t('moreActions'), icon: 'more', iconOnly: true });
    const menuWrap = h('div', { class: 'menu-wrap' }, [more]);
    const menu = Menu(more, menuWrap, function () {
      const entries = [];
      const a = account;
      const home = a.provider === HOME_PROVIDER;
      const entry = providerEntry(a.provider);
      if (a.isWorker) {
        entries.push({
          label: a.preferred ? t('menuUnprefer') : t('menuPrefer'),
          icon: 'star',
          run: function () {
            act('togglePreferred');
          },
        });

        // Default model: what this account's CLI suggests, the current default if it is not
        // among them, "let the CLI choose" where a worker may have none, and a way to type
        // one. A model is offered only for the CLI it belongs to.
        const models = entry !== null ? entry.models.slice() : home ? ctx.workerModels.slice() : [];
        entries.push({ group: t('menuDefaultModel') });
        models.forEach(function (model) {
          entries.push({
            label: model,
            mono: true,
            checked: model === a.defaultModel,
            run: function () {
              act('setModel', model);
            },
          });
        });
        if (a.defaultModel !== null && models.indexOf(a.defaultModel) === -1) {
          // Shown, never re-sent: this text may be a shortened form of the stored id.
          entries.push({ label: a.defaultModel, mono: true, checked: true, run: function () {} });
        }
        if (!home) {
          entries.push({
            label: t('menuModelCli'),
            checked: a.defaultModel === null,
            run: function () {
              act('setModel', null);
            },
          });
        }
        entries.push({
          label: t('menuModelOther'),
          run: function () {
            // No value: the host command asks for the model and validates what is typed.
            act('setModel');
          },
        });

        entries.push({ group: t('menuPermission') });
        if (home) {
          // One mode for every worker on the home CLI, and it is a setting: shown, not set here.
          const shared = a.permissionMode !== null ? a.permissionMode : ctx.workerPermissionMode;
          entries.push({
            label: t('menuPermShared', shared === null ? DASH : shared),
            icon: 'gear',
            title: t('menuPermSharedTip', providerName(a.provider, a.providerLabel)),
            run: function () {
              app.drawer.open(more, 'workerPermissionMode');
            },
          });
        } else {
          const modes = entry !== null ? entry.permissionModes : [];
          modes.forEach(function (mode) {
            entries.push({
              label: mode,
              mono: true,
              checked: mode === a.permissionMode,
              run: function () {
                act('setPermissionMode', mode);
              },
            });
          });
          if (a.permissionMode !== null && modes.indexOf(a.permissionMode) === -1) {
            entries.push({ label: a.permissionMode, mono: true, checked: true, run: function () {} });
          }
          entries.push({
            label: t('menuPermCli'),
            checked: a.permissionMode === null,
            run: function () {
              act('setPermissionMode', null);
            },
          });
        }
        entries.push({ separator: true });
      }
      if (home && a.loginCheck !== null) {
        entries.push({
          label: t('menuCheckLogin'),
          icon: 'refresh',
          run: function () {
            act('checkLogin');
          },
        });
      }
      // A Claude Code account is offered a new login only once it is CONFIRMED logged out.
      if (!home || a.loginCheck === null || accountState(a, Date.now()) === 'expired') {
        entries.push({
          label: t('menuRelogin'),
          icon: 'login',
          run: function () {
            act('relogin');
          },
        });
      }
      if (a.isWorker) {
        entries.push({ separator: true });
        entries.push({
          label: t('menuRemove'),
          icon: 'trash',
          danger: true,
          run: function () {
            act('remove');
          },
        });
      }
      return entries;
    });
    const actions = h('footer', { class: 'acct-actions' }, [relogin, openSession, retry, checkLogin, h('span', { class: 'spacer' }), menuWrap]);

    const root = h('article', { class: 'acct', 'aria-labelledby': nameId }, [
      prov,
      h('header', { class: 'acct-head' }, [
        h('div', { class: 'acct-id' }, [name, tagMain.root, tagPref.root]),
        h('div', { class: 'acct-badges' }, [running, plan]),
      ]),
      status,
      same,
      alertBox,
      meters,
      note,
      noRead,
      chips,
      stats,
      noStats,
      lastErr,
      actions,
    ]);

    const STATE_ICON = { expired: 'alert', error: 'warn', refreshing: 'spin', nolimits: 'info', unknown: 'unknown', cooling: 'pause', limit: 'warn', ok: 'check' };
    const STATE_TEXT = {
      expired: 'acctStateExpired',
      error: 'acctStateError',
      refreshing: 'acctStateRefreshing',
      nolimits: 'acctStateNoLimits',
      unknown: 'acctStateUnknown',
      cooling: 'acctStateCooling',
      limit: 'acctStateLimit',
      ok: 'acctStateOk',
    };

    function paintTimes(now) {
      const a = account;
      const s = accountState(a, now);
      if (s !== currentState) {
        paint(now);
        return;
      }
      const factParts = [];
      if (a.isWorker && a.defaultModel !== null) {
        factParts.push(t('acctDefaultModel', a.defaultModel));
      } else if (a.isWorker && a.provider !== HOME_PROVIDER) {
        // No default: once a task has reported what the CLI chose, "CLI default · last ran <id>".
        factParts.push(a.modelRanAs !== null ? t('acctModelCliDefault') : t('acctModelCli'));
      }
      // Only what a finished task of this account reported: an alias names no model version.
      if (a.isWorker && a.modelRanAs !== null) {
        factParts.push(t('acctLastRan', a.modelRanAs));
      }
      if (a.usageFetchedAt !== null && a.login !== 'refreshing') {
        factParts.push(t('acctChecked', fmtAgo(a.usageFetchedAt, now)));
      }
      setText(facts, factParts.join(t('sep')));
      for (let i = 0; i < meterComps.length; i++) {
        meterComps[i].tick(now);
      }
      const coolingNow = a.cooldownUntil !== null && a.cooldownUntil > now;
      show(cooldown.root, coolingNow);
      if (coolingNow) {
        cooldown.set(t('acctCooldown', fmtSpan(a.cooldownUntil - now, false)), t('acctCooldownTip', fmtClock(a.cooldownUntil)));
      }
      if (noReadKind === 'temp') {
        setText(noReadWhy, t('acctTempUnavailable', fmtAgo(a.lastGoodWindowsAt, now)));
      }
      if (!note.hidden) {
        setText(noteText, t('acctStale', fmtAgo(a.windowsStaleSince, now)));
      }
      paintLogin(now);
    }

    /** The login tag of a Claude Code account: its state, its age, its reason on hover. */
    function paintLogin(now) {
      const lc = account.loginCheck;
      const shown = lc !== null && lc.state !== 'loggedOut';
      show(loginTag.root, shown);
      if (!shown) {
        return;
      }
      let text;
      if (lc.state === 'ok') {
        text = t('acctLoginOk', fmtAgo(lc.checkedAt, now));
      } else if (lc.state === 'checking') {
        text = t('acctLoginChecking');
      } else if (lc.state === 'probeFailed') {
        text = t('acctLoginProbeFailed');
      } else {
        text = t('acctLoginUnconfirmed');
      }
      loginTag.set(text, lc.reason);
    }

    /**
     * Why a logged-in account has no gauges - the one honest sentence for each cause. Decided
     * from the reading and the settings; the provider id only chooses the WORDING (the home
     * CLI's "no plan limits" means a token login, another CLI's means nothing was reported).
     */
    function whyNoReading(a) {
      const home = a.provider === HOME_PROVIDER;
      if (!home && ctx.polling === false) {
        return 'off';
      }
      if (home && a.login === 'no-plan-limits') {
        return 'token';
      }
      if (a.lastGoodWindowsAt !== null) {
        return 'temp';
      }
      return home ? 'none' : 'unreported';
    }

    function paint(now) {
      const a = account;
      const s = accountState(a, now);
      currentState = s;
      attr(root, 'data-state', s);
      setText(name, a.name);
      attr(name, 'title', a.name);
      show(tagMain.root, a.isMain);
      show(tagPref.root, a.preferred);
      show(running, a.running > 0);
      setText(runText, t('acctRunning', fmtInt(a.running)));
      // The plan as the CLI names it ("Claude Max") when it said; else the reading's word.
      // Some CLIs report their own name as the kind of login; the plate above already says it.
      const planWord = a.planLabel !== null ? a.planLabel : a.plan;
      const planText = planWord !== null && !sameWord(planWord, a.provider) && !sameWord(planWord, a.providerLabel) ? planWord : null;
      show(plan, planText !== null);
      setText(plan, planText === null ? '' : planText);
      attr(plan, 'title', planText === null ? null : t('acctPlanTip', planText));

      const home = a.provider === HOME_PROVIDER;
      const cli = providerName(a.provider, a.providerLabel);
      setIcon(provSlot, providerSigil(a.provider));
      setText(provLabel, cli);
      attr(prov, 'title', t('provRunsOn', cli));
      // On a mixed page the eye is looking for the cards that are NOT on the home CLI.
      toggleClass(prov, 'is-home', home);

      attr(facts, 'title', a.isWorker && a.modelRanAs !== null ? t('acctLastRanTip', a.modelRanAs) : null);
      setIcon(stateSlot, STATE_ICON[s]);
      // "No plan limits" is a statement about a token login on the home CLI. On any other
      // CLI the same login state only says that no figures came back.
      setText(stateText, t(s === 'nolimits' && !home ? 'acctStateLoggedIn' : STATE_TEXT[s]));

      show(same, a.sameAccountAs.length > 0);
      setText(sameText, a.sameAccountAs.length === 0 ? '' : t(a.sameAccountAs.length === 1 ? 'acctSameAccountOne' : 'acctSameAccountMany', a.sameAccountAs.join(t('nameSep'))));

      const alerting = s === 'expired' || s === 'error';
      show(alertBox, alerting);
      if (s === 'expired') {
        setIcon(alertSlot, 'alert');
        setText(alertTitle, t('acctExpiredTitle'));
        // A logout that a RUN proved is said as that: it is why dispatches stopped going to
        // the account, and it stands whatever the status check of its CLI answers.
        setText(alertBody, a.loginDetail === RUN_LOGIN_FAILURE_DETAIL ? t('acctExpiredBodyRun') : a.isWorker ? t('acctExpiredBody') : t('acctExpiredBodyMain'));
      } else if (s === 'error') {
        setIcon(alertSlot, 'warn');
        setText(alertTitle, t('acctErrorTitle'));
        setText(alertBody, a.loginDetail === null ? t('acctErrorBody') : a.loginDetail);
      }

      // Gauges exist exactly when the reading carries windows - whichever CLI it came from.
      // They are display-only, so they are rebuilt when (and only when) the windows change.
      const loggedIn = a.login === 'ok' || a.login === 'no-plan-limits';
      const showMeters = loggedIn && a.windows.length > 0;
      const sig = showMeters ? (home ? 'paced' : 'plain') + JSON.stringify(a.windows) : s === 'refreshing' ? 'skeleton' : '';
      if (sig !== metersSig) {
        metersSig = sig;
        clear(meters);
        meterComps = [];
        if (showMeters) {
          a.windows.forEach(function (w) {
            // The gauge is the same for every CLI. Only the pace mark is held back where the
            // length of the window is a guess: a mark in the wrong place is worse than none.
            const meter = Meter(w, home);
            meterComps.push(meter);
            meters.appendChild(meter.root);
          });
        } else if (s === 'refreshing') {
          meters.appendChild(h('div', { class: 'sk sk-meter' }));
          meters.appendChild(h('div', { class: 'sk sk-meter' }));
        }
      }
      show(meters, sig !== '');
      toggleClass(meters, 'is-stale', a.windowsStaleSince !== null);
      show(note, showMeters && a.windowsStaleSince !== null);

      // Logged in, and nothing to draw: say so in the gauges' place, and say why.
      noReadKind = loggedIn && a.windows.length === 0 ? whyNoReading(a) : '';
      show(noRead, noReadKind !== '');
      if (noReadKind === 'off') {
        setText(noReadWhy, t('acctNoReadingOff'));
      } else if (noReadKind === 'token') {
        setText(noReadWhy, t('acctNoLimitsBody'));
      } else if (noReadKind === 'unreported') {
        setText(noReadWhy, t('acctNoReadingBody', cli));
      } else if (noReadKind === 'none') {
        setText(noReadWhy, t('acctNoWindows'));
      }

      const over = a.overage !== null && a.overage.enabled;
      show(overage.root, over);
      if (over) {
        const parts = [t('acctOverageOn')];
        if (a.overage.spendLabel !== null) {
          parts.push(a.overage.spendLabel);
        }
        if (a.overage.percent !== null) {
          parts.push(t('acctOverageCap', Math.round(a.overage.percent)));
        }
        overage.set(parts.join(t('sep')), t('acctOverageTip'));
      }
      // Session workers are on, and this CLI has none: its dispatches stay one-shot.
      const oneShotOnly = a.isWorker && !a.sessionWorkers && ctx.meshMode === true;
      show(oneShot.root, oneShotOnly);
      if (oneShotOnly) {
        oneShot.set(t('acctOneShot'), t('acctOneShotTip', cli));
      }

      const dispatched = a.isWorker && (a.allTime.tasks === null || a.allTime.tasks > 0);
      show(stats, dispatched);
      show(noStats, !dispatched);
      if (dispatched) {
        stat5h.set(a.session5h);
        stat7d.set(a.week);
        statAll.set(a.allTime);
      } else {
        setText(noStats, a.isWorker ? t('acctNoDispatches') : t('acctNotWorker'));
      }
      show(lastErr, a.lastError !== null);
      if (a.lastError !== null) {
        const failures = a.allTime.errors !== null && a.allTime.errors > 0 ? t('acctFailures', fmtInt(a.allTime.errors)) + t('sep') : '';
        setText(lastErrText, failures + t('acctLastError', a.lastError));
        attr(lastErr, 'title', a.lastError);
      }

      const keyless = a.key === null;
      show(relogin, s === 'expired');
      show(openSession, s !== 'expired');
      const lc = a.loginCheck;
      const offerCheck = home && lc !== null && (lc.state === 'probeFailed' || lc.state === 'unconfirmed');
      show(checkLogin, offerCheck);
      if (offerCheck) {
        setButtonLabel(checkLogin, lc.state === 'probeFailed' ? t('checkAgain') : t('checkLoginNow'));
      }
      checkLogin.disabled = keyless;
      show(retry, s === 'error' && !offerCheck);
      relogin.disabled = keyless;
      openSession.disabled = keyless;
      attr(openSession, 'title', t('openSessionTip', cli));
      more.disabled = keyless;
      setButtonLabel(more, t('moreActionsFor', a.name));

      paintTimes(now);
    }

    function tick(now) {
      paintTimes(now);
    }
    tickers.add(tick);

    function primary() {
      return relogin.hidden ? (openSession.hidden ? more : openSession) : relogin;
    }

    return {
      root: root,
      primary: primary,
      update: function (next) {
        account = next;
        ctx = accountContext;
        // If a state change hides the button that has the focus, move the focus to the
        // card's new primary action instead of dropping it on the page body.
        const hadFocus = actions.contains(document.activeElement) ? document.activeElement : null;
        paint(Date.now());
        if (hadFocus && hadFocus.hidden) {
          primary().focus({ preventScroll: true });
        }
      },
      destroy: function () {
        tickers.delete(tick);
        menu.close(false);
      },
    };
  }

  /** What a card needs from outside its own account (kept out of the per-item signature). */
  let accountContext = { workerModels: [], workerPermissionMode: null, meshMode: null, polling: null };

  /** Shown in the grid while there is no worker account yet. */
  function Onboarding() {
    function Step(text, actionLabel, run) {
      const slot = iconSlot('blank', 'step-mark');
      const label = h('span', { class: 'step-text', text: text });
      const action = actionLabel ? button({ label: actionLabel, cls: 'btn-small' }, run) : null;
      const root = h('li', { class: 'step' }, [slot, label, action]);
      return {
        root: root,
        set: function (done, available) {
          toggleClass(root, 'is-done', done === true);
          setIcon(slot, done === true ? 'check' : 'blank');
          if (action) {
            show(action, done !== true);
            action.disabled = !available;
          }
        },
        relabel: function (text) {
          if (action) {
            setButtonLabel(action, text);
          }
        },
      };
    }
    const stepWorker = Step(t('onboardStepWorker'));
    // Done once the session here can dispatch; its action is the fix the host names.
    let dispatchFix = 'updateWorkspaceSetup';
    const stepMcp = Step(t('onboardStepMcp'), t('setupWorkspace'), function () {
      post({ type: 'command', id: dispatchFix });
    });
    const stepPolicy = Step(t('onboardStepPolicy'), t('setupAdd'), function () {
      post({ type: 'command', id: 'addDispatchPolicy' });
    });
    const add = button({ label: t('addWorker'), icon: 'plus', cls: 'btn-primary' }, function () {
      post({ type: 'command', id: 'addWorker' });
    });
    const importBtn = button({ label: t('importWorkers') }, function () {
      post({ type: 'command', id: 'importWorkers' });
    });
    const supported = h('p', { class: 'onboard-body onboard-clis' });
    const root = h('article', { class: 'onboard' }, [
      h('h3', { class: 'onboard-title', text: t('onboardTitle') }),
      h('p', { class: 'onboard-body', text: t('onboardBody') }),
      supported,
      h('ol', { class: 'steps' }, [stepWorker.root, stepMcp.root, stepPolicy.root]),
      h('div', { class: 'onboard-actions' }, [add, importBtn]),
    ]);
    return {
      root: root,
      update: function (m) {
        stepWorker.set(false, true);
        const clis = m.settings.providers.map(function (p) { return p.label !== null ? p.label : p.id; });
        show(supported, clis.length > 1);
        setText(supported, clis.length > 1 ? t('onboardClis', fmtList(clis)) : '');
        dispatchFix = m.health.dispatchFix;
        stepMcp.relabel(dispatchFix === 'installMcp' ? t('setupRegister') : t('setupWorkspace'));
        stepMcp.set(m.health.canDispatch, m.health.canDispatch !== null);
        stepPolicy.set(m.health.policyInstalled, m.health.policyInstalled !== null);
      },
    };
  }

  function AccountsSection() {
    const head = SectionHead(t('accountsTitle'));
    const add = button({ label: t('addWorker'), icon: 'plus', cls: 'btn-quiet' }, function () {
      post({ type: 'command', id: 'addWorker' });
    });
    head.tools.appendChild(add);
    const grid = h('div', { class: 'acct-grid' });
    const onboarding = Onboarding();
    // Shown only when accounts run on more than one CLI: the key to the plates, with counts.
    const legend = h('ul', { class: 'prov-legend', 'aria-label': t('provLegendLabel') });
    // Registry entries this version cannot use: said, with no action - they are removed from
    // the Workers view, where the question that goes with it can be asked.
    const unsupportedTitle = h('strong', { class: 'callout-title' });
    const unsupportedList = h('ul', { class: 'unsupported-list' });
    const unsupported = h('div', { class: 'callout is-warning unsupported', role: 'status', hidden: true }, [
      iconSlot('warn'),
      h('div', { class: 'callout-text' }, [unsupportedTitle, h('p', { class: 'callout-body', text: t('unsupportedBody') }), unsupportedList]),
    ]);
    const root = h('section', { class: 'sec sec-accounts', 'aria-labelledby': head.id }, [head.root, legend, grid, unsupported]);
    const pool = new Map();
    let lastSig = '';

    return {
      root: root,
      reveal: function (domKey) {
        const comp = pool.get(domKey);
        if (comp) {
          revealNode(comp.root, comp.primary());
        }
      },
      update: function (m) {
        const sig = JSON.stringify([
          m.accounts,
          m.settings.workerModels,
          m.settings.providers,
          m.settings.workerPermissionMode,
          m.settings.meshMode,
          m.settings.providerUsagePolling,
          m.health.mcpInstalled,
          m.health.canDispatch,
          m.health.dispatchFix,
          m.health.policyInstalled,
          m.health.registryProblem,
          m.unsupportedAccounts,
        ]);
        if (sig === lastSig) {
          return;
        }
        lastSig = sig;
        accountContext = {
          workerModels: m.settings.workerModels,
          workerPermissionMode: m.settings.workerPermissionMode,
          meshMode: m.settings.meshMode,
          polling: m.settings.providerUsagePolling,
        };
        head.set(fmtInt(m.accounts.length), t('scopeNoteMachine'), accountTally(m.accounts, Date.now()).join(t('sep')));

        // Main first, then one CLI after another in the order the settings list them, each
        // keeping the registry's own order - so two CLIs never interleave.
        const ordered = m.accounts
          .map(function (a, i) { return { a: a, i: i }; })
          .sort(function (x, y) {
            if (x.a.isMain !== y.a.isMain) {
              return x.a.isMain ? -1 : 1;
            }
            const byProvider = providerRank(x.a.provider) - providerRank(y.a.provider);
            return byProvider !== 0 && !Number.isNaN(byProvider) ? byProvider : x.i - y.i;
          })
          .map(function (x) { return x.a; });
        const counts = new Map();
        ordered.forEach(function (a) {
          const hit = counts.get(a.provider);
          if (hit) {
            hit.count += 1;
          } else {
            counts.set(a.provider, { id: a.provider, label: providerName(a.provider, a.providerLabel), count: 1 });
          }
        });
        // One CLI on the whole page: nothing to tell apart, so the plates fold to their shape.
        const uniform = counts.size <= 1;
        toggleClass(grid, 'is-uniform', uniform);
        clear(legend);
        if (!uniform) {
          Array.from(counts.values())
            .sort(function (x, y) { return providerRank(x.id) - providerRank(y.id); })
            .forEach(function (entry) {
              legend.appendChild(
                h('li', { class: 'prov-legend-item' }, [
                  icon(providerSigil(entry.id)),
                  h('span', { class: 'prov-legend-name', text: entry.label }),
                  h('span', { class: 'prov-legend-count', text: fmtInt(entry.count) }),
                ]),
              );
            });
        }
        show(legend, !uniform);

        clear(unsupportedList);
        m.unsupportedAccounts.forEach(function (u) {
          unsupportedList.appendChild(
            h('li', { class: 'unsupported-item' }, [
              h('span', { class: 'unsupported-name' + (u.name === null ? ' is-unnamed' : ''), text: u.name === null ? t('unsupportedUnnamed') : u.name }),
              u.detail === null ? null : h('span', { class: 'unsupported-detail', text: u.detail }),
            ]),
          );
        });
        setText(unsupportedTitle, t('unsupportedTitle', fmtInt(m.unsupportedAccounts.length)));
        show(unsupported, m.unsupportedAccounts.length > 0);

        const hasWorker = m.accounts.some(function (a) { return a.isWorker; });
        // "Add your first worker" is for a registry that holds none - not for one that could
        // not be read, where the accounts are there and simply cannot be seen.
        const offerFirst = !hasWorker && m.health.registryProblem === null;
        keepFocus(function () {
          syncList(grid, pool, ordered, AccountCard);
          if (offerFirst) {
            onboarding.update(m);
            if (onboarding.root.parentNode !== grid || onboarding.root !== grid.lastChild) {
              grid.appendChild(onboarding.root);
            }
          } else if (onboarding.root.parentNode === grid) {
            grid.removeChild(onboarding.root);
          }
        });
        show(add, hasWorker);
      },
    };
  }

  /* ======================================================================= *
   * 7. Team (live sessions)
   * ======================================================================= */

  const LANES = [
    { id: 'busy', title: 'laneWorking', empty: 'laneWorkingEmpty', icon: 'activity' },
    { id: 'waiting', title: 'laneWaiting', empty: 'laneWaitingEmpty', icon: 'alert' },
    { id: 'parked', title: 'laneParked', empty: 'laneParkedEmpty', icon: 'pause' },
  ];
  function laneOf(session) {
    return session.status === 'busy' ? 'busy' : session.status === 'waiting' ? 'waiting' : 'parked';
  }

  function SessionCard(first) {
    let session = first;
    function act(action) {
      if (session.key !== null) {
        post({ type: 'session', action: action, key: session.key });
      }
    }
    const nameText = h('span', { class: 'sess-name-text' });
    const nameBtn = h('button', { type: 'button', class: 'sess-name' }, [nameText, icon('copy', 'ico-trail')]);
    let copiedTimer = null;
    on(nameBtn, 'click', function () {
      act('copyName');
      nameBtn.classList.add('is-copied');
      announce(t('sessCopied', session.name));
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(function () {
        nameBtn.classList.remove('is-copied');
      }, 1400);
    });
    const stateSlot = iconSlot('spin');
    const stateText = h('span');
    const stateEl = h('span', { class: 'sess-state' }, [stateSlot, stateText]);
    const title = h('p', { class: 'sess-title' });
    const detailText = h('span');
    const detail = h('p', { class: 'sess-detail' }, [iconSlot('alert'), detailText]);
    const src = Tag('cpu', 'tag-src');
    const account = Tag('user');
    const model = Tag(null, 'tag-mono');
    const location = Tag('folder');
    const other = Tag(null, 'tag-quiet');
    other.set(t('otherWorkspace'), t('otherWorkspaceTip'));
    const settled = Tag('check');
    settled.set(t('sessSettled'), t('sessSettledTip'));
    const tags = h('div', { class: 'sess-tags' }, [src.root, account.root, model.root, location.root, settled.root, other.root]);
    const branchText = h('span', { class: 'sess-branch-name' });
    const unmerged = h('span', { class: 'mark-unmerged', text: t('unmerged'), title: t('unmergedTip') });
    const branch = h('p', { class: 'sess-branch' }, [iconSlot('branch'), branchText, unmerged]);

    const attach = button({ label: t('sessAttach'), icon: 'terminal', cls: 'btn-small', title: t('sessAttachTip') }, function () {
      act('attach');
    });
    const logs = button({ label: t('sessLogs'), icon: 'logs', cls: 'btn-small', title: t('sessLogsTip') }, function () {
      act('logs');
    });
    const diff = button({ label: t('sessDiff'), icon: 'diff', cls: 'btn-small', title: t('sessDiffTip') }, function () {
      act('openDiff');
    });
    // One press: the host asks before it stops anything.
    const stop = button({ label: t('sessStop'), icon: 'stop', cls: 'btn-small btn-danger', title: t('sessStopTip') }, function () {
      act('stop');
    });
    const actions = h('div', { class: 'sess-actions' }, [attach, logs, diff, stop]);

    const root = h('li', { class: 'sess' }, [h('div', { class: 'sess-top' }, [nameBtn, stateEl]), title, detail, tags, branch, actions]);

    const STATE_ICON = { busy: 'spin', waiting: 'alert', idle: 'pause', stopped: 'stop', unknown: 'unknown' };

    function paintTime(now) {
      const s = session;
      let text;
      if (s.status === 'busy') {
        text = s.startedAt === null ? t('sessBusy') : t('sessBusyFor', fmtSpan(now - s.startedAt, true));
      } else if (s.status === 'waiting') {
        text = s.updatedAt === null ? t('sessWaiting') : t('sessWaitingFor', fmtSpan(now - s.updatedAt, false));
      } else if (s.status === 'idle') {
        text = s.updatedAt === null ? t('sessIdle') : t('sessIdleFor', fmtSpan(now - s.updatedAt, false));
      } else if (s.status === 'stopped') {
        text = t('sessStopped');
      } else {
        text = t('sessUnknown');
      }
      setText(stateText, text);
    }
    tickers.add(paintTime);

    return {
      root: root,
      update: function (next) {
        session = next;
        const s = next;
        attr(root, 'data-source', s.source);
        attr(root, 'data-status', s.status);
        setText(nameText, s.name);
        attr(nameBtn, 'title', t('sessCopyTip', s.name));
        nameBtn.disabled = s.key === null;
        setIcon(stateSlot, STATE_ICON[s.status]);

        const headline = s.taskTitle !== null ? s.taskTitle : s.source === 'teammate' ? t('sessTeammateNoTask') : s.source === 'peer' ? t('sessPeerNoTask') : t('sessNoTask');
        setText(title, headline);
        toggleClass(title, 'is-placeholder', s.taskTitle === null);
        attr(title, 'title', s.taskTitle);
        show(detail, s.detail !== null);
        if (s.detail !== null) {
          setText(detailText, s.status === 'waiting' ? t('sessWaitingOn', s.detail) : s.detail);
        }

        if (s.source === 'worker') {
          src.setIcon('cpu');
          src.set(t('srcWorker'), t('srcWorkerTip'));
        } else if (s.source === 'teammate') {
          src.setIcon('users');
          const who = s.role !== null ? t('srcTeammateRole', s.role) : t('srcTeammate');
          src.set(s.team !== null ? t('srcTeammateOf', who, s.team) : who, t('srcTeammateTip'));
        } else {
          src.setIcon('link');
          src.set(s.kind === 'background' ? t('srcPeerBackground') : t('srcPeer'), t('srcPeerTip'));
        }
        account.set(s.accountName, t('sessAccountTip', s.accountName));
        show(model.root, s.model !== null);
        model.set(s.model === null ? '' : s.model);
        const branched = s.source === 'worker' && s.branch !== null;
        show(location.root, s.location !== null && !branched);
        location.set(s.location === null ? '' : s.location, s.location);
        show(settled.root, s.settled && s.source === 'worker');
        show(other.root, !s.inWorkspace && state.model !== null && state.model.scope === 'all');

        show(branch, s.branch !== null);
        setText(branchText, s.branch === null ? '' : s.branch);
        attr(branchText, 'title', s.location === null ? s.branch : t('sessBranchTip', s.branch, s.location));
        show(unmerged, s.unmerged);

        const usable = s.key !== null;
        show(attach, s.canAttach && usable);
        show(logs, s.canAttach && usable);
        show(diff, s.source === 'worker' && s.branch !== null && usable);
        show(stop, s.canStop && usable);
        show(actions, !(attach.hidden && logs.hidden && diff.hidden && stop.hidden));
        paintTime(Date.now());
      },
      destroy: function () {
        tickers.delete(paintTime);
        clearTimeout(copiedTimer);
      },
    };
  }

  function TeamSection() {
    const head = SectionHead(t('teamTitle'));
    const unsupported = Callout('warning');
    const lanes = {};
    const lanesEl = h('div', { class: 'lanes' });
    LANES.forEach(function (lane) {
      const count = h('span', { class: 'lane-count' });
      const listEl = h('ul', { class: 'lane-list' });
      const empty = h('p', { class: 'lane-empty', text: t(lane.empty) });
      const id = uid('lane');
      const el = h('section', { class: 'lane lane-' + lane.id, 'aria-labelledby': id }, [
        h('header', { class: 'lane-head' }, [iconSlot(lane.icon), h('h3', { class: 'lane-title', id: id, text: t(lane.title) }), count]),
        listEl,
        empty,
      ]);
      lanes[lane.id] = { el: el, list: listEl, count: count, empty: empty };
      lanesEl.appendChild(el);
    });

    // Empty state: what session workers are, in two sentences, and the switch.
    const emptyTitle = h('h3', { class: 'empty-title' });
    const emptyBody = h('p', { class: 'empty-body' });
    const enable = button({ label: t('teamEnable'), icon: 'zap', cls: 'btn-primary' }, function () {
      sendSetting('meshMode', true);
    });
    const showAll = button({ label: t('showAllWorkspaces') }, function () {
      post({ type: 'setScope', scope: 'all' });
    });
    const enableStatus = h('span', { class: 'field-status', role: 'status' });
    const emptyBox = h('div', { class: 'empty-state' }, [
      h('div', { class: 'empty-art', 'aria-hidden': 'true' }, [icon('users')]),
      h('div', { class: 'empty-copy' }, [emptyTitle, emptyBody, h('div', { class: 'empty-actions' }, [enable, showAll, enableStatus])]),
    ]);
    watchSetting('meshMode', function (status) {
      setText(enableStatus, status.state === 'saved' ? '' : status.text);
      attr(enableStatus, 'data-state', status.state);
      enable.disabled = status.state === 'saving';
    });

    const root = h('section', { class: 'sec sec-team', 'aria-labelledby': head.id }, [head.root, unsupported.root, lanesEl, emptyBox]);
    const pool = new Map();
    let lastSig = '';

    return {
      root: root,
      update: function (m) {
        const sig = JSON.stringify([m.sessions, m.scope, m.workspace, m.settings.meshMode, m.health.sessionWorkersSupported, m.health.claudeVersion, m.health.sessionWorkersMinVersion]);
        if (sig === lastSig) {
          return;
        }
        lastSig = sig;

        const groups = { busy: [], waiting: [], parked: [] };
        m.sessions.forEach(function (s) {
          groups[laneOf(s)].push(s);
        });
        const any = m.sessions.length > 0;
        const tooOld = m.health.sessionWorkersSupported === false;

        const parts = any
          ? [t('teamWorking', groups.busy.length), t('teamWaiting', groups.waiting.length), t('teamParked', groups.parked.length)]
          : [];
        head.set(any ? fmtInt(m.sessions.length) : '', scopeText(m), parts.join(t('sep')));

        show(unsupported.root, tooOld && (any || m.settings.meshMode === true));
        if (tooOld) {
          unsupported.set(
            t('teamUnsupportedTitle', m.health.sessionWorkersMinVersion),
            t('teamUnsupportedBody', m.health.claudeVersion === null ? t('versionUnknown') : m.health.claudeVersion),
          );
        }

        keepFocus(function () {
          // One pool across the three lanes: a session that changes status MOVES, it is not rebuilt.
          const live = new Set(m.sessions.map(function (s) { return s.dom; }));
          pool.forEach(function (comp, key) {
            if (!live.has(key)) {
              comp.destroy();
              if (comp.root.parentNode) {
                comp.root.parentNode.removeChild(comp.root);
              }
              pool.delete(key);
            }
          });
          LANES.forEach(function (lane) {
            const roots = groups[lane.id].map(function (s) {
              let comp = pool.get(s.dom);
              if (!comp) {
                comp = SessionCard(s);
                pool.set(s.dom, comp);
              }
              comp.update(s);
              return comp.root;
            });
            orderChildren(lanes[lane.id].list, roots);
            setText(lanes[lane.id].count, fmtInt(roots.length));
            show(lanes[lane.id].empty, roots.length === 0);
            toggleClass(lanes[lane.id].el, 'is-empty', roots.length === 0);
          });
        });

        show(lanesEl, any);
        show(emptyBox, !any);
        if (!any) {
          const off = m.settings.meshMode !== true;
          if (tooOld && off) {
            setText(emptyTitle, t('teamUnsupportedTitle', m.health.sessionWorkersMinVersion));
            setText(emptyBody, t('teamUnsupportedBody', m.health.claudeVersion === null ? t('versionUnknown') : m.health.claudeVersion));
          } else if (off) {
            setText(emptyTitle, t('teamOffTitle'));
            setText(emptyBody, t('teamOffBody'));
          } else {
            setText(emptyTitle, m.scope === 'all' ? t('teamEmptyTitleAll') : t('teamEmptyTitle'));
            setText(emptyBody, t('teamEmptyBody'));
          }
          show(enable, off && !tooOld);
          show(showAll, !off && m.scope !== 'all' && m.workspace !== null);
          if (!off) {
            setText(enableStatus, '');
          }
        }
      },
    };
  }

  /* ======================================================================= *
   * 8. Activity (tasks)
   * ======================================================================= */

  const STATUS_META = {
    running: { icon: 'spin', label: 'statusRunning' },
    done: { icon: 'done', label: 'statusDone' },
    failed: { icon: 'failed', label: 'statusFailed' },
    cancelled: { icon: 'cancelled', label: 'statusCancelled' },
    orphaned: { icon: 'orphaned', label: 'statusOrphaned' },
    unknown: { icon: 'unknown', label: 'statusUnknown' },
  };
  const MODE_META = {
    oneshot: { label: 'modeOneshot', tip: 'modeOneshotTip' },
    detached: { label: 'modeDetached', tip: 'modeDetachedTip' },
    session: { label: 'modeSession', tip: 'modeSessionTip' },
  };

  /**
   * Where a task's model came from: the sentence of its tooltip (`tip` names the model that was
   * asked for; `alone` is for a task whose record names none), and the words of its detail row.
   */
  const MODEL_SOURCE = {
    dispatch: { tip: 'taskModelTipDispatch', alone: 'taskModelTipDispatchAlone', label: 'modelSourceDispatch' },
    worker: { tip: 'taskModelTipWorker', alone: 'taskModelTipWorkerAlone', label: 'modelSourceWorker' },
    cli: { tip: 'taskModelTipCli', alone: 'taskModelTipCli', label: 'modelSourceCli' },
  };

  /** Does the task's record name the model it asked for? `-` (and no text at all) is "none". */
  function namesModel(tk) {
    return tk.model !== '-' && tk.model !== DASH;
  }

  /** The CLI reported a model, and it is not the text that was asked for (an alias, usually). */
  function ranAnother(tk) {
    return tk.modelUsed !== null && tk.modelUsed !== tk.model;
  }

  /** The model cell's tooltip: where the model came from and what ran, as far as each is known. */
  function modelTip(tk) {
    const parts = [];
    if (tk.modelSource !== null) {
      // A record that names no model is never said to have "asked for -": the source alone.
      parts.push(namesModel(tk) ? t(MODEL_SOURCE[tk.modelSource].tip, tk.model) : t(MODEL_SOURCE[tk.modelSource].alone));
    }
    if (ranAnother(tk)) {
      parts.push(t('taskModelTipRan', tk.modelUsed));
    }
    return parts.length > 0 ? parts.join(' ') : tk.model;
  }

  function metaCell(cls, labelKey) {
    const value = h('span', { class: 'cell-value' });
    const root = h('span', { class: 'cell ' + cls }, [h('span', { class: 'cell-label', text: t(labelKey) }), value]);
    return { root: root, value: value };
  }

  function TaskRow(first) {
    let task = first;
    const detailId = uid('task');

    const pillSlot = iconSlot('done');
    const pillText = h('span');
    const pill = h('span', { class: 'pill status' }, [pillSlot, pillText]);

    const titleBtn = h('button', { type: 'button', class: 'task-title is-link', title: t('taskOpenTip') });
    const titleText = h('span', { class: 'task-title is-plain' });
    const other = h('span', { class: 'tag tag-quiet', text: t('otherWorkspace'), title: t('otherWorkspaceTip') });
    // Only on a task that did NOT run on the home CLI, so a page of Claude Code tasks carries none.
    const ranOn = Tag('provX', 'tag-prov');
    const titleBox = h('div', { class: 'task-titlebox' }, [titleBtn, titleText, ranOn.root, other]);
    on(titleBtn, 'click', function () {
      if (task.id !== null) {
        post({ type: 'openTask', id: task.id });
      }
    });

    const errText = h('span', { class: 'task-error-text' });
    const errLine = h('p', { class: 'task-error' }, [iconSlot('alert'), errText]);

    const mode = metaCell('cell-mode', 'colMode');
    const account = metaCell('cell-account', 'colAccount');
    const model = metaCell('cell-model', 'colModel');
    const started = metaCell('cell-started', 'colStarted');
    const duration = metaCell('cell-duration', 'colDuration');
    const tokens = metaCell('cell-tokens', 'colTokens');
    const meta = h('div', { class: 'task-meta' }, [mode.root, account.root, model.root, started.root, duration.root, tokens.root]);

    const cancel = button({ label: t('taskCancel'), cls: 'btn-small btn-danger' });
    const disarmCancel = armable(cancel, t('taskCancel'), t('taskCancelConfirm'), function () {
      if (task.id !== null) {
        post({ type: 'cancelTask', id: task.id });
      }
    });
    const expand = button({ label: t('taskDetails'), icon: 'chevronDown', iconOnly: true, cls: 'btn-expand' }, function () {
      const key = task.dom;
      if (state.expandedTasks.has(key)) {
        state.expandedTasks.delete(key);
      } else {
        state.expandedTasks.add(key);
      }
      paintExpanded();
    });
    attr(expand, 'aria-controls', detailId);
    const actions = h('div', { class: 'task-actions' }, [cancel, expand]);

    const detail = h('dl', { class: 'task-detail', id: detailId });
    const main = h('div', { class: 'task-main' }, [pill, titleBox, actions]);
    const root = h('li', { class: 'task' }, [main, meta, errLine, detail]);

    function detailRow(label, value, cls) {
      return h('div', { class: 'detail-row' }, [h('dt', { text: label }), h('dd', { class: cls || null, text: value })]);
    }

    let detailSig = '';
    function paintExpanded() {
      const open = state.expandedTasks.has(task.dom);
      attr(expand, 'aria-expanded', open ? 'true' : 'false');
      toggleClass(root, 'is-open', open);
      show(detail, open);
      if (!open) {
        detailSig = '';
        return;
      }
      const tk = task;
      const now = Date.now();
      // Rebuilt only when the task itself changed, so text being selected in an open
      // detail panel is not thrown away by a refresh that did not touch this task.
      const sig = JSON.stringify(tk);
      if (sig === detailSig) {
        return;
      }
      detailSig = sig;
      clear(detail);
      if (tk.error !== null) {
        detail.appendChild(detailRow(t('detailError'), tk.error, 'is-error'));
      }
      if (tk.promptPreview !== null) {
        detail.appendChild(detailRow(t('detailPrompt'), tk.promptPreview));
      }
      if (tk.provider !== null) {
        detail.appendChild(detailRow(t('detailProvider'), providerName(tk.provider, null)));
      }
      if (tk.modelUsed !== null) {
        detail.appendChild(detailRow(t('detailModelRan'), tk.modelUsed, 'is-mono'));
      }
      if (tk.modelSource !== null) {
        detail.appendChild(detailRow(t('detailModelSource'), t(MODEL_SOURCE[tk.modelSource].label)));
      }
      if (tk.sessionWorker !== null) {
        detail.appendChild(detailRow(t('detailSession'), tk.sessionWorker, 'is-mono'));
      }
      if (tk.branch !== null) {
        detail.appendChild(detailRow(t('detailBranch'), tk.unmerged ? t('detailBranchUnmerged', tk.branch) : tk.branch, 'is-mono'));
      }
      if (tk.endedAt !== null) {
        detail.appendChild(detailRow(t('detailEnded'), fmtWhen(tk.endedAt, now)));
      }
      if (tk.inputTokens !== null || tk.outputTokens !== null) {
        detail.appendChild(detailRow(t('detailTokens'), t('detailTokensValue', fmtInt(tk.inputTokens), fmtInt(tk.outputTokens))));
      }
      if (tk.costUsd !== null && tk.costUsd > 0) {
        detail.appendChild(detailRow(t('detailCost'), fmtUsd(tk.costUsd)));
      }
      detail.appendChild(detailRow(t('detailId'), tk.id === null ? DASH : tk.id, 'is-mono'));
    }

    let paintedDay = -1;
    function paintTime(now) {
      const tk = task;
      setText(started.value, fmtWhen(tk.startedAt, now));
      let span = DASH;
      if (tk.status === 'running') {
        span = tk.startedAt === null ? DASH : fmtSpan(now - tk.startedAt, true);
      } else if (tk.startedAt !== null && tk.endedAt !== null) {
        span = fmtSpan(tk.endedAt - tk.startedAt, true);
      }
      setText(duration.value, span);
      paintedDay = dayStamp;
    }
    // Up to 300 rows tick: only a running task's elapsed time moves every second, and the
    // start column changes only when the calendar day does.
    function tick(now) {
      if (task.status === 'running' || paintedDay !== dayStamp) {
        paintTime(now);
      }
    }
    tickers.add(tick);

    return {
      root: root,
      matches: function (status, needle, provider) {
        const tk = task;
        if (status !== 'all' && tk.status !== status) {
          return false;
        }
        if (provider !== null && taskProvider(tk) !== provider) {
          return false;
        }
        if (needle === '') {
          return true;
        }
        const cli = tk.provider === null ? null : providerName(tk.provider, null);
        const hay = [tk.title, tk.worker, tk.model, tk.modelUsed, cli, tk.branch, tk.sessionWorker, tk.error, tk.id].filter(Boolean).join('\n').toLowerCase();
        return hay.indexOf(needle) !== -1;
      },
      update: function (next) {
        task = next;
        const tk = next;
        const meta0 = STATUS_META[tk.status];
        attr(root, 'data-status', tk.status);
        setIcon(pillSlot, meta0.icon);
        setText(pillText, t(meta0.label));

        const link = tk.hasOutput && tk.id !== null;
        show(titleBtn, link);
        show(titleText, !link);
        setText(link ? titleBtn : titleText, tk.title);
        attr(titleText, 'title', tk.title);
        show(other, !tk.inWorkspace && state.model !== null && state.model.scope === 'all');
        const cli = providerName(taskProvider(tk), null);
        show(ranOn.root, tk.provider !== null);
        if (tk.provider !== null) {
          ranOn.setIcon(providerSigil(tk.provider));
          ranOn.set(cli, t('taskProviderTip', cli));
        }

        const showError = tk.error !== null && (tk.status === 'failed' || tk.status === 'orphaned' || tk.status === 'unknown');
        show(errLine, showError);
        if (showError) {
          setText(errText, tk.error);
        }

        const modeMeta = tk.mode === null ? null : MODE_META[tk.mode];
        setText(mode.value, modeMeta === null ? DASH : t(modeMeta.label));
        attr(mode.root, 'title', modeMeta === null ? null : t(modeMeta.tip, cli));
        attr(mode.root, 'data-mode', tk.mode);
        setText(account.value, tk.worker);
        attr(account.value, 'title', tk.worker);
        // What was asked for, then - only when the CLI said so - what ran.
        setText(model.value, ranAnother(tk) ? t('taskModelRan', tk.model, tk.modelUsed) : tk.model);
        attr(model.value, 'title', modelTip(tk));
        if (tk.mode === 'session') {
          setText(tokens.value, t('tokensNA'));
          attr(tokens.root, 'title', t('tokensNATip'));
        } else if (tk.inputTokens === null && tk.outputTokens === null) {
          setText(tokens.value, DASH);
          attr(tokens.root, 'title', null);
        } else {
          setText(tokens.value, t('tokensInOut', fmtTokens(tk.inputTokens), fmtTokens(tk.outputTokens)));
          attr(tokens.root, 'title', t('detailTokensValue', fmtInt(tk.inputTokens), fmtInt(tk.outputTokens)));
        }

        const cancellable = tk.status === 'running' && tk.id !== null;
        if (cancel.hidden !== !cancellable) {
          disarmCancel();
        }
        show(cancel, cancellable);
        paintTime(Date.now());
        paintExpanded();
      },
      destroy: function () {
        tickers.delete(tick);
        disarmCancel();
        state.expandedTasks.delete(task.dom);
      },
    };
  }

  /** Fourteen stacked day columns plus the success rate over the same days. */
  function ActivityChart() {
    const cols = h('div', { class: 'strip-cols', role: 'img' });
    const axisStart = h('span');
    const axisEnd = h('span');
    const strip = h('div', { class: 'strip' }, [cols, h('div', { class: 'strip-axis', 'aria-hidden': 'true' }, [axisStart, axisEnd])]);
    const rate = h('p', { class: 'rate-value' });
    const rateNote = h('p', { class: 'rate-note' });
    // The legend doubles as the three totals, so the swatches are explained by real numbers.
    const tallyItem = function (cls, labelKey) {
      const value = h('dd', { class: 'tally-value' });
      return {
        value: value,
        root: h('div', { class: 'tally-item' }, [h('dt', { class: 'tally-label' }, [h('span', { class: 'swatch ' + cls, 'aria-hidden': 'true' }), t(labelKey)]), value]),
      };
    };
    const tallyDone = tallyItem('is-done', 'statusDone');
    const tallyFailed = tallyItem('is-failed', 'statusFailed');
    const tallyCancelled = tallyItem('is-cancelled', 'statusCancelled');
    const root = h('div', { class: 'act-top' }, [
      h('div', { class: 'rate' }, [h('p', { class: 'rate-label', text: t('rateLabel') }), rate, rateNote]),
      h('div', { class: 'strip-box' }, [h('p', { class: 'strip-label', text: t('stripLabel') }), strip]),
      h('dl', { class: 'tally' }, [tallyDone.root, tallyFailed.root, tallyCancelled.root]),
    ]);
    let lastSig = '';
    return {
      root: root,
      update: function (m) {
        const sig = JSON.stringify([m.daily, m.tasks.length === 0]);
        if (sig === lastSig) {
          return;
        }
        lastSig = sig;
        const now = Date.now();
        let max = 0;
        const sum = { done: 0, failed: 0, cancelled: 0 };
        m.daily.forEach(function (d) {
          max = Math.max(max, d.done + d.failed + d.cancelled);
          sum.done += d.done;
          sum.failed += d.failed;
          sum.cancelled += d.cancelled;
        });
        clear(cols);
        m.daily.forEach(function (d) {
          const total = d.done + d.failed + d.cancelled;
          const label = d.day === null ? DASH : sameDay(d.day, now) ? t('today') : fmtDay(d.day);
          const col = h('div', { class: 'strip-col' + (d.day !== null && sameDay(d.day, now) ? ' is-today' : ''), title: t('stripDayTip', label, fmtCount(d.done), fmtCount(d.failed), fmtCount(d.cancelled)) });
          const stack = h('div', { class: 'strip-stack' });
          if (total === 0 || max === 0) {
            stack.classList.add('is-zero');
          } else {
            setVar(stack, '--h', Math.max(6, (total / max) * 100) + '%');
            [['done', d.done], ['failed', d.failed], ['cancelled', d.cancelled]].forEach(function (pair) {
              if (pair[1] > 0) {
                const seg = h('span', { class: 'strip-seg is-' + pair[0] });
                setVar(seg, '--g', String(pair[1]));
                stack.appendChild(seg);
              }
            });
          }
          col.appendChild(stack);
          cols.appendChild(col);
        });
        attr(cols, 'aria-label', t('stripAria', fmtCount(sum.done), fmtCount(sum.failed), fmtCount(sum.cancelled)));
        const first = m.daily.length > 0 ? m.daily[0].day : null;
        setText(axisStart, first === null ? '' : fmtDay(first));
        setText(axisEnd, m.daily.length > 0 ? t('today') : '');
        setText(tallyDone.value, fmtCount(sum.done));
        setText(tallyFailed.value, fmtCount(sum.failed));
        setText(tallyCancelled.value, fmtCount(sum.cancelled));
        // Cancelled tasks are a decision, not a failure: they stay out of the rate.
        const judged = sum.done + sum.failed;
        setText(rate, judged === 0 ? DASH : fmtPct((sum.done / judged) * 100));
        setText(rateNote, judged === 0 ? t('rateNone') : t('rateNote', fmtCount(sum.done), fmtCount(judged)));
        // Nothing finished in fourteen days and nothing listed: the summary would be a row
        // of zeroes above an empty state that already says so.
        show(root, max > 0 || m.tasks.length > 0);
      },
    };
  }

  function ActivitySection() {
    const head = SectionHead(t('activityTitle'));
    const problem = Callout('error');
    const chart = ActivityChart();

    const filterButtons = new Map();
    const filterGroup = h('div', { class: 'filter-chips', role: 'group', 'aria-label': t('filterStatusLabel') });
    ['all'].concat(TASK_STATUSES).forEach(function (status) {
      const label = h('span');
      const count = h('span', { class: 'filter-count' });
      const node = h('button', { type: 'button', class: 'filter-chip' }, [status === 'all' ? null : icon(STATUS_META[status].icon), label, count]);
      attr(node, 'data-status', status);
      setText(label, status === 'all' ? t('filterAll') : t(STATUS_META[status].label));
      on(node, 'click', function () {
        state.filterStatus = status;
        state.taskLimit = 50;
        persist();
        applyFilter();
      });
      filterButtons.set(status, { node: node, count: count });
      filterGroup.appendChild(node);
    });
    const search = h('input', { type: 'search', name: 'task-filter', class: 'input filter-text', placeholder: t('filterPlaceholder'), 'aria-label': t('filterTextLabel'), spellcheck: 'false' });
    search.value = state.filterText;
    on(search, 'input', function () {
      state.filterText = search.value.slice(0, 120);
      state.taskLimit = 50;
      persist();
      applyFilter();
    });
    const resultNote = h('p', { class: 'filter-note', role: 'status' });
    // A second row, present only while the list holds tasks of more than one CLI. Its chips
    // are toggles (no "All" of their own): pressing the active one shows every CLI again.
    const providerChips = h('div', { class: 'filter-chips' });
    const providerRow = h('div', { class: 'filter-prov', role: 'group', 'aria-label': t('filterProviderLabel') }, [
      h('span', { class: 'filter-head', 'aria-hidden': 'true', text: t('filterProviderHead') }),
      providerChips,
    ]);
    const providerPool = new Map();
    function ProviderChip(first) {
      let item = first;
      const slot = iconSlot('provX');
      const label = h('span');
      const count = h('span', { class: 'filter-count' });
      const node = h('button', { type: 'button', class: 'filter-chip' }, [slot, label, count]);
      on(node, 'click', function () {
        state.filterProvider = state.filterProvider === item.id ? null : item.id;
        state.taskLimit = 50;
        persist();
        applyFilter();
      });
      return {
        root: node,
        update: function (next) {
          item = next;
          setIcon(slot, providerSigil(next.id));
          setText(label, next.label);
          setText(count, fmtInt(next.count));
          attr(node, 'aria-pressed', state.filterProvider === next.id ? 'true' : 'false');
        },
      };
    }
    const filters = h('div', { class: 'filters' }, [filterGroup, h('label', { class: 'search' }, [icon('search'), search]), resultNote, providerRow]);

    const columns = h('div', { class: 'task-head', 'aria-hidden': 'true' }, [
      h('span', { text: t('colStatus') }),
      h('span', { text: t('colTask') }),
      h('span', { text: t('colMode') }),
      h('span', { text: t('colAccount') }),
      h('span', { text: t('colModel') }),
      h('span', { text: t('colStarted') }),
      h('span', { class: 'is-num', text: t('colDuration') }),
      h('span', { class: 'is-num', text: t('colTokens') }),
      h('span'),
    ]);
    const listEl = h('ul', { class: 'tasks' });
    const emptyTitle = h('h3', { class: 'empty-title' });
    const emptyBody = h('p', { class: 'empty-body' });
    const clearFilter = button({ label: t('filterClear') }, function () {
      state.filterStatus = 'all';
      state.filterText = '';
      state.filterProvider = null;
      search.value = '';
      persist();
      applyFilter();
    });
    const showAll = button({ label: t('showAllWorkspaces') }, function () {
      post({ type: 'setScope', scope: 'all' });
    });
    const emptyBox = h('div', { class: 'empty-state' }, [
      h('div', { class: 'empty-art', 'aria-hidden': 'true' }, [icon('logs')]),
      h('div', { class: 'empty-copy' }, [emptyTitle, emptyBody, h('div', { class: 'empty-actions' }, [clearFilter, showAll])]),
    ]);
    const more = button({ label: '', cls: 'btn-quiet' }, function () {
      state.taskLimit += 50;
      applyFilter();
    });
    const capNote = h('p', { class: 'cap-note' });
    const foot = h('div', { class: 'tasks-foot' }, [more, capNote]);
    const body = h('div', { class: 'act-body' }, [chart.root, filters, columns, listEl, emptyBox, foot]);
    const root = h('section', { class: 'sec sec-activity', 'aria-labelledby': head.id }, [head.root, problem.root, body]);

    const pool = new Map();
    let lastSig = '';
    let model = null;

    function applyFilter() {
      if (model === null) {
        return;
      }
      const m = model;
      const needle = state.filterText.trim().toLowerCase();
      const counts = { all: m.tasks.length, running: 0, done: 0, failed: 0, cancelled: 0, orphaned: 0 };
      m.tasks.forEach(function (tk) {
        if (counts[tk.status] !== undefined) {
          counts[tk.status] += 1;
        }
      });
      filterButtons.forEach(function (entry, status) {
        const active = state.filterStatus === status;
        attr(entry.node, 'aria-pressed', active ? 'true' : 'false');
        setText(entry.count, fmtInt(counts[status]));
        // A status with nothing in it is not offered, unless it is the active filter.
        show(entry.node, status === 'all' || counts[status] > 0 || active);
      });

      // Which CLIs ran the listed tasks. One CLI: no row, and no filter left behind on it.
      const ran = new Map();
      m.tasks.forEach(function (tk) {
        const id = taskProvider(tk);
        const hit = ran.get(id);
        if (hit) {
          hit.count += 1;
        } else {
          ran.set(id, { id: id, label: providerName(id, null), count: 1 });
        }
      });
      const several = ran.size > 1;
      if (state.filterProvider !== null && !(several && ran.has(state.filterProvider))) {
        state.filterProvider = null;
        persist();
      }
      show(providerRow, several);
      syncList(
        providerChips,
        providerPool,
        assignDomKeys(
          several ? Array.from(ran.values()).sort(function (x, y) { return providerRank(x.id) - providerRank(y.id); }) : [],
          'id',
        ),
        ProviderChip,
      );

      let matched = 0;
      let shown = 0;
      m.tasks.forEach(function (tk) {
        const comp = pool.get(tk.dom);
        if (!comp) {
          return;
        }
        const hit = comp.matches(state.filterStatus, needle, state.filterProvider);
        if (hit) {
          matched += 1;
        }
        const visible = hit && shown < state.taskLimit;
        if (visible) {
          shown += 1;
        }
        show(comp.root, visible);
      });

      const filtered = state.filterStatus !== 'all' || needle !== '' || state.filterProvider !== null;
      const none = matched === 0;
      show(listEl, !none);
      show(columns, !none);
      show(emptyBox, none);
      if (none) {
        if (m.tasks.length === 0) {
          setText(emptyTitle, m.scope === 'all' ? t('tasksEmptyTitleAll') : t('tasksEmptyTitle'));
          setText(emptyBody, t('tasksEmptyBody'));
        } else {
          setText(emptyTitle, t('tasksNoMatchTitle'));
          setText(emptyBody, t('tasksNoMatchBody'));
        }
        show(clearFilter, m.tasks.length > 0);
        show(showAll, m.tasks.length === 0 && m.scope !== 'all' && m.workspace !== null);
      }
      show(filters, m.tasks.length > 0);

      const hiddenCount = matched - shown;
      show(more, hiddenCount > 0);
      setButtonLabel(more, t('tasksShowMore', fmtInt(Math.min(50, hiddenCount)), fmtInt(hiddenCount)));
      setText(resultNote, filtered && !none ? t('filterResult', fmtInt(matched), fmtInt(m.tasks.length)) : '');
      const capped = m.taskTotal !== null && m.taskTotal > m.tasks.length;
      show(capNote, capped);
      if (capped) {
        setText(capNote, t('tasksCapped', fmtInt(m.tasks.length), fmtInt(m.taskTotal)));
      }
      show(foot, hiddenCount > 0 || capped);
    }

    return {
      root: root,
      update: function (m) {
        const sig = JSON.stringify([m.tasks, m.taskTotal, m.scope, m.health.taskLogProblem, m.running, m.settings.providers]);
        chart.update(m);
        if (sig === lastSig) {
          return;
        }
        lastSig = sig;
        model = m;

        const broken = m.health.taskLogProblem !== null;
        show(problem.root, broken);
        show(body, !broken);
        if (broken) {
          problem.set(t('taskLogTitle'), t('taskLogBody', m.health.taskLogProblem));
          head.set('', scopeText(m), '');
          return;
        }
        const runningNow = m.scope === 'all' ? m.running.all : m.running.workspace;
        const total = m.taskTotal === null ? m.tasks.length : m.taskTotal;
        head.set(fmtCount(total), scopeText(m), runningNow !== null && runningNow > 0 ? t('activityRunning', fmtCount(runningNow)) : '');

        keepFocus(function () {
          syncList(listEl, pool, m.tasks, TaskRow);
          applyFilter();
        });
      },
    };
  }

  /* ======================================================================= *
   * 9. Settings drawer
   * ======================================================================= */

  /**
   * One setting control. `kind`: select | text | int | toggle | guard.
   * The control shows what the user chose while a save is in flight, and what the HOST says
   * is in effect once it answers - never an optimistic "saved".
   */
  function Field(key, kind, opts) {
    const id = uid('set');
    const statusEl = h('span', { class: 'field-status', role: 'status' });
    const hint = h('p', { class: 'field-hint', id: id + '-hint' });
    const extra = h('p', { class: 'field-extra' });
    let control;
    let segmented = null;
    let stateLabel = null;
    let invalid = false;
    let statusTimer = null;

    function setStatus(kindOfStatus, text) {
      clearTimeout(statusTimer);
      setText(statusEl, text);
      attr(statusEl, 'data-state', kindOfStatus || null);
      if (kindOfStatus === 'saved') {
        statusTimer = setTimeout(function () {
          setText(statusEl, '');
          attr(statusEl, 'data-state', null);
        }, 3500);
      }
    }

    function read() {
      if (kind === 'toggle') {
        return control.checked;
      }
      return control.value;
    }
    function write(value) {
      if (value === null || value === undefined) {
        return;
      }
      if (kind === 'toggle') {
        if (control.checked !== (value === true)) {
          control.checked = value === true;
        }
        setText(stateLabel, value === true ? t('on') : t('off'));
      } else if (kind === 'guard') {
        segmented.set(value);
      } else if (String(control.value) !== String(value)) {
        control.value = String(value);
      }
    }
    // A value the page itself rejects is never sent; it stays in the box, marked, until the
    // user corrects it (a refresh must not silently replace what they are fixing).
    function markInvalid(message) {
      invalid = true;
      attr(control, 'aria-invalid', 'true');
      setStatus('failed', message);
      announce(message);
    }
    function markValid() {
      invalid = false;
      attr(control, 'aria-invalid', null);
    }
    function commit() {
      if (kind === 'int') {
        const raw = control.value.trim();
        const n = /^\d{1,7}$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isInteger(n) || n < opts.min || n > opts.max) {
          markInvalid(t('fieldIntRange', opts.min, opts.max));
          return;
        }
        markValid();
        sendSetting(key, n);
      } else if (kind === 'text') {
        const text = control.value.trim();
        if (text === '') {
          markInvalid(t('fieldTextEmpty'));
          return;
        }
        markValid();
        sendSetting(key, text);
      } else if (kind === 'toggle') {
        setText(stateLabel, control.checked ? t('on') : t('off'));
        sendSetting(key, control.checked);
      } else {
        sendSetting(key, read());
      }
    }

    let row;
    if (kind === 'toggle') {
      control = h('input', { type: 'checkbox', class: 'switch', id: id, role: 'switch', 'aria-describedby': id + '-hint' });
      stateLabel = h('span', { class: 'switch-state', 'aria-hidden': 'true' });
      on(control, 'change', commit);
      row = h('div', { class: 'field field-toggle' }, [
        h('div', { class: 'field-line' }, [h('label', { class: 'field-label', for: id, text: opts.label }), h('span', { class: 'switch-box' }, [stateLabel, control])]),
        hint,
        extra,
        statusEl,
      ]);
    } else if (kind === 'guard') {
      segmented = Segmented(
        opts.label,
        [
          { value: 'block', label: t('guardBlock') },
          { value: 'allow', label: t('guardAllow') },
        ],
        function (value) {
          sendSetting(key, value);
        },
      );
      control = segmented.root;
      row = h('div', { class: 'field' }, [h('div', { class: 'field-line' }, [h('span', { class: 'field-label', text: opts.label }), segmented.root]), hint, extra, statusEl]);
    } else {
      if (kind === 'select') {
        control = h('select', { class: 'input', id: id, 'aria-describedby': id + '-hint' });
      } else if (kind === 'int') {
        control = h('input', { type: 'number', class: 'input input-num', id: id, min: String(opts.min), max: String(opts.max), step: '1', inputmode: 'numeric', 'aria-describedby': id + '-hint' });
      } else {
        control = h('input', { type: 'text', class: 'input input-mono', id: id, spellcheck: 'false', autocomplete: 'off', 'aria-describedby': id + '-hint' });
      }
      on(control, 'change', commit);
      row = h('div', { class: 'field' }, [h('label', { class: 'field-label', for: id, text: opts.label }), control, hint, extra, statusEl]);
    }
    setText(hint, opts.hint || '');
    show(hint, Boolean(opts.hint));
    show(extra, false);

    watchSetting(key, function (status) {
      setStatus(status.state, status.text);
      toggleClass(row, 'is-saving', status.state === 'saving');
      if (status.state === 'saving') {
        return;
      }
      const typed = kind === 'text' || kind === 'int';
      if (typed && status.state === 'failed') {
        // The host refused what was typed. Keep it in the box, marked, so it can be corrected
        // rather than retyped; the message says it was not saved.
        invalid = true;
        attr(control, 'aria-invalid', 'true');
        return;
      }
      if (typed) {
        markValid();
      }
      // Show what is now in effect - unless the user has already typed something newer.
      if (status.value !== undefined && !(typed && document.activeElement === control)) {
        write(status.value);
      }
    });

    return {
      root: row,
      control: control,
      extra: extra,
      focus: function () {
        if (kind === 'guard') {
          const checked = control.querySelector('input:checked') || control.querySelector('input');
          if (checked) {
            checked.focus();
          }
        } else {
          control.focus();
        }
      },
      /** Options for a select; rebuilt only when the list changes and the control is idle. */
      setOptions: function (values, labelOf) {
        const sig = values.join('\n');
        if (control.getAttribute('data-options') === sig || document.activeElement === control) {
          return;
        }
        control.setAttribute('data-options', sig);
        const keep = control.value;
        clear(control);
        values.forEach(function (value) {
          control.appendChild(h('option', { value: value, text: labelOf ? labelOf(value) : value }));
        });
        control.value = keep;
      },
      /** A value from the model. Ignored while a save is pending or the user is editing. */
      setFromModel: function (value) {
        const editing = (kind === 'text' || kind === 'int') && document.activeElement === control;
        if (pendingSettings.has(key) || editing || invalid) {
          return;
        }
        write(value);
      },
      setExtra: function (text, warn) {
        setText(extra, text || '');
        show(extra, Boolean(text));
        toggleClass(extra, 'is-warn', Boolean(warn));
      },
    };
  }

  function SetupRow(label, hintText, onRun) {
    const slot = iconSlot('blank', 'setup-mark');
    const stateText = h('span', { class: 'setup-state' });
    const action = button({ label: '', cls: 'btn-small' }, onRun);
    const root = h('div', { class: 'setup-row' }, [
      slot,
      h('div', { class: 'setup-copy' }, [h('strong', { class: 'setup-label', text: label }), h('p', { class: 'field-hint', text: hintText }), stateText]),
      action,
    ]);
    return {
      root: root,
      /**
       * `installed`: true / false / null (no folder open). `staleLabel`, when given: what is
       * installed is not this version's text, and this is what the action that replaces it says.
       */
      set: function (installed, doLabel, redoLabel, staleLabel) {
        const stale = installed === true && typeof staleLabel === 'string';
        setIcon(slot, stale ? 'alert' : installed === true ? 'check' : installed === false ? 'alert' : 'blank');
        attr(root, 'data-state', stale ? 'stale' : installed === true ? 'done' : installed === false ? 'todo' : 'na');
        setText(stateText, stale ? t('setupOutdated') : installed === true ? t('setupDone') : installed === false ? t('setupMissing') : t('setupNoWorkspace'));
        setButtonLabel(action, stale ? staleLabel : installed === true ? redoLabel : doLabel);
        toggleClass(action, 'btn-primary', installed === false || stale);
        action.disabled = installed === null;
      },
    };
  }

  /**
   * What each CLI supports, as the settings describe it: a second, separate login (yes / not
   * verified / no) and session workers (yes / no). Display only - rebuilt when the list changes.
   */
  function ProviderTable() {
    const body = h('tbody');
    const root = h('table', { class: 'prov-table' }, [
      h('caption', { class: 'vh', text: t('provTableCaption') }),
      h('thead', null, [
        h('tr', null, [
          h('th', { scope: 'col', text: t('provColProvider') }),
          h('th', { scope: 'col', text: t('provColLogins') }),
          h('th', { scope: 'col', text: t('provColSessions') }),
        ]),
      ]),
      body,
    ]);
    function cell(level, text, tip) {
      const mark = level === 'yes' ? 'check' : level === 'no' ? 'cancelled' : 'unknown';
      return h('td', null, [h('span', { class: 'cap is-' + level, title: tip }, [icon(mark), h('span', { text: text })])]);
    }
    let lastSig = null;
    return {
      root: root,
      set: function (providers) {
        const sig = JSON.stringify(providers);
        if (sig === lastSig) {
          return;
        }
        lastSig = sig;
        clear(body);
        providers.forEach(function (p) {
          const logins =
            p.isolation === 'env'
              ? p.isolationVerified
                ? cell('yes', t('provYes'), t('provLoginsYesTip'))
                : cell('unverified', t('provUnverified'), t('provLoginsUnverifiedTip'))
              : p.isolation === 'none'
                ? cell('no', t('provNo'), t('provLoginsNoTip'))
                : h('td', { text: DASH });
          const sessions = p.sessionWorkers ? cell('yes', t('provYes'), t('provSessionsYesTip')) : cell('no', t('provNo'), t('provSessionsNoTip'));
          body.appendChild(
            h('tr', null, [
              h('th', { scope: 'row' }, [h('span', { class: 'prov-table-name' }, [icon(providerSigil(p.id)), h('span', { text: p.label !== null ? p.label : p.id })])]),
              logins,
              sessions,
            ]),
          );
        });
        show(root, providers.length > 0);
      },
    };
  }

  function Drawer() {
    const titleId = uid('drawer');
    let returnFocus = null;
    let opened = false;

    function command(id) {
      return function () {
        post({ type: 'command', id: id });
      };
    }

    const fields = {
      workerPermissionMode: Field('workerPermissionMode', 'select', { label: t('setPermission'), hint: t('setPermissionHint') }),
      claudePath: Field('claudePath', 'text', { label: t('setClaudePath'), hint: t('setClaudePathHint') }),
      workerTimeoutMinutes: Field('workerTimeoutMinutes', 'int', { label: t('setTaskTimeout'), hint: t('setTaskTimeoutHint'), min: 1, max: 480 }),
      quotaCooldownMinutes: Field('quotaCooldownMinutes', 'int', { label: t('setCooldown'), hint: t('setCooldownHint'), min: 1, max: 1440 }),
      sessionKeepalive: Field('sessionKeepalive', 'toggle', { label: t('setKeepalive'), hint: t('setKeepaliveHint') }),
      frontierWorkerDispatch: Field('frontierWorkerDispatch', 'guard', { label: t('setFrontier'), hint: t('setFrontierHint') }),
      overageWorkerDispatch: Field('overageWorkerDispatch', 'guard', { label: t('setOverage'), hint: t('setOverageHint') }),
      meshMode: Field('meshMode', 'toggle', { label: t('setMesh'), hint: t('setMeshHint') }),
      meshMaxLiveWorkers: Field('meshMaxLiveWorkers', 'int', { label: t('setMeshCap'), hint: t('setMeshCapHint'), min: 1, max: 64 }),
      meshHistoryLimit: Field('meshHistoryLimit', 'int', { label: t('setMeshHistory'), hint: t('setMeshHistoryHint'), min: 1, max: 1000 }),
      providerUsagePolling: Field('providerUsagePolling', 'toggle', { label: t('setProviderPolling'), hint: t('setProviderPollingHint') }),
    };
    const providerTable = ProviderTable();

    const setupMcp = SetupRow(t('setupMcp'), t('setupMcpHint'), command('installMcp'));
    const setupPolicy = SetupRow(t('setupPolicy'), t('setupPolicyHint'), command('addDispatchPolicy'));
    const setupAgent = SetupRow(t('setupAgent'), t('setupAgentHint'), command('installTeamAgent'));
    // Everything the rows above install, looked at and brought up to date in one step.
    const setupWorkspace = button({ label: t('setupWorkspace'), icon: 'refresh', title: t('setupWorkspaceTip') }, command('updateWorkspaceSetup'));

    const cancelAll = button({ label: t('dangerCancelAll'), cls: 'btn-danger' }, command('cancelAllTasks'));
    const clearTasks = button({ label: t('dangerClearTasks'), cls: 'btn-danger' }, command('clearTasks'));
    // One press, like its two neighbours: the host asks before it forgets anything.
    const resetCheckin = button({ label: t('dangerResetCheckin'), cls: 'btn-danger' }, command('resetCheckin'));

    function group(title, note, kids) {
      const id = uid('grp');
      return h('section', { class: 'group', 'aria-labelledby': id }, [
        h('h3', { class: 'group-title', id: id, text: title }),
        note ? h('p', { class: 'group-note', text: note }) : null,
        kids,
      ]);
    }
    function dangerRow(node, text) {
      return h('div', { class: 'danger-row' }, [h('p', { class: 'field-hint', text: text }), node]);
    }

    const close = button({ label: t('drawerClose'), icon: 'x', iconOnly: true }, function () {
      api.close();
    });
    const panel = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, [
      h('header', { class: 'drawer-head' }, [h('h2', { class: 'drawer-title', id: titleId, text: t('settings') }), close]),
      h('div', { class: 'drawer-body' }, [
        group(t('groupDispatch'), null, [
          fields.workerPermissionMode.root,
          fields.claudePath.root,
          fields.workerTimeoutMinutes.root,
          fields.quotaCooldownMinutes.root,
          fields.sessionKeepalive.root,
        ]),
        group(t('groupGuards'), t('groupGuardsNote'), [fields.frontierWorkerDispatch.root, fields.overageWorkerDispatch.root]),
        group(t('groupSession'), t('groupSessionNote'), [fields.meshMode.root, fields.meshMaxLiveWorkers.root, fields.meshHistoryLimit.root]),
        group(t('groupProviders'), t('groupProvidersNote'), [
          fields.providerUsagePolling.root,
          providerTable.root,
          // The same command as "Add worker account": its first question is which CLI.
          h('div', { class: 'setup-actions' }, [button({ label: t('addWorkerOther'), icon: 'plus' }, command('addWorker'))]),
        ]),
        group(t('groupSetup'), null, [
          setupMcp.root,
          setupPolicy.root,
          setupAgent.root,
          h('div', { class: 'setup-actions' }, [
            setupWorkspace,
            button({ label: t('addWorker'), icon: 'plus' }, command('addWorker')),
            button({ label: t('importWorkers') }, command('importWorkers')),
            button({ label: t('manageAssets') }, command('openAssetManager')),
            button({ label: t('cleanLitter'), title: t('cleanLitterTip') }, command('cleanSessionLitter')),
            button({ label: t('openSettings'), icon: 'external' }, command('openSettings')),
          ]),
        ]),
        h('section', { class: 'group group-danger', 'aria-label': t('groupDanger') }, [
          h('h3', { class: 'group-title', text: t('groupDanger') }),
          dangerRow(cancelAll, t('dangerCancelAllHint')),
          dangerRow(clearTasks, t('dangerClearTasksHint')),
          dangerRow(resetCheckin, t('dangerResetCheckinHint')),
        ]),
      ]),
    ]);
    const scrim = h('div', { class: 'scrim' });
    const root = h('div', { class: 'drawer-layer', hidden: true }, [scrim, panel]);
    on(scrim, 'click', function () {
      api.close();
    });

    function focusables() {
      const nodes = panel.querySelectorAll('button, input, select, textarea, [tabindex="0"]');
      const out = [];
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (!node.disabled && !node.hidden && node.offsetParent !== null) {
          out.push(node);
        }
      }
      return out;
    }
    on(panel, 'keydown', function (event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        api.close();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const nodes = focusables();
      if (nodes.length === 0) {
        event.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    function guardNote(field, guard) {
      if (guard.effective === null) {
        field.setExtra('', false);
        return;
      }
      const effective = guard.effective === 'allow' ? t('guardAllow') : t('guardBlock');
      if (guard.value !== null && guard.effective !== guard.value) {
        field.setExtra(guard.setBy === null ? t('guardMismatch', effective) : t('guardMismatchBy', effective, guard.setBy), true);
      } else {
        field.setExtra(t('guardInEffect', effective), false);
      }
    }

    const api = {
      root: root,
      isOpen: function () {
        return opened;
      },
      /** `from` gets the focus back on close; `focusKey` names a setting to land on. */
      open: function (from, focusKey) {
        returnFocus = from || document.activeElement;
        opened = true;
        show(root, true);
        app.main.inert = true;
        // Next frame, so the opening transition has a starting state to run from.
        requestAnimationFrame(function () {
          root.classList.add('is-open');
        });
        const target = focusKey && fields[focusKey] ? fields[focusKey] : null;
        if (target) {
          target.focus();
          try {
            target.root.scrollIntoView({ block: 'center' });
          } catch (e) {
            /* fine where it is */
          }
        } else {
          close.focus();
        }
      },
      close: function () {
        if (!opened) {
          return;
        }
        opened = false;
        root.classList.remove('is-open');
        app.main.inert = false;
        show(root, false);
        if (returnFocus && returnFocus.isConnected) {
          try {
            returnFocus.focus();
          } catch (e) {
            /* the opener is gone */
          }
        }
        returnFocus = null;
      },
      update: function (m) {
        const s = m.settings;
        const modes = s.permissionModes.slice();
        if (s.workerPermissionMode !== null && modes.indexOf(s.workerPermissionMode) === -1) {
          modes.push(s.workerPermissionMode);
        }
        fields.workerPermissionMode.setOptions(modes);
        fields.workerPermissionMode.setFromModel(s.workerPermissionMode);
        fields.workerPermissionMode.setExtra(s.workerPermissionMode === 'bypassPermissions' ? t('setPermissionBypassNote') : '', true);
        fields.claudePath.setFromModel(s.claudePath);
        fields.claudePath.setExtra(
          m.health.claudeVersion === null ? t('setClaudePathUnreadable') : t('setClaudePathVersion', m.health.claudeVersion),
          m.health.claudeVersion === null,
        );
        fields.workerTimeoutMinutes.setFromModel(s.workerTimeoutMinutes);
        fields.quotaCooldownMinutes.setFromModel(s.quotaCooldownMinutes);
        fields.sessionKeepalive.setFromModel(s.sessionKeepalive);
        fields.frontierWorkerDispatch.setFromModel(s.frontierWorkerDispatch.value);
        guardNote(fields.frontierWorkerDispatch, s.frontierWorkerDispatch);
        fields.overageWorkerDispatch.setFromModel(s.overageWorkerDispatch.value);
        guardNote(fields.overageWorkerDispatch, s.overageWorkerDispatch);
        fields.meshMode.setFromModel(s.meshMode);
        fields.meshMode.setExtra(
          m.health.sessionWorkersSupported === false
            ? t('setMeshUnsupported', m.health.sessionWorkersMinVersion, m.health.claudeVersion === null ? t('versionUnknown') : m.health.claudeVersion)
            : '',
          true,
        );
        fields.meshMaxLiveWorkers.setFromModel(s.meshMaxLiveWorkers);
        fields.meshHistoryLimit.setFromModel(s.meshHistoryLimit);
        fields.providerUsagePolling.setFromModel(s.providerUsagePolling);
        providerTable.set(s.providers);

        setupMcp.set(m.health.mcpInstalled, t('setupRegister'), t('setupRegisterAgain'));
        setupPolicy.set(m.health.policyInstalled, t('setupAdd'), t('setupUpdate'), m.health.policyOutdated === true ? t('setupPolicyUpdate') : undefined);
        setupAgent.set(m.health.teamAgentInstalled, t('setupInstall'), t('setupUpdate'));
        // The first thing to press while the session here cannot dispatch or its policy is old.
        toggleClass(setupWorkspace, 'btn-primary', m.health.canDispatch === false || m.health.policyOutdated === true);
        setupWorkspace.disabled = m.health.canDispatch === null;
        cancelAll.disabled = !(m.running.all !== null && m.running.all > 0);
      },
    };
    return api;
  }

  /* ======================================================================= *
   * 10. Notices from the host
   * ======================================================================= */

  function Toasts() {
    const root = h('div', { class: 'toasts', role: 'region', 'aria-label': t('noticesLabel') });
    const live = [];
    function dismiss(entry) {
      const at = live.indexOf(entry);
      if (at === -1) {
        return;
      }
      live.splice(at, 1);
      clearTimeout(entry.timer);
      if (entry.node.parentNode === root) {
        root.removeChild(entry.node);
      }
    }
    return {
      root: root,
      push: function (level, text) {
        const entry = { node: null, timer: null };
        const close = button({ label: t('noticeDismiss'), icon: 'x', iconOnly: true, cls: 'btn-quiet' }, function () {
          dismiss(entry);
        });
        entry.node = h('div', { class: 'toast is-' + level, role: level === 'error' ? 'alert' : 'status' }, [
          icon(level === 'error' ? 'alert' : level === 'warning' ? 'warn' : 'info'),
          h('p', { class: 'toast-text', text: text }),
          close,
        ]);
        root.appendChild(entry.node);
        live.push(entry);
        while (live.length > 4) {
          dismiss(live[0]);
        }
        if (level === 'info') {
          entry.timer = setTimeout(function () {
            dismiss(entry);
          }, 7000);
        }
      },
    };
  }

  /* ======================================================================= *
   * 11. Page assembly: skeleton -> app, schema guard, messages
   * ======================================================================= */

  const mount = document.getElementById('app') || document.body.appendChild(h('div', { id: 'app' }));
  let app = null;
  let skeletonTimer = null;
  let skeletonNote = null;

  function renderSkeleton() {
    clear(mount);
    attr(mount, 'aria-busy', 'true');
    const card = function () {
      return h('div', { class: 'sk-card' }, [
        h('div', { class: 'sk sk-line w40' }),
        h('div', { class: 'sk sk-line w60' }),
        h('div', { class: 'sk sk-meter' }),
        h('div', { class: 'sk sk-meter' }),
        h('div', { class: 'sk sk-line w80' }),
      ]);
    };
    const late = h('p', { class: 'skeleton-late', role: 'status', hidden: true, text: t('loadingLate') });
    skeletonNote = late;
    mount.appendChild(
      h('div', { class: 'skeleton' }, [
        h('p', { class: 'vh', text: t('loading') }),
        h('div', { class: 'sk-head' }, [h('div', { class: 'sk sk-line w20' }), h('div', { class: 'sk sk-title' }), h('div', { class: 'sk sk-line w40' })]),
        h('div', { class: 'sk-grid' }, [card(), card(), card()]),
        h('div', { class: 'sk-rows' }, [h('div', { class: 'sk sk-row' }), h('div', { class: 'sk sk-row' }), h('div', { class: 'sk sk-row' }), h('div', { class: 'sk sk-row' })]),
        late,
      ]),
    );
    clearTimeout(skeletonTimer);
    skeletonTimer = setTimeout(function () {
      show(late, true);
    }, 8000);
  }

  function renderFatal() {
    if (app) {
      app.drawer.close();
    }
    app = null;
    openMenu = null;
    tickers.clear();
    settingWatchers.clear();
    clearTimeout(skeletonTimer);
    clear(mount);
    attr(mount, 'aria-busy', null);
    mount.appendChild(
      h('div', { class: 'fatal', role: 'alert' }, [
        icon('refresh'),
        h('h1', { class: 'fatal-title', text: t('schemaTitle') }),
        h('p', { class: 'fatal-body', text: t('schemaBody') }),
      ]),
    );
  }

  function mountApp() {
    clearTimeout(skeletonTimer);
    clear(mount);
    attr(mount, 'aria-busy', null);
    const main = h('main', { class: 'page' });
    app = {
      main: main,
      header: Header(),
      health: HealthBar(),
      banners: Banners(),
      accounts: AccountsSection(),
      team: TeamSection(),
      activity: ActivitySection(),
      drawer: Drawer(),
      toasts: Toasts(),
    };
    append(main, [
      h('div', { class: 'masthead' }, [app.header.root, app.health.root]),
      app.banners.root,
      app.accounts.root,
      app.team.root,
      app.activity.root,
    ]);
    append(mount, [main, app.drawer.root, app.toasts.root, announcer]);
  }

  function applyModel(raw) {
    if (!isObj(raw) || raw.schema !== SCHEMA) {
      renderFatal();
      return;
    }
    const model = normModel(raw);
    if (!app) {
      mountApp();
    }
    state.model = model;
    providerIndex = indexProviders(model);
    app.header.update(model);
    app.health.update(model);
    app.banners.update(model);
    app.accounts.update(model);
    app.team.update(model);
    app.activity.update(model);
    app.drawer.update(model);
  }

  on(window, 'message', function (event) {
    const msg = event.data;
    if (!isObj(msg)) {
      return;
    }
    if (msg.type === 'model') {
      applyModel(msg.model);
    } else if (msg.type === 'settingResult') {
      onSettingResult(msg);
    } else if (msg.type === 'settingPending') {
      onSettingPending(msg);
    } else if (msg.type === 'notice') {
      const text = str(msg.text, 400);
      if (text === null) {
        return;
      }
      if (app) {
        app.toasts.push(pick(msg.level, ['info', 'warning', 'error'], 'info'), text);
      } else if (skeletonNote && skeletonNote.isConnected) {
        // Nothing is mounted yet (the first model failed to build): say so where the eye is.
        clearTimeout(skeletonTimer);
        setText(skeletonNote, text);
        show(skeletonNote, true);
      }
    }
  });

  on(document, 'keydown', function (event) {
    if (event.key === 'Escape' && openMenu) {
      openMenu.close(true);
    }
  });
  on(document, 'visibilitychange', function () {
    if (!document.hidden) {
      tickAll();
    }
  });

  setInterval(tickAll, 1000);
  renderSkeleton();
  post({ type: 'ready' });
})();

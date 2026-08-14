// ==UserScript==
// @name         Courts Creation Medellin
// @namespace    Alpu
// @version      1.2
// @description  Paste the Served Sports coverage plan (Sport / Tournament / Day / Courts / Duration UTC / Covered By / Duration Sofia / Duration Medellin) and turn the Medellin column into numbered per-court shifts plus derived speculative supervisor shifts ([S1]/[S2]/[S3]). Shift types follow the Sport column; Tennis gets the +2h closing extension, with per-tournament and per-row overrides. Review and fix every row before anything is written.
// @match        https://workplan.geniussports.com/admin_work_plan/*
// @grant        none
// @require      https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/Simon-Martinez-v/QOL-Scripts/main/courts-creation.user.js
// @downloadURL  https://raw.githubusercontent.com/Simon-Martinez-v/QOL-Scripts/main/courts-creation.user.js
// ==/UserScript==

(function () {
  'use strict';

  // =========================================================================
  // Config
  // =========================================================================

  const LS_KEY = 'wfm_plan_cfg_v1';

  const OFFICES = {
    Medellin: { utcOffsetMin: -5 * 60, label: 'Medellin (UTC−5)' },
    Sofia:    { utcOffsetMin:  3 * 60, label: 'Sofia (UTC+3, summer)' }
  };

  // Starting point only — the panel re-guesses from the live dropdown and you
  // can override any sport by hand.
  const SPORT_TYPE_SEED = {
    'Tennis': '105',
    'Table Tennis': '106',
    'Badminton': '121',
    'Beach Volleyball': '120',
    'Squash': '107',
    'Pickleball': '122'
  };

  const DEFAULTS = {
    office: 'Medellin',
    year: new Date().getUTCFullYear(),
    userId: '911',
    sportTypes: {},              // sport name -> shift type id
    fallbackTypeId: '74',        // Served Sports Analyst Pre-made shifts
    svTypeId: '76',              // Served Sports Supervisor Pre-made shifts
    category: 'normal',
    force: true,
    inputIsUTC: true,
    // Closing-shift extension
    extendSports: 'Tennis',      // comma separated
    extendMinutes: 120,
    tournamentRules: {},         // normalised tournament name -> 'always' | 'never'
    svUseExtended: true,         // supervisors cover the extended windows too
    // Supervisors
    courtsPerSv: 10,
    svMaxMinutes: 9 * 60,
    svMinMinutes: 4 * 60,
    svMergeGapMin: 120,
    roundToMin: 15,
    makeAnalysts: true,
    makeSupervisors: true,
    // Output
    courtNumbering: 'tournament', // 'tournament' = restart at 1 per tournament, 'day' = running count per day
    analystNote: '{tournament} {i}',
    svNote: '[S{k}] Speculative SV · peak {peak} courts',
    dryRun: true,
    throttleMs: 400,
    maxReadKb: 600
  };

  let cfg = Object.assign({}, DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    cfg = Object.assign(cfg, saved);
    cfg.sportTypes = Object.assign({}, saved.sportTypes || {});
    cfg.tournamentRules = Object.assign({}, saved.tournamentRules || {});
  } catch (e) { /* ignore corrupt config */ }

  function saveCfg() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) { /* quota */ }
  }

  const state = { raw: '', rows: [], plan: null, running: false, abort: false };

  // =========================================================================
  // Small helpers
  // =========================================================================

  const pad = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const stripTags = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

  const MIN_PER_DAY = 1440;

  function dateToAbs(y, m, d) { return Date.UTC(y, m - 1, d) / 60000; }
  function absToParts(abs) {
    const dayStart = Math.floor(abs / MIN_PER_DAY) * MIN_PER_DAY;
    const dt = new Date(dayStart * 60000);
    return {
      date: `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`,
      minutes: abs - dayStart
    };
  }
  function hhmm(min) {
    const m = ((min % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
    return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  }
  function fmtAbs(abs) {
    const p = absToParts(abs);
    return `${p.date.slice(8)}.${p.date.slice(5, 7)} ${hhmm(p.minutes)}`;
  }
  function durH(a, b) { return ((b - a) / 60).toFixed(2); }

  // =========================================================================
  // Parsing
  // =========================================================================

  function parseTSV(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === '\t') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  const RANGE_RE = /(\d{1,2})\s*[:;.h]\s*(\d{2})\s*(?:-|–|—|to)\s*(\d{1,2})\s*[:;.h]\s*(\d{2})/gi;
  const DAY_RE = /^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?$/;
  const OFFICE_RE = /^(both|sofia|medellin|medellín)$/i;

  function parseRanges(cell) {
    const s = String(cell || '').trim();
    if (!s || /^x$/i.test(s)) return [];
    const out = [];
    RANGE_RE.lastIndex = 0;
    let m;
    while ((m = RANGE_RE.exec(s)) !== null) {
      out.push({ start: (+m[1]) * 60 + (+m[2]), end: (+m[3]) * 60 + (+m[4]) });
    }
    return out;
  }

  function normOffice(v) {
    const s = String(v || '').trim().toLowerCase();
    if (s === 'both') return 'Both';
    if (s === 'sofia') return 'Sofia';
    if (s === 'medellin' || s === 'medellín') return 'Medellin';
    return '';
  }

  function parseCoverageRow(cells, idx) {
    const c = cells.map((v) => String(v == null ? '' : v).trim());
    if (!c.some((v) => v !== '')) return null;

    let dayIdx = -1;
    for (let i = 0; i < c.length; i++) { if (DAY_RE.test(c[i])) { dayIdx = i; break; } }
    if (dayIdx < 0) return null;

    let officeIdx = -1;
    for (let i = dayIdx; i < c.length; i++) { if (OFFICE_RE.test(c[i])) { officeIdx = i; break; } }

    const dm = DAY_RE.exec(c[dayIdx]);
    let year = cfg.year;
    if (dm[3]) year = dm[3].length <= 2 ? 2000 + (+dm[3]) : +dm[3];

    const before = c.slice(0, dayIdx).filter((v) => v !== '');
    let courts = null;
    for (let i = dayIdx + 1; i < c.length; i++) {
      if (/^\d{1,3}$/.test(c[i])) { courts = +c[i]; break; }
    }

    const anchor = officeIdx >= 0 ? officeIdx : dayIdx;
    const utcCell = c.slice(dayIdx + 1, anchor).filter((v) => parseRanges(v).length).pop() || '';
    const tail = c.slice(anchor + 1).filter((v) => v !== '' && (/^x$/i.test(v) || parseRanges(v).length));

    const office = officeIdx >= 0 ? normOffice(c[officeIdx]) : '';
    let sofiaCell = tail[0] || '';
    let medCell = tail[1] || '';
    if (tail.length === 1) {
      if (office === 'Medellin') { medCell = tail[0]; sofiaCell = 'x'; }
      else if (office === 'Sofia') { sofiaCell = tail[0]; medCell = 'x'; }
    }

    return {
      id: 'r' + idx,
      lineNo: idx + 1,
      sport: (before[0] || '').trim(),
      tournament: (before[1] || '').trim(),
      dateStr: `${year}-${pad(+dm[2])}-${pad(+dm[1])}`,
      courts,
      office,
      utcCell, sofiaCell, medCell,
      extend: 'auto',       // auto | yes | no
      include: true,
      problems: []
    };
  }

  function rowBase(r) {
    const [y, m, d] = r.dateStr.split('-').map(Number);
    return dateToAbs(y, m, d);
  }
  function toAbsSegs(r, segs) {
    const base = rowBase(r);
    return segs.map((s) => ({
      start: base + s.start,
      end: base + (s.end > s.start ? s.end : s.end + MIN_PER_DAY)
    }));
  }

  function validateRow(r) {
    const problems = [];
    const target = cfg.office;
    const own = target === 'Sofia' ? r.sofiaCell : r.medCell;
    const other = target === 'Sofia' ? r.medCell : r.sofiaCell;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.dateStr)) problems.push('bad date');
    if (!r.courts || r.courts < 1) problems.push('missing or zero courts');
    if (!r.office) problems.push('no office in "Covered By"');

    const ownSegs = parseRanges(own);
    const otherSegs = parseRanges(other);
    const utcSegs = parseRanges(r.utcCell);
    const covers = r.office === 'Both' || r.office === target;

    if (covers && ownSegs.length === 0) {
      problems.push(`marked "${r.office}" but the ${target} cell has no usable time (${own || 'empty'})`);
    }
    if (!covers && ownSegs.length > 0) {
      problems.push(`marked "${r.office}" but the ${target} cell has a time — which is right?`);
    }
    if (r.office === target && ownSegs.length === 1 && utcSegs.length === 1) {
      if (ownSegs[0].start !== utcSegs[0].start || ownSegs[0].end !== utcSegs[0].end) {
        problems.push(`${target}-only row but its window differs from Duration (UTC)`);
      }
    }
    if (r.office === 'Both' && ownSegs.length && otherSegs.length) {
      const all = ownSegs.concat(otherSegs)
        .map((s) => ({ s: s.start, e: s.end > s.start ? s.end : s.end + MIN_PER_DAY }))
        .sort((a, b) => a.s - b.s);
      for (let i = 1; i < all.length; i++) {
        if (all[i].s > all[i - 1].e) {
          problems.push(`handover gap ${hhmm(all[i - 1].e)} → ${hhmm(all[i].s)} between the two offices`);
        }
      }
    }
    ownSegs.forEach((s) => {
      if (s.start === s.end) problems.push(`zero-length window ${hhmm(s.start)}–${hhmm(s.end)}`);
    });

    r.problems = problems;
    r.ownSegs = ownSegs;
    r.otherSegs = otherSegs;
    r.covers = covers;
    return r;
  }

  function parseAll(text) {
    const rows = [];
    parseTSV(text).forEach((line, i) => {
      const r = parseCoverageRow(line, i);
      if (r) rows.push(validateRow(r));
    });
    return rows;
  }

  // =========================================================================
  // Shift type per sport
  // =========================================================================

  function typeSelect() {
    return document.getElementById('shift_type_id') || document.getElementById('multi_shift_type_id');
  }
  function typeOptionsList() {
    const src = typeSelect();
    if (!src) return [];
    return Array.from(src.options).map((o) => ({ value: o.value, text: o.text }));
  }
  function typeLabel(id) {
    const hit = typeOptionsList().find((o) => o.value === String(id));
    return hit ? hit.text : `id ${id}`;
  }

  // "Tennis" -> "Served Sports Tennis". Falls back to the seed table, then to
  // the generic analyst type, so a new sport still lands somewhere sensible.
  function guessTypeForSport(sport) {
    const name = String(sport || '').trim();
    if (!name) return cfg.fallbackTypeId;
    const opts = typeOptionsList();
    const lower = name.toLowerCase();
    const exact = opts.find((o) => o.text.trim().toLowerCase() === `served sports ${lower}`);
    if (exact) return exact.value;
    const loose = opts.find((o) => o.text.trim().toLowerCase() === lower)
      || opts.find((o) => /served sports/i.test(o.text) && o.text.toLowerCase().indexOf(lower) >= 0);
    if (loose) return loose.value;
    if (SPORT_TYPE_SEED[name]) return SPORT_TYPE_SEED[name];
    return cfg.fallbackTypeId;
  }

  function typeForSport(sport) {
    const key = String(sport || '').trim();
    if (cfg.sportTypes[key]) return cfg.sportTypes[key];
    return guessTypeForSport(key);
  }

  function sportsInRows() {
    const seen = [];
    state.rows.forEach((r) => {
      const s = (r.sport || '').trim();
      if (s && seen.indexOf(s) < 0) seen.push(s);
    });
    return seen;
  }

  // =========================================================================
  // Planning
  // =========================================================================

  // Tournament names arrive with stray spacing ("ATP Roehampton 2 Challenger "),
  // so flags are keyed on a normalised form.
  function tKey(name) { return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
  function tournamentRule(name) { return cfg.tournamentRules[tKey(name)] || 'auto'; }
  function setTournamentRule(name, mode) {
    const k = tKey(name);
    if (!k) return;
    if (mode === 'auto') delete cfg.tournamentRules[k];
    else cfg.tournamentRules[k] = mode;
    saveCfg();
  }

  function extendSportList() {
    return String(cfg.extendSports || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  }

  // Medellin extends a court by +2h only when it is the last office on that
  // court. If Sofia picks the court up afterwards, there is nothing to extend.
  function segmentClosing(r, absSeg) {
    const others = toAbsSegs(r, r.otherSegs || []);
    return !others.some((o) => o.end > absSeg.end);
  }

  // Precedence: this row, then this tournament, then the sport + who closes.
  function extensionFor(r, absSeg) {
    const closing = segmentClosing(r, absSeg);
    const handsOver = `hands the court to ${cfg.office === 'Sofia' ? 'Medellin' : 'Sofia'}`;

    if (r.extend === 'no') return { minutes: 0, reason: 'row set to never', closing, source: 'row' };
    if (r.extend === 'yes') return { minutes: cfg.extendMinutes, reason: 'row set to always', closing, source: 'row' };

    const tr = tournamentRule(r.tournament);
    if (tr === 'never') return { minutes: 0, reason: 'tournament set to never', closing, source: 'tournament' };
    if (tr === 'always') return { minutes: cfg.extendMinutes, reason: 'tournament set to always', closing, source: 'tournament' };

    const sportMatch = extendSportList().indexOf(String(r.sport || '').trim().toLowerCase()) >= 0;
    if (!sportMatch) return { minutes: 0, reason: `${r.sport || 'sport'} is not on the extension list`, closing, source: 'sport' };
    if (!closing) return { minutes: 0, reason: handsOver, closing, source: 'handover' };
    return { minutes: cfg.extendMinutes, reason: 'closes the court', closing, source: 'auto' };
  }

  // What the automatic rules alone would do, ignoring any flag.
  function autoExtension(r) {
    const segs = toAbsSegs(r, r.ownSegs || []);
    if (!segs.length) return { minutes: 0, reason: 'no window' };
    const last = segs[segs.length - 1];
    const sportMatch = extendSportList().indexOf(String(r.sport || '').trim().toLowerCase()) >= 0;
    if (!sportMatch) return { minutes: 0, reason: 'sport not listed' };
    if (!segmentClosing(r, last)) return { minutes: 0, reason: 'handed over' };
    return { minutes: cfg.extendMinutes, reason: 'closes the court' };
  }

  function roundTo(abs, mode) {
    const step = Math.max(1, cfg.roundToMin | 0);
    if (mode === 'down') return Math.floor(abs / step) * step;
    if (mode === 'up') return Math.ceil(abs / step) * step;
    return Math.round(abs / step) * step;
  }

  function buildPlan(rows) {
    const active = rows.filter((r) => r.include && r.covers && (r.ownSegs || []).length && r.courts > 0);
    const warnings = [];
    const analyst = [];
    const segs = [];
    const dayCounter = {};

    active.slice().sort((a, b) => (a.dateStr < b.dateStr ? -1 : a.dateStr > b.dateStr ? 1 : a.lineNo - b.lineNo))
      .forEach((r) => {
        toAbsSegs(r, r.ownSegs).forEach((seg, si) => {
          const ext = extensionFor(r, seg);
          const end = seg.end + ext.minutes;
          r.extApplied = ext;

          segs.push({ start: seg.start, end: cfg.svUseExtended ? end : seg.end, courts: r.courts, row: r });
          if (!cfg.makeAnalysts) return;

          let first = 1;
          if (cfg.courtNumbering === 'day') {
            const key = r.dateStr;
            first = (dayCounter[key] || 0) + 1;
            dayCounter[key] = first + r.courts - 1;
          }
          for (let n = 0; n < r.courts; n++) {
            const i = first + n;
            analyst.push({
              kind: 'analyst',
              row: r,
              typeId: typeForSport(r.sport),
              start: seg.start,
              end,
              extMinutes: ext.minutes,
              extReason: ext.reason,
              note: cfg.analystNote
                .replace('{sport}', r.sport)
                .replace('{tournament}', r.tournament)
                .replace('{i}', String(i))
                .replace('{n}', String(r.courts))
                .replace('{seg}', String(si + 1))
                .replace('{date}', r.dateStr)
            });
          }
        });
      });

    const points = Array.from(new Set(segs.reduce((acc, s) => acc.concat([s.start, s.end]), []))).sort((a, b) => a - b);
    const demand = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i], b = points[i + 1];
      const courts = segs.reduce((sum, s) => sum + (s.start <= a && s.end >= b ? s.courts : 0), 0);
      demand.push({ a, b, courts });
    }

    const peakCourts = demand.reduce((m, d) => Math.max(m, d.courts), 0);
    const maxLevel = Math.ceil(peakCourts / Math.max(1, cfg.courtsPerSv));
    const sv = [];

    if (cfg.makeSupervisors) {
      for (let k = 1; k <= maxLevel; k++) {
        const windows = [];
        demand.forEach((d) => {
          if (Math.ceil(d.courts / cfg.courtsPerSv) < k) return;
          const last = windows[windows.length - 1];
          if (last && d.a - last.end <= cfg.svMergeGapMin) last.end = d.b;
          else windows.push({ start: d.a, end: d.b });
        });

        windows.forEach((w) => {
          const total = w.end - w.start;
          const parts = Math.max(1, Math.ceil(total / cfg.svMaxMinutes));
          const step = total / parts;
          for (let i = 0; i < parts; i++) {
            let s = i === 0 ? roundTo(w.start, 'down') : roundTo(w.start + step * i, 'near');
            let e = i === parts - 1 ? roundTo(w.end, 'up') : roundTo(w.start + step * (i + 1), 'near');
            const flags = [];
            if (e - s < cfg.svMinMinutes) { e = s + cfg.svMinMinutes; flags.push('padded to minimum length'); }
            if (e - s > cfg.svMaxMinutes) flags.push('over maximum length after rounding');
            const peak = demand.reduce((m, d) => (d.a < e && d.b > s ? Math.max(m, d.courts) : m), 0);
            sv.push({
              kind: 'sv',
              level: k,
              part: parts > 1 ? `${i + 1}/${parts}` : '',
              typeId: cfg.svTypeId,
              start: s, end: e, peak, flags,
              note: cfg.svNote
                .replace('{k}', String(k))
                .replace('{peak}', String(peak))
                .replace('{part}', parts > 1 ? ` (${i + 1}/${parts})` : '')
            });
          }
        });
      }
    }

    sv.forEach((s) => s.flags.forEach((f) => warnings.push(`[S${s.level}] ${fmtAbs(s.start)} — ${f}`)));
    rows.filter((r) => r.include && r.problems.length).forEach((r) => {
      warnings.push(`Line ${r.lineNo} (${r.tournament} ${r.dateStr}) still flagged: ${r.problems.join('; ')}`);
    });
    const flagged = {};
    active.forEach((r) => {
      const tr = tournamentRule(r.tournament);
      if (tr !== 'auto') flagged[r.tournament.trim()] = tr;
    });
    Object.keys(flagged).forEach((t) => {
      warnings.push(`"${t}" is flagged ${flagged[t]} for the ${cfg.extendMinutes} min extension`);
    });
    const unmapped = sportsInRows().filter((s) => typeForSport(s) === cfg.fallbackTypeId);
    unmapped.forEach((s) => warnings.push(`No sport-specific shift type for "${s}" — using ${typeLabel(cfg.fallbackTypeId)}`));

    const all = analyst.concat(sv).sort((a, b) => a.start - b.start || (a.level || 0) - (b.level || 0));
    return { analyst, sv, all, demand, peakCourts, warnings, rowsUsed: active.length };
  }

  function toLocalFields(item) {
    const shift = cfg.inputIsUTC ? OFFICES[cfg.office].utcOffsetMin : 0;
    const s = absToParts(item.start + shift);
    const e = absToParts(item.end + shift);
    return { date: s.date, start: hhmm(s.minutes), end: hhmm(e.minutes), endDate: e.date };
  }

  // =========================================================================
  // Writing shifts
  // =========================================================================

  function getShiftForm() { return document.querySelector('form#shiftForm, form[action*="save_shift"]'); }

  function buildBody(item) {
    const form = getShiftForm();
    if (!form) return null;

    const params = new URLSearchParams();
    new FormData(form).forEach((v, k) => { if (typeof v === 'string') params.set(k, v); });

    const f = toLocalFields(item);
    params.set('shift_id', '0');
    params.set('shift_type_id', item.typeId || cfg.fallbackTypeId);
    params.set('shift_user_id', cfg.userId);
    params.set('shift_date', f.date);
    params.set('shift_start_time', f.start);
    params.set('shift_end_time', f.end);
    params.set('shift_note', item.note || '');
    params.set('shift_category', cfg.category);
    params.set('force_shift_create', cfg.force ? cfg.userId : '0');
    params.set('until_end', 'no');
    params.set('lunch_break', 'no');
    params.set('training', 'no');
    if (!params.has('eventFK')) params.set('eventFK', '');
    return params.toString();
  }

  async function readMessage(res) {
    const limit = Math.max(64, cfg.maxReadKb) * 1024;
    let text = '';
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      const dec = new TextDecoder('utf-8');
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        text += dec.decode(value, { stream: true });
        const i = text.indexOf('id="main_message"');
        if ((i >= 0 && text.indexOf('</p>', i) > 0) || bytes > limit) {
          try { await reader.cancel(); } catch (e) { /* already closed */ }
          break;
        }
      }
    } else {
      text = await res.text();
    }

    const i = text.indexOf('id="main_message"');
    if (i < 0) return { ok: false, msg: 'no confirmation message in the response' };
    const chunk = text.slice(i, i + 3000);
    const cls = (chunk.match(/class="([^"]*)"/) || [])[1] || '';
    const gt = chunk.indexOf('>');
    const close = chunk.indexOf('</p>');
    const msg = stripTags(chunk.slice(gt + 1, close > gt ? close : gt + 800));
    if (/\bred\b/.test(cls)) return { ok: false, msg: msg || 'rejected' };
    if (/\bblue\b/.test(cls) && msg) return { ok: true, msg };
    if (/success/i.test(msg)) return { ok: true, msg };
    return { ok: false, msg: msg || 'no confirmation message — check the day before re-running' };
  }

  async function createOne(item) {
    const form = getShiftForm();
    if (!form) return { ok: false, msg: 'shift form not on the page — open a Work Plan day view' };
    const body = buildBody(item);
    if (body == null) return { ok: false, msg: 'could not build the request' };
    if (cfg.dryRun) return { ok: true, msg: 'dry run — nothing sent', dry: true, body };
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'follow'
      });
      const out = await readMessage(res);
      if (!res.ok) return { ok: false, msg: `HTTP ${res.status} — ${out.msg}` };
      return out;
    } catch (err) {
      return { ok: false, msg: 'request failed: ' + err.message };
    }
  }

  async function runCreate() {
    if (!state.plan || state.running) return;
    const items = state.plan.all;
    state.running = true;
    state.abort = false;
    setRunUI(true);

    const failures = [];
    let done = 0;
    log(`${cfg.dryRun ? 'Dry run' : 'Creating'}: ${items.length} shift(s) as user ${cfg.userId}.`, 'info');
    if (!cfg.dryRun) log('Existing shifts are not checked — running this twice creates a second copy.', 'warn');

    for (const item of items) {
      if (state.abort) { log('Stopped by you. Remaining shifts were not sent.', 'warn'); break; }
      const f = toLocalFields(item);
      const label = `${f.date} ${f.start}-${f.end} ${typeLabel(item.typeId)} — ${item.note}`;
      const res = await createOne(item);
      done++;
      if (res.ok) log(`✓ ${done}/${items.length} ${label}${res.dry ? ' (dry run)' : ''}`, res.dry ? 'info' : 'success');
      else {
        log(`✗ ${done}/${items.length} ${label} — ${res.msg}`, 'error');
        failures.push({
          Kind: item.kind, Date: f.date, Start: f.start, End: f.end,
          'Shift type': typeLabel(item.typeId), 'Type ID': item.typeId,
          'User ID': cfg.userId, Note: item.note, Error: res.msg
        });
      }
      const bar = document.getElementById('wfm-plan-bar');
      if (bar) bar.style.width = Math.round((done / items.length) * 100) + '%';
      if (!cfg.dryRun && cfg.throttleMs) await new Promise((r) => setTimeout(r, cfg.throttleMs));
    }

    if (failures.length) {
      log(`Finished with ${failures.length} failure(s). Downloading wfm_plan_failures.xlsx.`, 'error');
      exportSheet(failures, 'Failures', `wfm_plan_failures_${Date.now()}.xlsx`);
    } else if (!state.abort) {
      log(cfg.dryRun ? 'Dry run finished. Turn off "Dry run" to write these shifts.' : 'All shifts created.', 'success');
    }
    state.running = false;
    setRunUI(false);
  }

  function exportSheet(rows, sheetName, filename) {
    if (!window.XLSX) { log('SheetJS did not load — export unavailable.', 'error'); return; }
    const ws = window.XLSX.utils.json_to_sheet(rows);
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, sheetName);
    window.XLSX.writeFile(wb, filename);
  }

  function exportPlan() {
    if (!state.plan) return;
    const rows = state.plan.all.map((item) => {
      const f = toLocalFields(item);
      return {
        Kind: item.kind === 'sv' ? `SV [S${item.level}]${item.part ? ' ' + item.part : ''}` : 'Analyst',
        Sport: item.row ? item.row.sport : '',
        Tournament: item.row ? item.row.tournament : '',
        'Shift type': typeLabel(item.typeId),
        'UTC start': fmtAbs(item.start),
        'UTC end': fmtAbs(item.end),
        'Local date': f.date,
        'Local start': f.start,
        'Local end': f.end,
        Hours: durH(item.start, item.end),
        'Extension (min)': item.extMinutes || 0,
        'Extension reason': item.extReason || '',
        'Peak courts': item.peak || (item.row ? item.row.courts : ''),
        Note: item.note
      };
    });
    exportSheet(rows, 'Plan', `wfm_plan_${cfg.office.toLowerCase()}_${Date.now()}.xlsx`);
    log('Downloaded the plan as XLSX.', 'info');
  }

  // =========================================================================
  // Panel
  // =========================================================================

  const PANEL_ID = 'wfm_plan_div';

  function themeColor() {
    const el = document.querySelector('li.title');
    if (!el) return '#2f6f9f';
    const c = getComputedStyle(el).backgroundColor;
    return c && c !== 'rgba(0, 0, 0, 0)' ? c : '#2f6f9f';
  }

  function log(msg, level) {
    const box = document.getElementById('wfm-plan-log');
    if (box) {
      const colors = { success: '#0a0', error: '#c00', info: '#06c', warn: '#c80' };
      const line = document.createElement('div');
      line.style.color = colors[level] || '#555';
      line.textContent = msg;
      box.appendChild(line);
      box.scrollTop = box.scrollHeight;
    }
    console.log('[WFM Plan] ' + msg);
  }

  function setRunUI(running) {
    const run = document.getElementById('wfm-plan-run');
    const stop = document.getElementById('wfm-plan-stop');
    if (run) run.disabled = running;
    if (stop) stop.style.display = running ? 'inline-block' : 'none';
  }

  function typeOptionsHtml(selected) {
    const opts = typeOptionsList();
    if (!opts.length) return `<option value="${esc(selected)}">id ${esc(selected)}</option>`;
    return opts.map((o) =>
      `<option value="${esc(o.value)}"${o.value === String(selected) ? ' selected' : ''}>${esc(o.text)}</option>`).join('');
  }

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return true;
    const shiftForm = getShiftForm();
    if (!shiftForm) return false;

    const accent = themeColor();

    const sidebar = document.getElementById('wfm-tools-section');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-wfm-plan', 'button');
    btn.title = 'Turn a coverage plan into shifts';
    btn.innerHTML = `<img src="https://workplan.geniussports.com/img/page_excel.png" /> <span class="bold uppercase">Coverage plan</span>`;
    btn.addEventListener('click', () => {
      const p = document.getElementById(PANEL_ID);
      if (p) p.classList.toggle('hidden');
    });
    if (sidebar) sidebar.appendChild(btn);
    else {
      const anchor = Array.from(document.querySelectorAll('button'))
        .find((b) => /Create Multiple Shifts|Create shifts/i.test(b.title || ''));
      if (anchor) anchor.insertAdjacentElement('afterend', btn);
      else document.body.appendChild(btn);
    }

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'form_div hidden';
    panel.setAttribute('data-wfm-plan', 'panel');
    panel.style.cssText = 'max-width:960px; position:relative; z-index:50;';
    panel.innerHTML = `
      <h3 style="border-bottom:2px solid ${accent};">Coverage plan → shifts
        <span class="float_right">
          <img alt="Hide" title="Hide" src="https://workplan.geniussports.com/img/cancel.png" class="pointer" id="wfm-plan-hide" />
        </span>
      </h3>

      <p style="font-size:11px;">
        Paste the plan rows straight from Excel (tab separated). Columns are found by content, so blank
        spacer columns and empty <em>Prepared</em> columns are fine.
      </p>
      <textarea id="wfm-plan-input" rows="6" style="width:100%; font-family:monospace; font-size:11px;"
        placeholder="Tennis&#9;&#9;ATP Cincinnati&#9;&#9;17.08&#9;6&#9;14:30 - 03:00&#9;&#9;Medellin&#9;&#9;&#9;x&#9;14:30 - 03:00"></textarea>

      <div style="display:flex; gap:14px; flex-wrap:wrap; font-size:11px; margin-top:6px;">
        <label>Office
          <select id="wfm-plan-office">${Object.keys(OFFICES).map((k) =>
            `<option value="${k}"${k === cfg.office ? ' selected' : ''}>${esc(OFFICES[k].label)}</option>`).join('')}</select>
        </label>
        <label>Year <input id="wfm-plan-year" type="number" value="${cfg.year}" style="width:60px;"/></label>
        <label>User ID <input id="wfm-plan-user" value="${esc(cfg.userId)}" style="width:60px;"/></label>
        <label><input type="checkbox" id="wfm-plan-utc" ${cfg.inputIsUTC ? 'checked' : ''}/> Times are UTC → convert to office local</label>
        <label><input type="checkbox" id="wfm-plan-force" ${cfg.force ? 'checked' : ''}/> Force past/conflicting shifts</label>
      </div>

      <div style="font-size:11px; margin-top:6px; padding:6px; background:#f7f7f7; border:1px solid #ddd;">
        <div style="display:flex; gap:14px; flex-wrap:wrap; align-items:center;">
          <strong>Closing extension</strong>
          <label>Sports <input id="wfm-plan-extsports" value="${esc(cfg.extendSports)}" style="width:150px;"/></label>
          <label>Minutes <input id="wfm-plan-extmin" type="number" value="${cfg.extendMinutes}" style="width:50px;"/></label>
          <label><input type="checkbox" id="wfm-plan-svext" ${cfg.svUseExtended ? 'checked' : ''}/> Supervisors cover the extension</label>
        </div>
        <div style="color:#666; margin-top:3px;">
          Added only when this office is last on the court. A court handed over to the other office is not extended.
        </div>
      </div>

      <div style="display:flex; gap:14px; flex-wrap:wrap; font-size:11px; margin-top:6px; padding:6px; background:#f7f7f7; border:1px solid #ddd;">
        <label><input type="checkbox" id="wfm-plan-mkanalyst" ${cfg.makeAnalysts ? 'checked' : ''}/> One shift per court</label>
        <label>Court numbers
          <select id="wfm-plan-numbering">
            <option value="tournament"${cfg.courtNumbering === 'tournament' ? ' selected' : ''}>restart per tournament</option>
            <option value="day"${cfg.courtNumbering === 'day' ? ' selected' : ''}>running count per day</option>
          </select>
        </label>
        <label>Note <input id="wfm-plan-anote" value="${esc(cfg.analystNote)}" style="width:170px;"/></label>
        <label><input type="checkbox" id="wfm-plan-mksv" ${cfg.makeSupervisors ? 'checked' : ''}/> Speculative supervisors</label>
        <label>Courts per SV <input id="wfm-plan-cps" type="number" value="${cfg.courtsPerSv}" style="width:45px;"/></label>
        <label>SV min h <input id="wfm-plan-svmin" type="number" step="0.25" value="${cfg.svMinMinutes / 60}" style="width:45px;"/></label>
        <label>SV max h <input id="wfm-plan-svmax" type="number" step="0.25" value="${cfg.svMaxMinutes / 60}" style="width:45px;"/></label>
        <label>Merge gaps under (min) <input id="wfm-plan-gap" type="number" value="${cfg.svMergeGapMin}" style="width:45px;"/></label>
        <label>Round to (min) <input id="wfm-plan-round" type="number" value="${cfg.roundToMin}" style="width:45px;"/></label>
        <label>Supervisor shift type <select id="wfm-plan-stype">${typeOptionsHtml(cfg.svTypeId)}</select></label>
      </div>

      <div style="display:flex; gap:16px; align-items:flex-start; flex-wrap:wrap;">
        <div id="wfm-plan-sports" style="font-size:11px; margin-top:6px;"></div>
        <div id="wfm-plan-tournaments" style="font-size:11px; margin-top:6px; max-height:240px; overflow:auto;"></div>
      </div>

      <p style="margin-top:8px;">
        <button type="button" id="wfm-plan-parse" class="image_button"><span class="bold uppercase">Check the table</span></button>
        <button type="button" id="wfm-plan-build" class="image_button" style="display:none;"><span class="bold uppercase">Build the shifts</span></button>
      </p>

      <div id="wfm-plan-rows" style="max-height:280px; overflow:auto;"></div>
      <div id="wfm-plan-preview" style="max-height:340px; overflow:auto; margin-top:8px;"></div>

      <p id="wfm-plan-actions" style="display:none; margin-top:8px;">
        <label style="font-weight:bold;"><input type="checkbox" id="wfm-plan-dry" ${cfg.dryRun ? 'checked' : ''}/> Dry run (nothing is written)</label>
        <button type="button" id="wfm-plan-export" class="image_button"><span class="bold uppercase">Export plan</span></button>
        <button type="button" id="wfm-plan-run" class="image_button"><span class="bold uppercase">Create shifts</span></button>
        <button type="button" id="wfm-plan-stop" class="image_button" style="display:none;"><span class="bold uppercase">Stop</span></button>
      </p>
      <div style="height:4px; background:#eee; margin:4px 0;"><div id="wfm-plan-bar" style="height:4px; width:0; background:${accent};"></div></div>
      <div id="wfm-plan-log" style="font-size:11px; font-family:monospace; max-height:180px; overflow:auto; background:#f4f4f4; border:1px solid #ccc; padding:6px;"></div>
    `;

    const host = document.getElementById('shift_div') || shiftForm.parentElement;
    host.parentElement.insertBefore(panel, host.nextSibling);

    const $ = (id) => document.getElementById(id);
    $('wfm-plan-hide').addEventListener('click', () => panel.classList.add('hidden'));
    $('wfm-plan-input').value = state.raw;
    $('wfm-plan-input').addEventListener('input', (e) => { state.raw = e.target.value; });

    const bindCfg = (id, key, transform) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('change', () => {
        const raw = el.type === 'checkbox' ? el.checked : el.value;
        cfg[key] = transform ? transform(raw) : raw;
        saveCfg();
      });
    };
    bindCfg('wfm-plan-office', 'office');
    bindCfg('wfm-plan-year', 'year', (v) => parseInt(v, 10) || DEFAULTS.year);
    bindCfg('wfm-plan-user', 'userId', (v) => String(v).trim());
    bindCfg('wfm-plan-utc', 'inputIsUTC');
    bindCfg('wfm-plan-force', 'force');
    bindCfg('wfm-plan-stype', 'svTypeId');
    bindCfg('wfm-plan-extsports', 'extendSports');
    bindCfg('wfm-plan-extmin', 'extendMinutes', (v) => Math.max(0, parseInt(v, 10) || 0));
    bindCfg('wfm-plan-svext', 'svUseExtended');
    bindCfg('wfm-plan-mkanalyst', 'makeAnalysts');
    bindCfg('wfm-plan-mksv', 'makeSupervisors');
    bindCfg('wfm-plan-numbering', 'courtNumbering');
    bindCfg('wfm-plan-anote', 'analystNote');
    bindCfg('wfm-plan-cps', 'courtsPerSv', (v) => Math.max(1, parseInt(v, 10) || 10));
    bindCfg('wfm-plan-svmin', 'svMinMinutes', (v) => Math.round((parseFloat(v) || 4) * 60));
    bindCfg('wfm-plan-svmax', 'svMaxMinutes', (v) => Math.round((parseFloat(v) || 9) * 60));
    bindCfg('wfm-plan-gap', 'svMergeGapMin', (v) => Math.max(0, parseInt(v, 10) || 0));
    bindCfg('wfm-plan-round', 'roundToMin', (v) => Math.max(1, parseInt(v, 10) || 15));
    bindCfg('wfm-plan-dry', 'dryRun');

    $('wfm-plan-office').addEventListener('change', () => {
      state.rows.forEach(validateRow);
      state.plan = null;
      renderTournaments(); renderRows(); renderPlan();
    });

    $('wfm-plan-parse').addEventListener('click', () => {
      state.raw = $('wfm-plan-input').value;
      state.rows = parseAll(state.raw);
      state.plan = null;
      renderSports(); renderTournaments(); renderRows(); renderPlan();
    });
    $('wfm-plan-build').addEventListener('click', () => {
      state.rows.forEach(validateRow);
      state.plan = buildPlan(state.rows);
      renderTournaments(); renderRows(); renderPlan();
    });
    $('wfm-plan-export').addEventListener('click', exportPlan);
    $('wfm-plan-run').addEventListener('click', runCreate);
    $('wfm-plan-stop').addEventListener('click', () => { state.abort = true; });

    if (state.rows.length) { renderSports(); renderTournaments(); renderRows(); }
    if (state.plan) renderPlan();
    return true;
  }

  // ---- Sport → shift type -------------------------------------------------

  function renderSports() {
    const box = document.getElementById('wfm-plan-sports');
    if (!box) return;
    const sports = sportsInRows();
    if (!sports.length) { box.innerHTML = ''; return; }

    let html = `<table class="list" style="font-size:11px;"><tr><th>Sport</th><th>Shift type</th></tr>`;
    sports.forEach((s) => {
      const chosen = typeForSport(s);
      const auto = !cfg.sportTypes[s];
      html += `<tr><td>${esc(s)}</td><td>
        <select data-sport="${esc(s)}" style="min-width:230px;">${typeOptionsHtml(chosen)}</select>
        ${auto ? '<span style="color:#888;"> matched automatically</span>' : ''}
      </td></tr>`;
    });
    html += '</table>';
    box.innerHTML = html;

    box.querySelectorAll('select[data-sport]').forEach((sel) => {
      sel.addEventListener('change', () => {
        cfg.sportTypes[sel.getAttribute('data-sport')] = sel.value;
        saveCfg();
        state.plan = null;
        renderSports(); renderPlan();
      });
    });
  }

  // ---- Tournament extension flags -----------------------------------------

  function tournamentsInRows() {
    const map = {};
    state.rows.forEach((r) => {
      const k = tKey(r.tournament);
      if (!k) return;
      if (!map[k]) map[k] = { name: r.tournament.trim(), sport: r.sport, days: 0, rows: [] };
      map[k].days++;
      map[k].rows.push(r);
    });
    return Object.keys(map).sort().map((k) => map[k]);
  }

  function renderTournaments() {
    const box = document.getElementById('wfm-plan-tournaments');
    if (!box) return;
    const list = tournamentsInRows();
    if (!list.length) { box.innerHTML = ''; return; }

    const flags = list.filter((t) => tournamentRule(t.name) !== 'auto').length;
    let html = `<table class="list" style="font-size:11px;">
      <tr><th colspan="3">Extension by tournament${flags ? ` — ${flags} flagged` : ''}</th></tr>
      <tr><th>Tournament</th><th>Days</th><th>+${cfg.extendMinutes}m</th></tr>`;

    list.forEach((t) => {
      const rule = tournamentRule(t.name);
      const auto = autoExtension(t.rows[t.rows.length - 1]);
      const autoLabel = auto.minutes ? `auto: +${auto.minutes}m` : `auto: none (${auto.reason})`;
      html += `<tr${rule !== 'auto' ? ' style="background:#f2f6ff;"' : ''}>
        <td>${esc(t.name)}<br/><span style="color:#888;">${esc(t.sport)}</span></td>
        <td>${t.days}</td>
        <td>
          <select data-tournament="${esc(t.name)}">
            <option value="auto"${rule === 'auto' ? ' selected' : ''}>${esc(autoLabel)}</option>
            <option value="always"${rule === 'always' ? ' selected' : ''}>always extend</option>
            <option value="never"${rule === 'never' ? ' selected' : ''}>never extend</option>
          </select>
        </td></tr>`;
    });
    html += `<tr><td colspan="3"><button type="button" id="wfm-plan-clearflags" class="image_button">
      <span class="bold uppercase">Clear flags</span></button></td></tr></table>`;
    box.innerHTML = html;

    box.querySelectorAll('select[data-tournament]').forEach((sel) => {
      sel.addEventListener('change', () => {
        setTournamentRule(sel.getAttribute('data-tournament'), sel.value);
        state.plan = null;
        renderTournaments(); renderRows(); renderPlan();
      });
    });
    const clear = document.getElementById('wfm-plan-clearflags');
    if (clear) clear.addEventListener('click', () => {
      cfg.tournamentRules = {};
      saveCfg();
      state.plan = null;
      renderTournaments(); renderRows(); renderPlan();
    });
  }

  // ---- Coverage rows, editable --------------------------------------------

  function renderRows() {
    const box = document.getElementById('wfm-plan-rows');
    const buildBtn = document.getElementById('wfm-plan-build');
    if (!box) return;

    if (!state.rows.length) {
      box.innerHTML = `<p style="font-size:11px; color:#c00;">Nothing recognised. Each row needs a day like <code>17.08</code> and a time range like <code>14:30 - 03:00</code>.</p>`;
      if (buildBtn) buildBtn.style.display = 'none';
      return;
    }

    const target = cfg.office;
    const flagged = state.rows.filter((r) => r.include && r.problems.length).length;
    const usable = state.rows.filter((r) => r.include && r.covers && (r.ownSegs || []).length).length;
    const courts = state.rows.filter((r) => r.include && r.covers)
      .reduce((s, r) => s + (r.courts || 0) * ((r.ownSegs || []).length || 0), 0);

    let html = `<p style="font-size:11px;"><strong>${state.rows.length} rows</strong> — ${usable} covered by ${esc(target)},
      ${courts} court-slots, <span style="color:${flagged ? '#c00' : '#0a0'}">${flagged} needing a decision</span>.</p>`;

    html += `<table class="list" style="width:100%; font-size:11px;">
      <tr><th>Use</th><th>Line</th><th>Date</th><th>Sport / tournament</th><th>Courts</th><th>Covered by</th>
      <th>${esc(target)} window</th><th>+${cfg.extendMinutes}m</th><th>Needs a decision</th></tr>`;

    state.rows.forEach((r) => {
      const cell = target === 'Sofia' ? r.sofiaCell : r.medCell;
      const bad = r.problems.length > 0;
      const ext = r.extApplied;
      const tRule = tournamentRule(r.tournament);
      const extText = ext ? (ext.minutes ? `+${ext.minutes}m` : '—') : '';
      const extSrc = ext && ext.source && ext.source !== 'auto' ? ext.source : '';
      html += `<tr data-row="${r.id}" style="${bad && r.include ? 'background:#fff4f4;' : ''}">
        <td><input type="checkbox" data-field="include" ${r.include ? 'checked' : ''}/></td>
        <td>${r.lineNo}</td>
        <td><input data-field="dateStr" value="${esc(r.dateStr)}" style="width:80px;"/></td>
        <td>${esc(r.sport)} — ${esc(r.tournament)}</td>
        <td><input data-field="courts" value="${r.courts == null ? '' : r.courts}" style="width:35px;"/></td>
        <td><input data-field="office" value="${esc(r.office)}" style="width:65px;"/></td>
        <td><input data-field="cell" value="${esc(cell)}" style="width:170px;"/></td>
        <td title="${esc(ext ? ext.reason : '')}">
          <select data-field="extend">
            <option value="auto"${r.extend === 'auto' ? ' selected' : ''}>${tRule === 'auto' ? 'auto' : 'tournament: ' + tRule}</option>
            <option value="yes"${r.extend === 'yes' ? ' selected' : ''}>always</option>
            <option value="no"${r.extend === 'no' ? ' selected' : ''}>never</option>
          </select> ${esc(extText)}<span style="color:#888;">${extSrc ? ' ' + esc(extSrc) : ''}</span>
        </td>
        <td style="color:#c00;">${esc(r.problems.join('; '))}</td>
      </tr>`;
    });
    html += '</table>';
    box.innerHTML = html;

    box.querySelectorAll('tr[data-row]').forEach((tr) => {
      const r = state.rows.find((x) => x.id === tr.getAttribute('data-row'));
      tr.querySelectorAll('[data-field]').forEach((input) => {
        input.addEventListener('change', () => {
          const f = input.getAttribute('data-field');
          if (f === 'include') r.include = input.checked;
          else if (f === 'courts') r.courts = parseInt(input.value, 10) || null;
          else if (f === 'office') r.office = normOffice(input.value) || input.value.trim();
          else if (f === 'extend') r.extend = input.value;
          else if (f === 'cell') {
            if (cfg.office === 'Sofia') r.sofiaCell = input.value; else r.medCell = input.value;
          } else r[f] = input.value.trim();
          validateRow(r);
          state.plan = null;
          renderRows(); renderPlan();
        });
      });
    });

    if (buildBtn) buildBtn.style.display = usable ? 'inline-block' : 'none';
  }

  // ---- The resulting shifts -----------------------------------------------

  function renderPlan() {
    const box = document.getElementById('wfm-plan-preview');
    const actions = document.getElementById('wfm-plan-actions');
    if (!box) return;
    if (!state.plan) { box.innerHTML = ''; if (actions) actions.style.display = 'none'; return; }

    const p = state.plan;
    const hours = p.all.reduce((s, i) => s + (i.end - i.start) / 60, 0);
    const extended = p.analyst.filter((a) => a.extMinutes > 0).length;
    const byDay = {};
    p.all.forEach((i) => {
      const d = toLocalFields(i).date;
      byDay[d] = byDay[d] || { analyst: 0, sv: 0 };
      byDay[d][i.kind === 'sv' ? 'sv' : 'analyst']++;
    });

    let html = `<p style="font-size:11px;"><strong>${p.all.length} shifts</strong> —
      ${p.analyst.length} court, ${p.sv.length} supervisor, ${hours.toFixed(1)} hours total.
      ${extended} court shifts extended by ${cfg.extendMinutes} min.
      Peak concurrent courts ${p.peakCourts} → up to ${Math.ceil(p.peakCourts / cfg.courtsPerSv)} supervisors.</p>`;

    html += `<table class="list" style="width:100%; font-size:11px;"><tr><th>Local date</th><th>Court shifts</th><th>Supervisors</th></tr>`;
    Object.keys(byDay).sort().forEach((d) => {
      html += `<tr><td>${d}</td><td>${byDay[d].analyst}</td><td>${byDay[d].sv}</td></tr>`;
    });
    html += '</table>';

    // First day of court shifts, so the numbering and the +2h are visible.
    const firstDay = Object.keys(byDay).sort()[0];
    const sample = p.analyst.filter((a) => toLocalFields(a).date === firstDay);
    if (sample.length) {
      html += `<table class="list" style="width:100%; font-size:11px; margin-top:6px;">
        <tr><th colspan="4">${esc(firstDay)} — first day, ${sample.length} court shifts</th></tr>
        <tr><th>Note</th><th>Local</th><th>Shift type</th><th>Extension</th></tr>`;
      sample.forEach((a) => {
        const f = toLocalFields(a);
        html += `<tr${a.extMinutes ? ' style="background:#f2fbf2;"' : ''}>
          <td>${esc(a.note)}</td><td>${f.start} - ${f.end}</td>
          <td>${esc(typeLabel(a.typeId))}</td>
          <td>${a.extMinutes ? '+' + a.extMinutes + 'm · ' + esc(a.extReason) : esc(a.extReason)}</td></tr>`;
      });
      html += '</table>';
    }

    if (p.sv.length) {
      html += `<table class="list" style="width:100%; font-size:11px; margin-top:6px;">
        <tr><th>Tag</th><th>UTC</th><th>${esc(cfg.office)} local</th><th>Hours</th><th>Peak courts</th><th>Note</th></tr>`;
      p.sv.slice().sort((a, b) => a.start - b.start || a.level - b.level).forEach((s) => {
        const f = toLocalFields(s);
        html += `<tr${s.flags.length ? ' style="background:#fffbe6;"' : ''}>
          <td>[S${s.level}]${s.part ? ' ' + s.part : ''}</td>
          <td>${fmtAbs(s.start)} → ${hhmm(absToParts(s.end).minutes)}</td>
          <td>${f.date} ${f.start} → ${f.end}</td>
          <td>${durH(s.start, s.end)}</td>
          <td>${s.peak}</td>
          <td>${esc(s.flags.join('; '))}</td>
        </tr>`;
      });
      html += '</table>';
    }

    if (p.warnings.length) {
      html += `<p style="font-size:11px; color:#c80;"><strong>Worth a look:</strong></p><ul style="font-size:11px; color:#c80;">` +
        p.warnings.map((w) => `<li>${esc(w)}</li>`).join('') + '</ul>';
    }

    box.innerHTML = html;
    if (actions) actions.style.display = p.all.length ? 'block' : 'none';
  }

  // =========================================================================
  // Console API + init
  // =========================================================================

  window.wfmPlan = {
    cfg,
    set(k, v) { cfg[k] = v; saveCfg(); return cfg; },
    mapSport(sport, typeId) { cfg.sportTypes[sport] = String(typeId); saveCfg(); return cfg.sportTypes; },
    // wfmPlan.flagTournament('ATP Cincinnati', 'never' | 'always' | 'auto')
    flagTournament(name, mode) { setTournamentRule(name, mode || 'never'); return cfg.tournamentRules; },
    // wfmPlan.flagMatching(/challenger/i, 'never') — flags every parsed tournament that matches
    flagMatching(pattern, mode) {
      const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i');
      const hit = [];
      tournamentsInRows().forEach((t) => { if (re.test(t.name)) { setTournamentRule(t.name, mode || 'never'); hit.push(t.name); } });
      state.plan = null; renderTournaments(); renderRows(); renderPlan();
      return hit;
    },
    flags() { return cfg.tournamentRules; },
    parse(text) { state.raw = text; state.rows = parseAll(text); renderSports(); renderTournaments(); renderRows(); return state.rows; },
    build() { state.plan = buildPlan(state.rows); renderPlan(); return state.plan; },
    local(item) { return toLocalFields(item); },
    state,
    reset() { localStorage.removeItem(LS_KEY); cfg = Object.assign({}, DEFAULTS); cfg.sportTypes = {}; cfg.tournamentRules = {}; }
  };

  function init() {
    if (buildPanel()) return;
    let tries = 0;
    const t = setInterval(() => { if (buildPanel() || ++tries > 25) clearInterval(t); }, 300);
  }
  init();

  const obs = new MutationObserver(() => {
    if (!document.getElementById(PANEL_ID) && getShiftForm()) buildPanel();
  });
  obs.observe(document.body, { childList: true, subtree: true });

})();

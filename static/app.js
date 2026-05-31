/* ===========================================================================
   Disponibilidade da Banca — lógica do painel (JS puro)
   =========================================================================== */

const PERIOD_START = "2026-06-15";
const PERIOD_END = "2026-07-31";
const MONTHS = [
  { year: 2026, month: 5, label: "Junho 2026" }, // month is 0-based
  { year: 2026, month: 6, label: "Julho 2026" },
];
const DOW = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const MONTH_NAMES = [
  "jan", "fev", "mar", "abr", "mai", "jun",
  "jul", "ago", "set", "out", "nov", "dez",
];
const WEEKDAY_FULL = [
  "domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado",
];

// Pedro está na França (Brasil + 5h). Ele marca no horário da França;
// armazenamos sempre em horário de Brasília (referência da defesa).
const PEDRO_NAME = "Pedro Nuno de Souza Moura";
const FR_OFFSET = 5;
const isPedro = () => state.currentMember === PEDRO_NAME;
function shiftTime(hhmm, deltaH) {
  let [h, m] = hhmm.split(":").map(Number);
  h = (h + deltaH + 24) % 24;
  return `${pad(h)}:${pad(m)}`;
}
const brToFr = (t) => shiftTime(t, FR_OFFSET);
const frToBr = (t) => shiftTime(t, -FR_OFFSET);

const state = {
  members: [],
  currentMember: null,
  myBlocks: [],
  sel: { start: null, end: null },
  hover: null,
  editingId: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ───────────────────────────── helpers ───────────────────────────── */
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

function fmtDate(isoStr) {
  const [y, m, d] = isoStr.split("-").map(Number);
  return `${d} ${MONTH_NAMES[m - 1]}`;
}
function fmtDateLong(isoStr) {
  const [y, m, d] = isoStr.split("-").map(Number);
  const wd = new Date(y, m - 1, d).getDay();
  return `${WEEKDAY_FULL[wd]}, ${d} de ${MONTH_NAMES[m - 1]}`;
}

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (isError ? " toast--err" : "");
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let detail = "Erro na requisição.";
    try {
      detail = (await res.json()).detail || detail;
    } catch (_) {}
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

/* ───────────────────────────── modais ───────────────────────────── */
let modalCleanup = null;
function openModal(id) {
  const modal = $(id);
  modal.hidden = false;
  const onKey = (e) => {
    if (e.key === "Escape") closeModal(id);
  };
  document.addEventListener("keydown", onKey);
  modal.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", () => closeModal(id), { once: true })
  );
  modalCleanup = () => document.removeEventListener("keydown", onKey);
  const focusable = modal.querySelector("button:not([data-close])");
  if (focusable) focusable.focus();
}
function closeModal(id) {
  $(id).hidden = true;
  if (modalCleanup) modalCleanup();
}

/* ───────────────────────────── membros ───────────────────────────── */
async function loadMembers() {
  state.members = await api("/api/members");
  const select = $("#member-select");
  for (const m of state.members) {
    const opt = document.createElement("option");
    opt.value = m.nome;
    opt.textContent = m.cargo ? `${m.nome} · ${m.cargo}` : m.nome;
    select.appendChild(opt);
  }
}

function setupNameFlow() {
  const select = $("#member-select");
  const confirmBtn = $("#confirm-name-btn");

  select.addEventListener("change", () => {
    confirmBtn.disabled = !select.value;
  });

  confirmBtn.addEventListener("click", () => {
    if (!select.value) return;
    $("#modal-name-value").textContent = select.value;
    openModal("#modal-name");
  });

  $("#modal-name-confirm").addEventListener("click", async () => {
    closeModal("#modal-name");
    await identify(select.value);
  });

  $("#switch-name-btn").addEventListener("click", () => {
    state.currentMember = null;
    state.myBlocks = [];
    resetSelection();
    $("#identity-badge").hidden = true;
    $("#marcar").classList.add("block--locked");
    $("#marcar").setAttribute("aria-disabled", "true");
    select.value = "";
    confirmBtn.disabled = true;
    renderIntervals();
  });
}

async function identify(name) {
  state.currentMember = name;
  $("#identity-name").textContent = name;
  $("#identity-badge").hidden = false;
  $("#marcar").classList.remove("block--locked");
  $("#marcar").setAttribute("aria-disabled", "false");
  state.myBlocks = await api(
    `/api/availability?member=${encodeURIComponent(name)}`
  );
  renderIntervals();
  validatePicker();
  loadIntersection();
  toast(`Olá, ${name.split(" ")[0]}! Marque seus intervalos.`);
}

/* ───────────────────────────── calendário ───────────────────────────── */
function buildCalendars() {
  const wrap = $("#calendars");
  wrap.innerHTML = "";
  for (const { year, month, label } of MONTHS) {
    const cal = document.createElement("div");
    cal.className = "cal";
    const title = document.createElement("p");
    title.className = "cal__name";
    title.textContent = label;
    cal.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "cal__grid";
    for (const d of DOW) {
      const dh = document.createElement("div");
      dh.className = "cal__dow";
      dh.textContent = d;
      grid.appendChild(dh);
    }

    const firstDow = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let i = 0; i < firstDow; i++) {
      const empty = document.createElement("div");
      empty.className = "cal__day is-empty";
      grid.appendChild(empty);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const isoStr = iso(year, month, d);
      const cell = document.createElement("div");
      cell.className = "cal__day";
      cell.textContent = d;
      cell.dataset.iso = isoStr;
      if (isoStr < PERIOD_START || isoStr > PERIOD_END) {
        cell.classList.add("is-disabled");
      } else {
        cell.addEventListener("click", () => onDayClick(isoStr));
        cell.addEventListener("mouseenter", () => onDayHover(isoStr));
      }
      grid.appendChild(cell);
    }
    cal.appendChild(grid);
    wrap.appendChild(cal);
  }
  wrap.addEventListener("mouseleave", () => {
    state.hover = null;
    paintCalendar();
  });
}

function onDayClick(isoStr) {
  const { start, end } = state.sel;
  if (!start || (start && end)) {
    state.sel = { start: isoStr, end: null };
  } else if (isoStr < start) {
    state.sel = { start: isoStr, end: null };
  } else {
    state.sel.end = isoStr;
  }
  state.hover = null;
  paintCalendar();
  updateReadout();
}

function onDayHover(isoStr) {
  if (state.sel.start && !state.sel.end) {
    state.hover = isoStr;
    paintCalendar();
  }
}

function paintCalendar() {
  const { start, end } = state.sel;
  const previewEnd = end || state.hover;
  $$(".cal__day").forEach((cell) => {
    if (!cell.dataset.iso) return;
    const d = cell.dataset.iso;
    cell.classList.remove("in-range", "is-endpoint", "is-hover-range");
    if (cell.classList.contains("is-disabled")) return;
    if (d === start || d === end) {
      cell.classList.add("is-endpoint");
    } else if (start && previewEnd && d > start && d < previewEnd) {
      cell.classList.add(end ? "in-range" : "is-hover-range");
    }
  });
}

function updateReadout() {
  $("#readout-start").textContent = state.sel.start
    ? fmtDate(state.sel.start)
    : "—";
  $("#readout-end").textContent = state.sel.end ? fmtDate(state.sel.end) : "—";
  validatePicker();
}

function resetSelection() {
  state.sel = { start: null, end: null };
  state.hover = null;
  state.editingId = null;
  $("#add-interval-btn").textContent = "+ adicionar intervalo";
  updateReadout();
  paintCalendar();
  $$(".interval-card").forEach((c) => c.classList.remove("is-editing"));
}

/* ───────────────────────────── fuso horário ───────────────────────────── */
function updateTzNote() {
  const note = $("#tz-note");
  if (!state.currentMember) {
    note.hidden = true;
    return;
  }
  if (isPedro()) {
    const fs = $("#time-start").value;
    const fe = $("#time-end").value;
    note.className = "tz-note tz-note--pedro";
    note.innerHTML =
      `🇫🇷 Este é o seu horário na França <b>${fs}–${fe}</b>, ` +
      `que corresponde a <b>${frToBr(fs)}–${frToBr(fe)}</b> no Brasil.`;
  } else {
    note.className = "tz-note tz-note--advice";
    note.innerHTML =
      `🌍 Considere o fuso-horário do amigo <b>Pedro</b>, que está 5 horas à ` +
      `frente de você. Caso seja possível, opte por um horário até às <b>18h</b> ` +
      `em consideração a ele.`;
  }
  note.hidden = false;
}

/* ───────────────────────────── validação picker ───────────────────────────── */
function validatePicker() {
  const err = $("#picker-error");
  const btn = $("#add-interval-btn");
  const { start, end } = state.sel;
  const ts = $("#time-start").value;
  const te = $("#time-end").value;
  let msg = "";
  if (start) {
    if (ts >= te) msg = "O horário final deve ser depois do inicial.";
    else if (isPedro() && ts < "05:00")
      msg =
        "Para a conversão de fuso, escolha um horário a partir das 05:00 (França).";
  }

  err.hidden = !msg;
  if (msg) err.textContent = msg;
  // Basta o início: um dia solto vale como intervalo de fim = início.
  btn.disabled = !(start && !msg && state.currentMember);

  if (state.editingId) {
    btn.textContent = "✓ salvar alterações";
  } else if (start && (!end || end === start)) {
    btn.textContent = "+ adicionar dia";
  } else {
    btn.textContent = "+ adicionar intervalo";
  }
  updateTzNote();
}

/* ───────────────────────────── adicionar / salvar ───────────────────────────── */
function setupPickerControls() {
  $("#time-start").addEventListener("input", validatePicker);
  $("#time-end").addEventListener("input", validatePicker);

  $("#add-interval-btn").addEventListener("click", () => {
    const summary = $("#modal-save-summary");
    summary.innerHTML = "";
    const li = document.createElement("li");
    const fs = $("#time-start").value;
    const fe = $("#time-end").value;
    const timeStr = isPedro()
      ? `🇫🇷 ${fs}–${fe} · 🇧🇷 ${frToBr(fs)}–${frToBr(fe)}`
      : `${fs}–${fe}`;
    const endDate = state.sel.end || state.sel.start;
    const dateStr =
      endDate === state.sel.start
        ? fmtDateLong(state.sel.start)
        : `${fmtDateLong(state.sel.start)} → ${fmtDateLong(endDate)}`;
    li.textContent = `${dateStr} · ${timeStr}`;
    summary.appendChild(li);
    $("#modal-save-title").textContent = state.editingId
      ? "Atualizar este intervalo?"
      : "O intervalo está correto?";
    openModal("#modal-save");
  });

  $("#modal-save-confirm").addEventListener("click", async () => {
    closeModal("#modal-save");
    await persistInterval();
  });
}

async function persistInterval() {
  // Pedro digita em horário da França; convertemos para Brasília ao salvar.
  let startTime = $("#time-start").value;
  let endTime = $("#time-end").value;
  if (isPedro()) {
    startTime = frToBr(startTime);
    endTime = frToBr(endTime);
  }
  const payload = {
    member: state.currentMember,
    start_date: state.sel.start,
    end_date: state.sel.end || state.sel.start, // dia solto: fim = início
    start_time: startTime,
    end_time: endTime,
  };
  try {
    if (state.editingId) {
      const updated = await api(`/api/availability/${state.editingId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      const idx = state.myBlocks.findIndex((b) => b.id === state.editingId);
      if (idx >= 0) state.myBlocks[idx] = updated;
      toast("Intervalo atualizado.");
    } else {
      const created = await api("/api/availability", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      state.myBlocks.push(created);
      toast("Intervalo adicionado.");
    }
    resetSelection();
    renderIntervals();
    loadIntersection();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ───────────────────────────── lista de intervalos ───────────────────────────── */
function renderIntervals() {
  const list = $("#intervals-list");
  const empty = $("#intervals-empty");
  const count = $("#intervals-count");
  list.innerHTML = "";
  count.textContent = state.myBlocks.length;
  empty.hidden = state.myBlocks.length > 0;

  const sorted = [...state.myBlocks].sort((a, b) =>
    (a.start_date + a.start_time).localeCompare(b.start_date + b.start_time)
  );

  for (const b of sorted) {
    const li = document.createElement("li");
    li.className = "interval-card";
    if (b.id === state.editingId) li.classList.add("is-editing");

    const when = document.createElement("div");
    when.className = "interval-card__when";
    const dates = document.createElement("span");
    dates.className = "interval-card__dates";
    dates.textContent =
      b.start_date === b.end_date
        ? fmtDateLong(b.start_date)
        : `${fmtDate(b.start_date)} → ${fmtDate(b.end_date)}`;
    const time = document.createElement("span");
    time.className = "interval-card__time";
    time.innerHTML = isPedro()
      ? `🇫🇷 ${brToFr(b.start_time)}–${brToFr(b.end_time)} &nbsp;·&nbsp; 🇧🇷 ${b.start_time}–${b.end_time}`
      : `${b.start_time} – ${b.end_time}`;
    when.append(dates, time);

    const actions = document.createElement("div");
    actions.className = "interval-card__actions";
    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.textContent = "editar";
    editBtn.addEventListener("click", () => startEdit(b));
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn icon-btn--del";
    delBtn.textContent = "excluir";
    delBtn.addEventListener("click", () => confirmDelete(b));
    actions.append(editBtn, delBtn);

    li.append(when, actions);
    list.appendChild(li);
  }
}

function startEdit(b) {
  state.editingId = b.id;
  state.sel = { start: b.start_date, end: b.end_date };
  // Blocos guardados em horário de Brasília; Pedro edita em horário da França.
  $("#time-start").value = isPedro() ? brToFr(b.start_time) : b.start_time;
  $("#time-end").value = isPedro() ? brToFr(b.end_time) : b.end_time;
  $("#add-interval-btn").textContent = "✓ salvar alterações";
  paintCalendar();
  updateReadout();
  renderIntervals();
  $("#marcar").scrollIntoView({ behavior: "smooth", block: "start" });
  toast("Editando intervalo — ajuste e salve.");
}

function confirmDelete(b) {
  const when =
    b.start_date === b.end_date
      ? fmtDateLong(b.start_date)
      : fmtDate(b.start_date) + " → " + fmtDate(b.end_date);
  const time = isPedro()
    ? `🇫🇷 ${brToFr(b.start_time)}–${brToFr(b.end_time)}`
    : `${b.start_time}–${b.end_time}`;
  $("#modal-delete-value").textContent = `${when} · ${time}`;
  openModal("#modal-delete");
  $("#modal-delete-confirm").onclick = async () => {
    closeModal("#modal-delete");
    try {
      await api(`/api/availability/${b.id}`, { method: "DELETE" });
      state.myBlocks = state.myBlocks.filter((x) => x.id !== b.id);
      if (state.editingId === b.id) resetSelection();
      renderIntervals();
      loadIntersection();
      toast("Intervalo excluído.");
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/* ───────────────────────────── interseção ───────────────────────────── */
// Diagnóstico exibido quando NÃO há coincidência: mostra a janela de cada
// pessoa em horário de Brasília (e a equivalência da França, para o Pedro),
// deixando claro quem está desencontrado e por quê.
function diagnosticHtml(data) {
  const rows = data.responded
    .map((name) => {
      const wins = data.windows_by_member[name] || [];
      const txt = wins
        .map((w) => {
          const br = `${w.start}–${w.end}`;
          const fr =
            name === PEDRO_NAME
              ? ` <em>(${brToFr(w.start)}–${brToFr(w.end)} na França)</em>`
              : "";
          return br + fr;
        })
        .join(", ");
      return `<li><span class="diag__name">${name.split(" ")[0]}</span><span class="diag__win">${txt || "—"}</span></li>`;
    })
    .join("");
  return `
    <div class="diag">
      <p class="diag__title">Por que ainda não coincide — janela de cada pessoa, em <b>horário de Brasília</b>:</p>
      <ul class="diag__list">${rows}</ul>
      <p class="diag__tip">Para haver coincidência, as janelas precisam se sobrepor neste fuso. Dica: ajuste para que todas cubram um mesmo intervalo.</p>
    </div>`;
}

async function loadIntersection() {
  const result = $("#intersection-result");
  const roster = $("#roster");
  try {
    const data = await api("/api/intersection");

    roster.innerHTML = "";
    for (const name of data.members) {
      const chip = document.createElement("span");
      const isIn = data.responded.includes(name);
      chip.className = "roster__chip " + (isIn ? "is-in" : "is-out");
      chip.innerHTML = `<span class="dot"></span>${name.split(" ")[0]}`;
      chip.title = isIn ? `${name} já marcou` : `${name} ainda não marcou`;
      roster.appendChild(chip);
    }

    // Sem ninguém ainda.
    if (data.responded.length === 0) {
      result.innerHTML = `<p class="result__empty">Ninguém marcou disponibilidade ainda. Seja a primeira pessoa!</p>`;
      return;
    }

    // Nota cumulativa: quem já entrou no cálculo / quem ainda falta.
    let note;
    if (data.missing.length > 0) {
      const faltam = data.missing.map((n) => n.split(" ")[0]).join(", ");
      const jaCount = data.responded.length;
      note =
        `<p class="result__note">⏳ Parcial — coincidência entre ${jaCount} de ${data.members.length}. ` +
        `Ainda falta${data.missing.length === 1 ? "" : "m"}: <b>${faltam}</b>.</p>`;
    } else {
      note = `<p class="result__note">✓ Todos os ${data.members.length} integrantes já responderam.</p>`;
    }

    if (data.slots.length === 0) {
      result.innerHTML =
        note +
        `<p class="result__empty">Quem já respondeu ainda não tem um dia e horário em comum.</p>` +
        diagnosticHtml(data);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "slots";
    for (const slot of data.slots) {
      const [y, m, d] = slot.date.split("-").map(Number);
      const wd = new Date(y, m - 1, d).getDay();
      const card = document.createElement("div");
      card.className = "slot";
      const windows = slot.windows
        .map((w) => {
          const fr = isPedro()
            ? `<span class="slot__fr">🇫🇷 ${brToFr(w.start)}–${brToFr(w.end)}</span>`
            : "";
          return `<span class="slot__win">${w.start} – ${w.end}${fr}</span>`;
        })
        .join("");
      card.innerHTML = `
        <div class="slot__dow">${WEEKDAY_FULL[wd]}</div>
        <div class="slot__date">${d} ${MONTH_NAMES[m - 1]}</div>
        <div class="slot__windows">${windows}</div>`;
      grid.appendChild(card);
    }
    result.innerHTML = note;
    result.appendChild(grid);
  } catch (e) {
    result.innerHTML = `<p class="result__empty">Não foi possível carregar a interseção.</p>`;
  }
}

/* ───────────────────────────── init ───────────────────────────── */
async function init() {
  buildCalendars();
  setupNameFlow();
  setupPickerControls();
  await loadMembers();
  updateReadout();
  loadIntersection();
}

document.addEventListener("DOMContentLoaded", init);

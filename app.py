"""Painel de disponibilidade da banca de TCC.

Backend FastAPI leve. Cada membro (lido de banca.csv) marca vários blocos de
disponibilidade — uma faixa de dias + uma janela de horário — e o sistema calcula
a interseção em que todos os membros estão livres.

Stack: FastAPI + sqlite3 (stdlib) + csv (stdlib). Sem ORM.
"""

from __future__ import annotations

import csv
import os
import smtplib
import sqlite3
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from pathlib import Path

from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator

BASE_DIR = Path(__file__).parent
CSV_PATH = BASE_DIR / "banca.csv"
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "banca.db"
STATIC_DIR = BASE_DIR / "static"

# Carrega variáveis de ambiente de um arquivo .env (se existir).
load_dotenv(BASE_DIR / ".env")

# Janela permitida para a defesa.
PERIOD_START = date(2026, 6, 15)
PERIOD_END = date(2026, 7, 31)

# Destinatário do aviso de "todos preencheram e há horário em comum".
NOTIFY_TO = os.getenv("NOTIFY_TO", "mateus.e.alcantara@edu.unirio.br")
WEEKDAYS_PT = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"]
MONTHS_PT = [
    "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]


# --------------------------------------------------------------------------- #
# Banco de dados
# --------------------------------------------------------------------------- #
def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    with get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS availability (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                member      TEXT NOT NULL,
                start_date  TEXT NOT NULL,
                end_date    TEXT NOT NULL,
                start_time  TEXT NOT NULL,
                end_time    TEXT NOT NULL,
                created_at  TEXT NOT NULL
            )
            """
        )
        # Estado interno (chave/valor) — usado para não reenviar o e-mail.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT)"
        )


def get_state(key: str, default: str = "") -> str:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT value FROM app_state WHERE key = ?", (key,)
        ).fetchone()
    return row["value"] if row else default


def set_state(key: str, value: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO app_state (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


# --------------------------------------------------------------------------- #
# Membros (banca.csv)
# --------------------------------------------------------------------------- #
def load_members() -> list[dict[str, str]]:
    members: list[dict[str, str]] = []
    with open(CSV_PATH, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            nome = (row.get("nome") or "").strip()
            cargo = (row.get("cargo") or "").strip()
            if nome:
                members.append({"nome": nome, "cargo": cargo})
    return members


def member_names() -> list[str]:
    return [m["nome"] for m in load_members()]


# --------------------------------------------------------------------------- #
# Lógica de interseção
# --------------------------------------------------------------------------- #
def _to_minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _from_minutes(total: int) -> str:
    return f"{total // 60:02d}:{total % 60:02d}"


def _union_windows(windows: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Funde janelas de horário (em minutos) sobrepostas/adjacentes."""
    if not windows:
        return []
    windows = sorted(windows)
    merged = [windows[0]]
    for start, end in windows[1:]:
        last_start, last_end = merged[-1]
        if start <= last_end:
            merged[-1] = (last_start, max(last_end, end))
        else:
            merged.append((start, end))
    return merged


def _intersect_two(
    a: list[tuple[int, int]], b: list[tuple[int, int]]
) -> list[tuple[int, int]]:
    """Interseção entre dois conjuntos de janelas."""
    result: list[tuple[int, int]] = []
    for a_start, a_end in a:
        for b_start, b_end in b:
            start = max(a_start, b_start)
            end = min(a_end, b_end)
            if start < end:
                result.append((start, end))
    return _union_windows(result)


def compute_intersection(
    blocks: list[sqlite3.Row | dict], members: list[str]
) -> list[dict]:
    """Para cada dia do período, encontra as janelas em que TODOS os membros
    estão disponíveis.

    Para cada membro monta a união das janelas de horário dos blocos que cobrem
    o dia; o dia só vira candidato se todos os membros têm cobertura e existe
    interseção comum não-vazia.
    """
    if not members:
        return []

    # day -> member -> lista de janelas (minutos)
    by_day: dict[str, dict[str, list[tuple[int, int]]]] = {}
    for b in blocks:
        start = datetime.strptime(b["start_date"], "%Y-%m-%d").date()
        end = datetime.strptime(b["end_date"], "%Y-%m-%d").date()
        window = (_to_minutes(b["start_time"]), _to_minutes(b["end_time"]))
        day = start
        while day <= end:
            key = day.isoformat()
            by_day.setdefault(key, {}).setdefault(b["member"], []).append(window)
            day += timedelta(days=1)

    results: list[dict] = []
    day = PERIOD_START
    while day <= PERIOD_END:
        key = day.isoformat()
        per_member = by_day.get(key, {})
        if all(name in per_member for name in members):
            # Interseção das uniões de janelas de cada membro.
            common = _union_windows(per_member[members[0]])
            for name in members[1:]:
                common = _intersect_two(common, _union_windows(per_member[name]))
                if not common:
                    break
            if common:
                results.append(
                    {
                        "date": key,
                        "windows": [
                            {"start": _from_minutes(s), "end": _from_minutes(e)}
                            for s, e in common
                        ],
                    }
                )
        day += timedelta(days=1)
    return results


# --------------------------------------------------------------------------- #
# Modelos de request
# --------------------------------------------------------------------------- #
class AvailabilityIn(BaseModel):
    member: str
    start_date: str
    end_date: str
    start_time: str
    end_time: str

    @field_validator("start_time", "end_time")
    @classmethod
    def _valid_time(cls, v: str) -> str:
        datetime.strptime(v, "%H:%M")
        return v

    @field_validator("start_date", "end_date")
    @classmethod
    def _valid_date(cls, v: str) -> str:
        datetime.strptime(v, "%Y-%m-%d")
        return v


def validate_block(data: AvailabilityIn) -> None:
    if data.member not in member_names():
        raise HTTPException(422, "Membro desconhecido.")
    start = datetime.strptime(data.start_date, "%Y-%m-%d").date()
    end = datetime.strptime(data.end_date, "%Y-%m-%d").date()
    if start < PERIOD_START or end > PERIOD_END:
        raise HTTPException(
            422,
            f"Datas devem estar entre {PERIOD_START.isoformat()} e {PERIOD_END.isoformat()}.",
        )
    if end < start:
        raise HTTPException(422, "Data final não pode ser antes da inicial.")
    if _to_minutes(data.end_time) <= _to_minutes(data.start_time):
        raise HTTPException(422, "Horário final deve ser depois do inicial.")


# --------------------------------------------------------------------------- #
# Notificação por e-mail
# --------------------------------------------------------------------------- #
def _fmt_slot_pt(slot: dict) -> str:
    y, m, d = (int(x) for x in slot["date"].split("-"))
    wd = date(y, m, d).weekday()
    janelas = ", ".join(f"{w['start']}–{w['end']}" for w in slot["windows"])
    return f"{WEEKDAYS_PT[wd]}, {d} de {MONTHS_PT[m - 1]} de {y} · {janelas}"


def _build_email_body(slots: list[dict]) -> str:
    linhas = "\n".join(f"  • {_fmt_slot_pt(s)}" for s in slots)
    return (
        "Boa notícia! Todos os integrantes da banca já marcaram a disponibilidade "
        "e há horário(s) em comum para a defesa do TCC\n"
        '"Percepção de Violência na Cidade do Rio de Janeiro".\n\n'
        f"Dias e horários em que TODOS coincidem (horário de Brasília):\n{linhas}\n\n"
        "— Painel de disponibilidade da banca\n"
    )


def send_email(subject: str, body: str) -> None:
    """Envia o e-mail via SMTP (se configurado por variáveis de ambiente).

    Sem SMTP configurado, grava o conteúdo em data/notifications.log — útil
    para desenvolvimento e como registro de auditoria.
    """
    host = os.getenv("SMTP_HOST")
    sender = os.getenv("SMTP_FROM") or os.getenv("SMTP_USER")

    if not host or not sender:
        log = DATA_DIR / "notifications.log"
        with open(log, "a", encoding="utf-8") as fh:
            fh.write(
                f"\n===== {datetime.now().isoformat(timespec='seconds')} "
                f"[SMTP não configurado — apenas registrado] =====\n"
                f"Para: {NOTIFY_TO}\nAssunto: {subject}\n\n{body}\n"
            )
        print(f"[notificação] SMTP não configurado; gravado em {log}")
        return

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = NOTIFY_TO
    msg.set_content(body)

    port = int(os.getenv("SMTP_PORT", "587"))
    user = os.getenv("SMTP_USER")
    password = os.getenv("SMTP_PASSWORD")
    try:
        if port == 465:
            with smtplib.SMTP_SSL(host, port, timeout=20) as s:
                if user and password:
                    s.login(user, password)
                s.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=20) as s:
                s.starttls()
                if user and password:
                    s.login(user, password)
                s.send_message(msg)
        print(f"[notificação] e-mail enviado para {NOTIFY_TO}")
    except Exception as exc:  # não derruba a aplicação por falha de e-mail
        print(f"[notificação] FALHA ao enviar e-mail: {exc}")


def maybe_notify() -> None:
    """Dispara o e-mail uma única vez quando TODOS responderam e existe um
    horário em comum. Rearma quando a condição deixa de ser satisfeita."""
    members = member_names()
    with get_conn() as conn:
        blocks = conn.execute("SELECT * FROM availability").fetchall()
    responded = {b["member"] for b in blocks}
    everyone = all(m in responded for m in members)
    slots = compute_intersection(blocks, members) if everyone else []
    satisfied = everyone and bool(slots)

    already = get_state("notified", "0")
    if satisfied and already != "1":
        send_email(
            "✓ Banca completa: há horário em comum para a defesa",
            _build_email_body(slots),
        )
        set_state("notified", "1")
    elif not satisfied and already != "0":
        set_state("notified", "0")


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #
app = FastAPI(title="Disponibilidade da Banca")


@app.on_event("startup")
def _startup() -> None:
    init_db()


@app.get("/api/members")
def get_members() -> list[dict[str, str]]:
    return load_members()


@app.get("/api/availability")
def get_availability(member: str | None = None) -> list[dict]:
    with get_conn() as conn:
        if member:
            rows = conn.execute(
                "SELECT * FROM availability WHERE member = ? ORDER BY start_date, start_time",
                (member,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM availability ORDER BY start_date, start_time"
            ).fetchall()
    return [dict(r) for r in rows]


@app.post("/api/availability")
def create_availability(data: AvailabilityIn, background: BackgroundTasks) -> dict:
    validate_block(data)
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO availability
               (member, start_date, end_date, start_time, end_time, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                data.member,
                data.start_date,
                data.end_date,
                data.start_time,
                data.end_time,
                datetime.now().isoformat(timespec="seconds"),
            ),
        )
        row = conn.execute(
            "SELECT * FROM availability WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
    background.add_task(maybe_notify)
    return dict(row)


@app.put("/api/availability/{block_id}")
def update_availability(
    block_id: int, data: AvailabilityIn, background: BackgroundTasks
) -> dict:
    validate_block(data)
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT * FROM availability WHERE id = ?", (block_id,)
        ).fetchone()
        if existing is None:
            raise HTTPException(404, "Intervalo não encontrado.")
        if existing["member"] != data.member:
            raise HTTPException(422, "Não é possível alterar o dono do intervalo.")
        conn.execute(
            """UPDATE availability
               SET start_date = ?, end_date = ?, start_time = ?, end_time = ?
               WHERE id = ?""",
            (
                data.start_date,
                data.end_date,
                data.start_time,
                data.end_time,
                block_id,
            ),
        )
        row = conn.execute(
            "SELECT * FROM availability WHERE id = ?", (block_id,)
        ).fetchone()
    background.add_task(maybe_notify)
    return dict(row)


@app.delete("/api/availability/{block_id}")
def delete_availability(block_id: int, background: BackgroundTasks) -> dict:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM availability WHERE id = ?", (block_id,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Intervalo não encontrado.")
    background.add_task(maybe_notify)
    return {"ok": True}


@app.get("/api/intersection")
def get_intersection() -> dict:
    members = member_names()
    with get_conn() as conn:
        blocks = conn.execute("SELECT * FROM availability").fetchall()
    # Mantém a ordem do CSV apenas para quem já respondeu.
    responded_set = {b["member"] for b in blocks}
    responded = [m for m in members if m in responded_set]
    missing = [m for m in members if m not in responded_set]

    # Resumo por pessoa (em horário de Brasília): janelas de horário distintas
    # que cada um declarou. Serve de diagnóstico quando não há coincidência.
    windows_by_member: dict[str, list[dict]] = {}
    for m in responded:
        wins = sorted({(b["start_time"], b["end_time"]) for b in blocks if b["member"] == m})
        windows_by_member[m] = [{"start": s, "end": e} for s, e in wins]

    # Interseção cumulativa: calculada apenas entre quem já marcou,
    # para que cada pessoa possa preencher com base nas demais.
    return {
        "members": members,
        "responded": responded,
        "missing": missing,
        "windows_by_member": windows_by_member,
        "period": {
            "start": PERIOD_START.isoformat(),
            "end": PERIOD_END.isoformat(),
        },
        "slots": compute_intersection(blocks, responded),
    }


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/", StaticFiles(directory=STATIC_DIR), name="static")

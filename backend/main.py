"""Night Out Together â€” a small group planner for deciding where to go out.

Contract notes:
  * SQLite lives at /data/nightout.db. /data is the only path that survives a
    deploy, and it may be empty or absent at first boot, so init_db() creates
    both the directory and the schema.
  * Serves plain HTTP on :8080 (see Dockerfile). /healthz is the healthcheck.
"""

from __future__ import annotations

import json
import math
import os
import re
import secrets
import sqlite3
from urllib.parse import urlencode
from urllib.request import Request as UrlRequest, urlopen
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.exceptions import HTTPException as StarletteHTTPException

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
DB_PATH = DATA_DIR / "nightout.db"
BASE_DIR = Path(__file__).parent

RADIUS_MILES = 7.0
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no confusable 0/O/1/I

SCHEMA = """
CREATE TABLE IF NOT EXISTS groups (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    plan_when     TEXT NOT NULL DEFAULT '',
    start_date    TEXT NOT NULL DEFAULT '',
    end_date      TEXT NOT NULL DEFAULT '',
    decided_venue INTEGER,
    anchor_lat    REAL,
    anchor_lng    REAL,
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS members (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id    INTEGER NOT NULL,
    token       TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    lat         REAL,
    lng         REAL,
    place       TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'in',
    is_admin    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS venues (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   INTEGER NOT NULL,
    member_id  INTEGER NOT NULL,
    name       TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL DEFAULT 'bar',
    lat        REAL NOT NULL,
    lng        REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS votes (
    venue_id  INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    value     INTEGER NOT NULL,
    PRIMARY KEY (venue_id, member_id)
);
CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   INTEGER NOT NULL,
    member_id  INTEGER,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_members_group ON members(group_id);
CREATE INDEX IF NOT EXISTS idx_venues_group ON venues(group_id);
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, id);
"""


@contextmanager
def db():
    """One short lived connection per request, always closed again."""
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    try:
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    """First boot: /data may be empty or missing entirely."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.executescript(SCHEMA)
        columns = {row[1] for row in conn.execute("PRAGMA table_info(members)")}
        if "is_admin" not in columns:
            conn.execute("ALTER TABLE members ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
        group_columns = {row[1] for row in conn.execute("PRAGMA table_info(groups)")}
        if "start_date" not in group_columns:
            conn.execute("ALTER TABLE groups ADD COLUMN start_date TEXT NOT NULL DEFAULT ''")
        if "end_date" not in group_columns:
            conn.execute("ALTER TABLE groups ADD COLUMN end_date TEXT NOT NULL DEFAULT ''")
        conn.execute(
            "UPDATE members SET is_admin=1 WHERE id IN ("
            "SELECT MIN(id) FROM members GROUP BY group_id HAVING SUM(is_admin)=0"
            ")"
        )


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ANN201
    init_db()
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)
allowed_origins = [origin.strip() for origin in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

# ---------------------------------------------------------------- helpers


def miles_between(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 3958.7613  # earth radius, miles
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def clean(text: str, limit: int) -> str:
    text = re.sub(r"\s", " ", (text or "").strip())
    return text[:limit]


def clean_date(value: str) -> str:
    value = clean(str(value or ""), 10)
    if not value:
        return ""
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "Use a valid calendar date.")
    return value


def reverse_address(lat: float, lng: float) -> str:
    query = urlencode({"lat": lat, "lon": lng, "format": "jsonv2", "zoom": 18})
    request = UrlRequest(
        f"https://nominatim.openstreetmap.org/reverse?{query}",
        headers={"User-Agent": "NightOutTogether/1.0"},
    )
    try:
        with urlopen(request, timeout=5) as response:
            data = json.load(response)
    except Exception:
        return "Address lookup unavailable. Use the map pin instead."
    address = data.get("address", {})
    parts = [
        address.get("house_number"),
        address.get("road"),
        address.get("city") or address.get("town") or address.get("village"),
        address.get("postcode"),
    ]
    return ", ".join(part for part in parts if part) or data.get("display_name", "Address unavailable.")


def new_code(conn: sqlite3.Connection) -> str:
    for _ in range(50):
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))
        if not conn.execute("SELECT 1 FROM groups WHERE code=?", (code,)).fetchone():
            return code
    raise HTTPException(500, "could not allocate a group code")


def cookie_name(code: str) -> str:
    return f"crew_{code}"


def valid_coords(lat, lng) -> bool:
    try:
        lat, lng = float(lat), float(lng)
    except (TypeError, ValueError):
        return False
    return -90 <= lat <= 90 and -180 <= lng <= 180 and not (lat == 0 and lng == 0)


def get_group(conn: sqlite3.Connection, code: str) -> sqlite3.Row:
    row = conn.execute(
        "SELECT * FROM groups WHERE code=?", (code.upper(),)
    ).fetchone()
    if not row:
        raise HTTPException(404, "That crew code does not exist.")
    return row


def get_member(conn: sqlite3.Connection, request: Request, group: sqlite3.Row):
    token = request.cookies.get(cookie_name(group["code"]))
    if not token:
        return None
    return conn.execute(
        "SELECT * FROM members WHERE token=? AND group_id=?", (token, group["id"])
    ).fetchone()


def require_member(conn, request, group) -> sqlite3.Row:
    member = get_member(conn, request, group)
    if not member:
        raise HTTPException(401, "Join the crew first.")
    conn.execute(
        "UPDATE members SET last_seen=? WHERE id=?",
        (datetime.now(timezone.utc).isoformat(timespec="seconds"), member["id"]),
    )
    return member


def require_admin(member: sqlite3.Row) -> sqlite3.Row:
    if not member["is_admin"]:
        raise HTTPException(403, "Only the group admin can change group dates.")
    return member


def group_center(members) -> tuple[float | None, float | None]:
    """Centroid of every member who has shared a location."""
    pts = [(m["lat"], m["lng"]) for m in members if m["lat"] is not None]
    if not pts:
        return None, None
    # Average on the unit sphere so the centroid behaves near the date line.
    x = y = z = 0.0
    for lat, lng in pts:
        a, b = math.radians(lat), math.radians(lng)
        x += math.cos(a) * math.cos(b)
        y += math.cos(a) * math.sin(b)
        z += math.sin(a)
    n = len(pts)
    x, y, z = x / n, y / n, z / n
    lng = math.degrees(math.atan2(y, x))
    lat = math.degrees(math.atan2(z, math.hypot(x, y)))
    return round(lat, 6), round(lng, 6)


def build_state(conn: sqlite3.Connection, group: sqlite3.Row, me: sqlite3.Row) -> dict:
    can_view_locations = bool(me["is_admin"])
    members = conn.execute(
        "SELECT * FROM members WHERE group_id=? ORDER BY id", (group["id"],)
    ).fetchall()
    c_lat, c_lng = group_center(members)
    if c_lat is None:
        c_lat, c_lng = group["anchor_lat"], group["anchor_lng"]

    venues = conn.execute(
        "SELECT * FROM venues WHERE group_id=? ORDER BY id", (group["id"],)
    ).fetchall()
    votes = conn.execute(
        "SELECT v.* FROM votes v JOIN venues n ON n.id=v.venue_id WHERE n.group_id=?",
        (group["id"],),
    ).fetchall()
    msgs = conn.execute(
        "SELECT * FROM messages WHERE group_id=? ORDER BY id DESC LIMIT 200",
        (group["id"],),
    ).fetchall()

    names = {m["id"]: m["name"] for m in members}

    out_members = []
    for m in members:
        can_see_member_location = can_view_locations or bool(m["is_admin"])
        d = None
        if m["lat"] is not None and c_lat is not None:
            d = round(miles_between(m["lat"], m["lng"], c_lat, c_lng), 1)
        out_members.append(
            {
                "id": m["id"],
                "name": m["name"],
                "place": m["place"] if can_see_member_location else "",
                "status": m["status"],
                "lat": m["lat"] if can_see_member_location else None,
                "lng": m["lng"] if can_see_member_location else None,
                "has_location": can_see_member_location and m["lat"] is not None,
                "miles_from_center": d if can_view_locations else None,
                "far": can_view_locations and d is not None and d > RADIUS_MILES,
                "is_me": m["id"] == me["id"],
                "is_admin": bool(m["is_admin"]),
            }
        )

    out_venues = []
    for v in venues:
        vv = [x for x in votes if x["venue_id"] == v["id"]]
        yes = [names.get(x["member_id"], "?") for x in vv if x["value"] == 1]
        maybe = [names.get(x["member_id"], "?") for x in vv if x["value"] == 0]
        no = [names.get(x["member_id"], "?") for x in vv if x["value"] == -1]
        mine = next((x["value"] for x in vv if x["member_id"] == me["id"]), None)
        centre_d = (
            round(miles_between(v["lat"], v["lng"], c_lat, c_lng), 1)
            if c_lat is not None
            else None
        )
        walks = []
        for m in members:
            if m["lat"] is None:
                continue
            walks.append(
                {
                    "name": m["name"],
                    "miles": round(miles_between(m["lat"], m["lng"], v["lat"], v["lng"]), 1),
                }
            )
        worst = max((w["miles"] for w in walks), default=None)
        out_venues.append(
            {
                "id": v["id"],
                "name": v["name"],
                "note": v["note"],
                "kind": v["kind"],
                "lat": v["lat"] if can_view_locations else None,
                "lng": v["lng"] if can_view_locations else None,
                "proposer": names.get(v["member_id"], "someone"),
                "mine": v["member_id"] == me["id"],
                "miles_from_center": centre_d if can_view_locations else None,
                "in_radius": (centre_d is not None and centre_d <= RADIUS_MILES) if can_view_locations else None,
                "furthest_member_miles": worst if can_view_locations else None,
                "trips": sorted(walks, key=lambda w: w["miles"]) if can_view_locations else [],
                "yes": yes,
                "maybe": maybe,
                "no": no,
                "score": len(yes) * 2 + len(maybe) - len(no) * 2,
                "my_vote": mine,
                "decided": group["decided_venue"] == v["id"],
            }
        )
    out_venues.sort(key=lambda v: (-int(v["decided"]), -v["score"], v["id"]))

    return {
        "group": {
            "code": group["code"],
            "name": group["name"],
            "plan_when": group["plan_when"],
            "start_date": group["start_date"],
            "end_date": group["end_date"],
            "decided_venue": group["decided_venue"],
        },
        "radius_miles": RADIUS_MILES,
         "can_view_locations": can_view_locations,
         "center": {"lat": c_lat, "lng": c_lng} if can_view_locations else {"lat": None, "lng": None},
        "me": {"id": me["id"], "name": me["name"], "status": me["status"], "is_admin": bool(me["is_admin"]),
             "place": me["place"], "lat": me["lat"] if can_view_locations else None,
             "lng": me["lng"] if can_view_locations else None},
        "members": out_members,
        "venues": out_venues,
        "messages": [
            {
                "id": m["id"],
                "author": names.get(m["member_id"], "Night Out"),
                "system": m["member_id"] is None,
                "mine": m["member_id"] == me["id"],
                "body": m["body"],
                "at": m["created_at"],
            }
            for m in reversed(msgs)
        ],
    }


def system_message(conn, group_id: int, body: str) -> None:
    conn.execute(
        "INSERT INTO messages (group_id, member_id, body) VALUES (?, NULL, ?)",
        (group_id, body),
    )


def script_json(data: dict) -> str:
    """JSON safe to drop inside a <script> block: no raw < > & to break out of it."""
    return (
        json.dumps(data)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
    )


async def payload(request: Request) -> dict:
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


# ------------------------------------------------------------------ pages


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse(
        request, "index.html", {"radius": int(RADIUS_MILES)}
    )


@app.post("/create")
async def create(
    request: Request,
    group_name: str = Form(""),
    name: str = Form(...),
    lat: str = Form(""),
    lng: str = Form(""),
    place: str = Form(""),
    start_date: str = Form(""),
    end_date: str = Form(""),
):
    person = clean(name, 30) or "Someone"
    crew = clean(group_name, 40) or "Tonight's crew"
    has_loc = valid_coords(lat, lng)
    start_date = clean_date(start_date)
    end_date = clean_date(end_date)
    if start_date and end_date and end_date < start_date:
        raise HTTPException(400, "The end date must be on or after the start date.")
    with db() as conn:
        code = new_code(conn)
        cur = conn.execute(
            "INSERT INTO groups (code, name, start_date, end_date, anchor_lat, anchor_lng) VALUES (?,?,?,?,?,?)",
            (code, crew, start_date, end_date,
             float(lat) if has_loc else None, float(lng) if has_loc else None),
        )
        gid = cur.lastrowid
        token = secrets.token_urlsafe(24)
        conn.execute(
            "INSERT INTO members (group_id, token, name, lat, lng, place, is_admin) VALUES (?,?,?,?,?,?,1)",
            (gid, token, person,
             float(lat) if has_loc else None, float(lng) if has_loc else None,
             clean(place, 60)),
        )
        system_message(conn, gid, f"{person} started the crew. Share the code {code}.")
    resp = RedirectResponse(f"/g/{code}", status_code=303)
    set_cookie(resp, code, token)
    return resp


def set_cookie(resp, code: str, token: str) -> None:
    resp.set_cookie(
        cookie_name(code),
        token,
        max_age=60 * 60 * 24 * 120,
        httponly=True,
        samesite="lax",
        path="/",
    )


@app.post("/join")
def join_redirect(code: str = Form("")):
    code = re.sub(r"[^A-Za-z0-9]", "", code).upper()[:6]
    if not code:
        return RedirectResponse("/?e=code", status_code=303)
    return RedirectResponse(f"/g/{code}", status_code=303)


@app.get("/g/{code}", response_class=HTMLResponse)
def group_page(request: Request, code: str):
    code = code.upper()
    with db() as conn:
        group = get_group(conn, code)
        member = get_member(conn, request, group)
        headcount = conn.execute(
            "SELECT COUNT(*) c FROM members WHERE group_id=?", (group["id"],)
        ).fetchone()["c"]
        if not member:
            return templates.TemplateResponse(
                request,
                "join.html",
                {
                    "group": group,
                    "headcount": headcount,
                    "radius": int(RADIUS_MILES),
                },
            )
        state = build_state(conn, group, member)
    return templates.TemplateResponse(
        request,
        "group.html",
        {
            "group": group,
            "radius": int(RADIUS_MILES),
            "state_json": script_json(state),
        },
    )


@app.post("/g/{code}/join")
async def join_group(
    request: Request,
    code: str,
    name: str = Form(...),
    lat: str = Form(""),
    lng: str = Form(""),
    place: str = Form(""),
):
    code = code.upper()
    person = clean(name, 30) or "Someone"
    has_loc = valid_coords(lat, lng)
    with db() as conn:
        group = get_group(conn, code)
        existing = get_member(conn, request, group)
        if existing:
            return RedirectResponse(f"/g/{code}", status_code=303)
        token = secrets.token_urlsafe(24)
        conn.execute(
            "INSERT INTO members (group_id, token, name, lat, lng, place, is_admin) VALUES (?,?,?,?,?,?,0)",
            (group["id"], token, person,
             float(lat) if has_loc else None, float(lng) if has_loc else None,
             clean(place, 60)),
        )
        system_message(conn, group["id"], f"{person} joined the crew.")
    resp = RedirectResponse(f"/g/{code}", status_code=303)
    set_cookie(resp, code, token)
    return resp


# -------------------------------------------------------------------- api


@app.get("/api/g/{code}/state")
def api_state(request: Request, code: str):
    with db() as conn:
        group = get_group(conn, code)
        me = require_member(conn, request, group)
        return build_state(conn, group, me)


@app.get("/api/g/{code}/admin-location")
def api_admin_location(request: Request, code: str):
    with db() as conn:
        group = get_group(conn, code)
        me = require_admin(require_member(conn, request, group))
        if me["lat"] is None or me["lng"] is None:
            raise HTTPException(400, "Set your location before looking up your address.")
        return {
            "address": reverse_address(me["lat"], me["lng"]),
            "radius_miles": RADIUS_MILES,
            "message": "Other member locations are shown as an approximate planning window.",
        }


@app.post("/api/g/{code}/me")
async def api_me(request: Request, code: str):
    data = await payload(request)
    with db() as conn:
        group = get_group(conn, code)
        me = require_member(conn, request, group)
        if "name" in data:
            conn.execute(
                "UPDATE members SET name=? WHERE id=?",
                (clean(str(data["name"]), 30) or me["name"], me["id"]),
            )
        if "status" in data and data["status"] in ("in", "maybe", "out"):
            conn.execute(
                "UPDATE members SET status=? WHERE id=?", (data["status"], me["id"])
            )
        if "lat" in data and "lng" in data:
            if not valid_coords(data["lat"], data["lng"]):
                raise HTTPException(400, "That location did not look right.")
            conn.execute(
                "UPDATE members SET lat=?, lng=?, place=? WHERE id=?",
                (float(data["lat"]), float(data["lng"]),
                 clean(str(data.get("place", me["place"])), 60), me["id"]),
            )
        elif "place" in data:
            conn.execute(
                "UPDATE members SET place=? WHERE id=?",
                (clean(str(data["place"]), 60), me["id"]),
            )
        me = conn.execute("SELECT * FROM members WHERE id=?", (me["id"],)).fetchone()
        return build_state(conn, get_group(conn, code), me)


@app.post("/api/g/{code}/plan")
async def api_plan(request: Request, code: str):
    data = await payload(request)
    with db() as conn:
        group = get_group(conn, code)
        me = require_admin(require_member(conn, request, group))
        when = clean(str(data.get("when", "")), 60)
        start_date = clean_date(data.get("start_date", group["start_date"]))
        end_date = clean_date(data.get("end_date", group["end_date"]))
        if start_date and end_date and end_date < start_date:
            raise HTTPException(400, "The end date must be on or after the start date.")
        conn.execute(
            "UPDATE groups SET plan_when=?, start_date=?, end_date=? WHERE id=?",
            (when, start_date, end_date, group["id"]),
        )
        if when or start_date or end_date:
            dates = f"{start_date or 'open start'} to {end_date or 'open end'}"
            system_message(conn, group["id"], f"{me['name']} updated the plan: {dates}")
        return build_state(conn, get_group(conn, code), me)


@app.post("/api/g/{code}/venue")
async def api_venue(request: Request, code: str):
    data = await payload(request)
    with db() as conn:
        group = get_group(conn, code)
        me = require_member(conn, request, group)
        name = clean(str(data.get("name", "")), 60)
        if not name:
            raise HTTPException(400, "Give the spot a name.")
        if not valid_coords(data.get("lat"), data.get("lng")):
            raise HTTPException(400, "Pin the spot on the map first.")
        lat, lng = float(data["lat"]), float(data["lng"])

        members = conn.execute(
            "SELECT * FROM members WHERE group_id=?", (group["id"],)
        ).fetchall()
        c_lat, c_lng = group_center(members)
        if c_lat is None:
            c_lat, c_lng = group["anchor_lat"], group["anchor_lng"]
        if c_lat is not None:
            d = miles_between(lat, lng, c_lat, c_lng)
            if d > RADIUS_MILES:
                raise HTTPException(
                    400,
                    f"That spot is {d:.1f} miles from the crew's centre. "
                    f"The rule is {int(RADIUS_MILES)} miles, so it is out.",
                )
        kind = str(data.get("kind", "bar"))
        if kind not in ("bar", "pub", "club", "cocktails", "food", "other"):
            kind = "other"
        cur = conn.execute(
            "INSERT INTO venues (group_id, member_id, name, note, kind, lat, lng)"
            " VALUES (?,?,?,?,?,?,?)",
            (group["id"], me["id"], name, clean(str(data.get("note", "")), 140),
             kind, lat, lng),
        )
        conn.execute(
            "INSERT OR REPLACE INTO votes (venue_id, member_id, value) VALUES (?,?,1)",
            (cur.lastrowid, me["id"]),
        )
        system_message(conn, group["id"], f"{me['name']} put {name} on the list.")
        return build_state(conn, get_group(conn, code), me)


@app.post("/api/g/{code}/vote")
async def api_vote(request: Request, code: str):
    data = await payload(request)
    with db() as conn:
        group = get_group(conn, code)
        me = require_member(conn, request, group)
        try:
            venue_id = int(data.get("venue_id"))
            value = int(data.get("value"))
        except (TypeError, ValueError):
            raise HTTPException(400, "Bad vote.")
        if value not in (-1, 0, 1):
            raise HTTPException(400, "Bad vote.")
        owned = conn.execute(
            "SELECT 1 FROM venues WHERE id=? AND group_id=?", (venue_id, group["id"])
        ).fetchone()
        if not owned:
            raise HTTPException(404, "No such spot.")
        current = conn.execute(
            "SELECT value FROM votes WHERE venue_id=? AND member_id=?",
            (venue_id, me["id"]),
        ).fetchone()
        if current and current["value"] == value:
            conn.execute(
                "DELETE FROM votes WHERE venue_id=? AND member_id=?",
                (venue_id, me["id"]),
            )
        else:
            conn.execute(
                "INSERT OR REPLACE INTO votes (venue_id, member_id, value) VALUES (?,?,?)",
                (venue_id, me["id"], value),
            )
        return build_state(conn, group, me)


@app.delete("/api/g/{code}/venue/{venue_id}")
def api_venue_delete(request: Request, code: str, venue_id: int):
    with db() as conn:
        group = get_group(conn, code)
        me = require_member(conn, request, group)
        v = conn.execute(
            "SELECT * FROM venues WHERE id=? AND group_id=?", (venue_id, group["id"])
        ).fetchone()
        if not v:
            raise HTTPException(404, "No such spot.")
        if v["member_id"] != me["id"]:
            raise HTTPException(403, "Only the person who suggested it can remove it.")
        conn.execute("DELETE FROM votes WHERE venue_id=?", (venue_id,))
        conn.execute("DELETE FROM venues WHERE id=?", (venue_id,))
        if group["decided_venue"] == venue_id:
            conn.execute(
                "UPDATE groups SET decided_venue=NULL WHERE id=?", (group["id"],)
            )
        system_message(conn, group["id"], f"{me['name']} removed {v['name']}.")
        return build_state(conn, get_group(conn, code), me)


@app.post("/api/g/{code}/decide")
async def api_decide(request: Request, code: str):
    data = await payload(request)
    with db() as conn:
        group = get_group(conn, code)
        me = require_member(conn, request, group)
        raw = data.get("venue_id")
        if raw in (None, "", 0):
            conn.execute("UPDATE groups SET decided_venue=NULL WHERE id=?", (group["id"],))
            system_message(conn, group["id"], f"{me['name']} reopened the vote.")
        else:
            venue_id = int(raw)
            v = conn.execute(
                "SELECT * FROM venues WHERE id=? AND group_id=?",
                (venue_id, group["id"]),
            ).fetchone()
            if not v:
                raise HTTPException(404, "No such spot.")
            conn.execute(
                "UPDATE groups SET decided_venue=? WHERE id=?", (venue_id, group["id"])
            )
            system_message(conn, group["id"], f"It is locked in: {v['name']}. See you there.")
        return build_state(conn, get_group(conn, code), me)


@app.post("/api/g/{code}/message")
async def api_message(request: Request, code: str):
    data = await payload(request)
    with db() as conn:
        group = get_group(conn, code)
        me = require_member(conn, request, group)
        body = clean(str(data.get("body", "")), 400)
        if not body:
            raise HTTPException(400, "Say something first.")
        conn.execute(
            "INSERT INTO messages (group_id, member_id, body) VALUES (?,?,?)",
            (group["id"], me["id"], body),
        )
        return build_state(conn, group, me)


@app.post("/api/g/{code}/leave")
def api_leave(request: Request, code: str):
    with db() as conn:
        group = get_group(conn, code)
        me = require_member(conn, request, group)
        system_message(conn, group["id"], f"{me['name']} left the crew.")
        conn.execute(
            "DELETE FROM votes WHERE member_id=? AND venue_id IN"
            " (SELECT id FROM venues WHERE group_id=?)",
            (me["id"], group["id"]),
        )
        conn.execute("DELETE FROM members WHERE id=?", (me["id"],))
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(cookie_name(code), path="/")
    return resp


@app.delete("/api/g/{code}")
def api_group_delete(request: Request, code: str):
    with db() as conn:
        group = get_group(conn, code)
        me = require_admin(require_member(conn, request, group))
        conn.execute(
            "DELETE FROM votes WHERE venue_id IN (SELECT id FROM venues WHERE group_id=?)",
            (group["id"],),
        )
        conn.execute("DELETE FROM messages WHERE group_id=?", (group["id"],))
        conn.execute("DELETE FROM venues WHERE group_id=?", (group["id"],))
        conn.execute("DELETE FROM members WHERE group_id=?", (group["id"],))
        conn.execute("DELETE FROM groups WHERE id=?", (group["id"],))
    resp = JSONResponse({"ok": True, "deleted_by": me["name"]})
    resp.delete_cookie(cookie_name(code), path="/")
    return resp


@app.exception_handler(StarletteHTTPException)
async def http_error(request: Request, exc: StarletteHTTPException):
    if request.url.path.startswith("/api/"):
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code)
    detail = exc.detail if exc.status_code != 404 else (
        "That page is not here. Check the crew link, or start a new night."
    )
    return templates.TemplateResponse(
        request,
        "error.html",
        {"detail": detail, "status": exc.status_code},
        status_code=exc.status_code,
    )

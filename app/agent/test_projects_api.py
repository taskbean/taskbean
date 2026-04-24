"""Unit tests for project management API endpoints.

These tests create a temp SQLite DB with the correct schema and patch
_get_taskbean_db / _get_taskbean_db_rw so no real taskbean DB or Foundry
Local SDK is needed.  The FastAPI app is tested in-process via TestClient.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent))
from main import app  # noqa: E402


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def temp_db(tmp_path):
    """Create a temp DB with projects + todos schema."""
    db_path = str(tmp_path / "taskbean.db")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("""CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        tracked INTEGER DEFAULT 0,
        skill_installed INTEGER DEFAULT 0,
        hidden INTEGER DEFAULT 0,
        category TEXT DEFAULT NULL,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    )""")
    conn.execute("""CREATE TABLE todos (
        id TEXT PRIMARY KEY,
        title TEXT,
        emoji TEXT,
        due_date TEXT,
        due_time TEXT,
        completed INTEGER DEFAULT 0,
        reminder INTEGER DEFAULT 0,
        remind_at TEXT,
        reminder_fired INTEGER DEFAULT 0,
        source TEXT,
        priority TEXT DEFAULT 'none',
        notes TEXT,
        tags TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        project TEXT,
        project_path TEXT,
        upsert_key TEXT,
        session_id TEXT,
        agent TEXT,
        agent_session_id TEXT
    )""")
    conn.commit()
    yield conn, db_path
    conn.close()


@pytest.fixture
def seeded_db(temp_db):
    """Seed the temp DB with sample projects and todos."""
    conn, path = temp_db
    conn.executemany(
        "INSERT INTO projects (id, name, path, tracked, hidden, category, skill_installed) VALUES (?,?,?,?,?,?,?)",
        [
            ("p1", "alpha",   "/home/user/alpha",   1, 0, "work",     1),
            ("p2", "beta",    "/home/user/beta",     1, 0, "personal", 0),
            ("p3", "hidden1", "/home/user/hidden1",  1, 1, "work",     0),
            ("p4", "untracked", "/home/user/untracked", 0, 0, None,    0),
        ],
    )
    conn.executemany(
        "INSERT INTO todos (id, title, completed, project) VALUES (?,?,?,?)",
        [
            ("t1", "task one",   0, "alpha"),
            ("t2", "task two",   1, "alpha"),
            ("t3", "task three", 0, "beta"),
        ],
    )
    conn.commit()
    return conn, path


def _make_ro_conn(path: str):
    """Open a read-only connection matching _get_taskbean_db's contract."""
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _make_rw_conn(path: str):
    """Open a read-write connection matching _get_taskbean_db_rw's contract."""
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


@pytest.fixture
def client(seeded_db):
    """TestClient with patched DB accessors pointing at the seeded temp DB."""
    _conn, path = seeded_db
    with patch("main._get_taskbean_db", side_effect=lambda: _make_ro_conn(path)), \
         patch("main._get_taskbean_db_rw", side_effect=lambda: _make_rw_conn(path)):
        with TestClient(app) as c:
            yield c


# ── GET /api/projects ─────────────────────────────────────────────────────────

class TestGetProjects:
    def test_returns_tracked_non_hidden(self, client):
        r = client.get("/api/projects")
        assert r.status_code == 200
        data = r.json()
        names = {p["name"] for p in data}
        assert "alpha" in names
        assert "beta" in names
        assert "hidden1" not in names, "hidden project should be excluded by default"
        assert "untracked" not in names, "untracked project should be excluded"

    def test_includes_todo_counts(self, client):
        r = client.get("/api/projects")
        by_name = {p["name"]: p for p in r.json()}
        alpha = by_name["alpha"]
        assert alpha["total"] == 2
        assert alpha["done"] == 1
        assert alpha["pending"] == 1
        beta = by_name["beta"]
        assert beta["total"] == 1
        assert beta["done"] == 0
        assert beta["pending"] == 1

    def test_show_hidden_includes_all(self, client):
        r = client.get("/api/projects", params={"show_hidden": "true"})
        assert r.status_code == 200
        names = {p["name"] for p in r.json()}
        assert "hidden1" in names
        assert "alpha" in names

    def test_filter_by_category(self, client):
        r = client.get("/api/projects", params={"category": "work"})
        assert r.status_code == 200
        data = r.json()
        # Only non-hidden work projects (hidden1 is work but hidden)
        names = {p["name"] for p in data}
        assert names == {"alpha"}

    def test_filter_by_category_with_show_hidden(self, client):
        r = client.get("/api/projects", params={"category": "work", "show_hidden": "true"})
        names = {p["name"] for p in r.json()}
        assert names == {"alpha", "hidden1"}

    def test_empty_when_no_db(self):
        """If _get_taskbean_db returns None the endpoint returns []."""
        with patch("main._get_taskbean_db", return_value=None):
            with TestClient(app) as c:
                r = c.get("/api/projects")
                assert r.status_code == 200
                assert r.json() == []


# ── POST /api/projects/{name}/hide ────────────────────────────────────────────

class TestHideProject:
    def test_hide_success(self, client, seeded_db):
        conn, path = seeded_db
        r = client.post("/api/projects/alpha/hide")
        assert r.status_code == 200
        assert r.json() == {"status": "hidden", "project": "alpha"}
        # Verify DB was updated
        ro = _make_ro_conn(path)
        row = ro.execute("SELECT hidden FROM projects WHERE name = 'alpha'").fetchone()
        ro.close()
        assert row["hidden"] == 1

    def test_hide_nonexistent_returns_404(self, client):
        r = client.post("/api/projects/nope/hide")
        assert r.status_code == 404
        assert "not found" in r.json()["detail"].lower()


# ── POST /api/projects/{name}/show ────────────────────────────────────────────

class TestShowProject:
    def test_show_success(self, client, seeded_db):
        conn, path = seeded_db
        r = client.post("/api/projects/hidden1/show")
        assert r.status_code == 200
        assert r.json() == {"status": "visible", "project": "hidden1"}
        ro = _make_ro_conn(path)
        row = ro.execute("SELECT hidden FROM projects WHERE name = 'hidden1'").fetchone()
        ro.close()
        assert row["hidden"] == 0

    def test_show_nonexistent_returns_404(self, client):
        r = client.post("/api/projects/nope/show")
        assert r.status_code == 404


# ── POST /api/projects/{name}/category ────────────────────────────────────────

class TestSetCategory:
    def test_set_category(self, client, seeded_db):
        conn, path = seeded_db
        r = client.post("/api/projects/beta/category", json={"category": "work"})
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "updated"
        assert body["category"] == "work"
        ro = _make_ro_conn(path)
        row = ro.execute("SELECT category FROM projects WHERE name = 'beta'").fetchone()
        ro.close()
        assert row["category"] == "work"

    def test_clear_category(self, client, seeded_db):
        conn, path = seeded_db
        r = client.post("/api/projects/alpha/category", json={"category": None})
        assert r.status_code == 200
        assert r.json()["category"] is None
        ro = _make_ro_conn(path)
        row = ro.execute("SELECT category FROM projects WHERE name = 'alpha'").fetchone()
        ro.close()
        assert row["category"] is None

    def test_category_nonexistent_returns_404(self, client):
        r = client.post("/api/projects/nope/category", json={"category": "x"})
        assert r.status_code == 404

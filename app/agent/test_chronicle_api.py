from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent))
from main import app  # noqa: E402


def _make_ro_conn(path: str):
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _make_rw_conn(path: str):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


@pytest.fixture
def chronicle_db(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    db_path = str(tmp_path / "taskbean.db")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL UNIQUE,
            tracked INTEGER DEFAULT 0,
            skill_installed INTEGER DEFAULT 0,
            hidden INTEGER DEFAULT 0,
            category TEXT DEFAULT NULL,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );
        CREATE TABLE todos (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            completed INTEGER DEFAULT 0,
            source TEXT DEFAULT 'manual',
            priority TEXT DEFAULT 'none',
            notes TEXT,
            tags TEXT DEFAULT '[]',
            project TEXT,
            project_path TEXT,
            status TEXT DEFAULT 'pending',
            created_at TEXT NOT NULL
        );
        CREATE TABLE reconciliation_suggestions (
            id TEXT PRIMARY KEY,
            evidence_key TEXT NOT NULL UNIQUE,
            suggested_title TEXT NOT NULL,
            suggested_project TEXT,
            suggested_status TEXT DEFAULT 'pending',
            source_session_ids TEXT NOT NULL DEFAULT '[]',
            evidence_summary TEXT NOT NULL,
            confidence REAL NOT NULL DEFAULT 0,
            state TEXT NOT NULL DEFAULT 'pending',
            linked_todo_id TEXT REFERENCES todos(id) ON DELETE SET NULL,
            auto_linked INTEGER DEFAULT 0,
            decision_reason TEXT,
            decision_details TEXT,
            occurred_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            decided_at TEXT,
            raw_prompt TEXT,
            raw_response TEXT
        );
        CREATE TABLE task_evidence (
            id TEXT PRIMARY KEY,
            todo_id TEXT REFERENCES todos(id) ON DELETE SET NULL,
            suggestion_id TEXT REFERENCES reconciliation_suggestions(id) ON DELETE CASCADE,
            source TEXT NOT NULL,
            source_session_id TEXT NOT NULL,
            repo TEXT,
            project_path TEXT,
            branch TEXT,
            pr_refs TEXT NOT NULL DEFAULT '[]',
            issue_refs TEXT NOT NULL DEFAULT '[]',
            files_changed TEXT NOT NULL DEFAULT '[]',
            summary TEXT,
            confidence REAL NOT NULL DEFAULT 0,
            occurred_at TEXT,
            created_at TEXT NOT NULL,
            raw_tool_output TEXT
        );
        INSERT INTO projects (id, name, path, tracked, hidden) VALUES
          ('p1', 'taskbean', 'C:\\dev\\taskbean', 1, 0),
          ('p2', 'hidden', 'C:\\dev\\hidden', 1, 1);
        INSERT INTO todos (id, title, completed, source, priority, tags, project, project_path, status, created_at)
          VALUES ('todo-1', 'Canonical task', 0, 'agent', 'none', '[]', 'taskbean', 'C:\\dev\\taskbean', 'pending', '2026-01-01T09:00:00Z');
        INSERT INTO todos (id, title, completed, source, priority, tags, project, project_path, status, created_at)
          VALUES ('todo-hidden', 'Hidden canonical task', 0, 'agent', 'none', '[]', 'hidden', 'C:\\dev\\hidden', 'pending', '2026-01-01T09:00:00Z');
        INSERT INTO reconciliation_suggestions (
          id, evidence_key, suggested_title, suggested_project, suggested_status,
          source_session_ids, evidence_summary, confidence, state, occurred_at, created_at, updated_at,
          raw_prompt, raw_response
        ) VALUES
          ('sug-pending-0001', 'ev-1', 'Review Chronicle API', 'taskbean', 'pending',
           '["session-1"]', 'Implemented API endpoints from Chronicle metadata', 0.82, 'pending',
           '2026-01-01T10:00:00Z',
           '2026-01-01T10:00:00Z', '2026-01-01T10:00:00Z',
           'DO-NOT-EXPORT-RAW-PROMPT', 'DO-NOT-EXPORT-RAW-RESPONSE'),
          ('sug-hidden-0001', 'ev-hidden', 'Hidden project work', 'hidden', 'pending',
           '["session-hidden"]', 'Hidden project metadata summary', 0.5, 'pending',
           '2026-01-01T10:00:00Z',
           '2026-01-01T10:00:00Z', '2026-01-01T10:00:00Z', NULL, NULL),
          ('sug-hidden-null-project-0001', 'ev-hidden-null', 'Hidden project work without project name', NULL, 'pending',
           '["session-hidden-null"]', 'Hidden evidence path metadata summary', 0.5, 'pending',
           '2026-01-01T10:00:00Z',
           '2026-01-01T10:00:00Z', '2026-01-01T10:00:00Z', NULL, NULL);
        INSERT INTO task_evidence (
          id, todo_id, suggestion_id, source, source_session_id, repo, project_path,
          branch, pr_refs, issue_refs, files_changed, summary, confidence, occurred_at, created_at,
          raw_tool_output
        ) VALUES
          ('tev-1', NULL, 'sug-pending-0001', 'copilot', 'session-1', 'taskbean/taskbean',
           'C:\\dev\\taskbean', 'chronicle-api', '["#41"]', '["#40"]',
           '["app/agent/main.py"]', 'Safe evidence summary', 0.82, '2026-01-01T10:00:00Z', '2026-01-01T10:05:00Z',
           'DO-NOT-EXPORT-RAW-TOOL-OUTPUT'),
          ('tev-hidden', NULL, 'sug-hidden-0001', 'copilot', 'session-hidden', 'taskbean/taskbean',
           'C:\\dev\\hidden', 'hidden', '[]', '[]', '[]', 'Hidden evidence summary', 0.5,
           '2026-01-01T10:00:00Z', '2026-01-01T10:05:00Z', NULL),
          ('tev-hidden-null', NULL, 'sug-hidden-null-project-0001', 'copilot', 'session-hidden-null', 'taskbean/taskbean',
           'C:\\dev\\hidden', 'hidden', '[]', '[]', '[]', 'Hidden null-project evidence summary', 0.5,
           '2026-01-01T10:00:00Z', '2026-01-01T10:05:00Z', NULL);
        INSERT INTO reconciliation_suggestions (
          id, evidence_key, suggested_title, suggested_project, suggested_status,
          source_session_ids, evidence_summary, confidence, state, linked_todo_id,
          auto_linked, decision_reason, decision_details, occurred_at, created_at, updated_at, decided_at
        ) VALUES (
          'sug-auto-0001', 'ev-auto', 'Canonical task', 'taskbean', 'pending',
          '["session-auto"]', 'Auto-linked metadata summary', 0.95, 'linked', 'todo-1',
          1, 'same project, title overlap, same branch',
          '{"confidence":0.95,"matchedSignals":["same project","title overlap","same branch"],"missingSignals":[]}',
          '2026-01-01T10:10:00Z', '2026-01-01T10:10:00Z', '2026-01-01T10:10:00Z', '2026-01-01T10:11:00Z'
        );
        INSERT INTO task_evidence (
          id, todo_id, suggestion_id, source, source_session_id, repo, project_path,
          branch, pr_refs, issue_refs, files_changed, summary, confidence, occurred_at, created_at,
          raw_tool_output
        ) VALUES (
          'tev-auto', 'todo-1', 'sug-auto-0001', 'copilot', 'session-auto', 'taskbean/taskbean',
          'C:\\dev\\taskbean', 'chronicle-api', '["#41"]', '["#40"]',
          '["app/agent/main.py"]', 'Auto-linked evidence summary', 0.95,
          '2026-01-01T10:10:00Z', '2026-01-01T10:11:00Z', NULL
        );
        INSERT INTO reconciliation_suggestions (
          id, evidence_key, suggested_title, suggested_project, suggested_status,
          source_session_ids, evidence_summary, confidence, state, linked_todo_id,
          auto_linked, decision_reason, decision_details, occurred_at, created_at, updated_at, decided_at
        ) VALUES (
          'sug-auto-hidden-0001', 'ev-auto-hidden', 'Hidden canonical task', 'hidden', 'pending',
          '["session-auto-hidden"]', 'Hidden auto-linked metadata summary', 0.95, 'linked', 'todo-hidden',
          1, 'same project, title overlap, same branch',
          '{"confidence":0.95,"matchedSignals":["same project","title overlap","same branch"],"missingSignals":[]}',
          '2026-01-01T10:12:00Z', '2026-01-01T10:12:00Z', '2026-01-01T10:12:00Z', '2026-01-01T10:13:00Z'
        );
        INSERT INTO task_evidence (
          id, todo_id, suggestion_id, source, source_session_id, repo, project_path,
          branch, pr_refs, issue_refs, files_changed, summary, confidence, occurred_at, created_at,
          raw_tool_output
        ) VALUES (
          'tev-auto-hidden', 'todo-hidden', 'sug-auto-hidden-0001', 'copilot', 'session-auto-hidden', 'taskbean/taskbean',
          'C:\\dev\\hidden', 'hidden-branch', '[]', '[]',
          '["app/agent/main.py"]', 'Hidden auto-linked evidence summary', 0.95,
          '2026-01-01T10:12:00Z', '2026-01-01T10:13:00Z', NULL
        );
        """
    )
    conn.commit()
    conn.close()
    return db_path


@pytest.fixture
def client(chronicle_db):
    with patch("main._get_taskbean_db", side_effect=lambda: _make_ro_conn(chronicle_db)), \
         patch("main._get_taskbean_db_rw", side_effect=lambda: _make_rw_conn(chronicle_db)):
        with TestClient(app) as c:
            yield c


def test_lists_chronicle_suggestions_by_status(client):
    response = client.get("/api/chronicle/suggestions", params={"status": "pending"})
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "pending"
    assert data["count"] == 3
    suggestion = next(s for s in data["suggestions"] if s["id"] == "sug-pending-0001")
    assert suggestion["occurred_at"] == "2026-01-01T10:00:00Z"
    assert suggestion["evidence"][0]["files_changed"] == ["app/agent/main.py"]
    assert suggestion["evidence"][0]["occurred_at"] == "2026-01-01T10:00:00Z"
    assert "DO-NOT-EXPORT" not in response.text


def test_approves_suggestion_and_rejects_repeated_decision(client):
    first = client.post(
        "/api/chronicle/suggestions/sug-pending-0001/approve",
        json={"status": "done", "tags": ["weekly-review"]},
    )
    assert first.status_code == 200
    body = first.json()
    assert body["action"] == "approve"
    assert body["suggestion"]["state"] == "approved"
    assert body["task"]["source"] == "chronicle"
    assert body["task"]["completed"] is True
    assert body["task"]["created_at"] == "2026-01-01T10:00:00Z"
    assert body["suggestion"]["evidence"][0]["todo_id"] == body["task"]["id"]

    repeated = client.post("/api/chronicle/suggestions/sug-pending-0001/ignore")
    assert repeated.status_code == 409
    assert "already approved" in repeated.json()["detail"]


def test_approve_accepts_work_date_override(client):
    response = client.post(
        "/api/chronicle/suggestions/sug-pending-0001/approve",
        json={"title": "Retroactive Chronicle task", "workDate": "2026-01-03"},
    )
    assert response.status_code == 200
    assert response.json()["task"]["created_at"] == "2026-01-03T00:00:00Z"


def test_ignores_pending_suggestion(client):
    response = client.post("/api/chronicle/suggestions/sug-hidden-0001/ignore")
    assert response.status_code == 200
    body = response.json()
    assert body["action"] == "ignore"
    assert body["suggestion"]["state"] == "ignored"
    assert body["suggestion"]["decided_at"]


def test_links_suggestion_to_existing_task_and_returns_task_detail_evidence(client):
    link = client.post(
        "/api/chronicle/suggestions/sug-pending-0001/link",
        json={"todoId": "todo-1"},
    )
    assert link.status_code == 200
    assert link.json()["suggestion"]["state"] == "linked"

    detail = client.get("/api/task-detail/todo-1")
    assert detail.status_code == 200
    data = detail.json()
    assert data["evidence"][0]["suggestion_id"] == "sug-pending-0001"
    assert data["evidence"][0]["summary"] == "Safe evidence summary"


def test_report_preview_includes_auto_linked_audit_rows(client):
    response = client.get("/api/reports/preview", params={"date": "all"})
    assert response.status_code == 200
    auto_linked = response.json()["chronicle"]["autoLinked"]
    assert len(auto_linked) == 1
    assert auto_linked[0]["id"] == "sug-auto-0001"
    assert auto_linked[0]["auto_linked"] is True
    assert auto_linked[0]["decision_reason"] == "same project, title overlap, same branch"
    assert auto_linked[0]["decision_details"]["confidence"] == 0.95


def test_report_preview_filters_hidden_auto_linked_audit_rows(client):
    default_response = client.get("/api/reports/preview", params={"date": "all"})
    assert default_response.status_code == 200
    assert [s["id"] for s in default_response.json()["chronicle"]["autoLinked"]] == ["sug-auto-0001"]

    scoped_response = client.get("/api/reports/preview", params={"date": "all", "project": "hidden"})
    assert scoped_response.status_code == 200
    assert [s["id"] for s in scoped_response.json()["chronicle"]["autoLinked"]] == ["sug-auto-hidden-0001"]


def test_undo_auto_link_returns_suggestion_to_pending_review(client):
    response = client.post("/api/chronicle/suggestions/sug-auto-0001/undo-auto-link")
    assert response.status_code == 200
    body = response.json()
    assert body["action"] == "undo-auto-link"
    assert body["suggestion"]["state"] == "pending"
    assert body["suggestion"]["linked_todo_id"] is None
    assert body["suggestion"]["auto_linked"] is False
    assert body["suggestion"]["evidence"][0]["todo_id"] is None


def test_invalid_link_returns_explicit_404(client):
    response = client.post(
        "/api/chronicle/suggestions/sug-pending-0001/link",
        json={"todoId": "missing-task"},
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "Task missing-task not found"


def test_report_preview_includes_chronicle_scope_and_unavailable_state(client):
    response = client.get("/api/reports/preview", params={"date": "all"})
    assert response.status_code == 200
    data = response.json()
    assert data["chronicle"]["available"] is False
    assert data["chronicle"]["summary"]["pendingSuggestions"] == 1
    assert data["chronicle"]["pendingSuggestions"][0]["id"] == "sug-pending-0001"
    assert data["chronicle"]["pendingSuggestions"][0]["id"] != "sug-hidden-0001"
    assert data["chronicle"]["pendingSuggestions"][0]["id"] != "sug-hidden-null-project-0001"
    assert "DO-NOT-EXPORT" not in response.text


def test_report_preview_filters_pending_suggestions_by_work_time(client):
    response = client.get("/api/reports/preview", params={"date": "today"})
    assert response.status_code == 200
    assert response.json()["chronicle"]["summary"]["pendingSuggestions"] == 0

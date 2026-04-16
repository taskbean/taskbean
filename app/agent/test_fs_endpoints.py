"""Unit tests for the project-picker filesystem endpoints.

These tests use FastAPI's TestClient and bypass the live_server fixture so
they don't need Foundry Local running. The FS endpoints are pure: they
don't touch the agent or the model, only the local filesystem and (for
/api/projects/track) the `bean` CLI subprocess.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

# Importing main triggers a Jaeger docker start attempt; that's OK — it
# logs a warning and carries on. We just need the FastAPI `app` object.
sys.path.insert(0, str(Path(__file__).parent))
from main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    # TestClient runs ASGI in-process; no lifespan events we need to await.
    with TestClient(app) as c:
        yield c


@pytest.fixture
def temp_project(tmp_path: Path) -> Path:
    """Create a fake project with a handful of subfolders and signals."""
    (tmp_path / "alpha").mkdir()
    (tmp_path / "alpha" / ".git").mkdir()  # git-repo signal
    (tmp_path / "beta").mkdir()
    (tmp_path / "beta" / "package.json").write_text("{}")  # npm signal
    (tmp_path / "beta" / "pyproject.toml").write_text("")  # py signal
    (tmp_path / ".hidden").mkdir()  # hidden — omitted by default
    (tmp_path / "notes.txt").write_text("not a folder")  # file — omitted
    return tmp_path


def test_fs_roots_returns_home_and_drives(client: TestClient):
    r = client.get("/api/fs/roots")
    assert r.status_code == 200
    data = r.json()
    assert "home" in data and data["home"]
    assert isinstance(data.get("drives"), list)
    assert isinstance(data.get("suggested"), list)
    assert isinstance(data.get("recents"), list)
    if sys.platform == "win32":
        # At least the system drive should appear.
        assert any(d.startswith(("C:", "D:", "E:")) for d in data["drives"])


def test_fs_browse_happy_path(client: TestClient, temp_project: Path):
    r = client.get("/api/fs/browse", params={"path": str(temp_project)})
    assert r.status_code == 200
    data = r.json()
    assert data["path"] == str(temp_project.absolute())
    names = {e["name"]: e for e in data["entries"]}
    # Folders appear; hidden ones + files do not.
    assert "alpha" in names and "beta" in names
    assert "notes.txt" not in names
    assert ".hidden" not in names
    # Project signals are computed correctly.
    assert names["alpha"]["isGitRepo"] is True
    assert names["beta"]["hasPackageJson"] is True
    assert names["beta"]["hasPyProject"] is True
    assert names["alpha"]["hasPackageJson"] is False


def test_fs_browse_rejects_traversal(client: TestClient):
    r = client.get("/api/fs/browse", params={"path": "foo/../bar"})
    assert r.status_code == 400
    assert "'..'" in r.json()["detail"] or ".." in r.json()["detail"]


def test_fs_browse_404_on_missing(client: TestClient, tmp_path: Path):
    missing = tmp_path / "definitely-not-there"
    r = client.get("/api/fs/browse", params={"path": str(missing)})
    assert r.status_code == 404


def test_fs_browse_400_on_file(client: TestClient, tmp_path: Path):
    f = tmp_path / "file.txt"
    f.write_text("hi")
    r = client.get("/api/fs/browse", params={"path": str(f)})
    assert r.status_code == 400


def test_fs_browse_requires_path(client: TestClient):
    r = client.get("/api/fs/browse")
    assert r.status_code == 422  # FastAPI missing-query-param


def test_fs_browse_show_hidden(client: TestClient, temp_project: Path):
    r = client.get("/api/fs/browse", params={"path": str(temp_project), "show_hidden": "true"})
    data = r.json()
    names = {e["name"] for e in data["entries"]}
    assert ".hidden" in names


def test_track_endpoint_rejects_traversal(client: TestClient):
    r = client.post("/api/projects/track", json={"path": "foo/../bar"})
    assert r.status_code == 400


def test_track_endpoint_rejects_non_dir(client: TestClient, tmp_path: Path):
    f = tmp_path / "x.txt"
    f.write_text("")
    r = client.post("/api/projects/track", json={"path": str(f)})
    assert r.status_code == 400


def test_track_endpoint_invokes_bean(client: TestClient, tmp_path: Path):
    """Mock subprocess.run so we don't depend on bean being on PATH in CI."""
    class FakeResult:
        returncode = 0
        stdout = '{"path":"' + str(tmp_path).replace("\\", "\\\\") + '","name":"fake","tracked":true}'
        stderr = ""
    with patch("main.subprocess.run", return_value=FakeResult()):
        r = client.post("/api/projects/track", json={"path": str(tmp_path), "name": "fake"})
    assert r.status_code == 200
    assert r.json()["name"] == "fake"


def test_track_endpoint_surfaces_cli_error(client: TestClient, tmp_path: Path):
    class FakeResult:
        returncode = 1
        stdout = ""
        stderr = "bean track failed: some reason"
    with patch("main.subprocess.run", return_value=FakeResult()):
        r = client.post("/api/projects/track", json={"path": str(tmp_path)})
    assert r.status_code == 500
    assert "some reason" in r.json()["detail"]


def test_track_endpoint_rejects_shell_metachars_in_name(client: TestClient, tmp_path: Path):
    r = client.post("/api/projects/track", json={"path": str(tmp_path), "name": "foo & bar"})
    assert r.status_code == 400
    assert "disallowed characters" in r.json()["detail"]


def test_track_endpoint_rejects_shell_metachars_in_path(client: TestClient, tmp_path: Path):
    hostile = tmp_path / "a&b"
    hostile.mkdir()
    r = client.post("/api/projects/track", json={"path": str(hostile)})
    assert r.status_code == 400
    assert "disallowed characters" in r.json()["detail"]


def test_track_endpoint_rejects_non_json_stdout(client: TestClient, tmp_path: Path):
    class FakeResult:
        returncode = 0
        stdout = "tracking complete!\n"  # not JSON
        stderr = ""
    with patch("main.subprocess.run", return_value=FakeResult()):
        r = client.post("/api/projects/track", json={"path": str(tmp_path)})
    assert r.status_code == 500
    assert "non-JSON" in r.json()["detail"]


def test_track_endpoint_rejects_unexpected_json_shape(client: TestClient, tmp_path: Path):
    class FakeResult:
        returncode = 0
        stdout = '[1, 2, 3]'  # valid JSON but not a dict with "path"
        stderr = ""
    with patch("main.subprocess.run", return_value=FakeResult()):
        r = client.post("/api/projects/track", json={"path": str(tmp_path)})
    assert r.status_code == 500
    assert "unexpected JSON shape" in r.json()["detail"]


def test_fs_browse_rejects_relative_path(client: TestClient):
    r = client.get("/api/fs/browse", params={"path": "relative/path"})
    assert r.status_code == 400
    assert "absolute" in r.json()["detail"].lower()

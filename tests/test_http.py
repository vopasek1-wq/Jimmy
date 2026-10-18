"""HTTP klient proti lokálnímu serveru: opakování, rozpoznání blokace, chyby spojení."""
from __future__ import annotations

import http.server
import threading

import pytest

from tipster import config
from tipster.http import BlockedError, HttpClient, NetworkError, SourceError


@pytest.fixture
def server(monkeypatch):
    state = {"hits": 0, "script": []}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            state["hits"] += 1
            code, body, ctype = state["script"][min(state["hits"], len(state["script"])) - 1]
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))
        def log_message(self, *a): pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setattr(config, "REQUEST_RETRIES", 2)
    monkeypatch.setattr("tipster.http.time.sleep", lambda s: None)       # bez čekání mezi pokusy
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    state["url"] = f"http://127.0.0.1:{srv.server_port}/x"
    yield state
    srv.shutdown()


def client() -> HttpClient:
    c = HttpClient(delay=(0, 0))
    c.session.trust_env = False                       # lokální server nejde přes systémovou proxy
    return c


def test_ok_and_utf8(server):
    server["script"] = [(200, "<html>Příliš žluťoučký kůň</html>", "text/html")]
    assert "žluťoučký" in client().get_text(server["url"])


def test_json(server):
    server["script"] = [(200, '{"a": 1}', "application/json")]
    assert client().get_json(server["url"]) == {"a": 1}
    server["hits"], server["script"] = 0, [(200, "není json", "application/json")]
    with pytest.raises(SourceError):
        client().get_json(server["url"])


def test_server_error_is_retried_then_succeeds(server):
    server["script"] = [(503, "busy", "text/plain"), (200, "ok", "text/plain")]
    assert client().get_text(server["url"]) == "ok" and server["hits"] == 2


def test_persistent_server_error_gives_up(server):
    server["script"] = [(500, "boom", "text/plain")]
    with pytest.raises(SourceError, match="HTTP 500"):
        client().get_text(server["url"])
    assert server["hits"] == 3                       # 1 + 2 opakování


def test_cloudflare_challenge_raises_blocked_without_retry(server):
    server["script"] = [(403, "<html><head><title>Just a moment...</title></head></html>", "text/html")]
    with pytest.raises(BlockedError):
        client().get_text(server["url"])
    assert server["hits"] == 1


def test_not_found_is_a_clear_error(server):
    server["script"] = [(404, "nope", "text/plain")]
    with pytest.raises(SourceError, match="404"):
        client().get_text(server["url"])


def test_connection_refused_means_offline(monkeypatch):
    monkeypatch.setattr("tipster.http.time.sleep", lambda s: None)
    c = HttpClient(delay=(0, 0))
    c.session.trust_env = False
    with pytest.raises(NetworkError) as exc:
        c.get_text("http://127.0.0.1:9/x")           # port 9 nikdo neposlouchá
    assert exc.value.offline

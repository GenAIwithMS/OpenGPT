"""Connector sign-in (OAuth): discovery, registration, PKCE, tokens, refresh, callback."""
import base64
import hashlib
import json
import os
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock
from urllib.parse import parse_qs, urlparse

from tests import _helpers

_helpers.use_sqlite()

from app import secret_box  # noqa: E402
from app.exceptions import ConflictError, ValidationError  # noqa: E402
from app.services import connector_oauth, connectors  # noqa: E402


class FakeProvider:
    """An MCP server + OAuth authorization server with dynamic registration."""

    def __init__(self):
        self.codes = {}       # code -> challenge
        self.registered = 0
        self.issued = 0
        self.base = None

    def handler(self):
        provider = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _json(self, status, body, headers=None):
                data = json.dumps(body).encode()
                self.send_response(status)
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.path == "/.well-known/oauth-protected-resource/mcp":
                    return self._json(200, {"resource": f"{provider.base}/mcp",
                                            "authorization_servers": [provider.base], "scopes_supported": ["read"]})
                if self.path == "/.well-known/oauth-authorization-server":
                    return self._json(200, {"issuer": provider.base,
                                            "authorization_endpoint": f"{provider.base}/authorize",
                                            "token_endpoint": f"{provider.base}/token",
                                            "registration_endpoint": f"{provider.base}/register"})
                self._json(404, {})

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length).decode()
                if self.path == "/mcp":
                    meta = f"{provider.base}/.well-known/oauth-protected-resource/mcp"
                    return self._json(401, {}, {"WWW-Authenticate": f'Bearer resource_metadata="{meta}"'})
                if self.path == "/register":
                    provider.registered += 1
                    body = json.loads(raw)
                    assert body["redirect_uris"] == [connector_oauth.redirect_uri()]
                    return self._json(201, {"client_id": "client-123"})
                if self.path == "/token":
                    form = {k: v[0] for k, v in parse_qs(raw).items()}
                    if form["grant_type"] == "authorization_code":
                        challenge = provider.codes.pop(form["code"], None)
                        verifier_hash = base64.urlsafe_b64encode(
                            hashlib.sha256(form["code_verifier"].encode()).digest()).rstrip(b"=").decode()
                        if challenge != verifier_hash or form["client_id"] != "client-123":
                            return self._json(400, {"error": "invalid_grant"})
                    elif form.get("refresh_token") != "refresh-1":
                        return self._json(400, {"error": "invalid_grant"})
                    provider.issued += 1
                    return self._json(200, {"access_token": f"token-{provider.issued}", "expires_in": 3600,
                                            "refresh_token": "refresh-1", "token_type": "Bearer"})
                self._json(404, {})

        return Handler


class OAuthTests(unittest.TestCase):
    def setUp(self):
        _helpers.use_sqlite()
        env = mock.patch.dict(os.environ, {"SETTINGS_SECRET": "t", "PORT": "8000"})
        env.start()
        self.addCleanup(env.stop)
        secret_box._reset_for_tests()
        self.provider = FakeProvider()
        server = HTTPServer(("127.0.0.1", 0), self.provider.handler())
        self.provider.base = f"http://127.0.0.1:{server.server_port}"
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        connector_oauth._flows.clear()

    def sign_in(self, **kwargs):
        """Start, then play the provider: approve and send the browser back."""
        url = connectors.start_sign_in(**kwargs)["authorize_url"]
        q = {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
        self.assertEqual(q["code_challenge_method"], "S256")
        self.assertEqual(q["redirect_uri"], "http://127.0.0.1:8000/api/connectors/oauth/callback")
        self.assertEqual(q["resource"], f"{self.provider.base}/mcp")
        self.provider.codes["code-xyz"] = q["code_challenge"]
        return q["state"]

    def test_full_sign_in(self):
        state = self.sign_in(name="fake", url=f"{self.provider.base}/mcp")
        info = connectors.finish_sign_in(state, "code-xyz")
        self.assertTrue(info["signed_in"])
        self.assertNotIn("token-1", json.dumps(connectors.list_connectors()))
        servers = connectors.agent_mcp_config()["servers"]
        self.assertEqual(servers["fake"]["headers"]["Authorization"], "Bearer token-1")

        # Same authorization server again: the registration is reused.
        self.sign_in(name="fake2", url=f"{self.provider.base}/mcp")
        self.assertEqual(self.provider.registered, 1)

    def test_state_is_single_use_and_checked(self):
        state = self.sign_in(name="fake", url=f"{self.provider.base}/mcp")
        with self.assertRaises(ValidationError):
            connectors.finish_sign_in("wrong-state", "code-xyz")
        connectors.finish_sign_in(state, "code-xyz")
        with self.assertRaises(ValidationError):
            connectors.finish_sign_in(state, "code-xyz")

    def test_wrong_pkce_is_refused(self):
        state = self.sign_in(name="fake", url=f"{self.provider.base}/mcp")
        self.provider.codes["code-xyz"] = "not-the-challenge"
        with self.assertRaises(Exception):
            connectors.finish_sign_in(state, "code-xyz")
        self.assertEqual(connectors.list_connectors(), [])

    def test_refresh_before_expiry(self):
        state = self.sign_in(name="fake", url=f"{self.provider.base}/mcp")
        connectors.finish_sign_in(state, "code-xyz")
        with mock.patch.object(time, "time", return_value=time.time() + 3500):  # 100 s left
            self.assertEqual(connectors.refresh_due(), 1)
        self.assertEqual(connectors.agent_mcp_config()["servers"]["fake"]["headers"]["Authorization"], "Bearer token-2")

    def test_sign_in_again_updates_the_same_connector(self):
        state = self.sign_in(name="fake", url=f"{self.provider.base}/mcp")
        cid = connectors.finish_sign_in(state, "code-xyz")["id"]
        state = self.sign_in(connector_id=cid)
        self.assertEqual(connectors.finish_sign_in(state, "code-xyz")["id"], cid)
        self.assertEqual(len(connectors.list_connectors()), 1)

    def test_no_oauth_server(self):
        with self.assertRaises(ValidationError):
            connectors.start_sign_in(name="plain", url=f"{self.provider.base}/nothing-here")

    def test_name_taken(self):
        connectors.create(name="fake", kind="remote", url="https://e.com")
        with self.assertRaises(ConflictError):
            connectors.start_sign_in(name="fake", url=f"{self.provider.base}/mcp")


class CatalogAuthTests(unittest.TestCase):
    def setUp(self):
        _helpers.use_sqlite()

    def test_github_needs_its_app_for_sign_in(self):
        with mock.patch.dict(os.environ, {"GITHUB_OAUTH_CLIENT_ID": "", "GITHUB_OAUTH_CLIENT_SECRET": ""}):
            gh = next(c for c in connectors.catalog() if c["id"] == "github")
            self.assertEqual(gh["auth"], "key")
            self.assertIn("GITHUB_OAUTH_CLIENT_ID", gh["oauth_hint"])
        with mock.patch.dict(os.environ, {"GITHUB_OAUTH_CLIENT_ID": "id", "GITHUB_OAUTH_CLIENT_SECRET": "s"}):
            self.assertEqual(next(c for c in connectors.catalog() if c["id"] == "github")["auth"], "oauth")

    def test_oauth_entries_cant_be_added_without_signing_in(self):
        self.assertEqual(next(c for c in connectors.catalog() if c["id"] == "notion")["auth"], "oauth")
        with self.assertRaises(ValidationError):
            connectors.add_from_catalog("notion", {})


class FakeGitHub:
    """github.com's device-flow endpoints: device code, then token polling."""

    def __init__(self):
        self.answers = []          # what the token endpoint says next, in order
        self.code_error = None
        self.base = None

    def handler(self):
        gh = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _json(self, body):
                data = json.dumps(body).encode()
                self.send_response(200)  # GitHub reports errors with 200 + {"error"}
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                form = {k: v[0] for k, v in parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode()).items()}
                if self.path == "/login/device/code":
                    if gh.code_error:
                        return self._json({"error": gh.code_error})
                    assert form["client_id"] == "public-id" and "repo" in form["scope"]
                    return self._json({"device_code": "dev-1", "user_code": "WDJB-MJHT", "interval": 5,
                                       "expires_in": 900, "verification_uri": "https://github.com/login/device"})
                assert form["grant_type"] == "urn:ietf:params:oauth:grant-type:device_code"
                assert form["device_code"] == "dev-1" and "client_secret" not in form
                self._json(gh.answers.pop(0))

        return Handler


class GitHubDeviceFlowTests(unittest.TestCase):
    def setUp(self):
        _helpers.use_sqlite()
        env = mock.patch.dict(os.environ, {"SETTINGS_SECRET": "t", "GITHUB_OAUTH_CLIENT_ID": "public-id",
                                           "GITHUB_OAUTH_CLIENT_SECRET": ""})
        env.start()
        self.addCleanup(env.stop)
        secret_box._reset_for_tests()
        self.gh = FakeGitHub()
        server = HTTPServer(("127.0.0.1", 0), self.gh.handler())
        self.gh.base = f"http://127.0.0.1:{server.server_port}"
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        preset = dict(connector_oauth.PRESET_CLIENTS["github"],
                      device_code_url=f"{self.gh.base}/login/device/code",
                      token_url=f"{self.gh.base}/login/oauth/access_token")
        patcher = mock.patch.dict(connector_oauth.PRESET_CLIENTS, {"github": preset})
        patcher.start()
        self.addCleanup(patcher.stop)
        connector_oauth._device_flows.clear()

    def start(self):
        device = connectors.start_sign_in(catalog_id="github")["device"]
        self.assertEqual(device["user_code"], "WDJB-MJHT")
        self.assertEqual(device["verification_uri"], "https://github.com/login/device")
        return device["flow_id"]

    def poll_now(self, flow_id):
        connector_oauth._device_flows[flow_id]["next_poll"] = 0
        return connectors.poll_device_sign_in(flow_id)

    def test_client_id_alone_means_sign_in_with_a_code(self):
        self.assertEqual(next(c for c in connectors.catalog() if c["id"] == "github")["auth"], "oauth")
        self.gh.answers = [{"error": "authorization_pending"},
                           {"access_token": "gho_abc", "token_type": "bearer", "scope": "repo"}]
        flow_id = self.start()
        self.assertEqual(connectors.poll_device_sign_in(flow_id)["status"], "pending")
        # Asked again too soon: GitHub isn't called (it would answer slow_down).
        self.assertEqual(connectors.poll_device_sign_in(flow_id)["status"], "pending")
        result = self.poll_now(flow_id)
        self.assertEqual(result["status"], "done")
        self.assertTrue(result["connector"]["signed_in"])
        self.assertEqual(result["connector"]["catalog_id"], "github")
        github = connectors.agent_mcp_config()["servers"]["github"]
        self.assertEqual(github["url"], "https://api.githubcopilot.com/mcp/")
        self.assertEqual(github["headers"]["Authorization"], "Bearer gho_abc")
        self.assertEqual(connectors.poll_device_sign_in(flow_id)["status"], "expired")  # single use

    def test_slow_down_denied_and_expired(self):
        self.gh.answers = [{"error": "slow_down", "interval": 10}, {"error": "access_denied"}]
        flow_id = self.start()
        self.assertEqual(self.poll_now(flow_id)["status"], "pending")
        self.assertEqual(connector_oauth._device_flows[flow_id]["interval"], 10)
        self.assertEqual(self.poll_now(flow_id)["status"], "denied")
        self.assertEqual(connectors.list_connectors(), [])
        self.assertEqual(connectors.poll_device_sign_in("unknown")["status"], "expired")

    def test_device_flow_turned_off_on_the_app(self):
        self.gh.code_error = "device_flow_disabled"
        with self.assertRaises(ValidationError) as e:
            connectors.start_sign_in(catalog_id="github")
        self.assertIn("Enable Device Flow", str(e.exception))

    def test_secret_switches_to_the_redirect_flow(self):
        with mock.patch.dict(os.environ, {"GITHUB_OAUTH_CLIENT_SECRET": "s"}):
            self.assertFalse(connector_oauth.preset_client("github")["device"])
        self.assertTrue(connector_oauth.preset_client("github")["device"])


class CallbackRouteTests(unittest.TestCase):
    def setUp(self):
        _helpers.use_sqlite()
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from app.router import connectors as routes

        app = FastAPI()
        app.include_router(routes.connectors_callback_router, prefix="/api")
        self.client = TestClient(app)

    def test_errors_show_a_page(self):
        r = self.client.get("/api/connectors/oauth/callback", params={"error": "access_denied"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("cancelled", r.text)
        r = self.client.get("/api/connectors/oauth/callback", params={"state": "x", "code": "y"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("expired", r.text)

    def test_page_escapes_text(self):
        self.assertNotIn("<script>alert", connector_oauth.callback_page(False, "<script>alert(1)</script>"))


if __name__ == "__main__":
    unittest.main()

"""Local TEMPO Care server. Run with Python 3.9+; no pip packages required."""
import argparse
import getpass
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from care_chat import ChatError, Database, answer_question, make_model

ROOT = Path(__file__).resolve().parent
ADMIN_FILE = ROOT / ".tempo-admin.json"
STATIC_FILES = {"/": "index.html", "/index.html": "index.html", "/script.js": "script.js",
                "/chat.js": "chat.js", "/timeline.js": "timeline.js", "/sensor.js": "sensor.js", "/style.css": "style.css",
                "/device-link.js": "device-link.js", "/vendor/mqtt.min.js": "vendor/mqtt.min.js",
                "/config.js": "config.js"}
MIME = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}
SETUP_SQL = ROOT / "supabase" / "001_link_activity_profiles.sql"
# Web pages on other sites that may call this API (the app published on GitHub Pages). Comma-separated.
ALLOWED_ORIGINS = {origin.strip().rstrip("/").lower() for origin in
                   os.getenv("TEMPO_ORIGINS", "https://rupam-dutta.github.io").split(",") if origin.strip()}


def save_admin(username, password):
    if len(password) < 8:
        raise ValueError("Use at least eight characters for the admin password.")
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 600000).hex()
    ADMIN_FILE.write_text(json.dumps({"username": username, "salt": salt, "digest": digest}), encoding="utf-8")


_ENV_ADMIN = {}


def env_admin():
    """Admin from TEMPO_ADMIN_USERNAME / TEMPO_ADMIN_PASSWORD (cloud server without .tempo-admin.json)."""
    if not _ENV_ADMIN and os.getenv("TEMPO_ADMIN_USERNAME") and len(os.getenv("TEMPO_ADMIN_PASSWORD", "")) >= 8:
        salt = secrets.token_hex(16)
        _ENV_ADMIN.update(username=os.environ["TEMPO_ADMIN_USERNAME"], salt=salt,
                          digest=hashlib.pbkdf2_hmac("sha256", os.environ["TEMPO_ADMIN_PASSWORD"].encode(), salt.encode(), 600000).hex())
    return _ENV_ADMIN or None


def verify_admin(username, password):
    if ADMIN_FILE.exists():
        admin = json.loads(ADMIN_FILE.read_text(encoding="utf-8"))
    else:
        admin = env_admin()
        if not admin:
            raise ChatError("Admin login is not configured. Run start.cmd on the server computer to set it up.", 503)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), admin["salt"].encode(), 600000).hex()
    return hmac.compare_digest(username.encode(), admin["username"].encode()) and hmac.compare_digest(digest, admin["digest"])


class Application:
    def __init__(self, database=None, model=None):
        if database is None:
            # Reuse only the public database configuration from the existing app.
            # (the cloud server has no script.js and gets both values from its environment)
            url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY")
            if not (url and key):
                script = (ROOT / "script.js").read_text(encoding="utf-8")
                url = url or re.search(r'const SUPABASE_URL = "([^"]+)"', script)[1]
                key = key or re.search(r'const SUPABASE_KEY = "([^"]+)"', script)[1]
            database = Database(url, key)
        self.database = database
        self.model = model or make_model()
        # Public hostnames this server may be reached through (a tunnel or a domain), besides loopback.
        self.hosts = {host.strip().lower() for host in os.getenv("TEMPO_HOSTS", "").split(",") if host.strip()}
        if os.getenv("RENDER_EXTERNAL_HOSTNAME"):  # set by Render for the service's public address
            self.hosts.add(os.environ["RENDER_EXTERNAL_HOSTNAME"].strip().lower())
        self.sessions = {}
        self.attempts = {}
        self.lock = threading.Lock()
        self.inference = threading.BoundedSemaphore(1)

    def login(self, body, address):
        phone, password, role = (body.get(key) for key in ("phone", "password", "role"))
        if (not isinstance(phone, str) or not phone or len(phone) > 200 or
                not isinstance(password, str) or not password or len(password) > 512 or role not in ("Admin", "Care Family")):
            raise ChatError("Enter your login details.")
        now = time.monotonic()
        with self.lock:
            attempts = [stamp for stamp in self.attempts.get(address, []) if now - stamp < 300]
            if len(attempts) >= 10:
                raise ChatError("Too many login attempts. Please wait five minutes.", 429)
            self.attempts[address] = attempts + [now]
        if role == "Admin":
            valid = verify_admin(phone, password)
            name = "Developer (Admin)"
        else:
            # Compatibility with the existing tempo_users table. See README migration note.
            users = self.database.rows("tempo_users", [("select", "name,phone,role,password"),
                                                      ("phone", "eq." + phone), ("role", "eq.Care Family")], limit=2)
            user = next((user for user in users if user.get("phone") == phone and user.get("role") == role and
                         hmac.compare_digest(str(user.get("password", "")).encode(), password.encode())), None)
            valid, name = user is not None, (user or {}).get("name", "Care Family")
        if not valid:
            raise ChatError("The login details do not match. Please try again.", 401)
        token = secrets.token_urlsafe(32)
        identity = {"phone": phone, "role": role, "name": name}
        with self.lock:
            self.attempts.pop(address, None)
            self.sessions = {key: value for key, value in self.sessions.items() if value["expires"] > now}
            if len(self.sessions) >= 100:
                raise ChatError("Too many active sessions. Try again later.", 503)
            self.sessions[token] = {"identity": identity, "expires": now + 8 * 3600, "history": [],
                                    "scope": None, "last_question": 0, "lock": threading.Lock()}
        return token, identity

    def session(self, cookie, authorization=None):
        # The app on GitHub Pages sends "Authorization: Bearer <token>"; the app served by this server uses the cookie.
        token = None
        if authorization and authorization.startswith("Bearer "):
            token = authorization[7:].strip() or None
        if token is None:
            parsed = SimpleCookie()
            try:
                parsed.load(cookie or "")
                token = parsed["tempo_session"].value
            except (KeyError, ValueError):
                raise ChatError("Please log in again to use the assistant.", 401)
        with self.lock:
            session = self.sessions.get(token)
            if not session or session["expires"] <= time.monotonic():
                self.sessions.pop(token, None)
                raise ChatError("Your session has expired. Please log in again.", 401)
        return token, session


class Handler(BaseHTTPRequestHandler):
    server_version = "TEMPO"

    def log_message(self, *_args):
        # Do not persist questions, login details, URLs, or activity records in access logs.
        pass

    def cors_origin(self):
        origin = (self.headers.get("Origin") or "").rstrip("/").lower()
        return origin if origin in ALLOWED_ORIGINS else None

    def send_cors(self):
        origin = self.cors_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def auth(self):
        return self.server.app.session(self.headers.get("Cookie"), self.headers.get("Authorization"))

    def do_OPTIONS(self):
        # CORS preflight from the published app (GitHub Pages).
        try:
            self.check_host()
            if not self.cors_origin():
                raise ChatError("This site may not use the TEMPO Care API.", 403)
            self.send_response(204)
            self.send_cors()
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Tempo-Client")
            self.send_header("Access-Control-Max-Age", "600")
            if self.headers.get("Access-Control-Request-Private-Network") == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")  # https page -> this laptop's 127.0.0.1
            self.send_header("Content-Length", "0")
            self.end_headers()
        except ChatError as error:
            self.send(error.status, {"error": str(error)})

    def send(self, status, value, cookie=None):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def allowed_hosts(self):
        port = self.server.server_port
        return {f"127.0.0.1:{port}", f"localhost:{port}"} | self.server.app.hosts

    def request_host(self):
        # A reverse proxy or tunnel in front of the server forwards the public hostname it was reached through.
        return (self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or "").split(",")[0].strip().lower()

    def check_host(self):
        # A "*.example.com" entry allows any subdomain, for tunnels whose hostname is assigned at start-up.
        host = self.request_host()
        allowed = self.allowed_hosts()
        if host not in allowed and not any(pattern.startswith("*.") and host.endswith(pattern[1:]) and host != pattern[2:] for pattern in allowed):
            raise ChatError("Open TEMPO Care through its local address or its published address.", 403)

    def secure(self):
        return self.headers.get("X-Forwarded-Proto", "").split(",")[0].strip().lower() == "https" or os.getenv("TEMPO_HTTPS") == "1"

    def client_ip(self):
        # Behind a tunnel every connection arrives from loopback; the tunnel supplies the real client address.
        address = self.client_address[0]
        forwarded = self.headers.get("X-Forwarded-For")
        if forwarded and address in ("127.0.0.1", "::1"):
            return forwarded.split(",")[0].strip()
        return address

    def cookie(self, value, max_age):
        return "tempo_session=" + value + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=" + str(max_age) + ("; Secure" if self.secure() else "")

    def do_GET(self):
        try:
            path = urlparse(self.path).path
            if path == "/api/health":
                # Liveness only (no data), answered before the host check: hosting health checks use internal addresses.
                self.send(200, {"ok": True, "provider": "hosted" if type(self.server.app.model).__name__ == "HostedModel" else "local"})
                return
            self.check_host()
            if path in STATIC_FILES:
                file = ROOT / STATIC_FILES[path]
                content = file.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", MIME[file.suffix] + "; charset=utf-8")
                self.send_header("Content-Length", str(len(content)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("X-Frame-Options", "DENY")
                self.send_header("Referrer-Policy", "same-origin")
                self.end_headers()
                self.wfile.write(content)
                return
            _, session = self.auth()
            if path == "/api/chat/context":
                profiles = self.server.app.database.profiles(session["identity"])
                try:
                    # Validate the ownership column before advertising chat readiness.
                    self.server.app.database.rows("tempo_activity_log", [("select", "profile_id")], limit=1)
                    database_status = {"ready": True}
                except ChatError as error:
                    database_status = {"ready": False, "message": str(error)}
                self.send(200, {"profiles": profiles, "model": self.server.app.model.status(), "database": database_status})
            elif path == "/api/activity/setup":
                # The migration text is only handed to an authenticated administrator; it is never applied by this server.
                if session["identity"]["role"] != "Admin":
                    raise ChatError("Only an administrator can view the database setup.", 403)
                self.send(200, {"sql": SETUP_SQL.read_text(encoding="utf-8")})
            else:
                self.send(404, {"error": "Not found."})
        except ChatError as error:
            self.send(error.status, {"error": str(error)})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception:
            self.send(500, {"error": "The assistant encountered a server error. Please retry."})

    def do_POST(self):
        try:
            self.check_host()
            origin = self.headers.get("Origin")
            if (origin and origin.lower() not in ("http://" + self.request_host(), "https://" + self.request_host())
                    and not self.cors_origin()):
                raise ChatError("This request did not come from TEMPO Care.", 403)
            if self.headers.get("X-Tempo-Client") != "browser" or self.headers.get_content_type() != "application/json":
                raise ChatError("A TEMPO Care JSON request is required.", 403)
            try:
                length = int(self.headers.get("Content-Length", 0))
                if not 0 < length <= 12000:
                    raise ChatError("The request is too large or empty.", 413)
                self.connection.settimeout(15)
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError()
            except (ValueError, UnicodeError):
                raise ChatError("The request could not be read.")
            path = urlparse(self.path).path
            app = self.server.app
            if path == "/api/session":
                token, identity = app.login(body, self.client_ip())
                # Revoke the previous session when switching accounts.
                try:
                    old_token, _ = self.auth()
                    with app.lock:
                        app.sessions.pop(old_token, None)
                except ChatError:
                    pass
                self.send(200, dict(identity, token=token), self.cookie(token, 28800))
                return
            token, session = self.auth()
            if path == "/api/logout":
                with app.lock:
                    app.sessions.pop(token, None)
                self.send(200, {"ok": True}, self.cookie("", 0))
            elif path == "/api/chat":
                conversation = body.get("conversation_id")
                if not isinstance(conversation, str) or not 1 <= len(conversation) <= 80:
                    raise ChatError("Please reopen the assistant and try again.")
                if not app.inference.acquire(blocking=False):
                    raise ChatError("The local assistant is answering another question. Please retry in a moment.", 429)
                try:
                    with session["lock"]:
                        if time.monotonic() - session["last_question"] < 1:
                            raise ChatError("Please wait a moment before asking again.", 429)
                        session["last_question"] = time.monotonic()
                        scope = tuple(str(body.get(key)) for key in ("profile_id", "start", "end", "conversation_id"))
                        history = session["history"] if scope == session["scope"] else []
                        answer = answer_question(app.database, app.model, session["identity"], body, history)
                        # A logout during generation invalidates the result too.
                        self.auth()
                        session["scope"] = scope
                        session["history"] = (history + [{"role": "user", "content": body["question"]},
                                                          {"role": "assistant", "content": answer["answer"]}])[-6:]
                        self.send(200, answer)
                finally:
                    app.inference.release()
            elif path == "/api/chat/reset":
                with session["lock"]:
                    if not session["scope"] or not body.get("conversation_id") or session["scope"][-1] == body["conversation_id"]:
                        session["history"], session["scope"] = [], None
                self.send(200, {"ok": True})
            else:
                self.send(404, {"error": "Not found."})
        except ChatError as error:
            self.send(error.status, {"error": str(error)})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception:
            self.send(500, {"error": "The assistant encountered a server error. Please retry."})


def make_server(port=8000, app=None, host="127.0.0.1"):
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    if app is None:
        app = Application()
        # Pre-load the local model so the first question does not also pay the load time.
        threading.Thread(target=app.model.warm_up, daemon=True).start()
    server.app = app
    return server


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "8000")))
    parser.add_argument("--host", default="127.0.0.1", help="bind address; keep 127.0.0.1 behind a tunnel or reverse proxy")
    parser.add_argument("--set-admin-password", action="store_true")
    args = parser.parse_args()
    if args.set_admin_password:
        username = input("Admin username: ").strip()
        password = getpass.getpass("New admin password (8+ characters): ")
        if not username or password != getpass.getpass("Repeat password: "):
            parser.error("The username is empty or the passwords do not match.")
        save_admin(username, password)
        print("Admin login saved locally.")
    else:
        server = make_server(args.port, host=args.host)
        print(f"TEMPO Care: http://{args.host}:{server.server_port}", flush=True)
        if server.app.hosts:
            print("Also accepting the published address(es): " + ", ".join(sorted(server.app.hosts)), flush=True)
        print("Press Ctrl+C to stop. Model: " + ("hosted (" + server.app.model.model + ")" if type(server.app.model).__name__ == "HostedModel"
              else "local Ollama") + ".", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()

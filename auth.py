"""Server-only credentials, expiring sessions and bounded login throttling."""
import hashlib
import hmac
import os
import secrets
import threading
import time
from http.cookies import SimpleCookie, CookieError


class Auth:
    lifetime = 12 * 60 * 60

    def __init__(self):
        self.username = os.environ.get("ADMIN_USERNAME", "admin")
        self.salt = secrets.token_bytes(16)
        self.password_hash = self.digest(os.environ.get("ADMIN_PASSWORD", "hammonja"))
        self.sessions = {}
        self.attempts = {}
        self.lock = threading.Lock()

    def digest(self, value):
        return hashlib.pbkdf2_hmac("sha256", value.encode(), self.salt, 200000)

    def login(self, username, password, peer):
        with self.lock:
            now = time.time()
            self.attempts = {key: [t for t in times if t > now - 300]
                             for key, times in self.attempts.items() if times[-1] > now - 300}
            attempts = self.attempts.setdefault(peer, [])
            if len(attempts) >= 10:
                return "limited", None
            attempts.append(now)
        valid_password = hmac.compare_digest(self.digest(password), self.password_hash)
        if not hmac.compare_digest(username.encode(), self.username.encode()) or not valid_password:
            return "invalid", None
        with self.lock:
            self.sessions = {key: value for key, value in self.sessions.items() if value["expires"] > now}
            token = secrets.token_urlsafe(32)
            session = {"id": secrets.token_hex(12), "csrf": secrets.token_urlsafe(32), "expires": now + self.lifetime}
            self.sessions[self.key(token)] = session
            self.attempts.pop(peer, None)
            return token, session

    @staticmethod
    def key(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def token(self, headers):
        cookie = SimpleCookie()
        try:
            cookie.load(headers.get("Cookie", ""))
            return cookie["golf_admin"].value if "golf_admin" in cookie else ""
        except CookieError:
            return ""

    def session(self, headers):
        key = self.key(self.token(headers))
        with self.lock:
            session = self.sessions.get(key)
            if session and session["expires"] <= time.time():
                self.sessions.pop(key, None)
                session = None
            return session

    def logout(self, headers):
        with self.lock:
            self.sessions.pop(self.key(self.token(headers)), None)

    def cookie(self, token, clear=False):
        secure = "; Secure" if os.environ.get("COOKIE_SECURE", "0") == "1" else ""
        return f"golf_admin={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={0 if clear else self.lifetime}{secure}"

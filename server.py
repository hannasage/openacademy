#!/usr/bin/env python3
"""Local curriculum tracker. Python standard library only."""
import argparse
import json
import os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
import re

def validate_curriculum(c):
    if not isinstance(c, dict) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,59}", c.get("id", "")):
        raise ValueError("Use a curriculum ID with lowercase letters, numbers, and hyphens.")
    for k in ("title", "subtitle", "description"):
        if not isinstance(c.get(k), str) or not c[k].strip():
            raise ValueError(f"Curriculum needs {k}.")
    if not isinstance(c.get("resources"), dict) or not isinstance(c.get("modules"), list) or not 1 <= len(c["modules"]) <= 100:
        raise ValueError("Curriculum needs resources and 1–100 modules.")
    if type(c.get("weeks")) is not int or not 1 <= c["weeks"] <= 520:
        raise ValueError("Invalid curriculum duration.")
    if type(c.get("weeklyHours")) not in (int, float) or not 1 <= c["weeklyHours"] <= 40:
        raise ValueError("Invalid weekly study hours.")
    if "nextPhase" in c and (not isinstance(c["nextPhase"], list) or any(not isinstance(x, str) for x in c["nextPhase"])):
        raise ValueError("Next phase must be a list of text items.")
    if "researchDate" in c and not isinstance(c["researchDate"], str):
        raise ValueError("Research date must be text.")
    ids = set()
    for r in c["resources"].values():
        if not isinstance(r, dict) or any(not isinstance(r.get(k), str) for k in ("title", "url", "use")) or urlsplit(r["url"]).scheme not in ("http", "https"):
            raise ValueError("Each resource needs a title, an HTTP(S) URL, and use guidance.")
    for m in c["modules"]:
        if not isinstance(m, dict) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,60}", m.get("id", "")) or m["id"] in ids:
            raise ValueError("Module IDs must be unique letters, numbers, underscores, or hyphens.")
        ids.add(m["id"])
        for k in ("title", "phase", "question", "outcome", "math", "evidence", "challenge", "reading", "dataset"):
            if not isinstance(m.get(k), str):
                raise ValueError(f"Module needs {k}.")
        for k in ("tasks", "weeks", "resources", "prerequisites"):
            if not isinstance(m.get(k), list) or any(not isinstance(x, str) for x in m[k]):
                raise ValueError(f"Invalid module {k}.")
        if not 1 <= len(m["tasks"]) <= 30 or any(x not in c["resources"] for x in m["resources"]):
            raise ValueError("Invalid module tasks or resource references.")
        for k in ("hours", "weekStart", "weekEnd"):
            if type(m.get(k)) not in (int, float) or not 0 < m[k] <= 10000:
                raise ValueError(f"Invalid module {k}.")
        if m["weekStart"] > m["weekEnd"] or m["weekEnd"] > c["weeks"]:
            raise ValueError("Module weeks must fit the curriculum duration.")
    if any(p not in ids for m in c["modules"] for p in m["prerequisites"]):
        raise ValueError("Unknown prerequisite module.")
    return c

def initial(c):
    return {"version": 1, "revision": 0, "curriculumId": c["id"], "weeklyHours": c["weeklyHours"], "startDate": "", "modules": {}, "experiments": []}

def validate(s, c):
    module_map = {m["id"]: m for m in c["modules"]}
    if not isinstance(s, dict) or s.get("version") != 1:
        raise ValueError("This file is not a version 1 Touchline backup.")
    if s.get("curriculumId") != c["id"]:
        raise ValueError("This backup belongs to a different curriculum. Switch curricula before restoring it.")
    if type(s.get("revision")) is not int or s["revision"] < 0:
        raise ValueError("Invalid revision.")
    if type(s.get("weeklyHours")) not in (int, float) or not 1 <= s["weeklyHours"] <= 40:
        raise ValueError("Weekly hours must be between 1 and 40.")
    if not isinstance(s.get("startDate"), str) or len(s["startDate"]) > 10:
        raise ValueError("Invalid start date.")
    if s["startDate"]:
        from datetime import date
        date.fromisoformat(s["startDate"])
    if not isinstance(s.get("modules"), dict) or not isinstance(s.get("experiments"), list):
        raise ValueError("Invalid progress data.")
    for key, m in s["modules"].items():
        if key not in module_map or not isinstance(m, dict):
            raise ValueError("Unknown module.")
        if m.get("status") not in ("not-started", "active", "complete"):
            raise ValueError("Invalid module status.")
        if not isinstance(m.get("tasks"), list) or len(m["tasks"]) != len(module_map[key]["tasks"]) or any(type(x) is not bool for x in m["tasks"]):
            raise ValueError("Invalid task progress.")
        for field in ("notes", "evidence"):
            if not isinstance(m.get(field), str) or len(m[field]) > 50000:
                raise ValueError("Invalid notes or evidence.")
        if type(m.get("hours")) not in (int, float) or not 0 <= m["hours"] <= 10000:
            raise ValueError("Invalid study hours.")
        if m["status"] == "complete" and (not all(m["tasks"]) or not m["evidence"].strip()):
            raise ValueError("Complete all tasks and record evidence before completing a module.")
    if len(s["experiments"]) > 2000:
        raise ValueError("Too many experiments.")
    for e in s["experiments"]:
        if not isinstance(e, dict) or any(not isinstance(e.get(k), str) or len(e[k]) > 20000 for k in ("id", "date", "module", "title", "hypothesis", "result")):
            raise ValueError("Invalid experiment.")
        if e["module"] not in module_map or not e["title"].strip():
            raise ValueError("Invalid experiment title or module.")
    return s

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, code, body, kind="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https:; object-src 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def allowed(self):
        hosts = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        return host in hosts and (not origin or origin == f"http://{host}")

    def curricula(self):
        built_in = validate_curriculum(json.loads((ROOT / "curriculum.json").read_text()))
        return [built_in] + [validate_curriculum(json.loads(p.read_text())) for p in sorted((self.server.data_dir / "curricula").glob("*.json"))]

    def current(self):
        from urllib.parse import parse_qs
        plan_id = parse_qs(urlsplit(self.path).query).get("plan", ["soccer-ml"])[0]
        for c in self.curricula():
            if c["id"] == plan_id:
                return c
        raise ValueError("Unknown curriculum.")

    def read_state(self, c):
        target = self.server.data_dir / c["id"] / "state.json"
        if target.exists():
            return validate(json.loads(target.read_text()), c)
        return initial(c)

    def do_GET(self):
        if not self.allowed():
            return self.respond(403, {"error": "Use the local application address."})
        path = urlsplit(self.path).path
        if path == "/api/cloud-config":
            config_file = ROOT / "cloud-config.local.json"
            config = json.loads(config_file.read_text()) if config_file.exists() else {}
            return self.respond(200, {k: config.get(k, "") for k in ("url", "publishableKey")})
        if path == "/api/curricula":
            try:
                return self.respond(200, self.curricula())
            except (OSError, ValueError):
                return self.respond(500, {"error": "Cannot read curricula. Curriculum files were preserved."})
        if path == "/api/state":
            try:
                return self.respond(200, self.read_state(self.current()))
            except (OSError, ValueError):
                return self.respond(500, {"error": "Cannot read saved progress. Your file was preserved. Restore data/state.json from a backup."})
        files = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript"), "/style.css": ("style.css", "text/css"), "/curriculum.json": ("curriculum.json", "application/json")}
        files["/web.bundle.js"] = ("web.bundle.js", "text/javascript")
        files["/web.bundle.css"] = ("web.bundle.css", "text/css")
        if path not in files:
            return self.respond(404, {"error": "Not found."})
        name, kind = files[path]
        self.respond(200, (ROOT / name).read_bytes(), kind)

    def do_PUT(self):
        if not self.allowed():
            return self.respond(403, {"error": "Use the local application address."})
        path = urlsplit(self.path).path
        if path not in ("/api/state", "/api/curricula"):
            return self.respond(404, {"error": "Not found."})
        if self.headers.get("Content-Type") != "application/json":
            return self.respond(415, {"error": "Expected JSON."})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 2_000_000:
                return self.respond(413, {"error": "Backup must be smaller than 2 MB."})
            payload = json.loads(self.rfile.read(size))
            if path == "/api/curricula":
                c = validate_curriculum(payload)
                if any(x["id"] == c["id"] for x in self.curricula()):
                    return self.respond(409, {"error": "This curriculum ID already exists. Use a new ID to import a separate plan."})
                folder = self.server.data_dir / "curricula"
                folder.mkdir(parents=True, exist_ok=True)
                temp = folder / (c["id"] + ".tmp")
                temp.write_text(json.dumps(c, indent=2))
                temp.replace(folder / (c["id"] + ".json"))
                return self.respond(201, c)
            c = self.current()
            state = validate(payload, c)
            previous = self.read_state(c)
            if state["revision"] != previous["revision"]:
                return self.respond(409, {"error": "Another tab saved newer progress. Export your edits before reloading this tab."})
            state["revision"] += 1
            target = self.server.data_dir / c["id"] / "state.json"
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                target.with_suffix(".backup.json").write_text(json.dumps(previous, indent=2))
            temp = target.with_suffix(".tmp")
            with temp.open("w") as file:
                json.dump(state, file, indent=2)
                file.flush()
                os.fsync(file.fileno())
            temp.replace(target)
            return self.respond(200, state)
        except (ValueError, TypeError) as error:
            return self.respond(400, {"error": str(error)})
        except OSError:
            return self.respond(500, {"error": "Cannot save progress. Keep this tab open, export your edits, and make sure that the data folder is writable."})

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    args = parser.parse_args()
    server = HTTPServer(("127.0.0.1", args.port), Handler)
    server.data_dir = args.data_dir
    print(f"Touchline is ready at http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()

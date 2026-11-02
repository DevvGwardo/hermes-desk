"""VM preview / computer / zip routes for Nub Agent (Maia desktop).

Canonical copy also lives in hermes-agent:
  ~/.hermes/hermes-agent/hermes_cli/web_routers/preview.py
To overlay a cube that has not picked up that Hermes build, copy this file
onto the VM as hermes_cli/web_routers/preview.py and restart the dashboard.

These run on the *agent's* Hermes dashboard — the same process that already
serves ``/api/fs/*``. The desktop never talks to VM localhost itself (CORS +
no tunnel). Electron proxies through these authenticated routes.

SSRF rules for the HTTP proxy:
  - connect only to 127.0.0.1
  - port must be 1024–65535, excluding mail/ssh
  - do not follow redirects off loopback
"""

from __future__ import annotations

import io
import os
import shutil
import socket
import subprocess
import time
import zipfile
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse

router = APIRouter()

_BLOCKED_PORTS = frozenset({22, 25, 465, 587, 2525})
_ZIP_SKIP_DIR = frozenset({
    "node_modules", ".git", ".hg", ".svn", "__pycache__", ".venv", "venv",
    ".next", ".turbo", "coverage", "dist-electron",
})
_ZIP_MAX_FILES = 400
_ZIP_MAX_UNCOMPRESSED = 80 * 1024 * 1024
_FILE_MAX_BYTES = 12 * 1024 * 1024
_PROXY_MAX_BYTES = 32 * 1024 * 1024
_SCREENSHOT_NAMES = (".png", ".jpg", ".jpeg", ".webp")

_HOP = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host",
})


def _hermes_home() -> Path:
    raw = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    return Path(raw).expanduser()


def _workspace_ok(path: Path) -> bool:
    try:
        resolved = path.expanduser().resolve(strict=False)
    except (OSError, RuntimeError):
        return False
    allowed = [
        Path("/opt/data"),
        _hermes_home(),
        Path("/tmp"),
        Path.cwd(),
    ]
    home = Path.home()
    if str(home) not in {"/", ""}:
        allowed.append(home / ".hermes")
    text = str(resolved)
    return any(text == str(root) or text.startswith(str(root) + os.sep) for root in allowed)


def _safe_path(raw: str) -> Path:
    if not raw or "\0" in raw or ".." in raw.split(os.sep):
        raise HTTPException(status_code=400, detail="Invalid path")
    try:
        target = Path(raw).expanduser()
        if not target.is_absolute():
            target = Path.cwd() / target
        target = target.resolve(strict=False)
    except (OSError, RuntimeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid path")
    if not _workspace_ok(target):
        raise HTTPException(status_code=403, detail="Path is outside the agent workspace")
    return target


def _port_ok(port: int) -> bool:
    return 1024 <= port <= 65535 and port not in _BLOCKED_PORTS


def _loopback_url(raw: str) -> str:
    try:
        parsed = urlparse(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid URL")
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(status_code=400, detail="Only http(s) loopback URLs")
    host = (parsed.hostname or "").lower()
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise HTTPException(status_code=400, detail="URL must be loopback on the agent VM")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if port not in {80, 8080} and not _port_ok(port):
        raise HTTPException(status_code=400, detail="Port not allowed")
    return raw


def _listening_ports() -> list[dict]:
    """Read local listening TCP ports. Prefer ss; fall back to /proc/net/tcp."""
    found: dict[int, str] = {}
    ss = shutil.which("ss")
    if ss:
        try:
            out = subprocess.run(
                [ss, "-lntH"],
                capture_output=True,
                text=True,
                timeout=3,
                check=False,
            ).stdout
        except (OSError, subprocess.TimeoutExpired):
            out = ""
        for line in out.splitlines():
            # Local Address:Port is column 4 in `ss -lntH`
            parts = line.split()
            if len(parts) < 4:
                continue
            local = parts[3]
            if ":" not in local:
                continue
            port_s = local.rsplit(":", 1)[-1]
            try:
                port = int(port_s)
            except ValueError:
                continue
            if _port_ok(port):
                found[port] = local
    if not found and Path("/proc/net/tcp").exists():
        try:
            text = Path("/proc/net/tcp").read_text(encoding="ascii", errors="ignore")
        except OSError:
            text = ""
        for line in text.splitlines()[1:]:
            cols = line.split()
            if len(cols) < 4:
                continue
            # st 0A = listening
            if cols[3] != "0A":
                continue
            local = cols[1]
            if ":" not in local:
                continue
            try:
                port = int(local.split(":")[1], 16)
            except ValueError:
                continue
            if _port_ok(port):
                found[port] = "127.0.0.1:%d" % port
    rows = [{"port": port, "bind": bind, "hint": _port_hint(port)} for port, bind in sorted(found.items())]
    return rows


def _port_hint(port: int) -> str:
    return {
        3000: "node",
        3001: "node",
        4173: "vite-preview",
        5173: "vite",
        5174: "vite",
        8000: "http",
        8080: "http",
        8888: "jupyter",
        9119: "hermes-serve",
    }.get(port, "http")


@router.get("/api/preview/ports")
async def preview_ports():
    return {"ports": _listening_ports()}


@router.get("/api/preview/file")
async def preview_file(path: str = Query(..., min_length=1, max_length=4096)):
    target = _safe_path(path)
    if target.is_dir():
        index = target / "index.html"
        if index.is_file():
            target = index
        else:
            raise HTTPException(status_code=404, detail="No index.html in this folder")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    try:
        size = target.stat().st_size
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if size > _FILE_MAX_BYTES:
        raise HTTPException(status_code=413, detail="File too large to preview")
    data = target.read_bytes()
    import mimetypes
    mime, _ = mimetypes.guess_type(str(target))
    return Response(content=data, media_type=mime or "application/octet-stream")


@router.api_route("/api/preview/http/{port}/{path:path}", methods=["GET", "HEAD"])
@router.api_route("/api/preview/http/{port}", methods=["GET", "HEAD"])
async def preview_http(port: int, request: Request, path: str = ""):
    if not _port_ok(port):
        raise HTTPException(status_code=400, detail="Port not allowed")
    suffix = path or ""
    query = request.url.query
    target = f"http://127.0.0.1:{port}/{suffix}"
    if query:
        target = f"{target}?{query}"
    return await _proxy_loopback(target, request.method)


async def _proxy_loopback(url: str, method: str) -> Response:
    parsed = urlparse(url)
    host = "127.0.0.1"
    port = parsed.port or 80
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    try:
        sock = socket.create_connection((host, port), timeout=8)
    except OSError as exc:
        raise HTTPException(status_code=502, detail=f"Nothing listening on :{port} ({exc})")
    try:
        sock.settimeout(20)
        req = (
            f"{method} {path} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Connection: close\r\n"
            "Accept: */*\r\n"
            "User-Agent: NubAgent-VMPreview/1\r\n"
            "\r\n"
        )
        sock.sendall(req.encode("ascii"))
        buf = b""
        while b"\r\n\r\n" not in buf and len(buf) < 64_000:
            chunk = sock.recv(8192)
            if not chunk:
                break
            buf += chunk
        if b"\r\n\r\n" not in buf:
            raise HTTPException(status_code=502, detail="Upstream returned no headers")
        header_blob, body = buf.split(b"\r\n\r\n", 1)
        lines = header_blob.split(b"\r\n")
        status_line = lines[0].decode("latin-1", errors="replace")
        try:
            status = int(status_line.split(" ")[1])
        except (IndexError, ValueError):
            status = 502
        headers: dict[str, str] = {}
        for raw in lines[1:]:
            if b":" not in raw:
                continue
            name, value = raw.split(b":", 1)
            key = name.decode("latin-1").strip()
            if key.lower() in _HOP:
                continue
            headers[key] = value.decode("latin-1").strip()
        while len(body) < _PROXY_MAX_BYTES:
            chunk = sock.recv(64_000)
            if not chunk:
                break
            body += chunk
            if len(body) > _PROXY_MAX_BYTES:
                raise HTTPException(status_code=413, detail="Upstream response too large")
    finally:
        try:
            sock.close()
        except OSError:
            pass
    media = headers.get("Content-Type") or headers.get("content-type") or "application/octet-stream"
    # Drop content-length; FastAPI will set it.
    headers.pop("Content-Length", None)
    headers.pop("content-length", None)
    # Allow embedding inside the desktop Computer / Preview iframe.
    headers["X-Frame-Options"] = "ALLOWALL"
    headers.pop("Content-Security-Policy", None)
    headers.pop("content-security-policy", None)
    return Response(content=body, status_code=status, media_type=media.split(";")[0].strip(), headers=headers)


@router.get("/api/preview/zip")
async def preview_zip(path: str = Query(..., min_length=1, max_length=4096)):
    root = _safe_path(path)
    if not root.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    if root.is_file():
        files = [root]
        arc_root = root.parent
    else:
        files = []
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in _ZIP_SKIP_DIR and not d.startswith(".")]
            for name in filenames:
                if name.startswith(".") and name not in {".env.example", ".gitignore"}:
                    continue
                files.append(Path(dirpath) / name)
                if len(files) > _ZIP_MAX_FILES:
                    raise HTTPException(status_code=413, detail="Too many files to zip")
        arc_root = root
    buf = io.BytesIO()
    uncompressed = 0
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for file in files:
            try:
                size = file.stat().st_size
            except OSError:
                continue
            uncompressed += size
            if uncompressed > _ZIP_MAX_UNCOMPRESSED:
                raise HTTPException(status_code=413, detail="Project is too large to download")
            try:
                rel = file.relative_to(arc_root)
            except ValueError:
                continue
            zf.write(file, arcname=str(rel))
    data = buf.getvalue()
    filename = (root.name if root.name else "project") + ".zip"
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _newest_screenshot() -> Optional[Path]:
    roots = [
        _hermes_home() / "screenshots",
        _hermes_home() / "images",
        Path("/tmp"),
        Path("/opt/data/workspace"),
    ]
    newest: Optional[Path] = None
    newest_mtime = 0.0
    for root in roots:
        if not root.is_dir():
            continue
        try:
            for entry in root.iterdir():
                if not entry.is_file():
                    continue
                if entry.suffix.lower() not in _SCREENSHOT_NAMES:
                    continue
                try:
                    mtime = entry.stat().st_mtime
                except OSError:
                    continue
                if mtime > newest_mtime:
                    newest = entry
                    newest_mtime = mtime
        except OSError:
            continue
    # Ignore stale tmp junk older than 2 days unless it's clearly a preview shot.
    if newest and newest.parent == Path("/tmp") and (time.time() - newest_mtime) > 172800:
        if not newest.name.startswith("nub-"):
            return None
    return newest


def _chromium() -> Optional[str]:
    for name in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable"):
        found = shutil.which(name)
        if found:
            return found
    return None


@router.get("/api/computer/status")
async def computer_status():
    ports = _listening_ports()
    shot = _newest_screenshot()
    return {
        "ready": True,
        "provider": "vm",
        "platform": os.uname().sysname if hasattr(os, "uname") else os.name,
        "chromium": bool(_chromium()),
        "screenshot": str(shot) if shot else None,
        "ports": ports,
        "workspace": "/opt/data/workspace" if Path("/opt/data/workspace").is_dir() else str(Path.cwd()),
    }


@router.get("/api/computer/screenshot")
async def computer_screenshot(url: Optional[str] = None):
    """PNG of the page on the agent VM (Chromium) or the newest saved shot."""
    if url:
        safe = _loopback_url(url)
        chrome = _chromium()
        if not chrome:
            raise HTTPException(status_code=501, detail="Chromium is not installed on this VM")
        dest = Path("/tmp/nub-computer.png")
        try:
            proc = subprocess.run(
                [
                    chrome,
                    "--headless=new",
                    "--disable-gpu",
                    "--no-sandbox",
                    "--hide-scrollbars",
                    "--window-size=1280,800",
                    f"--screenshot={dest}",
                    safe,
                ],
                capture_output=True,
                timeout=25,
                check=False,
            )
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=504, detail="Screenshot timed out")
        if not dest.is_file() or dest.stat().st_size < 32:
            detail = (proc.stderr or b"").decode("utf-8", errors="replace")[-400:]
            raise HTTPException(status_code=502, detail=detail or "Chromium did not write a screenshot")
        return Response(content=dest.read_bytes(), media_type="image/png")

    shot = _newest_screenshot()
    if not shot:
        raise HTTPException(status_code=404, detail="No screenshot on the agent VM yet")
    import mimetypes
    mime, _ = mimetypes.guess_type(str(shot))
    return Response(content=shot.read_bytes(), media_type=mime or "image/png")

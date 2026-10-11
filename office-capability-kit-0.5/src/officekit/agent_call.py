#!/usr/bin/env python3
"""Copyable stdlib client for the bounded officekit file tool bridge.

This file is deliberately independent of the installed evaluator package. It
never starts a model, imports officekit, opens a private run, or submits scores.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import time
import uuid
try:
    import fcntl
except ImportError:
    fcntl = None

PROTOCOL = "officekit-agent-file-bridge-v1"
MAX_MESSAGE_BYTES = 1_000_000
REQUEST_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$")


class BridgeError(Exception):
    def __init__(self, message, status="UNKNOWN", error_class="INSTRUMENTATION"):
        super().__init__(message)
        self.status = status
        self.error_class = error_class


def strict_json(data):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError("Duplicate JSON object key")
            value[key] = item
        return value
    def constant(_):
        raise ValueError("Non-finite JSON numbers are not supported")
    value = json.loads(data, object_pairs_hook=pairs, parse_constant=constant)
    def finite(item):
        if isinstance(item, float) and not math.isfinite(item):
            raise ValueError("Non-finite JSON numbers are not supported")
        if isinstance(item, dict):
            for child in item.values(): finite(child)
        elif isinstance(item, list):
            for child in item: finite(child)
    finite(value)
    return value


def json_bytes(value):
    raw = (json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")
    if len(raw) > MAX_MESSAGE_BYTES:
        raise ValueError("Bridge message exceeds bounded message size")
    return raw


def checked_path(path, *, directory=False, allow_missing=False):
    """Reject symbolic links in every component, including a selected root."""
    value = Path(os.path.abspath(os.fspath(path)))
    current = Path(value.anchor)
    for part in value.parts[1:]:
        current = current / part
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError:
            if allow_missing:
                continue
            raise
        if stat.S_ISLNK(mode):
            raise ValueError("Symbolic links are not permitted in bridge paths")
        if current != value and not stat.S_ISDIR(mode):
            raise ValueError("Bridge path parent must be a directory")
    if value.exists():
        mode = value.lstat().st_mode
        if directory and not stat.S_ISDIR(mode):
            raise ValueError("Bridge root must be a directory")
        if not directory and not stat.S_ISREG(mode):
            raise ValueError("Bridge file must be a regular file")
    return value


def bridge_supported():
    return os.name == "posix" and os.open in os.supports_dir_fd and os.unlink in os.supports_dir_fd and os.rename in os.supports_dir_fd and hasattr(os, "O_NOFOLLOW") and fcntl is not None


class BridgeDirectory:
    """Anchor file operations to a no-follow directory descriptor on POSIX.

    This prevents file symlink traversal. It does not provide OS isolation from
    an agent that has permission to inspect other paths on the same computer.
    """
    def __init__(self, path):
        if not bridge_supported():
            raise BridgeError("This helper requires a POSIX no-follow dir_fd file bridge", "UNSUPPORTED")
        self.path = checked_path(path, directory=True)
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        self.fd = os.open(self.path, flags)
        self.identity = os.fstat(self.fd).st_dev, os.fstat(self.fd).st_ino
        self.lock_fd = None

    def close(self):
        if self.lock_fd is not None:
            self.release()
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def __enter__(self): return self
    def __exit__(self, *_): self.close()

    def _name(self, name):
        if not isinstance(name, str) or not name or PurePosixPath(name).name != name or name in (".", ".."):
            raise ValueError("Bridge filenames must be single canonical components")
        checked_path(self.path, directory=True)
        current = self.path.stat()
        if (current.st_dev, current.st_ino) != self.identity:
            raise ValueError("Bridge directory was replaced during the session")

    def read(self, name, missing=False):
        self._name(name)
        try:
            fd = os.open(name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0), dir_fd=self.fd)
        except FileNotFoundError:
            if missing: return None
            raise
        try:
            info = os.fstat(fd)
            # Atomic replacement can unlink this already-open old inode.
            # nlink=0 is a safe read-only snapshot, not an additional alias;
            # the caller still matches its request_id/hash before using it.
            if not stat.S_ISREG(info.st_mode) or info.st_nlink > 1:
                raise ValueError("Bridge request/response must be an unaliased regular file")
            if info.st_size > MAX_MESSAGE_BYTES:
                raise ValueError("Bridge message exceeds bounded message size")
            with os.fdopen(fd, "rb", closefd=False) as stream:
                raw = stream.read(MAX_MESSAGE_BYTES + 1)
            if len(raw) > MAX_MESSAGE_BYTES:
                raise ValueError("Bridge message exceeds bounded message size")
            return raw
        finally:
            os.close(fd)

    def write(self, name, value):
        self._name(name)
        try:
            mode = os.stat(name, dir_fd=self.fd, follow_symlinks=False).st_mode
            if not stat.S_ISREG(mode):
                raise ValueError("Bridge destination must be a regular file, never a symlink")
        except FileNotFoundError:
            pass
        raw = json_bytes(value)
        temporary = ".tmp-" + uuid.uuid4().hex
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=self.fd)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, name, src_dir_fd=self.fd, dst_dir_fd=self.fd)
        finally:
            try: os.unlink(temporary, dir_fd=self.fd)
            except FileNotFoundError: pass

    def acquire(self, request_id):
        if self.lock_fd is not None:
            raise BridgeError("Another helper request is in flight", error_class="PROTOCOL_INTEGRATION")
        self._name("client.lock")
        fd = os.open("client.lock", os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=self.fd)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            os.close(fd)
            raise ValueError("Bridge client lock must be an unaliased regular file")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise BridgeError("Another helper request is in flight; use one agent and one request at a time", error_class="PROTOCOL_INTEGRATION") from None
        self.lock_fd = fd
        os.ftruncate(fd, 0)
        os.write(fd, json_bytes({"request_id": request_id}))

    def release(self):
        if self.lock_fd is not None:
            fd, self.lock_fd = self.lock_fd, None
            try: fcntl.flock(fd, fcntl.LOCK_UN)
            finally: os.close(fd)
        # Keep the inode: deleting a lock file could let parallel clients lock
        # different inodes. The OS releases flock even when a helper is killed.


def request(bundle, op, *, tool=None, arguments=None, result=None, request_id=None, timeout=30, poll_interval=0.05):
    """Submit one request, returning only the actual host response envelope.

    Reuse request_id and the identical request after an interrupted wait. The
    host returns its cached response without another LocalSession invocation.
    A service retry after COMMIT_ACK_LOST instead uses a new bridge request_id
    and the SAME service idempotency_key, because it is a new tool invocation.
    """
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("Helper timeout must be a finite positive number")
    if not isinstance(poll_interval, (int, float)) or isinstance(poll_interval, bool) or not math.isfinite(poll_interval) or poll_interval <= 0:
        raise ValueError("Poll interval must be finite and positive")
    root = checked_path(bundle, directory=True)
    try:
        checked_path(root / ".bridge", directory=True)
    except FileNotFoundError:
        raise BridgeError("No trusted operator host is running for this public bundle", "UNSUPPORTED") from None
    request_id = request_id or uuid.uuid4().hex
    if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
        raise ValueError("request_id must be a bounded safe identifier")
    with BridgeDirectory(root / ".bridge") as bridge:
        ready_raw = bridge.read("ready.json", missing=True)
        if ready_raw is None:
            raise BridgeError("Trusted operator host is not ready", "UNSUPPORTED")
        ready = strict_json(ready_raw)
        if not isinstance(ready, dict) or ready.get("protocol") != PROTOCOL or not isinstance(ready.get("run_id"), str):
            raise BridgeError("Bridge ready message is invalid")
        value = {"protocol": PROTOCOL, "run_id": ready["run_id"], "request_id": request_id, "op": op}
        if op == "tool":
            if not isinstance(tool, str) or not isinstance(arguments, dict):
                raise ValueError("A tool call requires a tool string and JSON object arguments")
            value.update(tool=tool, arguments=arguments)
        elif op == "final":
            value["result"] = result
        else:
            raise ValueError("Operation must be tool or final")
        fingerprint = hashlib.sha256(json_bytes(value)).hexdigest()
        bridge.acquire(request_id)
        try:
            bridge.write("request.json", value)
            deadline = time.monotonic() + timeout
            while True:
                # The host publishes a response before its terminal status.
                # Read status first so an old response snapshot cannot hide a
                # final acknowledgment published before CLOSED/UNKNOWN.
                status_raw = bridge.read("status.json", missing=True)
                status = strict_json(status_raw) if status_raw is not None else None
                raw = bridge.read("response.json", missing=True)
                if raw is not None:
                    response = strict_json(raw)
                    if isinstance(response, dict) and response.get("protocol") == PROTOCOL and response.get("run_id") == ready["run_id"] and response.get("request_id") == request_id and response.get("request_sha256") == fingerprint:
                        return response
                if isinstance(status, dict) and status.get("run_id") == ready["run_id"] and status.get("status") in ("CLOSED", "UNKNOWN", "UNSUPPORTED"):
                    raise BridgeError("Operator host is closed or unavailable", status.get("status") if status.get("status") != "CLOSED" else "UNKNOWN")
                if time.monotonic() >= deadline:
                    raise BridgeError("Timed out waiting for a real host response; retry the identical request_id", "UNKNOWN")
                time.sleep(min(poll_interval, max(0, deadline - time.monotonic())))
        finally:
            bridge.release()


def preflight(bundle):
    """Read readiness without executing a tool or modifying the bundle."""
    root = checked_path(bundle, directory=True)
    try:
        with BridgeDirectory(root / ".bridge") as bridge:
            raw = bridge.read("ready.json", missing=True)
            if raw is None:
                raise BridgeError("Trusted operator host is not ready", "UNSUPPORTED")
            ready = strict_json(raw)
            if not isinstance(ready, dict) or ready.get("protocol") != PROTOCOL or not isinstance(ready.get("run_id"), str):
                raise BridgeError("Bridge ready message is invalid")
            status_raw = bridge.read("status.json", missing=True)
            status = strict_json(status_raw) if status_raw else {}
            if not isinstance(status, dict) or status.get("run_id") != ready["run_id"] or status.get("status") != "RUNNING":
                raise BridgeError("Trusted operator host is closed or unavailable", "UNKNOWN")
            return {"type": "environment", "status": "READY", "protocol": PROTOCOL,
                    "run_id": ready["run_id"], "case_id": ready.get("case_id"),
                    "max_tool_calls": ready.get("max_tool_calls"),
                    "environment": ready.get("environment", {})}
    except FileNotFoundError:
        raise BridgeError("No trusted operator host is running for this public bundle", "UNSUPPORTED") from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", default=".", help="Public bundle directory only")
    parser.add_argument("--request-id", help="Reuse exactly this ID only for an identical request")
    parser.add_argument("--timeout", type=float, default=30)
    commands = parser.add_subparsers(dest="op", required=True)
    commands.add_parser("preflight")
    call = commands.add_parser("tool")
    call.add_argument("name")
    call.add_argument("arguments", help="Strict JSON object")
    final = commands.add_parser("final")
    final.add_argument("result", help="Strict candidate JSON, or @relative-file inside the public bundle")
    args = parser.parse_args(argv)
    try:
        options = {"request_id": args.request_id, "timeout": args.timeout}
        if args.op == "preflight":
            print(json_bytes(preflight(args.bundle)).decode("utf-8"), end="")
            return 0
        if args.op == "tool":
            options.update(tool=args.name, arguments=strict_json(args.arguments))
        else:
            raw = args.result
            if raw.startswith("@"):
                relative = raw[1:]
                path = PurePosixPath(relative)
                if path.is_absolute() or ".." in path.parts or path.as_posix() != relative:
                    raise ValueError("Final file must be a canonical path inside the public bundle")
                target = checked_path(checked_path(args.bundle, directory=True) / relative)
                if target.stat().st_size > MAX_MESSAGE_BYTES:
                    raise ValueError("Final result exceeds bounded message size")
                raw = target.read_text(encoding="utf-8")
            options["result"] = strict_json(raw)
        response = request(args.bundle, args.op, **options)
        print(json_bytes(response).decode("utf-8"), end="")
        return 0 if response.get("type") != "rejected" else 2
    except (BridgeError, OSError, ValueError, UnicodeError, RecursionError) as exc:
        status = exc.status if isinstance(exc, BridgeError) else "UNKNOWN"
        error_class = exc.error_class if isinstance(exc, BridgeError) else "PROTOCOL_INTEGRATION"
        print(json.dumps({"type": "environment_error", "status": status, "error_class": error_class, "message": str(exc)}, sort_keys=True))
        return 2


if __name__ == "__main__":
    sys.exit(main())

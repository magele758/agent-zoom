"""Resolve existing local Git checkouts. Never run repo scripts or send a path to a remote."""
import concurrent.futures
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
from urllib.parse import urlsplit


def fallback_roots(roots):
    skip = {"node_modules", "dist", "build", "target", "vendor", "venv", "__pycache__", "Pods"}
    for root in roots:
        for path, directories, files in os.walk(root, followlinks=False):
            if ".git" in directories or ".git" in files:
                yield path
            depth = len(Path(path).relative_to(root).parts)
            directories[:] = [d for d in directories if not d.startswith(".") and d not in skip] if depth < 4 else []


def available_cwds(home):
    db_path = home / "hub.db"
    if not db_path.is_file():
        return []
    db = sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True, timeout=1)
    try:
        paths = {row[0] for row in db.execute("SELECT DISTINCT path FROM worktree_snapshots WHERE path LIKE '/%'")}
        paths.update(row[0] for row in db.execute("SELECT DISTINCT cwd FROM sessions WHERE cwd LIKE '/%'"))
        return paths
    finally:
        db.close()


def git_identity(repo):
    marker = repo / ".git"
    if marker.is_dir():
        return str(marker.resolve())
    if marker.is_file():
        with marker.open(encoding="utf-8") as fp:
            line = fp.readline(8192).strip()
        if line.startswith("gitdir: "):
            git_dir = (repo / line[8:]).resolve()
            common = git_dir / "commondir"
            if common.is_file():
                git_dir = (git_dir / common.read_text().strip()).resolve()
            if git_dir.is_dir():
                return str(git_dir)
    return None


def github_name(raw):
    if raw.startswith("git@github.com:"):
        name = raw.removeprefix("git@github.com:")
    else:
        try:
            url = urlsplit(raw)
            if url.scheme not in ("ssh", "https", "http", "git") or url.hostname != "github.com":
                return None
            name = url.path.lstrip("/")
        except ValueError:
            return None
    name = name.rstrip("/").removesuffix(".git")
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+", name) and name.split("/")[1] not in (".", ".."):
        return name
    return None


def describe(copies):
    repo = min(copies, key=lambda p: (len(p), p))
    env = {**os.environ, "GIT_OPTIONAL_LOCKS":"0", "GIT_TERMINAL_PROMPT":"0"}
    def git(*args):
        result = subprocess.run(["git", "-C", repo, *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, timeout=5)
        return os.fsdecode(result.stdout) if result.returncode == 0 else ""
    name = github_name(git("config", "--local", "--get", "remote.origin.url").strip())
    worktrees = [s[9:] for s in git("worktree", "list", "--porcelain", "-z").split("\0") if s.startswith("worktree ") and os.path.isdir(s[9:])]
    paths = list(dict.fromkeys(os.path.realpath(p) for p in worktrees + sorted(copies)))
    return {"fullName": name or paths[0], "paths": paths}


def configured_roots(notes):
    home = Path(os.environ.get("OPC_AGENT_HUB_DIR", "~/.agent-hub")).expanduser().resolve()
    roots = os.environ.get("OPC_REPO_ROOTS", "~/developer").split(os.pathsep)
    roots = [str(Path(p).expanduser().resolve()) for p in roots if p and Path(p).expanduser().is_dir()]
    if (home / "src/agent_hub/collectors.py").is_file():
        sys.path.insert(0, str(home / "src"))
        try:
            from agent_hub.collectors import find_repos
            found = list(find_repos(roots))
        except (ImportError, OSError):
            found = list(fallback_roots(roots))
            notes.append("Agent Hub 的仓库发现器不可用，已按指定根目录扫描")
    else:
        found = list(fallback_roots(roots))
    try:
        history = available_cwds(home)
    except (sqlite3.Error, OSError):
        history = []
        notes.append("Agent Hub 的历史工作目录暂不可读")
    found.extend(workspace_roots(history).values())
    return found, roots


def workspace_roots(workspaces):
    roots = {}
    for cwd in workspaces:
        p = Path(cwd)
        if not p.is_absolute() or not p.is_dir():
            continue
        # Resolve aliases before walking upwards (macOS /var, or a symlink into a worktree).
        p = p.resolve()
        for parent in (p, *p.parents):
            if (parent / ".git").exists():
                roots[cwd] = str(parent)
                break
    return roots


def main():
    notes = []
    hints = {}
    if sys.argv[1:] == ["--workspaces"]:
        hints = workspace_roots(json.load(sys.stdin))
        found, roots = set(hints.values()), []
    else:
        found, roots = configured_roots(notes)
    groups = {}
    for p in found:
        try:
            identity = git_identity(Path(p))
            if identity:
                groups.setdefault(identity, set()).add(os.path.realpath(p))
        except (OSError, ValueError):
            notes.append("部分本地 Git 路径不可读")
    rows = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
        for job in [ex.submit(describe, copies) for copies in groups.values()]:
            try:
                rows.append(job.result())
            except (OSError, subprocess.TimeoutExpired, ValueError):
                notes.append("部分检出目录暂时无法核对 Git 来源")
    print(json.dumps({"rows":rows, "roots":roots, "notes":list(dict.fromkeys(notes)), "workspaceRoots":hints}, ensure_ascii=True))


if __name__ == "__main__":
    main()

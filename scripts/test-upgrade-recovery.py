#!/usr/bin/env python3
"""Test the tagged-checkout route, rollback and subsequent installed CLI on Windows/POSIX."""

import io
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile

REPO = Path(__file__).resolve().parents[1]
VERSION = json.loads((REPO / "packages/lucid-server/package.json").read_text())[
    "lucidRelease"
]
TAG = "v" + VERSION
BUN = shutil.which("bun")
assert BUN


def git(*args, cwd=REPO):
    return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()


def archive(ref, destination):
    destination.mkdir(parents=True)
    data = subprocess.check_output(["git", "archive", ref], cwd=REPO)
    with tarfile.open(fileobj=io.BytesIO(data)) as files:
        files.extractall(destination, filter="data")


def exercise(root):
    home = root / "home with spaces"
    base = home / ".lucid"
    project = root / "space = project"
    project.mkdir()
    checkout = root / "release checkout"
    git("clone", "--quiet", "--shared", str(REPO), str(checkout))
    sha = git("rev-parse", "HEAD")
    git("checkout", "--quiet", "--detach", sha, cwd=checkout)
    git("tag", "-f", TAG, sha, cwd=checkout)
    for name in ["server", "native", "perception"]:
        archive("v0.6.5:packages/lucid-" + name, base / name)
    manifest = base / "server/package.json"
    pkg = json.loads(manifest.read_text())
    pkg["dependencies"].update(
        {
            "@lucid-memory/native": "file:../native",
            "@lucid-memory/perception": "file:../perception",
        }
    )
    manifest.write_text(json.dumps(pkg))
    cdir = home / "claude settings"
    xdir = home / "codex settings"
    cdir.mkdir()
    xdir.mkdir()
    settings = cdir / "settings.json"
    settings.write_text(
        '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"other"}]}]}}'
    )
    toml = xdir / "config.toml"
    toml.write_text('notify=["other"]\n')
    config = base / "config.json"
    config.write_text(
        json.dumps(
            {
                "databaseMode": "profiles",
                "clients": {
                    c: {"enabled": True, "profile": "work"} for c in ["claude", "codex"]
                },
                "profiles": {"work": {"dbPath": str(home / "DB space" / "private.db")}},
                "unrelated": {"keep": True},
            }
        )
    )
    snapshot = config.read_bytes()
    env = {
        k: v
        for k, v in os.environ.items()
        if k.upper()
        in [
            "PATH",
            "SYSTEMROOT",
            "COMSPEC",
            "PATHEXT",
            "TEMP",
            "TMP",
            "TMPDIR",
            "LANG",
            "LOCALAPPDATA",
            "APPDATA",
            "BUN_INSTALL_CACHE_DIR",
        ]
    }
    env.update(
        {
            "HOME": str(home),
            "USERPROFILE": str(home),
            "CODEX_HOME": str(xdir),
            "CLAUDE_CONFIG_DIR": str(cdir),
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "url." + checkout.as_uri() + ".insteadOf",
            "GIT_CONFIG_VALUE_0": "https://github.com/JasonDocton/lucid-memory.git",
        }
    )

    def run(*args, ok=True):
        p = subprocess.run(
            [BUN, *map(str, args)],
            cwd=project,
            env=env,
            capture_output=True,
            text=True,
            timeout=180,
        )
        assert (p.returncode == 0) == ok, (p.stdout[-1200:], p.stderr[-1800:])
        return p.stdout + p.stderr

    preload = root / "fixture.ts"
    preload.write_text(
        "globalThis.fetch=async url=>String(url).endsWith('/releases/latest')?Response.json({tag_name:"
        + json.dumps(TAG)
        + "}):Response.json({models:[]})"
    )

    def cli(*args):
        # Future updates go through the installed launcher, including Windows cmd.exe.
        if (
            args == ("update",)
            and (base / "bin" / ("lucid.cmd" if os.name == "nt" else "lucid")).exists()
        ):
            env["BUN_OPTIONS"] = "--preload=" + preload.as_posix()
            cmd = (
                [
                    os.environ.get("COMSPEC", "cmd.exe"),
                    "/d",
                    "/c",
                    str(base / "bin/lucid.cmd"),
                    "update",
                ]
                if os.name == "nt"
                else [str(base / "bin/lucid"), "update"]
            )
            r = subprocess.run(
                cmd, cwd=project, env=env, capture_output=True, text=True, timeout=180
            )
            assert r.returncode == 0, (r.stdout[-1000:], r.stderr[-2000:])
            return r.stdout + r.stderr
        return run(
            "run",
            "--preload",
            preload,
            "--no-install",
            base / "server/src/cli.ts",
            *args,
        )

    cli(
        "store",
        "Do not lose this memory.",
        "--type=decision",
        "--project=" + str(project),
    )
    dbpath = home / "DB space/private.db"

    def memories():
        with closing(sqlite3.connect(dbpath)) as db:
            return db.execute("SELECT id,content,project_id FROM memories").fetchall()

    oldrows = memories()
    assert len(oldrows) == 1
    program = checkout / "packages/lucid-server/src/upgrade.ts"

    def recover(ok=True):
        return run(
            "run", "--no-env-file", "--no-install", program, "--from-checkout", ok=ok
        )

    # A simultaneous updater holds a process-scoped lock, not a memory database lock.
    with closing(sqlite3.connect(base / ".update-lock.sqlite")) as lock:
        lock.execute("BEGIN EXCLUSIVE")
        assert "locked" in recover(False).lower()
        assert memories() == oldrows and config.read_bytes() == snapshot
        lock.rollback()

    # Unknown directories are never cleared; an interrupted real swap must be recoverable.
    work = base / ".upgrade-work"
    work.mkdir()
    sentinel = work / "unrelated"
    sentinel.write_text("keep")
    assert "Unrecognized" in recover(False) and sentinel.read_text() == "keep"
    sentinel.unlink()
    work.rmdir()
    work.mkdir()
    (work / "owner").write_text("lucid-update-v1")
    (work / "old").mkdir()
    (base / "server").rename(work / "old/server")
    original = settings.read_bytes()
    # A failure in the second client occurs after Claude settings were changed.
    failed_backup = Path(str(toml) + ".backup")
    failed_backup.mkdir()
    failed = recover(False)
    assert (
        settings.read_bytes() == original
        and not (base / "server/src/upgrade.ts").exists()
    ), failed
    assert json.loads(manifest.read_text())["version"] == "0.6.5"
    assert memories() == oldrows and config.read_bytes() == snapshot
    failed_backup.rmdir()
    recover()
    assert config.read_bytes() == snapshot and memories() == oldrows
    assert json.loads(manifest.read_text())["version"] == VERSION
    assert len(json.loads(settings.read_text())["hooks"]["Stop"]) == 2
    # Exercise the post-v0.6.5 CLI on a whitespace home, with an older installed version.
    installed = json.loads(manifest.read_text())
    installed["version"] = installed["lucidRelease"] = "0.6.5"
    manifest.write_text(json.dumps(installed))
    assert "Updated to Lucid" in cli("update")
    assert (
        json.loads(manifest.read_text())["version"] == VERSION
        and memories() == oldrows
        and config.read_bytes() == snapshot
    )
    assert "up to date" in cli("update")
    print(
        f"PASS {os.name}: tagged checkout, interrupted swap, rollback after first client, whitespace CLI upgrade and idempotence."
    )


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="lucid-release-recovery-") as name:
        exercise(Path(name))

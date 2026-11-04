#!/usr/bin/env python3
"""Exercise the *released* installer and CLI against a local Git remote and release response."""
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import shutil
import sqlite3
import subprocess
import tempfile
import time
import tomllib

REPO = Path(__file__).resolve().parents[1]
OLD = "v0.6.5"
VERSION = json.loads((REPO / "packages/lucid-server/package.json").read_text())["lucidRelease"]
NEW = "v" + VERSION
BUN = shutil.which("bun")
assert BUN

def git(*args, cwd=REPO):
    return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()

def run(argv, cwd, env, ok=True):
    r = subprocess.run(argv, cwd=cwd, env=env, text=True, capture_output=True, timeout=210)
    if (r.returncode == 0) != ok:
        raise AssertionError(f"{argv}: {r.returncode}\n{r.stdout[-3500:]}\n{r.stderr[-3500:]}")
    return r.stdout + r.stderr

def install(script, env, answers):
    pid, fd = pty.fork()
    if not pid:
        os.execve("/bin/bash", ["bash", str(script)], env)
    log = b""
    offset = 0
    try:
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            if not select.select([fd], [], [], 0.5)[0]:
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            log += chunk
            if answers:
                prompt, answer = answers[0]
                index = log.find(prompt.encode(), offset)
                if index >= 0:
                    os.write(fd, answer.encode()+b"\n")
                    offset = index + len(prompt)
                    answers.pop(0)
        else:
            os.kill(pid, 9)
            raise AssertionError("Installer timed out: " + log[-3000:].decode(errors="replace"))
    finally:
        os.close(fd)
        status = os.waitpid(pid, 0)[1]
    assert os.waitstatus_to_exitcode(status) == 0 and not answers, log[-3500:].decode(errors="replace")

def rows(path):
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
        return db.execute("SELECT id,type,content,project_id,tags FROM memories ORDER BY id").fetchall()

def digest(path):
    return hashlib.sha256(path.read_bytes()).digest()

def exercise(root):
    remote = root / "origin.git"
    git("clone", "--quiet", "--bare", "--shared", str(REPO), str(remote))
    old_sha, new_sha = git("rev-parse", OLD+"^{commit}"), git("rev-parse", "HEAD")
    git("update-ref","refs/heads/main",old_sha,cwd=remote)
    git("symbolic-ref","HEAD","refs/heads/main",cwd=remote)
    git("update-ref","refs/tags/"+NEW,new_sha,cwd=remote)
    installer = root/"install.sh"
    installer.write_text(git("show",OLD+":install.sh")+"\n")
    fakebin = root/"fixture-bin"
    fakebin.mkdir()
    # Do not install system tools, download models, or restart desktop applications.
    for tool in ["curl","pgrep","pkill","open","osascript","sudo","brew","pip3","ffmpeg","yt-dlp","whisper"]:
        stub=fakebin/tool
        stub.write_text("#!/bin/sh\nexit "+("1" if tool in {"curl","pgrep","pkill","open","osascript","sudo"} else "0")+"\n")
        stub.chmod(0o755)
    project=root/"sample project"
    project.mkdir()
    preload=project/"release.ts"
    preload.write_text("""globalThis.fetch = async (url) => {
        if (String(url).endsWith('/releases/latest')) return Response.json({tag_name:process.env.TEST_RELEASE});
        if (String(url).endsWith('/api/tags')) return Response.json({models:[]});
        throw Error('Unexpected test fetch: '+url);
    }""")
    (project/"bunfig.toml").write_text("preload = ["+json.dumps(str(preload))+"]\n")
    states=[]
    for name, clients, choice in [("claude",["claude"],"1"),("codex",["codex"],"2"),("both",["claude","codex"],"1 2")]:
        home=root/name
        (home/".claude").mkdir(parents=True)
        (home/".codex").mkdir()
        (home/".claude/settings.json").write_text('{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/team/stop.sh"}]}]}}')
        (home/".codex/config.toml").write_text(('notify = ["/usr/bin/true"]\n' if name=="both" else '')+'[mcp_servers.other]\ncommand = "other"\n')
        env = {"HOME":str(home),"USERPROFILE":str(home),"PATH":str(fakebin)+os.pathsep+os.environ["PATH"],"TERM":"dumb","LANG":"C",
               "GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_GLOBAL":os.devnull,"GIT_CONFIG_COUNT":"1",
               "GIT_CONFIG_KEY_0":"url."+remote.as_uri()+".insteadOf","GIT_CONFIG_VALUE_0":"https://github.com/JasonDocton/lucid-memory.git",
               "TEST_RELEASE":OLD}
        if os.environ.get("BUN_INSTALL_CACHE_DIR"): env["BUN_INSTALL_CACHE_DIR"]=os.environ["BUN_INSTALL_CACHE_DIR"]
        prompts=[("Continue with installation? [Y/n]: ","y"),("OpenAI API key (press Enter to skip): ",""),("Choice: ",choice)]
        if len(clients)>1: prompts.append(("Choice [1]: ","2"))
        prompts.append(("Enable automatic updates? [Y/n]: ","n"))
        install(installer,env,prompts)
        base=home/".lucid"
        cli=str(base/"bin/lucid")
        assert "0.6.5" in run([cli,"version"], project, env)
        assert "already on the latest" in run([cli,"update"], project, env)
        # Configure independent custom profile paths, using the public v0.6.5 CLI.
        paths={}
        for client in clients:
            db=home/"personal data"/(client+".sqlite")
            paths[client]=db
            run([cli,"config","create-profile",client+"-work","--path="+str(db)],project,env)
            run([cli,"config","set-profile",client,client+"-work"],project,env)
        run([cli,"config","set-mode","profiles"],project,env)
        for client in clients:
            run([cli,"store",name+"/"+client+" original memory","--type=decision","--project="+str(project)],project,{**env,"LUCID_CLIENT":client})
            assert len(rows(paths[client]))==1
        (base/".env").write_text("EXAMPLE=preserved\n")
        states.append((name,clients,env,cli,base,paths,{c:rows(db) for c,db in paths.items()},(base/"config.json").read_bytes()))
    # The release is not published yet. Only Git discovery and release metadata are redirected.
    git("update-ref","refs/heads/main",new_sha,cwd=remote)
    for name, clients,env,cli,base,paths,oldrows,oldconfig in states:
        env={**env,"TEST_RELEASE":NEW}
        assert "Update complete!" in run([cli,"update"],project,env)
        assert json.loads((base/"server/package.json").read_text())["version"]==VERSION
        assert (base/"config.json").read_bytes()==oldconfig
        assert (base/".env").read_text()=="EXAMPLE=preserved\n"
        for c,db in paths.items(): assert rows(db)==oldrows[c]
        for package in ("native","perception"):
            installed=base/package
            expected=REPO/"packages"/("lucid-"+package)
            assert json.loads((installed/"package.json").read_text())["version"]==VERSION, (name, package, (installed/"package.json").read_text())
            assert (base/"server/node_modules/@lucid-memory"/package).resolve()==installed.resolve()
            for asset in expected.glob("*.node"): assert digest(asset)==digest(installed/asset.name)
        settings=json.loads((base.parent/".claude/settings.json").read_text())
        stops=settings["hooks"]["Stop"]
        assert stops[0]["hooks"][0]["command"]=="/team/stop.sh"
        assert len(stops)==1+("claude" in clients)
        codex=tomllib.loads((base.parent/".codex/config.toml").read_text())
        assert codex["mcp_servers"]["other"]["command"]=="other"
        assert ("lucid-memory" in codex["mcp_servers"])==("codex" in clients)
        if "codex" in clients: assert any(s.endswith("codex-notify.ts") for s in codex["notify"])
        if name=="both": assert codex["notify"][-1]=="/usr/bin/true"
        # Exercise the registered callbacks and read existing/new data from the same DBs.
        for c in clients:
            reply="Confirmed "+name+"/"+c+" assistant reply."
            if c=="claude":
                handler=next(h for g in stops for h in g["hooks"] if h["command"]=="bun")
                p=subprocess.run([BUN,*handler["args"]],cwd=project,env=env,text=True,input=json.dumps({"session_id":"s","prompt_id":"p","hook_event_name":"Stop","cwd":str(project),"last_assistant_message":reply}),capture_output=True,timeout=15)
                assert p.returncode==0 and not p.stdout,p.stderr
            else:
                event=json.dumps({"type":"agent-turn-complete","thread-id":"t","turn-id":"p","cwd":str(project),"input-messages":["A question"],"last-assistant-message":reply})
                run([BUN,*codex["notify"][1:],event],project,env)
            after=rows(paths[c])
            assert oldrows[c][0] in after and any(r[2]==reply and 'assistant' in r[4] for r in after)
            for other in clients:
                if other!=c: assert all(r[2]!=reply for r in rows(paths[other]))
        assert "up to date" in run([cli,"update"],project,env)
        print(f"PASS {name}: stock {OLD} installer and lucid update -> {NEW}; original IDs, profiles, registrations and subsequent captures verified.",flush=True)
    return states,remote,project

if __name__=="__main__":
    with tempfile.TemporaryDirectory(prefix="lucid-upgrade-") as directory:
        exercise(Path(directory))

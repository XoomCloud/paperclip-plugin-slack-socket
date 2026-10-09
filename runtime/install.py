#!/usr/bin/python3 -I
"""Validated, non-destructive installer. Default: plan only. Run with sudo."""
import argparse,json,os,pathlib,re,shutil,stat,subprocess,sys,hashlib
ROOT=pathlib.Path(__file__).resolve().parent
DEST=pathlib.Path("/usr/local/lib/xoomai-runtime")
def fail(message):raise SystemExit(message)
def protected(path):
    path=pathlib.Path(path)
    if not path.is_absolute() or ".." in path.parts:fail("Absolute normalized paths required")
    for part in [path,*path.parents]:
        if part.exists() and part.is_symlink():fail("Symlink path needs explicit migration review")
    return path
def validate(cfg):
    if cfg.get("schemaVersion")!=1:fail("Unsupported runtime config schema")
    uuid=r"[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}"
    if not re.fullmatch(uuid,cfg.get("companyId","")):fail("Use the existing company UUID")
    from urllib.parse import urlsplit
    url=urlsplit(cfg.get("baseUrl",""))
    if url.scheme!="https" or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ("","/"):fail("Use the authenticated private HTTPS Paperclip origin")
    if not re.fullmatch(r"T[A-Z0-9]+",cfg.get("slackTeamId","")):fail("Slack workspace ID required")
    if not 1<=len(cfg.get("employees",[]))<=60:fail("Selected roster required")
    for field in ["appRoot","pluginRoot","paperclipHome","stateRoot","serviceEnvironmentFile","nodeBinary"]:protected(cfg[field])
    if cfg["stateRoot"]!="/var/lib/xoomai-runtime":fail("This release supports /var/lib/xoomai-runtime only")
    if not cfg.get("slackBotTokenRefs") or not cfg.get("paperclipApiKeyRef"):fail("Managed service/Slack secret references required")
    # Reject credential material; references only.
    if re.search(r"\b(?:xox[baprs]-|xapp-|sk-(?:ant-)?)[A-Za-z0-9_-]+",json.dumps(cfg)):fail("Config must not contain plaintext API tokens")
    seen={k:set() for k in ["key","agentId","linuxUser","workspace","nativeHistory"]}
    for row in cfg["employees"]:
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}",row["key"]):fail("Invalid employee key")
        if not re.fullmatch(uuid,row["agentId"]):fail("Map the existing employee UUID")
        if not re.fullmatch(r"(?:xa-|xoom-)[a-z0-9-]{1,27}",row["linuxUser"]):fail("Invalid selected employee Linux user")
        if row["engine"] not in ["codex","claude"]:fail("Invalid runtime engine")
        for field in ["workspace","nativeHistory"]:
            target=protected(row[field])
            if not target.is_relative_to("/srv/xoomai/agents") and not target.is_relative_to("/home/"+row["linuxUser"]):fail("Employee storage escapes approved roots")
        protected(row["binary"])
        for field,values in seen.items():
            if row[field] in values:fail("Duplicate employee identity/path")
            values.add(row[field])
    roots=[pathlib.Path(row[k]) for row in cfg["employees"] for k in ["workspace","nativeHistory"]]
    for i,a in enumerate(roots):
        for b in roots[i+1:]:
            if a==b or a.is_relative_to(b) or b.is_relative_to(a):fail("Employee storage roots overlap")
    if cfg.get("images",{}).get("enabled"):
        images=cfg["images"]
        if not images.get("secretRef") or not images.get("model") or not 0<images.get("maxRequestCostUsd",0)<=images.get("monthlyCapUsd",0):fail("Images require an operator-authorized USD monthly cap and per-request reserve")
    return cfg
def verify_checksums():
    for line in (ROOT/"SHA256SUMS").read_text().splitlines():
        digest,name=line.split("  ",1)
        path=ROOT/name
        if not path.is_file() or path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest()!=digest:fail("Runtime bundle checksum mismatch")
def wrapper(key):
    return '''#!/usr/bin/python3 -I
import json,os,tempfile,sys
fd,path=tempfile.mkstemp(prefix="xoomai-launch-env-",dir="/tmp")
try:
    with os.fdopen(fd,"w") as f:json.dump(dict(os.environ),f)
    import subprocess
    result=subprocess.run(["/usr/bin/sudo","-n","/usr/local/lib/xoomai-runtime/dispatch.py","KEY",path,*sys.argv[1:]])
    sys.exit(result.returncode)
finally:
    try:os.unlink(path)
    except FileNotFoundError:pass
'''.replace("KEY",key)
def owned_directory(path,user,adopt):
    path=pathlib.Path(path)
    if path.exists():
        if path.stat().st_uid!=user.pw_uid or path.stat().st_mode&0o007:fail("Existing employee directory has unexpected owner/public access; preserve and review")
        if not adopt:fail("Existing employee storage: use --adopt-existing after inventory/backup")
    else:
        path.mkdir(parents=True,mode=0o750);os.chown(path,user.pw_uid,user.pw_gid);path.chmod(0o750)
def write_managed(path,body,mode=0o755):
    path=pathlib.Path(path);protected(path)
    encoded=body.encode() if isinstance(body,str) else body
    if path.exists() and path.read_bytes()!=encoded:
        fail("Existing managed file differs: preserve and review "+str(path))
    if not path.exists():path.write_bytes(encoded)
    path.chmod(mode);os.chown(path,0,0)
def main():
    import pwd
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--config",required=True);p.add_argument("--apply",action="store_true")
    p.add_argument("--adopt-existing",action="store_true")
    a=p.parse_args()
    cfg=validate(json.loads(pathlib.Path(a.config).read_text()))
    verify_checksums()
    server=pathlib.Path(cfg["appRoot"])/"node_modules/@paperclipai/server"
    subprocess.run([sys.executable,str(ROOT/"patch-session.py"),"--server-root",str(server),"--check"],check=True)
    if os.geteuid()!=0:fail("Run installer plan with sudo; do not use --apply until reviewed")
    service=pwd.getpwnam("paperclip")
    for executable in [cfg["nodeBinary"],*(r["binary"] for r in cfg["employees"])]:
        target=pathlib.Path(executable).resolve();info=target.stat()
        if info.st_uid!=0 or info.st_mode&0o022:fail("Runtime executables must be root-owned and protected")
    print(json.dumps({"mode":"apply" if a.apply else "plan","employeeCount":len(cfg["employees"]),"adoptExisting":a.adopt_existing,"nativePatchCompatible":True,"changes":["install root-owned helpers and per-agent command wrappers","create missing selected users/directories only","install exact-release session patch","create service units disabled pending acceptance","write protected non-secret runtime map"],"requiredOperatorActions":["backup and zero-active-run maintenance window","PATCH each existing agent adapterConfig.command to its generated wrapper","merge NoNewPrivileges=false into Paperclip unit only if using this direct sudo dispatcher","provide existing service environment with DATABASE_URL and Paperclip encryption configuration","start services after compatibility review","run live isolation/session/Slack/file acceptance"]}))
    if not a.apply:return
    for row in cfg["employees"]:
        try:user=pwd.getpwnam(row["linuxUser"])
        except KeyError:
            subprocess.run(["/usr/sbin/useradd","--create-home","--shell","/usr/sbin/nologin",row["linuxUser"]],check=True)
            user=pwd.getpwnam(row["linuxUser"])
        if user.pw_uid<1000 or user.pw_name=="paperclip":fail("Unsafe existing employee account")
        for field in ["workspace","nativeHistory"]:owned_directory(row[field],user,a.adopt_existing)
        workspace=pathlib.Path(row["workspace"])
        subprocess.run(["/usr/bin/setfacl","-m","u:paperclip:r-x",str(workspace)],check=True)
        for parent in workspace.parents:
            if str(parent) in ("/srv/xoomai/agents","/srv/xoomai") or parent.is_relative_to("/srv/xoomai/agents"):
                subprocess.run(["/usr/bin/setfacl","-m",f"u:{user.pw_name}:--x,u:paperclip:--x",str(parent)],check=True)
    DEST.mkdir(parents=True,exist_ok=True);DEST.chmod(0o755)
    for item in ROOT.iterdir():
        if item.is_file() and item.name!="config.example.json":write_managed(DEST/item.name,item.read_bytes(),0o755 if item.suffix==".py" or item.name.startswith("xoomai-") else 0o644)
    configDir=pathlib.Path("/etc/xoomai");configDir.mkdir(exist_ok=True,mode=0o750)
    target=configDir/"runtime.json"
    if target.exists() and json.loads(target.read_text())!=cfg:fail("Existing runtime map differs; do not overwrite it")
    if not target.exists():target.write_text(json.dumps(cfg,indent=2)+"\n")
    os.chown(target,0,service.pw_gid);target.chmod(0o640)
    for row in cfg["employees"]:write_managed("/usr/local/bin/xoomai-run-"+row["key"],wrapper(row["key"]))
    for name in ["xoomai-task","xoomai-artifact","xoomai-image"]:write_managed("/usr/local/bin/"+name,(ROOT/name).read_bytes())
    sudoers=pathlib.Path("/etc/sudoers.d/xoomai-dispatch")
    body="paperclip ALL=(root) NOPASSWD: /usr/local/lib/xoomai-runtime/dispatch.py *\n"
    trial=pathlib.Path("/etc/sudoers.d/.xoomai-dispatch-test")
    trial.write_text(body);trial.chmod(0o440)
    try:subprocess.run(["/usr/sbin/visudo","-cf",str(trial)],check=True);write_managed(sudoers,body,0o440)
    finally:trial.unlink(missing_ok=True)
    state=pathlib.Path(cfg["stateRoot"]);state.mkdir(exist_ok=True,mode=0o700)
    os.chown(state,service.pw_uid,service.pw_gid);state.chmod(0o700)
    for kind in ["delivery","image"]:
        script="delivery-service.mjs" if kind=="delivery" else "image-service.mjs"
        unit="\n".join(["[Unit]","Description=XoomAI "+kind+" runtime","After=network-online.target paperclip.service","[Service]","Type=simple","User=paperclip","Group=paperclip","UMask=0077","WorkingDirectory="+cfg["appRoot"],"EnvironmentFile="+cfg["serviceEnvironmentFile"],"Environment=XOOMAI_RUNTIME_CONFIG=/etc/xoomai/runtime.json","ExecStart="+cfg["nodeBinary"]+" /usr/local/lib/xoomai-runtime/"+script,"Restart=on-failure","RestartSec=10","NoNewPrivileges=true","PrivateTmp=true","[Install]","WantedBy=multi-user.target",""])
        write_managed("/etc/systemd/system/xoomai-"+kind+".service",unit,0o644)
    subprocess.run([sys.executable,str(ROOT/"patch-session.py"),"--server-root",str(server),"--apply"],check=True)
    subprocess.run(["/usr/bin/systemctl","daemon-reload"],check=True)
    print("Installed. Services not started. Reconcile existing adapter commands/unit restriction and acceptance before enablement.")
if __name__=="__main__":main()

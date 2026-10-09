#!/usr/bin/python3 -I
"""Root-owned dispatcher. Invoked only through per-agent generated command wrappers."""
import json,os,pathlib,pwd,stat,sys,subprocess,signal,re,hashlib
CONFIG=pathlib.Path("/etc/xoomai/runtime.json")
def fail(message):raise SystemExit(message)
def safe_json(path,owner,max_bytes=1048576):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=owner or info.st_mode&0o022 or info.st_nlink!=1 or info.st_size>max_bytes:fail("Unsafe input file")
        with os.fdopen(fd) as f:fd=-1;return json.load(f)
    finally:
        if fd>=0:os.close(fd)
def acl_tree(root,user):
    # Traverse descriptors, not user-changeable path names; no symlink following.
    for _,dirs,files,dirfd in os.fwalk(root,follow_symlinks=False):
        subprocess.run(["/usr/bin/setfacl","-m",f"u:{user}:rwX,u:paperclip:rwX",f"/proc/self/fd/{dirfd}"],pass_fds=(dirfd,),check=True)
        subprocess.run(["/usr/bin/setfacl","-m",f"d:u:{user}:rwx,d:u:paperclip:rwx",f"/proc/self/fd/{dirfd}"],pass_fds=(dirfd,),check=True)
        for name in files:
            try:fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=dirfd)
            except OSError:continue
            try:
                if stat.S_ISREG(os.fstat(fd).st_mode):
                    subprocess.run(["/usr/bin/setfacl","-m",f"u:{user}:rw,u:paperclip:rw",f"/proc/self/fd/{fd}"],pass_fds=(fd,),check=True)
            finally:os.close(fd)
def main():
    if os.geteuid()!=0:fail("Root dispatcher required")
    service=pwd.getpwnam("paperclip")
    if os.environ.get("SUDO_UID")!=str(service.pw_uid):fail("Only Paperclip service may invoke dispatcher")
    if len(sys.argv)<3:fail("Employee and environment handoff required")
    cfg=safe_json(CONFIG,0)
    rows=[x for x in cfg["employees"] if x["key"]==sys.argv[1] and x.get("enabled",True)]
    if len(rows)!=1:fail("Unknown or disabled employee")
    row=rows[0];account=pwd.getpwnam(row["linuxUser"])
    env_path=pathlib.Path(sys.argv[2])
    if env_path.parent!=pathlib.Path("/tmp") or not env_path.name.startswith("xoomai-launch-env-"):fail("Invalid handoff path")
    try:
        env=safe_json(env_path,service.pw_uid)
        if env_path.stat().st_mode&0o077:fail("Handoff must be mode 0600")
    finally:
        if env_path.exists() and not env_path.is_symlink() and env_path.stat().st_uid==service.pw_uid:env_path.unlink()
    if not isinstance(env,dict) or any(not isinstance(k,str) or not isinstance(v,str) for k,v in env.items()):fail("Invalid runtime environment")
    args=sys.argv[3:]
    if args!=["--version"] and (env.get("PAPERCLIP_AGENT_ID")!=row["agentId"] or env.get("PAPERCLIP_COMPANY_ID")!=cfg["companyId"]):fail("Employee/company mismatch")
    cwd=pathlib.Path.cwd().resolve();workspace=pathlib.Path(row["workspace"]).resolve()
    if not cwd.is_relative_to(workspace):fail("Workspace mismatch")
    home=pathlib.Path(env.get("HOME",""))
    match=re.fullmatch(r"paperclip-ai-([a-f0-9-]{36})-([a-f0-9-]{36})-[A-Za-z0-9]+",home.name)
    managed=bool(match and match[1]==cfg["companyId"] and home.parent==pathlib.Path("/tmp"))
    if args!=["--version"] and not managed:fail("Expected supported ephemeral Paperclip managed home")
    if managed:
        info=home.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=service.pw_uid:fail("Invalid managed home")
        for key in ["CODEX_HOME","CLAUDE_CONFIG_DIR","XDG_CONFIG_HOME","XDG_DATA_HOME"]:
            if key in env and not pathlib.Path(env[key]).absolute().is_relative_to(home):fail("Provider home escapes managed home")
        acl_tree(home,row["linuxUser"])
        # Copy only server-generated Claude prompt/MCP inputs; never arbitrary host paths.
        allowed=pathlib.Path(cfg["paperclipHome"])/"instances/default/companies"/cfg["companyId"]
        for i,arg in enumerate(args):
            if arg not in ("--append-system-prompt-file","--system-prompt-file","--mcp-config","--add-dir"):continue
            if i+1>=len(args):fail("Missing provider input")
            source=pathlib.Path(args[i+1]).resolve()
            approved=allowed/"claude-prompt-cache" if arg!="--mcp-config" else allowed/"agents"/row["agentId"]/"claude-runtime/runs"
            if arg=="--add-dir":
                if source.is_relative_to(approved):args[i+1]=str(home)
                continue
            if not source.is_relative_to(approved):fail("Unexpected provider input path")
            fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW)
            try:
                info=os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid!=service.pw_uid or info.st_size>10485760:fail("Unsafe provider input")
                import tempfile
                out,name=tempfile.mkstemp(prefix="xoomai-input-",suffix=source.suffix,dir=home)
                with os.fdopen(out,"wb") as dest,os.fdopen(fd,"rb") as src:fd=-1;dest.write(src.read())
                subprocess.run(["/usr/bin/setfacl","-m",f"u:{row['linuxUser']}:r,u:paperclip:r",name],check=True)
                args[i+1]=name
            finally:
                if fd>=0:os.close(fd)
    env.update(USER=row["linuxUser"],LOGNAME=row["linuxUser"],PATH="/usr/local/bin:/usr/bin:/bin",XOOMAI_EMPLOYEE=row["key"],XOOMAI_WORKSPACE=str(workspace))
    env["HOME"]=str(home) if managed else account.pw_dir
    env["TMPDIR"]=env["HOME"];env["TMP"]=env["HOME"];env["TEMP"]=env["HOME"]
    for key in list(env):
        if key.startswith(("SUDO_","LD_","PYTHON")) or key in ("NODE_OPTIONS","NODE_PATH"):env.pop(key,None)
    binary=pathlib.Path(row["binary"]).resolve()
    info=binary.stat()
    if info.st_uid!=0 or info.st_mode&0o022 or not stat.S_ISREG(info.st_mode):fail("Provider binary must be root-owned and not group/world writable")
    child=os.fork()
    if child==0:
        os.initgroups(account.pw_name,account.pw_gid);os.setgid(account.pw_gid);os.setuid(account.pw_uid);os.umask(0o077)
        if managed:
            history=pathlib.Path(row["nativeHistory"])/hashlib.sha256(match[2].encode()).hexdigest()
            history.mkdir(parents=True,exist_ok=True,mode=0o700)
            provider=pathlib.Path(env["CODEX_HOME"] if row["engine"]=="codex" else env["CLAUDE_CONFIG_DIR"])
            for name in (("sessions","archived_sessions") if row["engine"]=="codex" else ("projects",)):
                target=history/name;target.mkdir(exist_ok=True,mode=0o700);link=provider/name
                if link.is_symlink():
                    if link.resolve()!=target.resolve():fail("History link mismatch")
                elif link.exists():fail("Existing runtime history needs migration; do not overwrite it")
                else:link.symlink_to(target,target_is_directory=True)
        os.execve(str(binary),[str(binary),*args],env)
    def forward(sig,_):
        try:os.kill(child,sig)
        except ProcessLookupError:pass
    for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):signal.signal(sig,forward)
    try:_,status=os.waitpid(child,0)
    finally:
        if managed:acl_tree(home,row["linuxUser"])
    return os.waitstatus_to_exitcode(status)
if __name__=="__main__":sys.exit(main())

#!/usr/bin/python3 -I
"""Exact-release, hash-checked native-session patch. Never patch an unknown build."""
import argparse,hashlib,json,pathlib,shutil
p=argparse.ArgumentParser()
p.add_argument("--server-root",required=True)
p.add_argument("--check",action="store_true")
p.add_argument("--apply",action="store_true")
p.add_argument("--restore",action="store_true")
a=p.parse_args()
root=pathlib.Path(a.server_root).resolve()
if json.loads((root/"package.json").read_text())["version"]!="2026.916.1":
    raise SystemExit("Unsupported Paperclip server; use the supported version, or qualify a new bundle")
target=root/"dist/services/heartbeat.js"
source=target.read_bytes()
expected="4606c12bd4de2e1e69daec8e820fea3460e686ba5b06d4fedc5159e261770d33"
original=root/"dist/services/heartbeat.xoomai-original"
module=root/"dist/services/xoomai-session-config.mjs"
def digest(b):return hashlib.sha256(b).hexdigest()
def patched(b):
    text=b.decode("utf-8")
    old="        adapterConfig: input.effectiveAdapterConfig,\n"
    if text.count(old)!=1:raise SystemExit("Fingerprint anchor mismatch")
    if text.count("taskSessionDecodedParams?.paperclipAiCredentialIdentity")!=2:
        raise SystemExit("Credential-identity anchor mismatch")
    text='import { normalizeManagedAiSessionConfig } from "./xoomai-session-config.mjs";\n'+text
    text=text.replace(old,"        adapterConfig: normalizeManagedAiSessionConfig(input.effectiveAdapterConfig),\n")
    return text.replace("taskSessionDecodedParams?.paperclipAiCredentialIdentity","parseObject(taskSession?.sessionParamsJson).paperclipAiCredentialIdentity").encode()
if original.exists():
    raw=original.read_bytes()
    if digest(raw)!=expected:raise SystemExit("Original backup checksum mismatch")
    if source not in (raw,patched(raw)):raise SystemExit("Existing patch differs; preserve it and reconcile manually")
else:
    if digest(source)!=expected:raise SystemExit("Unrecognized server build; nothing changed")
    raw=source
if a.restore:
    if not original.exists():raise SystemExit("No original backup exists")
    target.write_bytes(raw)
    print("Restored original heartbeat; retain backup and history; restart only in approved window")
elif a.apply:
    if not original.exists():shutil.copy2(target,original)
    shutil.copy2(pathlib.Path(__file__).parent/"session-config.mjs",module)
    temp=target.with_suffix(".xoomai-tmp")
    temp.write_bytes(patched(raw));temp.chmod(target.stat().st_mode)
    temp.replace(target)
    print("Applied exact-release session patch; target validation/restart required")
else:
    print(json.dumps({"compatible":True,"alreadyPatched":source==patched(raw),"originalSha256":expected}))

"""Fixed read-only controller commands and bounded native executable identity."""
import hashlib
import json
import os
from pathlib import Path
import stat
import re

GIT_FLAGS = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false']
SCRIPTS = {
    'profile': 'const p=require(process.argv[1]);console.log(JSON.stringify({profile:p.PROFILE,hash:p.profileSha256,harnessHash:p.harnessDigest()}))',
    'dependencies': "const s=require(process.argv[1]),p=require(process.argv[2]);if(process.argv[5]){const b=p.readJson(process.argv[5]);require('node:assert/strict').equal(p.sourceManifestHash(b.source),process.argv[6]);s.verifySourceManifest(process.argv[3],process.argv[4],b.source)}console.log(JSON.stringify({dependencies:s.dependencyManifest(process.argv[3],process.argv[4]),harnessSha256:p.harnessDigest()}))",
    'plan': 'const p=require(process.argv[1]),a=p.readJson(process.argv[2]),x=p.readPilotEvidence(process.argv[3]),y=p.readPilotEvidence(process.argv[5]);p.validatePlan(a,x.pilot,process.argv[4],x.supervisor,y.pilot,y.supervisor,x.owner,y.owner);console.log(JSON.stringify(a))',
    'source': 'const p=require(process.argv[1]),s=require(process.argv[2]);s.verifySourceManifest(process.argv[3],process.argv[4],p.readJson(process.argv[5]).source)',
    'launch': 'const p=require(process.argv[1]);p.validateLaunchIdentity(p.readJson(process.argv[2]),process.version,process.argv[3])',
}

def streamed_executable(file):
    fd = os.open(file, os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= 128 * 1024 ** 2:
            raise RuntimeError('Executable is not a bounded regular file')
        digest = hashlib.sha256(); count = 0
        while count <= before.st_size:
            block = os.read(fd, min(65536, before.st_size + 1 - count))
            if not block: break
            count += len(block); digest.update(block)
        after = os.fstat(fd); named = os.lstat(file)
        version = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        # Windows path stat synthesizes .exe execute bits; fstat has no filename.
        # Keep full same-descriptor mode/change-time and named type/read/write bits.
        name_version = lambda value: (value.st_dev, value.st_ino, value.st_mode & ~0o111 if os.name == 'nt' else value.st_mode, value.st_size, value.st_mtime_ns,
            value.st_birthtime_ns if os.name == 'nt' else value.st_ctime_ns)
        if count != before.st_size or version(before) != version(after) or name_version(after) != name_version(named):
            raise RuntimeError('Executable changed during bounded descriptor hashing')
        return {'path': str(Path(file).resolve(strict=True)), 'bytes': count, 'sha256': digest.hexdigest()}
    finally:
        os.close(fd)

def validate_native_tools(tools):
    if not isinstance(tools, dict) or set(tools) != {'node', 'git'}:
        raise RuntimeError('Exact sealed native tool manifest is required')
    for kind, tool in tools.items():
        if (not isinstance(tool, dict) or set(tool) != {'path', 'version', 'sha256'}
                or not isinstance(tool['path'], str) or not 1 <= len(tool['path']) <= 1024 or not Path(tool['path']).is_absolute()
                or not isinstance(tool['version'], str) or not 1 <= len(tool['version']) <= 64
                or not isinstance(tool['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', tool['sha256'])
                or Path(tool['path']).name.lower() != kind + '.exe'):
            raise RuntimeError('Invalid sealed native tool identity')
    if tools['node']['path'] == tools['git']['path']:
        raise RuntimeError('Native tool identities must be distinct')
    return tools

def tool_identity(file, tools):
    validate_native_tools(tools)
    if file not in [tool['path'] for tool in tools.values()]:
        raise RuntimeError('Unsupported metadata executable; PATH wrappers are not admitted')
    return validate_tool_identity(file, streamed_executable(file), tools)

def validate_tool_identity(file, actual, tools):
    validate_native_tools(tools)
    expected = next((tool for tool in tools.values() if tool['path'] == file), None)
    if expected is None:
        raise RuntimeError('Unsupported metadata executable; PATH wrappers are not admitted')
    if actual['path'] != str(Path(file).resolve(strict=True)) or actual['sha256'] != expected['sha256']:
        raise RuntimeError('Metadata executable differs from reviewed native binary')
    return {**actual, 'version': expected['version']}

def classify_metadata(argv, cwd, context):
    if not isinstance(argv, list) or not argv or not all(isinstance(value, str) for value in argv):
        raise RuntimeError('Invalid metadata argv')
    root = context['root']; dependencies = context['dependencies']; harness = Path(root) / 'scripts/qualification/runtime-memory'
    profile, loader = str(harness / 'profile.cjs'), str(harness / 'source-loader.cjs')
    tools = validate_native_tools(context['windowsNativeTools'])
    if argv[0] == tools['git']['path']:
        if argv[1:] == ['--version']:
            operation = 'git-version'
        elif cwd == root and argv[1:6] == GIT_FLAGS and argv[6:] in [['rev-parse', 'HEAD'], ['status', '--porcelain']]:
            operation = 'git-head' if argv[6] == 'rev-parse' else 'git-clean'
        else:
            raise RuntimeError('Unknown Git metadata command')
    elif argv[0] == tools['node']['path'] and context['node'] == tools['node']['path']:
        if argv[1:] == ['--version']:
            operation = 'node-version'
        else:
            operation = next((key for key, script in SCRIPTS.items() if argv[1:3] == ['-e', script]), None)
            tail = argv[3:]
            valid = ((operation == 'profile' and tail == [profile])
                or (operation == 'dependencies' and len(tail) in [4, 6] and tail[:4] == [loader, profile, root, dependencies]
                    and (len(tail) == 4 or (tail[4] == str(Path(context['output']) / 'runtime-bootstrap-ready.json') and re.fullmatch('[a-f0-9]{64}', tail[5]))))
                or (operation == 'plan' and context['plan'] is not None and tail == [profile, context['plan'], context['pilot'], context['sourceHead'], context['peerPilot']])
                or (operation == 'source' and context['plan'] is not None and tail == [profile, loader, root, dependencies, context['plan']])
                or (operation == 'launch' and context['plan'] is not None and tail == [profile, context['plan'], context['launcherSha256']]))
            if not valid:
                raise RuntimeError('Unknown Node metadata command')
    else:
        raise RuntimeError('Unknown metadata executable')
    if cwd not in [None, root]:
        raise RuntimeError('Unknown metadata working directory')
    tool = tool_identity(argv[0], tools)
    command = json.dumps({'argv': argv, 'cwd': cwd}, separators=(',', ':'), ensure_ascii=False).encode()
    return {'operation': operation, 'commandSha256': hashlib.sha256(command).hexdigest(), 'tool': tool}

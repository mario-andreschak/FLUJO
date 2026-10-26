"""Bounded launch evidence. No workload, installation or cleanup occurs on import."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
from metadata_commands import SCRIPTS

GIB = 1024 ** 3


def require_current_node(node, expected, runner=None):
    current = (runner([node, '--version']).stdout.decode() if runner else subprocess.check_output([node, '--version'], text=True)).strip()
    if current != expected:
        raise RuntimeError('Current Node differs from the launch contract')
    return current


def require_dependency_manifest(node, harness, root, dependencies, harness_hash, expected=None, bootstrap=None, runner=None):
    script = SCRIPTS['dependencies']
    argv = [node, '-e', script, str(harness / 'source-loader.cjs'), str(harness / 'profile.cjs'), str(root), str(dependencies)]
    if bootstrap:
        argv.extend([str(bootstrap[0]), bootstrap[1]])
    result = runner(argv) if runner else subprocess.run(argv, capture_output=True, timeout=20, check=True)
    if len(result.stdout) > 65536 or len(result.stderr) > 65536 or result.stderr:
        raise RuntimeError('Dependency preflight output exceeds its contract')
    record = json.loads(result.stdout)
    if record.get('harnessSha256') != harness_hash:
        raise RuntimeError('Current harness changed before child admission')
    current = record['dependencies']
    if expected is not None and current != expected:
        raise RuntimeError('Installed dependency manifest changed before child admission')
    return current


def read_record(file):
    with file.open('rb') as stream:
        data = stream.read(65537)
    if len(data) > 65536:
        raise RuntimeError('Launch evidence exceeds allowance')
    return json.loads(data)


def validate_disk_receipt(request, receipt, lease, now_ms):
    if receipt.get('request') != request or receipt.get('kind') != 'windows-physical-volume-v1':
        raise RuntimeError('Physical disk receipt does not bind this launch request')
    if receipt.get('currentLauncherSha256') != request.get('launcherSha256') or not request.get('launcherSha256'):
        raise RuntimeError('Current launcher differs from the expected launch identity')
    if (lease.get('token') != request['token'] or lease.get('state') != 'running'
            or lease.get('pid') != receipt.get('watcherPid')
            or not 0 <= now_ms - lease.get('time', 0) <= 4000):
        raise RuntimeError('Physical disk watcher lease is missing or stale')
    if not 0 <= now_ms - receipt.get('measuredAtMs', 0) <= 4000:
        raise RuntimeError('Physical disk measurement is stale')
    if receipt.get('volume') != 'C:\\' or receipt.get('admitted') is not True:
        raise RuntimeError('Physical backing-volume admission failed')
    free = receipt.get('freeBytes')
    if type(free) is not int or free < request['requiredFreeBytes']:
        raise RuntimeError('Physical backing volume lacks the combined reservation and floor')
    return receipt


class DiskAdmission:
    def __init__(self, identity, required_bytes):
        if not 20 * GIB <= required_bytes <= 140 * GIB:
            raise RuntimeError('Invalid fixed disk reservation')
        self.phase = Path(os.environ['FLUJO_569_PHASE_EVIDENCE']).resolve(strict=True)
        self.token = os.environ['FLUJO_569_PHASE_TOKEN']
        if len(self.token) != 32 or any(c not in '0123456789abcdef' for c in self.token):
            raise RuntimeError('Invalid owned phase token')
        self.identity = identity
        self.required_bytes = required_bytes
        self.receipts = []

    def admit(self):
        sequence = len(self.receipts) + 1
        request = {**self.identity, 'token': self.token, 'nonce': secrets.token_hex(24),
                   'sequence': sequence, 'requiredFreeBytes': self.required_bytes,
                   'supervisorPid': os.getpid(), 'requestedAtMs': int(time.time() * 1000)}
        with (self.phase / f'storage-request-{sequence}.json').open('x', encoding='utf8') as stream:
            json.dump(request, stream)
        response = self.phase / f'storage-admission-{sequence}.json'
        until = time.monotonic() + 10
        while time.monotonic() < until:
            try:
                receipt = read_record(response)
                lease = read_record(self.phase / 'watcher-lease.json')
                result = validate_disk_receipt(request, receipt, lease, int(time.time() * 1000))
                self.receipts.append(result)
                return result
            except (FileNotFoundError, json.JSONDecodeError):
                time.sleep(.05)
        raise RuntimeError('Current Windows physical disk admission is unavailable')


def cgroup_paths(entry, env, mount=Path('/sys/fs/cgroup')):
    """Resolve current membership; do not accept an unrelated caller-selected cgroup."""
    if not entry or not entry.startswith('/') or '..' in Path(entry).parts:
        raise RuntimeError('Invalid current cgroup membership')
    current = (mount / entry.lstrip('/')).resolve(strict=True)
    aggregate = Path(env['FLUJO_569_CGROUP']).resolve(strict=True)
    parent = Path(env['FLUJO_569_CGROUP_PARENT']).resolve(strict=True)
    workload = Path(env['FLUJO_569_WORKLOAD_CGROUP']).resolve(strict=True)
    if (parent.parent != mount.resolve(strict=True) or aggregate.parent != parent
            or workload != aggregate / 'workload' or current != workload
            or not (aggregate / 'guardian').is_dir()):
        raise RuntimeError('Current workload does not belong to the declared guarded aggregate')
    return aggregate, workload, parent


def cgroup_controls(group):
    memory = (group / 'memory.max').read_text().strip()
    cpu = (group / 'cpu.max').read_text().split()
    swap = (group / 'memory.swap.max').read_text().strip()
    if (memory != str(2 * GIB) or cpu != ['200000', '100000'] or swap != '0'
            or (group / 'memory.oom.group').read_text().strip() != '1'
            or (group / 'pids.max').read_text().strip() != '256'):
        raise RuntimeError('Guarded cgroup limits differ from the fixed runtime envelope')
    return {'memoryMax': int(memory), 'cpuMax': cpu, 'swapMax': 0, 'pidsMax': 256, 'oomGroup': 1}


def cgroup_sample(group):
    result = {}
    for name in ['memory.current', 'memory.peak', 'pids.current']:
        value = (group / name).read_text().strip()
        if not value.isascii() or not value.isdigit() or len(value) > 20:
            raise RuntimeError('Invalid cgroup measurement')
        result[name] = int(value)
    return result

#!/usr/bin/env python3
"""Source qualification supervisor. No package installs, cloud calls, or detached jobs.

Windows: two-CPU Job Object and shared memory cap, children assigned suspended.
Linux: require the caller's cgroup v2 to already enforce <=2 CPUs and <=2 GiB.
Never count timeout, killed process, missing stdio EOF or missing receipt as success.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import secrets
import re
import stat
import datetime
import uuid
import shutil
import subprocess
import sys
import threading
import time
from envelope_evidence import DiskAdmission, cgroup_paths, cgroup_controls, cgroup_sample, read_record, require_current_node, require_dependency_manifest
from dataset_evidence import prepare_linux_dataset, inspect_linux_dataset, guest_disk_admission
from metadata_commands import SCRIPTS, GIT_FLAGS

MIB = 1024 ** 2
GIB = 1024 ** 3
HERE = Path(__file__).resolve().parent
OS_SAMPLE_MAX_BYTES = 656
OS_SAMPLE_MAX_COUNT = 100_000


def os_evidence_projection(record_bytes, sample_count, allowance):
    projected = record_bytes * sample_count
    if projected > allowance:
        raise RuntimeError('OS evidence projection exceeds fixed file allowance')
    return projected


def encode_os_sample(value):
    record = json.dumps(value) + '\n'
    if len(record.encode('utf8')) > OS_SAMPLE_MAX_BYTES:
        raise RuntimeError('OS sample exceeds predeclared record bound')
    return record


def save(file, value):
    with file.open('x', encoding='utf8') as handle:
        json.dump(value, handle, indent=2)


def bounded_json(file):
    descriptor = os.open(file, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(descriptor, 'rb') as handle:
        before = os.fstat(handle.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > MIB:
            raise RuntimeError('Receipt is not regular or exceeds 1 MiB')
        data = handle.read(MIB + 1)
        after = os.fstat(handle.fileno()); named = os.lstat(file)
        version = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        # Python on Windows exposes change time through fstat but creation time
        # through lstat's deprecated ctime. Compare explicit birth time by name;
        # still require the descriptor's own change time to remain unchanged.
        named_version = (lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_size, value.st_mtime_ns, value.st_birthtime_ns)) if os.name == 'nt' else version
        if len(data) > MIB or len(data) != after.st_size or version(before) != version(after) or named_version(after) != named_version(named):
            raise RuntimeError('Receipt changed or exceeds 1 MiB')
        return json.loads(data)


def owned_provider_environment(ready, pid, token):
    if not isinstance(ready, dict) or set(ready) != {'pid', 'origin', 'tokenSha256'}:
        raise RuntimeError('Provider ready record has unexpected fields')
    if type(ready['pid']) is not int or ready['pid'] != pid:
        raise RuntimeError('Provider ready PID differs from owned child')
    match = re.fullmatch(r'http://127\.0\.0\.1:([1-9][0-9]{0,4})', ready['origin']) if isinstance(ready['origin'], str) else None
    if not match or int(match[1]) > 65535 or ready['tokenSha256'] != hashlib.sha256(token.encode()).hexdigest():
        raise RuntimeError('Provider endpoint or credential differs from owned launch')
    return {'FLUJO_569_PROVIDER_PORT': str(int(match[1])), 'FLUJO_569_PROVIDER_PID': str(pid)}


def native_process_birth_marker(pid):
    if type(pid) is not int or pid <= 0:
        raise RuntimeError('Invalid owned runtime PID')
    if os.name == 'nt':
        from ctypes import wintypes as w
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]; kernel.OpenProcess.restype = w.HANDLE
        kernel.GetProcessTimes.argtypes = [w.HANDLE, *[ctypes.POINTER(w.FILETIME)] * 4]
        kernel.CloseHandle.argtypes = [w.HANDLE]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            creation, exit_time, kernel_time, user_time = w.FILETIME(), w.FILETIME(), w.FILETIME(), w.FILETIME()
            if not kernel.GetProcessTimes(handle, ctypes.byref(creation), ctypes.byref(exit_time), ctypes.byref(kernel_time), ctypes.byref(user_time)):
                raise ctypes.WinError(ctypes.get_last_error())
            ticks = (creation.dwHighDateTime << 32) | creation.dwLowDateTime
            # FILETIME begins in1601; production PowerShell returns DateTime ticks since0001.
            epoch = (datetime.date(1601, 1, 1) - datetime.date(1, 1, 1)).days * 864_000_000_000
            return 'win32-v2:' + str(ticks + epoch)
        finally:
            kernel.CloseHandle(handle)
    text = Path(f'/proc/{pid}/stat').read_text()
    fields = text[text.rfind(')') + 1:].split()
    if len(fields) <= 19 or fields[0] == 'Z' or not fields[19].isdigit():
        raise RuntimeError('Owned Linux runtime birth identity is unavailable')
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    return f'linux-v2:{boot}:{fields[19]}'


def validate_runtime_bootstrap(record, contract, pid):
    keys = {'version', 'nonce', 'pid', 'identity', 'settlement', 'sourceHead', 'harnessSha256', 'profileSha256', 'source', 'sourceManifestSha256'}
    if not isinstance(record, dict) or set(record) != keys or record.get('version') != 'runtime-bootstrap-v1' or type(record.get('pid')) is not int or record['pid'] != pid:
        raise RuntimeError('Bootstrap belongs to a different runtime')
    if record.get('nonce') != contract['bootstrapNonce']:
        raise RuntimeError('Bootstrap nonce differs from owned launch')
    for field in ['sourceHead', 'harnessSha256', 'profileSha256']:
        if record.get(field) != contract[field]:
            raise RuntimeError('Bootstrap source identity changed: ' + field)
    identity = record.get('identity', {})
    if set(identity) != {'pid', 'processInstanceId', 'processBirthMarkerV2'} or identity['pid'] != pid:
        raise RuntimeError('Bootstrap process identity is invalid')
    if str(uuid.UUID(identity['processInstanceId'])) != identity['processInstanceId']:
        raise RuntimeError('Bootstrap process instance is invalid')
    if identity['processBirthMarkerV2'] != native_process_birth_marker(pid):
        raise RuntimeError('Bootstrap birth identity differs from actual OS process')
    settlement = record.get('settlement', {})
    probes = settlement.get('probes')
    if settlement.get('sealed') is not True or not isinstance(probes, list) or len(probes) > 3 or (os.name == 'nt' and not probes):
        raise RuntimeError('Bootstrap child gate did not seal')
    for probe in probes:
        if (probe.get('closed') is not True or probe.get('exitCode') != 0 or probe.get('signal') is not None
                or probe.get('killed') is not False or probe.get('stdoutEnded') is not True or probe.get('stderrEnded') is not True):
            raise RuntimeError('Native bootstrap probe did not settle')
    return {key: value for key, value in record.items() if key != 'source'}


def require_runtime_only(envelope, pid):
    until = time.monotonic() + 2
    while True:
        if isinstance(envelope, WindowsEnvelope):
            count = envelope.process_counts()['activeProcesses']
            if count == 1:
                return {'runtimeOnly': True, 'runtimePid': pid, 'kind': 'windows-job', 'jobActiveProcesses': count}
        else:
            members = sorted(int(value) for value in (envelope.workload / 'cgroup.procs').read_text().split())
            if members == sorted([os.getpid(), pid]):
                return {'runtimeOnly': True, 'runtimePid': pid, 'supervisorPid': os.getpid(), 'kind': 'cgroup-v2', 'workloadMembers': members}
        if time.monotonic() >= until:
            detail = {'jobActiveProcesses': count} if isinstance(envelope, WindowsEnvelope) else {'workloadMembers': members}
            raise RuntimeError('Bootstrap retained descendants before provider admission: ' + json.dumps(detail))
        time.sleep(.01)


def parse_memory_events(text):
    """Bounded kernel-counter record; malformed/missing evidence is not success."""
    if len(text) > 16 * 1024:
        raise RuntimeError('memory.events record exceeds allowance')
    counters = {}
    for line in text.splitlines():
        fields = line.split()
        if len(fields) != 2:
            raise RuntimeError('Malformed memory.events record')
        name, value = fields
        if (not name.isascii() or not name.replace('_', '').isalpha() or len(name) > 64
                or name in counters or not value.isascii() or not value.isdigit()
                or len(value) > 20 or len(counters) >= 128):
            raise RuntimeError('Invalid memory.events counter')
        counters[name] = int(value)
    if not {'low', 'high', 'max', 'oom', 'oom_kill'}.issubset(counters):
        raise RuntimeError('Required memory.events counters are missing')
    return counters


def memory_event_report(before_text, after_text):
    before = parse_memory_events(before_text)
    after = parse_memory_events(after_text)
    if before.keys() != after.keys():
        raise RuntimeError('memory.events counter set changed during qualification')
    deltas = {name: after[name] - value for name, value in before.items()}
    if any(value < 0 for value in deltas.values()):
        raise RuntimeError('memory.events counter decreased during qualification')
    oom_increases = {name: deltas.get(name, 0) for name in ['oom', 'oom_kill', 'oom_group_kill']
                     if deltas.get(name, 0) > 0}
    return {'before': before, 'after': after, 'deltas': deltas, 'oomIncreases': oom_increases,
            'oomObserved': bool(oom_increases),
            'reclaimPressure': {name: deltas[name] for name in ['low', 'high', 'max']}}


def git(root, *args, runner):
    executable = runner.envelope.console.context['windowsNativeTools']['git']['path'] if os.name == 'nt' else 'git'
    return runner([executable, *GIT_FLAGS, *args], cwd=root).stdout.decode().strip()


def process_metrics(pid):
    if os.name == 'nt':
        from ctypes import wintypes as w
        class Memory(ctypes.Structure):
            _fields_ = [('cb', w.DWORD), ('PageFaultCount', w.DWORD),
                        *[(name, ctypes.c_size_t) for name in ['PeakWorkingSetSize', 'WorkingSetSize',
                          'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage',
                          'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage']]]
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.restype = w.HANDLE
        kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
        kernel.CloseHandle.argtypes = [w.HANDLE]
        kernel.GetProcessHandleCount.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
        psapi = ctypes.WinDLL('psapi', use_last_error=True)
        psapi.GetProcessMemoryInfo.argtypes = [w.HANDLE, ctypes.POINTER(Memory), w.DWORD]
        handle = kernel.OpenProcess(0x1000 | 0x10, False, pid)
        if not handle:
            return None
        try:
            info = Memory(); info.cb = ctypes.sizeof(info); count = w.DWORD()
            if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(info), info.cb):
                raise ctypes.WinError(ctypes.get_last_error())
            if not kernel.GetProcessHandleCount(handle, ctypes.byref(count)):
                raise ctypes.WinError(ctypes.get_last_error())
            return {'rss': info.WorkingSetSize, 'peakRss': info.PeakWorkingSetSize, 'handles': count.value}
        finally:
            kernel.CloseHandle(handle)
    try:
        values = {}
        for line in Path(f'/proc/{pid}/status').read_text().splitlines():
            if line.startswith(('VmRSS:', 'VmHWM:')):
                key, value, _ = line.split(); values[key[:-1]] = int(value) * 1024
        return {'rss': values['VmRSS'], 'peakRss': values['VmHWM'], 'fds': len(list(Path(f'/proc/{pid}/fd').iterdir()))}
    except FileNotFoundError:
        return None


class WindowsEnvelope:
    def __init__(self):
        self.console = None
        from ctypes import wintypes as w
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel.CreateJobObjectW.restype = w.HANDLE
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
        self.kernel.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
        self.kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        self.kernel.QueryInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.c_void_p]
        self.kernel.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
        self.kernel.CloseHandle.argtypes = [w.HANDLE]
        self.kernel.GetCurrentProcess.restype = w.HANDLE
        self.kernel.GetProcessAffinityMask.argtypes = [w.HANDLE, ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(ctypes.c_size_t)]
        class Basic(ctypes.Structure):
            _fields_ = [('processTime', ctypes.c_int64), ('jobTime', ctypes.c_int64), ('flags', w.DWORD),
                        ('minWS', ctypes.c_size_t), ('maxWS', ctypes.c_size_t), ('active', w.DWORD),
                        ('affinity', ctypes.c_size_t), ('priority', w.DWORD), ('scheduling', w.DWORD)]
        class Io(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in ['readOps', 'writeOps', 'otherOps', 'readBytes', 'writeBytes', 'otherBytes']]
        class Extended(ctypes.Structure):
            _fields_ = [('basic', Basic), ('io', Io), ('processMemory', ctypes.c_size_t),
                        ('jobMemory', ctypes.c_size_t), ('peakProcess', ctypes.c_size_t), ('peakJob', ctypes.c_size_t)]
        allowed, system = ctypes.c_size_t(), ctypes.c_size_t()
        if not self.kernel.GetProcessAffinityMask(self.kernel.GetCurrentProcess(), ctypes.byref(allowed), ctypes.byref(system)):
            raise ctypes.WinError(ctypes.get_last_error())
        cpus = [bit for bit in range(64) if allowed.value & (1 << bit)][:2]
        if len(cpus) != 2:
            raise RuntimeError('Two available CPUs are required')
        limits = Extended(); limits.basic.flags = 0x200 | 0x2000 | 0x10 | 0x8
        limits.basic.affinity = sum(1 << bit for bit in cpus); limits.basic.active = 2
        # Reserve 128 MiB for the independent supervisor outside the Job Object.
        limits.jobMemory = 2 * GIB - 128 * MIB
        self.job = self.kernel.CreateJobObjectW(None, None)
        if not self.job or not self.kernel.SetInformationJobObject(self.job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise ctypes.WinError(ctypes.get_last_error())
        self.receipt = {'kind': 'windows-job', 'cpuAffinity': cpus, 'jobMemoryBytes': limits.jobMemory,
                        'supervisorReserveBytes': 128 * MIB, 'maxChildProcesses': 2, 'killOnClose': True}

    def spawn(self, argv, qualification_role=None, **kwargs):
        # Qualification inherits only the independently admitted private console.
        # Standalone equipment without a console uses detached Node fixtures.
        metadata = isinstance(qualification_role, str) and qualification_role.startswith('metadata-')
        process = subprocess.Popen(argv, creationflags=0x4 if self.console and not metadata else 0x8 | 0x4, **kwargs)
        try:
            if not self.kernel.AssignProcessToJobObject(self.job, int(process._handle)):
                raise ctypes.WinError(ctypes.get_last_error())
            if self.console:
                self.console.admit_suspended(process.pid, qualification_role)
            resume = ctypes.WinDLL('ntdll').NtResumeProcess
            resume.argtypes = [ctypes.c_void_p]; resume.restype = ctypes.c_long
            if resume(int(process._handle)) != 0:
                raise RuntimeError('Could not resume job-owned child')
            if self.console:
                self.console.resumed(process.pid)
            return process
        except BaseException:
            process.kill(); process.wait()
            for stream in [process.stdin, process.stdout, process.stderr]:
                if stream: stream.close()
            raise

    def process_counts(self):
        from ctypes import wintypes as w
        class Accounting(ctypes.Structure):
            _fields_ = [(key, ctypes.c_int64) for key in ['user', 'kernel', 'periodUser', 'periodKernel']] + [
                (key, w.DWORD) for key in ['pageFaults', 'totalProcesses', 'activeProcesses', 'terminatedProcesses']]
        value = Accounting()
        if not self.kernel.QueryInformationJobObject(self.job, 1, ctypes.byref(value), ctypes.sizeof(value), None):
            raise ctypes.WinError(ctypes.get_last_error())
        return {'activeProcesses': value.activeProcesses, 'totalProcesses': value.totalProcesses,
                'terminatedProcesses': value.terminatedProcesses}

    def settlement(self):
        until = time.monotonic() + 1
        while True:
            value = self.process_counts()
            if not value['activeProcesses'] or time.monotonic() >= until:
                break
            time.sleep(.01)  # Allow natural Job accounting settlement, never kill to obtain zero.
        return {'activeProcessesBeforeCleanup': value['activeProcesses'], 'totalProcesses': value['totalProcesses'],
                'forcedCleanup': value['activeProcesses'] != 0}

    def close(self):
        # Cleanup never upgrades a run to success. The caller records settlement first.
        self.kernel.TerminateJobObject(self.job, 2); self.kernel.CloseHandle(self.job)


class LinuxEnvelope:
    def __init__(self):
        entries = Path('/proc/self/cgroup').read_text().splitlines()
        entry = next((line.split(':', 2)[2] for line in entries if line.startswith('0::')), None)
        if entry is None:
            raise RuntimeError('cgroup v2 is required')
        self.root, self.workload, self.parent = cgroup_paths(entry, os.environ)
        self.controls = {str(group): cgroup_controls(group) for group in [self.root, self.workload, self.parent]}
        self.receipt = {'kind': 'cgroup-v2', 'path': str(self.root), 'workloadPath': str(self.workload),
                        'parentPath': str(self.parent), 'controls': self.controls, 'guardianIncluded': True}
        self.events_before = (self.root / 'memory.events').read_text()
        self.workload_events_before = (self.workload / 'memory.events').read_text()

    def sample(self):
        for group in [self.root, self.workload, self.parent]:
            if cgroup_controls(group) != self.controls[str(group)]:
                raise RuntimeError('Cgroup envelope changed')
        return {'aggregate': cgroup_sample(self.root), 'workload': cgroup_sample(self.workload)}

    def spawn(self, argv, qualification_role=None, **kwargs):
        return subprocess.Popen(argv, start_new_session=True, **kwargs)

    def close(self):
        pass


class Child:
    def __init__(self, name, envelope, argv, output, env, stdin_pipe=False):
        self.name = name; self.errors = []; self.ended = {}; self.byte_counts = {}; self.exit = None
        self.process = envelope.spawn(argv, qualification_role=name, cwd=output, env=env, stdin=subprocess.PIPE if stdin_pipe else subprocess.DEVNULL,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.threads = []
        self.stdin_thread = None
        try:
            for stream in ['stdout', 'stderr']:
                thread = threading.Thread(target=self.copy, args=(stream, output), daemon=True)
                thread.start(); self.threads.append(thread)
            if isinstance(envelope, WindowsEnvelope) and envelope.console:
                envelope.console.register(self.process.pid, name)
        except BaseException:
            if self.process.poll() is None:
                self.process.kill()
            self.settlement()
            raise

    def configure(self, configuration):
        channel_bytes = json.dumps(configuration).encode()
        if len(channel_bytes) > 4096:
            raise RuntimeError('Parent configuration exceeds channel allowance')
        def write_configuration():
            try:
                self.process.stdin.write(channel_bytes); self.process.stdin.close()
            except BaseException:
                self.errors.append('Parent configuration delivery failed')
        self.stdin_thread = threading.Thread(target=write_configuration, daemon=True)
        self.stdin_thread.start(); self.stdin_thread.join(timeout=2)
        if self.stdin_thread.is_alive() or self.errors or self.process.poll() is not None:
            raise RuntimeError('Parent configuration did not settle before admission')

    def copy(self, stream, output):
        count = 0; self.ended[stream] = False
        try:
            with (output / f'{self.name}-{stream}.log').open('xb') as handle:
                source = getattr(self.process, stream)
                while True:
                    chunk = source.read(64 * 1024)
                    if not chunk:
                        self.ended[stream] = True; break
                    count += len(chunk)
                    if count > 64 * MIB:
                        raise RuntimeError('stdio exceeded 64 MiB allowance')
                    handle.write(chunk)
        except BaseException as error:
            self.errors.append(str(error))
        finally:
            self.byte_counts[stream] = count

    def settlement(self):
        self.exit = self.process.wait(timeout=20)
        if self.stdin_thread:
            self.stdin_thread.join(timeout=2)
            if self.stdin_thread.is_alive():
                self.errors.append('Parent configuration writer did not stop')
        elif self.process.stdin:
            self.process.stdin.close()
        for thread in self.threads:
            thread.join(timeout=10)
        if all(not thread.is_alive() for thread in self.threads):
            self.process.stdout.close(); self.process.stderr.close()
        return {'code': self.exit, 'stdoutEnded': self.ended.get('stdout', False),
                'stderrEnded': self.ended.get('stderr', False), 'streamErrors': self.errors,
                'streamBytes': self.byte_counts, 'copyThreadsStopped': all(not thread.is_alive() for thread in self.threads)}


class MetadataRunner:
    """All controller Git/Node helpers occupy the same finite child envelope."""
    def __init__(self, envelope, phase):
        self.envelope = envelope; self.phase = phase; self.sequence = 0

    def __call__(self, argv, cwd=None, timeout=20):
        self.sequence += 1
        if self.sequence > 24:
            raise RuntimeError('Metadata command count exceeds allowance')
        role = 'metadata-' + str(self.sequence)
        console = getattr(self.envelope, 'console', None)
        if console:
            console.prepare_metadata(role, argv, str(cwd) if cwd is not None else None)
        env = os.environ.copy()
        if env.get('NODE_OPTIONS') or env.get('UV_THREADPOOL_SIZE'):
            raise RuntimeError('Metadata must not inherit Node resource/preload overrides')
        for key in ['NODE_OPTIONS', 'NODE_PATH', 'NODE_V8_COVERAGE', 'UV_THREADPOOL_SIZE']:
            env.pop(key, None)
        child = self.envelope.spawn(argv, qualification_role=role, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        captured = {'stdout': bytearray(), 'stderr': bytearray()}; ended = {}; errors = []; threads = []
        def consume(name):
            try:
                while True:
                    data = getattr(child, name).read1(65536)
                    if not data:
                        ended[name] = True; break
                    if len(captured[name]) + len(data) > MIB:
                        raise RuntimeError('Metadata ' + name + ' exceeded 1 MiB')
                    captured[name].extend(data)
            except BaseException as error:
                errors.append(repr(error))
            finally:
                getattr(child, name).close()
        failure = None
        try:
            for name in captured:
                thread = threading.Thread(target=consume, args=(name,), daemon=True); thread.start(); threads.append(thread)
            deadline = time.monotonic() + timeout
            while child.poll() is None:
                if console:
                    console.check()
                if errors or time.monotonic() > deadline:
                    raise RuntimeError('Metadata process exceeded output/deadline allowance')
                time.sleep(.01)
            child.wait(timeout=2)
            for thread in threads:
                thread.join(timeout=2)
            if errors or len(ended) != 2 or any(thread.is_alive() for thread in threads):
                raise RuntimeError('Metadata process did not drain both streams')
            if console:
                console.inner.finish([child.pid])
                console.check()
            if child.returncode:
                raise RuntimeError('Metadata command failed: ' + str(child.returncode))
            if console:
                console.finish_metadata(role, child.pid)
            return subprocess.CompletedProcess(argv, child.returncode, bytes(captured['stdout']), bytes(captured['stderr']))
        except BaseException as error:
            failure = repr(error)
            raise
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
            for thread in threads:
                thread.join(timeout=2)
            if all(not thread.is_alive() for thread in threads):
                child.stdout.close(); child.stderr.close()
            save(self.phase / (role + '.json'), {'argv': argv, 'pid': child.pid, 'code': child.returncode,
                'failure': failure, 'ended': ended, 'errors': errors, 'threadsStopped': all(not thread.is_alive() for thread in threads),
                'streams': {key: {'bytes': len(value), 'sha256': hashlib.sha256(value).hexdigest()} for key, value in captured.items()}})


def supervise(args):
    phase = Path(os.environ['FLUJO_569_PHASE_EVIDENCE']).resolve(strict=True)
    envelope = WindowsEnvelope() if os.name == 'nt' else LinuxEnvelope()
    console = None
    try:
        if isinstance(envelope, WindowsEnvelope):
            from windows_console import ControllerConsole
            launch = bounded_json(phase / 'launch-config.json')
            context = {'root': str(args.root.resolve(strict=True)), 'dependencies': str(args.dependencies.resolve(strict=True)),
                       'node': str(Path(args.node).resolve(strict=True)), 'sourceHead': launch['identity']['sourceHead'],
                       'output': str(args.output.resolve()), 'plan': str(args.plan) if args.plan else None,
                       'pilot': str(args.pilot) if args.pilot else None, 'peerPilot': str(args.peer_pilot) if args.peer_pilot else None,
                       'launcherSha256': launch['identity']['launcherSha256'], 'windowsNativeTools': launch['windowsNativeTools']}
            console = ControllerConsole(envelope, phase, os.environ['FLUJO_569_PHASE_TOKEN'], bounded_json, context)
            envelope.console = console
        return supervise_owned(args, envelope, MetadataRunner(envelope, phase), console)
    finally:
        if console:
            console.close()
        envelope.close()


def supervise_owned(args, envelope, metadata, console):
    root = args.root.resolve(strict=True); dependencies = args.dependencies.resolve(strict=True)
    output = args.output.resolve(); node = str(Path(args.node).resolve(strict=True))
    equipment = args.mode == 'equipment-bootstrap'
    phase = Path(os.environ['FLUJO_569_PHASE_EVIDENCE'])
    launch = bounded_json(phase / 'launch-config.json')
    if (launch.get('identity', {}).get('mode') != args.mode
            or (launch.get('equipmentOnly') is True) != equipment):
        raise RuntimeError('Explicit equipment mode and outer launch scope must agree')
    if output == root or root in output.parents or output.exists():
        raise RuntimeError('Output must be a new directory outside the checkout')
    if console:
        for tool in console.context['windowsNativeTools'].values():
            if metadata([tool['path'], '--version']).stdout.decode().strip() != tool['version']:
                raise RuntimeError('Actual metadata tool version differs from reviewed binary')
    if git(root, 'status', '--porcelain', runner=metadata):
        raise RuntimeError('Runtime source checkout must be clean')
    phase_name = Path(os.environ['FLUJO_569_PHASE_EVIDENCE']).name
    if os.name != 'nt':
        prepare_linux_dataset(args.output, phase_name)
    source_head = git(root, 'rev-parse', 'HEAD', runner=metadata)
    profile_command = [node, '-e', SCRIPTS['profile'], str(HERE / 'profile.cjs')]
    profile_record = json.loads(metadata(profile_command).stdout)
    profile = profile_record['profile']; cadence = profile['candidateCadenceMs']
    dependencies_at_start = require_dependency_manifest(node, HERE, root, dependencies, profile_record['harnessHash'], runner=metadata)
    # Bound the complete 1 Hz record stream before admitting either child.
    os_evidence_projection(OS_SAMPLE_MAX_BYTES, OS_SAMPLE_MAX_COUNT, profile['maxEvidenceFileBytes'])
    combined_reservation = 2 * GIB  # Pilot only; all actual growth is measured and guarded.
    qualification_source = None
    plan_sha256 = None
    if args.mode == 'endurance':
        if not args.plan or not args.pilot or not args.peer_pilot:
            raise RuntimeError('Endurance requires --plan, --pilot and --peer-pilot settled platform receipts')
        validate = SCRIPTS['plan']
        plan = json.loads(metadata([node, '-e', validate, str(HERE / 'profile.cjs'), str(args.plan), str(args.pilot), source_head, str(args.peer_pilot)]).stdout)
        plan_sha256 = hashlib.sha256(args.plan.read_bytes()).hexdigest()
        cadence = plan['cadenceMs']; combined_reservation = plan['combinedStorageBytes']
        qualification_source = plan['source']
        if dependencies_at_start != {key: qualification_source[key] for key in dependencies_at_start}:
            raise RuntimeError('Installed dependency manifest differs from successful pilots')
        verify_source = SCRIPTS['source']
        metadata([node, '-e', verify_source, str(HERE / 'profile.cjs'), str(HERE / 'source-loader.cjs'),
                  str(root), str(dependencies), str(args.plan)])
    if shutil.disk_usage(output.parent).free < combined_reservation + profile['budgets']['minimumFreeBytes']:
        raise RuntimeError('Insufficient space for both platform runs, preserved pilots and 20 GiB floor')
    disk_admission = DiskAdmission({'sourceHead': source_head, 'profileSha256': profile_record['hash'],
        'harnessSha256': profile_record['harnessHash'], 'mode': args.mode, 'planSha256': plan_sha256},
        combined_reservation + profile['budgets']['minimumFreeBytes'])
    launch = read_record(disk_admission.phase / 'launch-config.json')
    if launch.get('token') != disk_admission.token:
        raise RuntimeError('Launch configuration belongs to a different owner')
    expected_node = plan['expectedNode'] if args.mode == 'endurance' else launch['identity']['node']
    expected_launcher = plan['launcherSha256'] if args.mode == 'endurance' else launch['identity']['launcherSha256']
    guest_admissions = []
    def admit_child(bootstrap_source=None):
        # Re-read the actual executable immediately before EACH child admission.
        current_node = require_current_node(node, expected_node, runner=metadata)
        require_dependency_manifest(node, HERE, root, dependencies, profile_record['harnessHash'], dependencies_at_start, bootstrap_source, runner=metadata)
        if os.name != 'nt':
            guest_admissions.append(guest_disk_admission(output, phase_name,
                combined_reservation + profile['budgets']['minimumFreeBytes']))
        disk_admission.identity.update({'node': current_node, 'launcherSha256': expected_launcher})
        admitted = disk_admission.admit()  # Watcher independently rehashes current helper files.
        if args.mode == 'endurance':
            verify_launch = SCRIPTS['launch']
            metadata([node, '-e', verify_launch, str(HERE / 'profile.cjs'), str(args.plan), admitted['currentLauncherSha256']])
    output.mkdir(); (output / 'data').mkdir(); (output / 'home').mkdir()
    dataset_filesystem = inspect_linux_dataset(output, phase_name) if os.name != 'nt' else None
    contract = {'version': profile['version'], 'profileSha256': profile_record['hash'], 'mode': args.mode,
                'harnessSha256': profile_record['harnessHash'],
                'root': str(root), 'dependencies': str(dependencies), 'sourceHead': source_head,
                'cadenceMs': cadence, 'token': secrets.token_hex(24), 'bootstrapNonce': secrets.token_hex(24), 'envelope': envelope.receipt,
                'combinedStorageReservationBytes': combined_reservation, 'source': qualification_source}
    contract['datasetFilesystem'] = dataset_filesystem
    contract['windowsConsole'] = console.admission if console else None
    contract['equipmentOnly'] = equipment; contract['qualification'] = not equipment
    provider_token = contract['token']  # Original generated scalar; never reload a credential from disk.
    save(output / 'contract.json', contract)
    env = {key: os.environ[key] for key in ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC'] if key in os.environ}
    env.update({'HOME': str(output / 'home'), 'USERPROFILE': str(output / 'home'), 'NODE_ENV': 'production',
                'FLUJO_DATA_DIR': str(output / 'data'), 'CODEX_HOME': str(output / 'home' / '.codex')})
    children = []; results = {}; failure = None; started = time.monotonic()
    bootstrap = None; bootstrap_admission = None
    try:
        admit_child()
        runtime = Child('runtime', envelope, [node, str(HERE / 'runtime.cjs'), str(output)], output, env, stdin_pipe=True); children.append(runtime)
        bootstrap_file = output / 'runtime-bootstrap-ready.json'
        until = time.monotonic() + 45
        while not bootstrap_file.exists():
            if console:
                console.check()
            if runtime.process.poll() is not None or runtime.errors or time.monotonic() > until:
                raise RuntimeError('Runtime native bootstrap did not become ready')
            time.sleep(.05)
        bootstrap = validate_runtime_bootstrap(bounded_json(bootstrap_file), contract, runtime.process.pid)
        if console:
            console.bootstrap(bootstrap)
        bootstrap_admission = require_runtime_only(envelope, runtime.process.pid)
        admit_child((bootstrap_file, bootstrap['sourceManifestSha256']))
        if runtime.process.poll() is not None:
            raise RuntimeError('Owned runtime exited before provider admission')
        bootstrap_admission = require_runtime_only(envelope, runtime.process.pid)
        configuration = {'nonce': contract['bootstrapNonce'], 'pid': runtime.process.pid,
            **{field: contract[field] for field in ['sourceHead', 'harnessSha256', 'profileSha256']}}
        if equipment:
            peer_script = "process.stdin.resume();process.stdin.on('end',()=>require('node:fs').writeFileSync(process.argv[1],JSON.stringify({completed:true,equipmentOnly:true,qualification:false,mode:'equipment-bootstrap',role:'equipment-peer',pid:process.pid,providerNeverStarted:true}),{flag:'wx'}))"
            provider = Child('equipment-peer', envelope, [node, '-e', peer_script, str(output / 'provider-settled.json')], output, env, stdin_pipe=True)
            children.append(provider)
            configuration.update(version='runtime-equipment-v1', peer={'pid': provider.process.pid})
        else:
            provider_env = {**env, 'FLUJO_569_PROVIDER_TOKEN': provider_token}
            provider = Child('provider', envelope, [node, str(HERE / 'provider.cjs'), str(output)], output, provider_env); children.append(provider)
            provider_env.pop('FLUJO_569_PROVIDER_TOKEN')
            until = time.monotonic() + 20
            while not (output / 'provider-ready.json').exists():
                if console:
                    console.check()
                if provider.process.poll() is not None or provider.errors or time.monotonic() > until:
                    raise RuntimeError('Provider did not become ready')
                time.sleep(.05)
            provider_binding = owned_provider_environment(bounded_json(output / 'provider-ready.json'), provider.process.pid, provider_token)
            configuration.update(version='runtime-provider-v1', provider={'pid': provider.process.pid,
                'port': int(provider_binding['FLUJO_569_PROVIDER_PORT']), 'token': provider_token})
        if provider.process.poll() is not None or runtime.process.poll() is not None:
            raise RuntimeError('Owned process exited before parent configuration')
        runtime.configure(configuration)
        duration = profile['enduranceMs'] if args.mode == 'endurance' else profile['pilotBatches'] * cadence
        deadline = time.monotonic() + (duration + profile['drainMs'] + profile['parkedHoldMs']
                     + (profile['warmupBatches'] + 2) * profile['batchDeadlineMs'] + 120_000) / 1000
        if equipment:
            deadline = time.monotonic() + 20
        with (output / 'os-samples.jsonl').open('x', encoding='utf8', newline='\n') as metrics:
            count = 0; metrics_bytes = 0
            while runtime.process.poll() is None:
                current = {child.name: process_metrics(child.process.pid) for child in children}
                current['supervisor'] = console.check() if console else process_metrics(os.getpid())
                count += 1
                if count > OS_SAMPLE_MAX_COUNT:
                    raise RuntimeError('OS sample count exceeded allowance')
                cgroup = envelope.sample() if isinstance(envelope, LinuxEnvelope) else None
                record = encode_os_sample({'elapsedSeconds': time.monotonic() - started, **current, 'cgroup': cgroup})
                metrics_bytes += len(record.encode('utf8'))
                if metrics_bytes > profile['maxEvidenceFileBytes']:
                    raise RuntimeError('OS evidence exceeded fixed file allowance')
                metrics.write(record); metrics.flush()
                if current['runtime'] and max(current['runtime']['rss'], current['runtime']['peakRss']) > GIB:
                    raise RuntimeError('OS-observed application RSS exceeded 1 GiB')
                if current[provider.name] and max(current[provider.name]['rss'], current[provider.name]['peakRss']) > 384 * MIB:
                    raise RuntimeError('OS-observed provider RSS exceeded 384 MiB')
                if current['supervisor'] and current['supervisor']['rss'] > 128 * MIB:
                    raise RuntimeError('Supervisor RSS exceeded reserved 128 MiB')
                if sum(value['rss'] for value in current.values() if value) > 2 * GIB:
                    raise RuntimeError('Aggregate observed RSS exceeded 2 GiB')
                if provider.process.poll() is not None or any(child.errors for child in children):
                    raise RuntimeError('Child or stdio failed')
                if time.monotonic() > deadline:
                    raise RuntimeError('Full process deadline exceeded')
                if shutil.disk_usage(output).free < 20 * GIB:
                    raise RuntimeError('Free disk floor reached')
                time.sleep(1)
        results['runtime'] = runtime.settlement()
        if equipment:
            provider.process.stdin.close()
        else:
            (output / 'stop-provider').touch(exist_ok=False)
        results[provider.name] = provider.settlement()
        for name, result in results.items():
            if result['code'] != 0 or not result['stdoutEnded'] or not result['stderrEnded'] or result['streamErrors'] or not result['copyThreadsStopped']:
                raise RuntimeError(name + ' did not exit independently with both stdio streams drained')
        receipt = bounded_json(output / 'runtime-receipt.json')
        if not receipt['completed'] or not bounded_json(output / 'runtime-settled.json')['completed']:
            raise RuntimeError('Runtime did not complete')
        if receipt.get('bootstrap') != bootstrap:
            raise RuntimeError('Final runtime bootstrap identity differs from independently admitted identity')
        if equipment:
            peer = bounded_json(output / 'provider-settled.json')
            if (peer.get('equipmentOnly') is not True or peer.get('qualification') is not False
                    or peer.get('role') != 'equipment-peer' or peer.get('pid') != provider.process.pid
                    or peer.get('providerNeverStarted') is not True
                    or receipt.get('equipmentOnly') is not True or receipt.get('qualification') is not False):
                raise RuntimeError('Equipment receipt scope is missing or changed')
        elif bounded_json(output / 'provider-settled.json')['active'] != 0:
            raise RuntimeError('Provider retained requests')
        if git(root, 'rev-parse', 'HEAD', runner=metadata) != source_head or git(root, 'status', '--porcelain', runner=metadata):
            raise RuntimeError('Runtime checkout changed during qualification')
        if os.name != 'nt' and inspect_linux_dataset(output, phase_name) != dataset_filesystem:
            raise RuntimeError('Linux dataset filesystem identity changed')
        if json.loads(metadata(profile_command).stdout) != profile_record:
            raise RuntimeError('Harness changed during qualification')
        if console:
            console_result = console.finish()
    except BaseException as error:
        failure = repr(error)
        (output / 'stop-runtime').touch(exist_ok=True); (output / 'stop-provider').touch(exist_ok=True)
        for child in children:
            if child.process.poll() is None:
                child.process.kill()
            try:
                results[child.name] = child.settlement()
            except BaseException as settlement_error:
                results[child.name] = {'settlementError': repr(settlement_error)}
    finally:
        if isinstance(envelope, WindowsEnvelope):
            try:
                results['windowsJob'] = envelope.settlement()
                if results['windowsJob']['forcedCleanup']:
                    failure = failure or 'Windows Job retained descendants before cleanup'
            except BaseException as error:
                results['windowsJob'] = {'measurementError': repr(error)}
                failure = failure or 'Could not establish Windows Job settlement'
        if isinstance(envelope, LinuxEnvelope):
            try:
                results['cgroup'] = memory_event_report(envelope.events_before, (envelope.root / 'memory.events').read_text())
                results['workloadCgroup'] = memory_event_report(envelope.workload_events_before, (envelope.workload / 'memory.events').read_text())
                results['finalCgroupSample'] = envelope.sample()
                if results['cgroup']['oomObserved'] or results['workloadCgroup']['oomObserved']:
                    failure = failure or 'cgroup OOM counters increased during qualification'
            except BaseException as error:
                results['cgroup'] = {'measurementError': repr(error)}
                failure = failure or 'Could not establish cgroup memory event deltas'
        save(output / 'supervisor-receipt.json', {'completed': failure is None, 'failure': failure,
             'mode': args.mode, 'equipmentOnly': equipment, 'qualification': not equipment,
             'elapsedSeconds': time.monotonic() - started, 'processes': results, 'envelope': contract['envelope'],
             'sourceHead': source_head, 'profileSha256': profile_record['hash'],
             'harnessSha256': profile_record['harnessHash'], 'diskAdmissions': disk_admission.receipts,
             'datasetFilesystem': dataset_filesystem, 'guestDiskAdmissions': guest_admissions,
             'bootstrap': bootstrap, 'bootstrapAdmission': bootstrap_admission,
             'windowsConsole': console_result if console and failure is None else None,
             'windowsNativeTools': console.context['windowsNativeTools'] if console else None,
             'evidencePreserved': True})
    if failure:
        raise RuntimeError(f'{failure}; evidence preserved at {output}')
    print(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['pilot', 'endurance', 'equipment-bootstrap'], required=True)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--dependencies', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--node', default=shutil.which('node'))
    parser.add_argument('--plan', type=Path)
    parser.add_argument('--pilot', type=Path)
    parser.add_argument('--peer-pilot', type=Path)
    supervise(parser.parse_args())

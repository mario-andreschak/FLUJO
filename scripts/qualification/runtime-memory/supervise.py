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
import shutil
import subprocess
import sys
import threading
import time
from envelope_evidence import DiskAdmission, cgroup_paths, cgroup_controls, cgroup_sample, read_record, require_current_node, require_dependency_manifest
from dataset_evidence import prepare_linux_dataset, inspect_linux_dataset, guest_disk_admission

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
    if file.stat().st_size > MIB:
        raise RuntimeError('Receipt exceeds 1 MiB')
    with file.open(encoding='utf8') as handle:
        return json.load(handle)


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


def git(root, *args):
    return subprocess.check_output(['git', *args], cwd=root, text=True,
                                   creationflags=0x08000000 if os.name == 'nt' else 0).strip()


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

    def spawn(self, argv, **kwargs):
        process = subprocess.Popen(argv, creationflags=0x08000000 | 0x4, **kwargs)
        try:
            if not self.kernel.AssignProcessToJobObject(self.job, int(process._handle)):
                raise ctypes.WinError(ctypes.get_last_error())
            resume = ctypes.WinDLL('ntdll').NtResumeProcess
            resume.argtypes = [ctypes.c_void_p]; resume.restype = ctypes.c_long
            if resume(int(process._handle)) != 0:
                raise RuntimeError('Could not resume job-owned child')
            return process
        except BaseException:
            process.kill(); process.wait(); raise

    def settlement(self):
        from ctypes import wintypes as w
        class Accounting(ctypes.Structure):
            _fields_ = [(key, ctypes.c_int64) for key in ['user', 'kernel', 'periodUser', 'periodKernel']] + [
                (key, w.DWORD) for key in ['pageFaults', 'totalProcesses', 'activeProcesses', 'terminatedProcesses']]
        value = Accounting()
        until = time.monotonic() + 1
        while True:
            if not self.kernel.QueryInformationJobObject(self.job, 1, ctypes.byref(value), ctypes.sizeof(value), None):
                raise ctypes.WinError(ctypes.get_last_error())
            if not value.activeProcesses or time.monotonic() >= until:
                break
            time.sleep(.01)  # Allow natural Job accounting settlement, never kill to obtain zero.
        return {'activeProcessesBeforeCleanup': value.activeProcesses, 'totalProcesses': value.totalProcesses,
                'forcedCleanup': value.activeProcesses != 0}

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

    def spawn(self, argv, **kwargs):
        return subprocess.Popen(argv, start_new_session=True, **kwargs)

    def close(self):
        pass


class Child:
    def __init__(self, name, envelope, argv, output, env):
        self.name = name; self.errors = []; self.ended = {}; self.byte_counts = {}; self.exit = None
        self.process = envelope.spawn(argv, cwd=output, env=env, stdin=subprocess.DEVNULL,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.threads = []
        for stream in ['stdout', 'stderr']:
            thread = threading.Thread(target=self.copy, args=(stream, output), daemon=True)
            thread.start(); self.threads.append(thread)

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
        for thread in self.threads:
            thread.join(timeout=10)
        return {'code': self.exit, 'stdoutEnded': self.ended.get('stdout', False),
                'stderrEnded': self.ended.get('stderr', False), 'streamErrors': self.errors,
                'streamBytes': self.byte_counts, 'copyThreadsStopped': all(not thread.is_alive() for thread in self.threads)}


def supervise(args):
    root = args.root.resolve(strict=True); dependencies = args.dependencies.resolve(strict=True)
    output = args.output.resolve(); node = str(Path(args.node).resolve(strict=True))
    if output == root or root in output.parents or output.exists():
        raise RuntimeError('Output must be a new directory outside the checkout')
    if git(root, 'status', '--porcelain'):
        raise RuntimeError('Runtime source checkout must be clean')
    phase_name = Path(os.environ['FLUJO_569_PHASE_EVIDENCE']).name
    if os.name != 'nt':
        prepare_linux_dataset(args.output, phase_name)
    source_head = git(root, 'rev-parse', 'HEAD')
    profile_command = [node, '-e', 'const p=require(process.argv[1]);console.log(JSON.stringify({profile:p.PROFILE,hash:p.profileSha256,harnessHash:p.harnessDigest()}))', str(HERE / 'profile.cjs')]
    profile_record = json.loads(subprocess.check_output(profile_command, text=True))
    profile = profile_record['profile']; cadence = profile['candidateCadenceMs']
    dependencies_at_start = require_dependency_manifest(node, HERE, root, dependencies, profile_record['harnessHash'])
    # Bound the complete 1 Hz record stream before admitting either child.
    os_evidence_projection(OS_SAMPLE_MAX_BYTES, OS_SAMPLE_MAX_COUNT, profile['maxEvidenceFileBytes'])
    combined_reservation = 2 * GIB  # Pilot only; all actual growth is measured and guarded.
    qualification_source = None
    plan_sha256 = None
    if args.mode == 'endurance':
        if not args.plan or not args.pilot or not args.peer_pilot:
            raise RuntimeError('Endurance requires --plan, --pilot and --peer-pilot settled platform receipts')
        validate = "const p=require(process.argv[1]),a=p.readJson(process.argv[2]),x=p.readPilotEvidence(process.argv[3]),y=p.readPilotEvidence(process.argv[5]);p.validatePlan(a,x.pilot,process.argv[4],x.supervisor,y.pilot,y.supervisor,x.owner,y.owner);console.log(JSON.stringify(a))"
        plan = json.loads(subprocess.check_output([node, '-e', validate, str(HERE / 'profile.cjs'), str(args.plan), str(args.pilot), source_head, str(args.peer_pilot)], text=True))
        plan_sha256 = hashlib.sha256(args.plan.read_bytes()).hexdigest()
        cadence = plan['cadenceMs']; combined_reservation = plan['combinedStorageBytes']
        qualification_source = plan['source']
        if dependencies_at_start != {key: qualification_source[key] for key in dependencies_at_start}:
            raise RuntimeError('Installed dependency manifest differs from successful pilots')
        verify_source = "const p=require(process.argv[1]),s=require(process.argv[2]);s.verifySourceManifest(process.argv[3],process.argv[4],p.readJson(process.argv[5]).source)"
        subprocess.check_call([node, '-e', verify_source, str(HERE / 'profile.cjs'), str(HERE / 'source-loader.cjs'),
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
    def admit_child():
        # Re-read the actual executable immediately before EACH child admission.
        current_node = require_current_node(node, expected_node)
        require_dependency_manifest(node, HERE, root, dependencies, profile_record['harnessHash'], dependencies_at_start)
        if os.name != 'nt':
            guest_admissions.append(guest_disk_admission(output, phase_name,
                combined_reservation + profile['budgets']['minimumFreeBytes']))
        disk_admission.identity.update({'node': current_node, 'launcherSha256': expected_launcher})
        admitted = disk_admission.admit()  # Watcher independently rehashes current helper files.
        if args.mode == 'endurance':
            verify_launch = "const p=require(process.argv[1]);p.validateLaunchIdentity(p.readJson(process.argv[2]),process.version,process.argv[3])"
            subprocess.check_call([node, '-e', verify_launch, str(HERE / 'profile.cjs'), str(args.plan), admitted['currentLauncherSha256']])
    envelope = WindowsEnvelope() if os.name == 'nt' else LinuxEnvelope()
    output.mkdir(); (output / 'data').mkdir(); (output / 'home').mkdir()
    dataset_filesystem = inspect_linux_dataset(output, phase_name) if os.name != 'nt' else None
    contract = {'version': profile['version'], 'profileSha256': profile_record['hash'], 'mode': args.mode,
                'harnessSha256': profile_record['harnessHash'],
                'root': str(root), 'dependencies': str(dependencies), 'sourceHead': source_head,
                'cadenceMs': cadence, 'token': secrets.token_hex(24), 'envelope': envelope.receipt,
                'combinedStorageReservationBytes': combined_reservation, 'source': qualification_source}
    contract['datasetFilesystem'] = dataset_filesystem
    save(output / 'contract.json', contract)
    env = {key: os.environ[key] for key in ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC'] if key in os.environ}
    env.update({'HOME': str(output / 'home'), 'USERPROFILE': str(output / 'home'), 'NODE_ENV': 'production',
                'FLUJO_DATA_DIR': str(output / 'data'), 'CODEX_HOME': str(output / 'home' / '.codex')})
    children = []; results = {}; failure = None; started = time.monotonic()
    try:
        admit_child()
        provider = Child('provider', envelope, [node, str(HERE / 'provider.cjs'), str(output)], output, env); children.append(provider)
        until = time.monotonic() + 20
        while not (output / 'provider-ready.json').exists():
            if provider.process.poll() is not None or provider.errors or time.monotonic() > until:
                raise RuntimeError('Provider did not become ready')
            time.sleep(.05)
        admit_child()
        runtime = Child('runtime', envelope, [node, str(HERE / 'runtime.cjs'), str(output)], output, env); children.append(runtime)
        duration = profile['enduranceMs'] if args.mode == 'endurance' else profile['pilotBatches'] * cadence
        deadline = time.monotonic() + (duration + profile['drainMs'] + profile['parkedHoldMs']
                     + (profile['warmupBatches'] + 2) * profile['batchDeadlineMs'] + 120_000) / 1000
        with (output / 'os-samples.jsonl').open('x', encoding='utf8', newline='\n') as metrics:
            count = 0; metrics_bytes = 0
            while runtime.process.poll() is None:
                current = {child.name: process_metrics(child.process.pid) for child in children}
                current['supervisor'] = process_metrics(os.getpid())
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
                if current['provider'] and max(current['provider']['rss'], current['provider']['peakRss']) > 384 * MIB:
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
        (output / 'stop-provider').touch(exist_ok=False)
        results['provider'] = provider.settlement()
        for name, result in results.items():
            if result['code'] != 0 or not result['stdoutEnded'] or not result['stderrEnded'] or result['streamErrors'] or not result['copyThreadsStopped']:
                raise RuntimeError(name + ' did not exit independently with both stdio streams drained')
        receipt = bounded_json(output / 'runtime-receipt.json')
        if not receipt['completed'] or not bounded_json(output / 'runtime-settled.json')['completed']:
            raise RuntimeError('Runtime did not complete')
        if bounded_json(output / 'provider-settled.json')['active'] != 0:
            raise RuntimeError('Provider retained requests')
        if git(root, 'rev-parse', 'HEAD') != source_head or git(root, 'status', '--porcelain'):
            raise RuntimeError('Runtime checkout changed during qualification')
        if os.name != 'nt' and inspect_linux_dataset(output, phase_name) != dataset_filesystem:
            raise RuntimeError('Linux dataset filesystem identity changed')
        if json.loads(subprocess.check_output(profile_command, text=True)) != profile_record:
            raise RuntimeError('Harness changed during qualification')
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
        envelope.close()
        save(output / 'supervisor-receipt.json', {'completed': failure is None, 'failure': failure,
             'elapsedSeconds': time.monotonic() - started, 'processes': results, 'envelope': contract['envelope'],
             'sourceHead': source_head, 'profileSha256': profile_record['hash'],
             'harnessSha256': profile_record['harnessHash'], 'diskAdmissions': disk_admission.receipts,
             'datasetFilesystem': dataset_filesystem, 'guestDiskAdmissions': guest_admissions,
             'evidencePreserved': True})
    if failure:
        raise RuntimeError(f'{failure}; evidence preserved at {output}')
    print(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['pilot', 'endurance'], required=True)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--dependencies', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--node', default=shutil.which('node'))
    parser.add_argument('--plan', type=Path)
    parser.add_argument('--pilot', type=Path)
    parser.add_argument('--peer-pilot', type=Path)
    supervise(parser.parse_args())

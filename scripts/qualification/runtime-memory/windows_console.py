"""Read-only Windows ownership/console evidence; no process launch or cleanup."""
import ctypes
from ctypes import wintypes as w
import json
import os
from pathlib import Path
import time
import re
from metadata_commands import classify_metadata, tool_identity, validate_native_tools

MIB = 1024 ** 2
MAX_PROCESSES = 32

def controller_role(role):
    return isinstance(role, str) and (role in ['runtime', 'provider', 'equipment-peer']
        or re.fullmatch(r'metadata-([1-9]|1[0-9]|2[0-4])', role) is not None)


def publish(file, value):
    data = json.dumps(value).encode()
    if len(data) > 65536:
        raise RuntimeError('Console evidence exceeds 64 KiB')
    prepared = file.with_name(file.name + '.prepared')
    with prepared.open('xb') as stream:
        stream.write(data)
    os.link(prepared, file)


class Native:
    def __init__(self):
        self.k = ctypes.WinDLL('kernel32', use_last_error=True)
        self.n = ctypes.WinDLL('ntdll')
        self.u = ctypes.WinDLL('user32', use_last_error=True)
        self.p = ctypes.WinDLL('psapi', use_last_error=True)
        k = self.k
        k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]; k.OpenProcess.restype = w.HANDLE
        k.CloseHandle.argtypes = [w.HANDLE]; k.GetCurrentProcess.restype = w.HANDLE
        k.GetProcessId.argtypes = [w.HANDLE]; k.GetProcessId.restype = w.DWORD
        k.GetProcessTimes.argtypes = [w.HANDLE, *[ctypes.POINTER(w.FILETIME)] * 4]
        k.QueryFullProcessImageNameW.argtypes = [w.HANDLE, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD)]
        k.GetProcessAffinityMask.argtypes = [w.HANDLE, ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(ctypes.c_size_t)]
        k.GetProcessHandleCount.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
        k.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
        k.GetExitCodeProcess.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
        k.IsProcessInJob.argtypes = [w.HANDLE, w.HANDLE, ctypes.POINTER(w.BOOL)]
        k.QueryInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.c_void_p]
        k.GetConsoleWindow.restype = w.HWND
        k.GetConsoleProcessList.argtypes = [ctypes.POINTER(w.DWORD), w.DWORD]
        self.u.IsWindowVisible.argtypes = [w.HWND]
        self.n.NtQueryInformationProcess.argtypes = [w.HANDLE, w.ULONG, ctypes.c_void_p, w.ULONG, ctypes.POINTER(w.ULONG)]
        self.n.NtQueryInformationProcess.restype = ctypes.c_long
        self.p.GetProcessMemoryInfo.argtypes = [w.HANDLE, ctypes.c_void_p, w.DWORD]

    def members(self, job):
        data = (ctypes.c_size_t * (MAX_PROCESSES + 1))()
        if not self.k.QueryInformationJobObject(job, 3, ctypes.byref(data), ctypes.sizeof(data), None):
            raise ctypes.WinError(ctypes.get_last_error())
        count = data[0] >> 32
        if count > MAX_PROCESSES:
            raise RuntimeError('Job membership exceeds evidence allowance')
        return sorted(data[1:count + 1])

    def counts(self, job):
        class Accounting(ctypes.Structure):
            _fields_ = [(key, ctypes.c_int64) for key in ['user', 'kernel', 'periodUser', 'periodKernel']] + [
                (key, w.DWORD) for key in ['pageFaults', 'totalProcesses', 'activeProcesses', 'terminatedProcesses']]
        value = Accounting()
        if not self.k.QueryInformationJobObject(job, 1, ctypes.byref(value), ctypes.sizeof(value), None):
            raise ctypes.WinError(ctypes.get_last_error())
        return {key: getattr(value, key) for key in ['totalProcesses', 'activeProcesses', 'terminatedProcesses']}

    def console(self):
        pids = (w.DWORD * MAX_PROCESSES)()
        count = self.k.GetConsoleProcessList(pids, MAX_PROCESSES)
        if not 0 < count <= MAX_PROCESSES:
            raise RuntimeError('Missing or oversized public console client list')
        window = self.k.GetConsoleWindow()
        host = ctypes.c_size_t(); length = w.ULONG()
        status = self.n.NtQueryInformationProcess(self.k.GetCurrentProcess(), 49, ctypes.byref(host), ctypes.sizeof(host), ctypes.byref(length))
        return {'clients': sorted(pids[:count]), 'window': window or 0,
                'visible': bool(window and self.u.IsWindowVisible(window)),
                'hostCorroboration': {'status': status, 'raw': host.value, 'pid': host.value & ~3,
                                      'returnedBytes': length.value, 'method': 'NtQueryInformationProcess49 corroboration'}}

    def facts(self, handle):
        class Basic(ctypes.Structure):
            _fields_ = [(key, ctypes.c_void_p) for key in ['exit', 'peb', 'affinity', 'priority', 'pid', 'parent']]
        basic = Basic(); length = w.ULONG()
        if self.n.NtQueryInformationProcess(handle, 0, ctypes.byref(basic), ctypes.sizeof(basic), ctypes.byref(length)) < 0:
            raise RuntimeError('Could not read held process parent identity')
        image = ctypes.create_unicode_buffer(1024); size = w.DWORD(1024)
        if not self.k.QueryFullProcessImageNameW(handle, 0, image, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        values = [w.FILETIME() for _ in range(4)]
        if not self.k.GetProcessTimes(handle, *[ctypes.byref(value) for value in values]):
            raise ctypes.WinError(ctypes.get_last_error())
        affinity, system = ctypes.c_size_t(), ctypes.c_size_t()
        if not self.k.GetProcessAffinityMask(handle, ctypes.byref(affinity), ctypes.byref(system)):
            raise ctypes.WinError(ctypes.get_last_error())
        return {'pid': self.k.GetProcessId(handle), 'parentPid': basic.parent, 'image': image.value,
                'creationFiletime': str(values[0].dwHighDateTime << 32 | values[0].dwLowDateTime), 'affinity': affinity.value}

    def memory(self, handle, handles=False):
        class Memory(ctypes.Structure):
            _fields_ = [('cb', w.DWORD), ('faults', w.DWORD)] + [(key, ctypes.c_size_t) for key in
                ['peakRss', 'rss', 'peakPagedPool', 'pagedPool', 'peakNonpagedPool', 'nonpagedPool', 'pagefile', 'peakPagefile']]
        value = Memory(); value.cb = ctypes.sizeof(value)
        if not self.p.GetProcessMemoryInfo(handle, ctypes.byref(value), value.cb):
            raise ctypes.WinError(ctypes.get_last_error())
        result = {'rss': value.rss, 'peakRss': value.peakRss}
        if handles:
            count = w.DWORD()
            if not self.k.GetProcessHandleCount(handle, ctypes.byref(count)):
                raise ctypes.WinError(ctypes.get_last_error())
            result['handles'] = count.value
        return result

    def exit(self, handle):
        wait = self.k.WaitForSingleObject(handle, 0); code = w.DWORD()
        if wait not in [0, 258] or not self.k.GetExitCodeProcess(handle, ctypes.byref(code)):
            raise ctypes.WinError(ctypes.get_last_error())
        return {'signaled': wait == 0, 'exitCode': code.value}


class HeldProcesses:
    def __init__(self, native, job):
        self.native = native; self.job = job; self.records = {}; self.handles = {}; self.errors = []

    def add(self, pid):
        if pid in self.records:
            return self.records[pid]
        if len(self.records) >= MAX_PROCESSES:
            raise RuntimeError('Held ownership record allowance exceeded')
        handle = self.native.k.OpenProcess(0x1410 | 0x100000, False, pid)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            facts = self.native.facts(handle)
            if facts['pid'] != pid or pid not in self.native.members(self.job):
                raise RuntimeError('Process does not belong to the exact owned Job')
            memory = self.native.memory(handle)
            self.records[pid] = {'identity': facts, 'maximumObservedPeakRss': memory['peakRss'], 'lastMemory': memory}
            self.handles[pid] = handle
            return self.records[pid]
        except BaseException:
            self.native.k.CloseHandle(handle)
            raise

    def sample(self, pid, handles=False):
        record = self.records[pid]; handle = self.handles[pid]
        try:
            memory = self.native.memory(handle, handles)
            if memory['peakRss'] < record['maximumObservedPeakRss']:
                raise RuntimeError('Held kernel peak decreased')
            record['maximumObservedPeakRss'] = memory['peakRss']; record['lastMemory'] = memory
            return memory
        except BaseException as error:
            lifecycle = self.native.exit(handle); members = self.native.members(self.job)
            evidence = {'pid': pid, 'operation': 'held memory', 'error': repr(error), 'lifecycle': lifecycle, 'freshJobMembers': members}
            self.errors.append(evidence)
            # Preserve the actual failure. Missing final peaks can never qualify.
            raise RuntimeError('Held process memory evidence unavailable: ' + json.dumps(evidence)) from error

    def finish(self, pids=None):
        members = self.native.members(self.job)
        for pid in pids if pids is not None else self.records:
            lifecycle = self.native.exit(self.handles[pid])
            if not lifecycle['signaled'] or lifecycle['exitCode'] != 0 or pid in members:
                raise RuntimeError('Owned process did not exit naturally outside its Job: ' + str(pid))
            memory = self.sample(pid)
            if memory['peakRss'] <= 0:
                raise RuntimeError('Final held kernel peak is missing or zero')
            self.records[pid]['final'] = {**lifecycle, 'memory': memory, 'freshJobAbsent': True, 'heldHandle': True}
        return {str(pid): record for pid, record in self.records.items()}

    def close(self):
        for handle in self.handles.values():
            self.native.k.CloseHandle(handle)
        self.handles.clear()


def validate_private_console(controller, host, console, members, affinity):
    expected_image = str(Path(os.environ['SystemRoot']) / 'System32' / 'conhost.exe')
    if (console['clients'] != [controller['pid']] or console['visible']
            or console['hostCorroboration']['status'] < 0 or console['hostCorroboration']['pid'] != host['pid']
            or host['parentPid'] != controller['pid'] or int(host['creationFiletime']) < int(controller['creationFiletime'])
            or host['image'].lower() != expected_image.lower()
            or set(members) != {controller['pid'], host['pid']}
            or controller['affinity'] != affinity or host['affinity'] != affinity):
        raise RuntimeError('Console is not fresh, private, hidden and already in the owned outer Job')


class ControllerConsole:
    def __init__(self, envelope, phase, token, read_json, context):
        self.native = Native(); self.envelope = envelope; self.phase = phase; self.token = token
        self.held = HeldProcesses(self.native, None); self.inner = HeldProcesses(self.native, envelope.job)
        self.attested = set(); self.pending = {}; self.roles = {}; self.read_json = read_json; self.maximumControlPeakRss = 0
        self.child_admissions = {}
        self.context = context; self.metadata_permits = {}; self.metadata_settlements = {}; self.suspended = set()
        validate_native_tools(context['windowsNativeTools'])
        own = self.held.add(os.getpid())['identity']; initial = self.native.console()
        host = self.held.add(initial['hostCorroboration']['pid'])['identity']; self.host = host['pid']
        validate_private_console(own, host, initial, self.native.members(None), sum(1 << bit for bit in envelope.receipt['cpuAffinity']))
        self.identity = {'version': 'owned-controller-console-v1', 'controller': own, 'host': host, 'initialConsole': initial}
        publish(phase / 'console-request.json', {'token': token, 'identity': self.identity})
        deadline = time.monotonic() + 10
        while not (phase / 'console-admission.json').exists():
            if time.monotonic() > deadline:
                raise RuntimeError('Independent console admission is missing')
            time.sleep(.05)
        admission = read_json(phase / 'console-admission.json')
        if admission.get('token') != token or admission.get('identity') != self.identity or admission.get('admitted') is not True:
            raise RuntimeError('Independent console admission does not bind this owner')
        self.admission = admission

    def await_record(self, name):
        file = self.phase / name; deadline = time.monotonic() + 5
        while not file.exists():
            self.check()
            if time.monotonic() > deadline:
                raise RuntimeError('Independent metadata handshake timed out: ' + name)
            time.sleep(.01)
        return self.read_json(file)

    def prepare_metadata(self, role, argv, cwd):
        sequence = len(self.metadata_permits) + 1
        if role != 'metadata-' + str(sequence) or sequence > 24 or len(self.metadata_settlements) != sequence - 1:
            raise RuntimeError('Metadata operations must settle sequentially')
        command = classify_metadata(argv, cwd, self.context)
        before = self.envelope.process_counts()
        request = {'token': self.token, 'role': role, 'sequence': sequence, 'argv': argv, 'cwd': cwd,
                   'command': command, 'innerBefore': before}
        publish(self.phase / ('metadata-prepare-' + str(sequence) + '.json'), request)
        permit = self.await_record('metadata-permit-' + str(sequence) + '.json')
        expected = {key: request[key] for key in ['token', 'role', 'sequence', 'command', 'innerBefore']}
        if permit != {**expected, 'outerBefore': self.native.counts(None), 'admitted': True}:
            raise RuntimeError('Metadata pre-create permit changed command or kernel baseline')
        self.metadata_permits[role] = permit

    def finish_metadata(self, role, pid):
        permit = self.metadata_permits[role]; after = self.envelope.process_counts()
        if after['totalProcesses'] != permit['innerBefore']['totalProcesses'] + 1 or after['terminatedProcesses']:
            raise RuntimeError('Metadata created an additional inner process')
        request = {'token': self.token, 'role': role, 'sequence': permit['sequence'], 'pid': pid,
                   'commandSha256': permit['command']['commandSha256'], 'innerAfter': after,
                   'exitCode': 0, 'stdoutEnded': True, 'stderrEnded': True}
        publish(self.phase / ('metadata-finished-' + str(permit['sequence']) + '.json'), request)
        final = self.await_record('metadata-settlement-' + str(permit['sequence']) + '.json')
        if (any(final.get(key) != value for key, value in request.items()) or final.get('completed') is not True
                or final['outerAfter']['totalProcesses'] != permit['outerBefore']['totalProcesses'] + 1):
            raise RuntimeError('Independent metadata settlement differs')
        self.metadata_settlements[role] = final

    def admit_suspended(self, pid, role):
        if not controller_role(role) or role in self.roles or len(self.child_admissions) >= 26:
            raise RuntimeError('Invalid or duplicate suspended child role')
        self.roles[role] = pid; self.suspended.add(pid)
        identity = self.inner.add(pid)['identity']
        metadata = role.startswith('metadata-')
        if metadata and role not in self.metadata_permits:
            raise RuntimeError('Detached metadata has no pre-create permit')
        sequence = len(self.child_admissions) + 1
        request = {'token': self.token, 'sequence': sequence, 'role': role, 'identity': identity,
                   'stage': 'assigned-before-resume', 'consoleMode': 'detached-metadata' if metadata else 'inherited',
                   'creationFlags': 12 if metadata else 4}
        publish(self.phase / ('console-child-request-' + str(sequence) + '.json'), request)
        file = self.phase / ('console-child-admission-' + str(sequence) + '.json')
        deadline = time.monotonic() + 5
        while not file.exists():
            self.check()
            if time.monotonic() > deadline:
                raise RuntimeError('Independent suspended child admission timed out')
            time.sleep(.01)
        admission = self.read_json(file)
        if admission != {**request, 'admitted': True}:
            raise RuntimeError('Suspended child admission changed identity or scope')
        self.child_admissions[role] = admission

    def resumed(self, pid):
        self.suspended.remove(pid); self.pending[pid] = time.monotonic()

    def check(self):
        before = self.native.members(self.envelope.job); console = self.native.console(); after = self.native.members(self.envelope.job)
        members = set(before) | set(after)
        if len(before) > 2 or len(after) > 2 or console['visible'] or console['window'] != self.identity['initialConsole']['window']:
            raise RuntimeError('Owned console or inner process envelope changed')
        if console['hostCorroboration']['status'] < 0 or console['hostCorroboration']['pid'] != self.host:
            raise RuntimeError('Controller console host changed')
        if set(console['clients']) - members - {os.getpid()}:
            raise RuntimeError('Private console contains an unowned client')
        for pid in members:
            record = self.inner.add(pid); self.pending.setdefault(pid, time.monotonic())
            metadata = pid in {value for role, value in self.roles.items() if role.startswith('metadata-')}
            if metadata and pid in console['clients']:
                raise RuntimeError('Detached metadata unexpectedly joined the private console')
            if not metadata and pid in console['clients']:
                self.attested.add(pid)
            if not metadata and pid not in self.suspended and pid not in self.attested and time.monotonic() - self.pending[pid] > 1:
                raise RuntimeError('Child did not positively join the private console')
            if record['identity']['affinity'] != self.identity['controller']['affinity']:
                raise RuntimeError('Child CPU affinity changed')
        metrics = [self.held.sample(pid, handles=True) for pid in [os.getpid(), self.host]]
        combined = {key: sum(value[key] for value in metrics) for key in ['rss', 'peakRss', 'handles']}
        self.maximumControlPeakRss = max(self.maximumControlPeakRss, combined['peakRss'])
        if max(combined['rss'], combined['peakRss']) > 128 * MIB:
            raise RuntimeError('Controller plus console exceeds the existing 128 MiB reserve')
        return combined

    def register(self, pid, role):
        self.roles[role] = pid
        deadline = time.monotonic() + 1
        while pid not in self.attested:
            self.check()
            if time.monotonic() > deadline:
                raise RuntimeError('Owned child console admission timed out')
            time.sleep(.01)

    def bootstrap(self, bootstrap):
        self.check()
        for probe in bootstrap['settlement']['probes']:
            if probe['pid'] not in self.attested:
                raise RuntimeError('Native probe lacked positive owned console/inner Job evidence')
            self.roles['native-probe-' + str(probe['attempt'])] = probe['pid']
        self.inner.finish([probe['pid'] for probe in bootstrap['settlement']['probes']])

    def finish(self):
        deadline = time.monotonic() + 2
        while self.native.members(self.envelope.job) or self.native.console()['clients'] != [os.getpid()]:
            if time.monotonic() > deadline:
                raise RuntimeError('Console retained workload clients')
            time.sleep(.01)
        self.check()
        if self.native.members(self.envelope.job) or self.native.console()['clients'] != [os.getpid()]:
            raise RuntimeError('Console retained workload clients')
        records = self.inner.finish()
        metadata_pids = {pid for role, pid in self.roles.items() if role.startswith('metadata-')}
        expected = self.attested | metadata_pids
        if (set(self.inner.records) != expected or set(self.roles.values()) != expected or len(self.roles) != len(expected)
                or set(self.metadata_settlements) != set(self.metadata_permits)):
            raise RuntimeError('An inner process lacked positive public console membership')
        counts = self.native.counts(self.envelope.job)
        if counts['activeProcesses'] or counts['terminatedProcesses'] or counts['totalProcesses'] != len(records):
            raise RuntimeError('Inner lifetime process count differs from exact held roles')
        for tool in {value['command']['tool']['path']: value['command']['tool'] for value in self.metadata_permits.values()}.values():
            if tool_identity(tool['path'], self.context['windowsNativeTools']) != tool:
                raise RuntimeError('Metadata executable changed before controller completion')
        result = {'identity': self.identity, 'admission': self.admission, 'roles': self.roles,
                  'windowsNativeTools': self.context['windowsNativeTools'],
                  'childAdmissions': self.child_admissions,
                  'metadataPermits': self.metadata_permits, 'metadataSettlements': self.metadata_settlements, 'innerLifetimeCounts': counts,
                  'children': records, 'publiclyAttestedPids': sorted(self.attested), 'finalConsole': self.native.console(),
                  'combinedSupervisorMetrics': self.check(), 'metricMeaning': 'controller plus private console host; outer observer supplies final post-exit peaks'}
        result['maximumControlPeakRss'] = self.maximumControlPeakRss
        publish(self.phase / 'console-controller-final.json', {'token': self.token, **result})
        return result

    def close(self):
        self.inner.close(); self.held.close()


class OuterConsoleObserver:
    def __init__(self, job, controller_pid, phase, token, affinity, context):
        self.native = Native(); self.held = HeldProcesses(self.native, job); self.job = job
        self.controller_pid = controller_pid; self.phase = phase; self.token = token; self.affinity = affinity
        self.identity = None; self.max_members = 0
        self.child_admissions = {}
        self.context = context; self.metadata_permits = {}; self.metadata_settlements = {}
        validate_native_tools(context['windowsNativeTools'])
        self.held.add(controller_pid)

    def observe(self):
        members = self.native.members(self.job); self.max_members = max(self.max_members, len(members))
        for pid in members:
            self.held.add(pid)
        if self.identity:
            for pid in [self.controller_pid, self.identity['host']['pid']]:
                self.held.sample(pid)
            if sum(self.held.records[pid]['maximumObservedPeakRss'] for pid in [self.controller_pid, self.identity['host']['pid']]) > 128 * MIB:
                raise RuntimeError('Independent controller plus console reserve exceeded')

    def admit(self, request):
        if request.get('token') != self.token or request.get('identity', {}).get('controller', {}).get('pid') != self.controller_pid:
            raise RuntimeError('Console request belongs to another controller')
        value = request['identity']; self.observe()
        own = self.held.records[self.controller_pid]['identity']; host = self.held.add(value['host']['pid'])['identity']
        validate_private_console(own, host, value['initialConsole'], self.native.members(self.job), self.affinity)
        if own != value['controller'] or host != value['host']:
            raise RuntimeError('Independent console process identities differ')
        self.identity = value
        publish(self.phase / 'console-admission.json', {'token': self.token, 'identity': value, 'admitted': True, 'outerObserverPid': os.getpid()})

    def prepare_metadata(self, request):
        sequence = len(self.metadata_permits) + 1; role = 'metadata-' + str(sequence)
        if (not self.identity or sequence > 24 or len(self.metadata_settlements) != sequence - 1
                or request.get('token') != self.token or request.get('sequence') != sequence or request.get('role') != role):
            raise RuntimeError('Invalid metadata pre-create request')
        command = classify_metadata(request['argv'], request['cwd'], self.context)
        if command != request['command']:
            raise RuntimeError('Independent metadata command identity differs')
        self.observe()
        permit = {key: request[key] for key in ['token', 'role', 'sequence', 'command', 'innerBefore']}
        permit.update(outerBefore=self.native.counts(self.job), admitted=True)
        self.metadata_permits[role] = permit
        publish(self.phase / ('metadata-permit-' + str(sequence) + '.json'), permit)

    def finish_metadata(self, request):
        sequence = len(self.metadata_settlements) + 1; role = 'metadata-' + str(sequence)
        permit = self.metadata_permits.get(role); child = self.child_admissions.get(role)
        if (not permit or not child or request.get('token') != self.token or request.get('sequence') != sequence
                or request.get('role') != role or request.get('pid') != child['identity']['pid']
                or request.get('commandSha256') != permit['command']['commandSha256'] or request.get('exitCode') != 0
                or request.get('stdoutEnded') is not True or request.get('stderrEnded') is not True
                or request['innerAfter']['totalProcesses'] != permit['innerBefore']['totalProcesses'] + 1):
            raise RuntimeError('Invalid metadata completion request')
        records = self.held.finish([request['pid']]); after = self.native.counts(self.job)
        if after['totalProcesses'] != permit['outerBefore']['totalProcesses'] + 1 or after['terminatedProcesses']:
            raise RuntimeError('Metadata added an extra outer process')
        final = {**request, 'outerAfter': after, 'finalHeldPeakRss': records[str(request['pid'])]['final']['memory']['peakRss'], 'completed': True}
        self.metadata_settlements[role] = final
        publish(self.phase / ('metadata-settlement-' + str(sequence) + '.json'), final)

    def admit_child(self, request):
        role = request.get('role'); sequence = len(self.child_admissions) + 1
        if (not self.identity or request.get('token') != self.token or request.get('sequence') != sequence
                or sequence > 26 or not controller_role(role) or role in self.child_admissions
                or request.get('stage') != 'assigned-before-resume'):
            raise RuntimeError('Invalid suspended child ownership request')
        pid = request['identity']['pid']; actual = self.held.add(pid)['identity']
        metadata = role.startswith('metadata-')
        if request.get('consoleMode') != ('detached-metadata' if metadata else 'inherited') or request.get('creationFlags') != (12 if metadata else 4):
            raise RuntimeError('Child launch transport differs from its explicit role')
        if metadata:
            permit = self.metadata_permits.get(role)
            if (not permit or actual['image'].lower() != permit['command']['tool']['path'].lower()
                    or self.native.counts(self.job)['totalProcesses'] != permit['outerBefore']['totalProcesses'] + 1):
                raise RuntimeError('Metadata child differs from pre-create command/total baseline')
        if (actual != request['identity'] or actual['parentPid'] != self.controller_pid
                or actual['affinity'] != self.affinity or self.native.exit(self.held.handles[pid])['signaled']):
            raise RuntimeError('Suspended child lacks independently held live ownership')
        admission = {**request, 'admitted': True}
        self.child_admissions[role] = admission
        publish(self.phase / ('console-child-admission-' + str(sequence) + '.json'), admission)

    def finish(self, controller):
        if not self.identity or controller.get('token') != self.token or controller.get('identity') != self.identity:
            raise RuntimeError('Final console ownership attestation is missing or changed')
        if self.native.members(self.job):
            raise RuntimeError('Outer Job retained processes before final console measurement')
        records = self.held.finish()
        counts = self.native.counts(self.job)
        if counts['activeProcesses'] or counts['terminatedProcesses'] or counts['totalProcesses'] != len(records):
            raise RuntimeError('Outer lifetime process total differs from all independently held identities')
        direct_roles = {role for role in controller['roles'] if not role.startswith('native-probe-')}
        if controller.get('childAdmissions') != self.child_admissions or set(self.child_admissions) != direct_roles:
            raise RuntimeError('Controller child lacked independent before-resume admission')
        metadata_roles = {role for role in controller['roles'] if role.startswith('metadata-')}
        if (controller.get('metadataPermits') != self.metadata_permits or controller.get('metadataSettlements') != self.metadata_settlements
                or set(self.metadata_permits) != metadata_roles or set(self.metadata_settlements) != metadata_roles):
            raise RuntimeError('Metadata three-stage ownership proof is incomplete')
        for tool in {value['command']['tool']['path']: value['command']['tool'] for value in self.metadata_permits.values()}.values():
            if tool_identity(tool['path'], self.context['windowsNativeTools']) != tool:
                raise RuntimeError('Metadata executable changed before independent completion')
        required = {str(self.controller_pid), str(self.identity['host']['pid']), *controller['children']}
        if set(records) != required or {str(pid) for pid in controller['roles'].values()} != set(controller['children']):
            raise RuntimeError('Extra or unregistered outer process lacks inner/public-console ownership')
        for pid, child in controller['children'].items():
            if pid not in records or records[pid]['identity'] != child['identity']:
                raise RuntimeError('Inner child lacks independently held outer ownership')
        reserve = sum(records[str(pid)]['final']['memory']['peakRss'] for pid in [self.controller_pid, self.identity['host']['pid']])
        if reserve > 128 * MIB:
            raise RuntimeError('Final held controller plus console peak exceeds 128 MiB')
        for role, cap in [('runtime', 1024 * MIB), ('provider', 384 * MIB), ('equipment-peer', 384 * MIB)]:
            if role in controller['roles'] and records[str(controller['roles'][role])]['final']['memory']['peakRss'] > cap:
                raise RuntimeError('Final held ' + role + ' peak exceeds its allowance')
        return {'version': 'owned-console-final-v1', 'completed': True, 'identity': self.identity,
                'windowsNativeTools': self.context['windowsNativeTools'],
                'controller': controller, 'heldProcesses': records, 'finalReservePeakRss': reserve,
                'childAdmissions': self.child_admissions,
                'finalControlPeakUpperBound': reserve, 'outerLifetimeCounts': counts,
                'metadataPermits': self.metadata_permits, 'metadataSettlements': self.metadata_settlements,
                'reserveLimitBytes': 128 * MIB, 'outerJobEmpty': True, 'maximumOuterMembers': self.max_members,
                'rawErrors': self.held.errors}

    def close(self):
        self.held.close()

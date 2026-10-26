"""Stdlib-only supervisor tests; never load production runtime or start a pilot."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import os
import sys
import subprocess
import time
from metadata_commands import classify_metadata, tool_identity, validate_tool_identity, validate_native_tools, streamed_executable, GIT_FLAGS, SCRIPTS
from contextlib import contextmanager


@contextmanager
def preserved_directory():
    # Deletions belong to the owner's flujo-bash cleanup after test settlement.
    yield tempfile.mkdtemp(prefix='flujo-memory-supervisor-', dir=os.environ.get('FLUJO_QUALIFICATION_TEST_EVIDENCE'))

sys.path.insert(0, str(Path(__file__).parent))
from dataset_evidence import validate_dataset_path, guest_disk_admission
from envelope_evidence import cgroup_paths, cgroup_controls, validate_disk_receipt, require_current_node, require_dependency_manifest

spec = importlib.util.spec_from_file_location('runtime_memory_supervisor', Path(__file__).with_name('supervise.py'))
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


class FakeProcess:
    def __init__(self):
        self.stdin = None
        self.stdout = io.BytesIO(b'out\n')
        self.stderr = io.BytesIO(b'err\n')

    def wait(self, timeout):
        return 0


class SupervisorTests(unittest.TestCase):
    def test_fixed_metadata_registry_and_sealed_streamed_file_binding(self):
        # Portable file fingerprints only. These fixtures are never executed.
        with preserved_directory() as directory:
            root = str(Path(__file__).resolve().parents[3]); harness = Path(__file__).parent; tools = {}
            for kind in ['node', 'git']:
                file = Path(directory) / (kind + '.exe'); file.write_bytes(('fixture-' + kind).encode())
                record = streamed_executable(file)
                tools[kind] = {'path': str(file), 'version': 'fixture-version', 'sha256': record['sha256']}
            node, git_path = tools['node']['path'], tools['git']['path']
            context = {'root': root, 'dependencies': root, 'node': node, 'sourceHead': 'a' * 40, 'windowsNativeTools': tools,
                       'output': directory, 'plan': None, 'pilot': None, 'peerPilot': None, 'launcherSha256': 'b' * 64}
            self.assertEqual(classify_metadata([node, '--version'], None, context)['operation'], 'node-version')
            self.assertEqual(classify_metadata([git_path, *GIT_FLAGS, 'status', '--porcelain'], root, context)['operation'], 'git-clean')
            actual = tool_identity(git_path, tools)
            with self.assertRaises(RuntimeError): validate_tool_identity(git_path, {**actual, 'sha256': '0' * 64}, tools)
            for argv in [[str(Path(directory) / 'wrapper.exe'), '--version'], [node, '-e', 'process.exit(0)'],
                         [git_path, 'status', '--porcelain'], [node, '-e', SCRIPTS['profile'], str(harness / 'unknown.cjs')]]:
                with self.assertRaises(RuntimeError): classify_metadata(argv, root, context)
            with self.assertRaises(RuntimeError): tool_identity(str(harness / 'unknown.exe'), tools)
            for changed in [{}, {**tools, 'extra': tools['node']}, {**tools, 'node': {**tools['node'], 'extra': True}}]:
                with self.assertRaises(RuntimeError): validate_native_tools(changed)

    def test_streamed_executable_rejects_same_length_mutation_with_restored_mtime(self):
        with preserved_directory() as directory:
            file = Path(directory) / 'fixture.exe'; file.write_bytes(b'a' * 131072)
            before = file.stat(); read = os.read; changed = False
            def mutate(fd, size):
                nonlocal changed
                data = read(fd, size)
                if not changed:
                    changed = True; file.write_bytes(b'b' * 131072); os.utime(file, ns=(before.st_atime_ns, before.st_mtime_ns))
                return data
            with patch.object(os, 'read', side_effect=mutate):
                with self.assertRaises(RuntimeError): streamed_executable(file)

    def test_private_console_refuses_foreign_parent_job_clients_visible_window_or_birth(self):
        from windows_console import validate_private_console
        import copy
        with patch.dict(os.environ, {'SystemRoot': r'C:\Windows'}):
            own={'pid':101,'creationFiletime':'100','affinity':3}
            host={'pid':102,'parentPid':101,'creationFiletime':'101','affinity':3,
                  'image':str(Path(os.environ['SystemRoot'])/'System32'/'conhost.exe')}
            console={'clients':[101],'visible':False,'hostCorroboration':{'status':0,'pid':102}}
            validate_private_console(own,host,console,[101,102],3)
            for change in [{'parentPid':999},{'creationFiletime':'99'},{'image':'foreign.exe'},{'affinity':7}]:
                with self.assertRaises(RuntimeError):validate_private_console(own,{**host,**change},console,[101,102],3)
            for changed in [{**console,'visible':True},{**console,'clients':[101,999]},
                            {**console,'hostCorroboration':{'status':0,'pid':999}}]:
                with self.assertRaises(RuntimeError):validate_private_console(own,host,changed,[101,102],3)
            with self.assertRaises(RuntimeError):validate_private_console(own,host,copy.deepcopy(console),[101],3)

    @unittest.skipUnless(os.name == 'nt', 'Actual Windows inner Job metadata fixture')
    def test_metadata_runner_bounds_natural_failure_and_drains_both_streams(self):
        envelope=supervisor.WindowsEnvelope()
        try:
            with preserved_directory() as directory:
                runner=supervisor.MetadataRunner(envelope,Path(directory));node=supervisor.shutil.which('node')
                value=runner([node,'-e',"process.stdout.write('ok');process.stderr.write('diagnostic')"])
                self.assertEqual(value.stdout,b'ok');self.assertEqual(value.stderr,b'diagnostic')
                with self.assertRaisesRegex(RuntimeError,'Metadata command failed'):
                    runner([node,'-e','process.exitCode=2'])
                record=json.loads((Path(directory)/'metadata-2.json').read_text())
                self.assertEqual(record['code'],2);self.assertEqual(record['ended'],{'stdout':True,'stderr':True})
                self.assertTrue(record['threadsStopped']);self.assertFalse(envelope.settlement()['forcedCleanup'])
        finally:envelope.close()

    @unittest.skipUnless(os.name == 'nt', 'Actual Windows post-spawn cleanup fixture')
    def test_drain_thread_start_failure_reaps_both_child_types(self):
        for kind in ['metadata', 'child']:
            envelope = supervisor.WindowsEnvelope(); children = []; original = envelope.spawn
            def spawn(*args, **kwargs):
                child = original(*args, **kwargs); children.append(child); return child
            envelope.spawn = spawn
            try:
                with preserved_directory() as directory, patch.object(threading.Thread, 'start', side_effect=RuntimeError('thread start fixture')):
                    argv = [supervisor.shutil.which('node'), '-e', 'setInterval(()=>{},1000)']
                    with self.assertRaisesRegex(RuntimeError, 'thread start fixture'):
                        if kind == 'metadata': supervisor.MetadataRunner(envelope, Path(directory))(argv)
                        else: supervisor.Child('fixture', envelope, argv, Path(directory), os.environ.copy())
                    self.assertEqual(len(children), 1); self.assertIsNotNone(children[0].poll())
                    self.assertTrue(children[0].stdout.closed and children[0].stderr.closed)
                    self.assertEqual(envelope.settlement()['activeProcessesBeforeCleanup'], 0)
            finally:
                envelope.close()

    @unittest.skipUnless(os.name == 'nt', 'Actual Windows suspended-admission refusal')
    def test_missing_outer_admission_never_resumes_native_child(self):
        envelope = supervisor.WindowsEnvelope(); admitted = []
        class RefuseAdmission:
            def admit_suspended(self, pid, role):
                admitted.append((pid, role))
                raise RuntimeError('Missing independent outer acknowledgment')
        envelope.console = RefuseAdmission()
        try:
            with preserved_directory() as directory:
                marker = Path(directory) / 'must-not-run.json'
                with self.assertRaisesRegex(RuntimeError, 'Missing independent'):
                    envelope.spawn([supervisor.shutil.which('node'), '-e', "require('node:fs').writeFileSync(process.argv[1],'ran')", str(marker)],
                        qualification_role='metadata-1', stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                self.assertEqual(len(admitted), 1); self.assertFalse(marker.exists())
                self.assertEqual(envelope.settlement()['activeProcessesBeforeCleanup'], 0)
        finally:
            envelope.close()

    def test_native_written_receipt_is_read_consistently_by_python_and_node(self):
        with preserved_directory() as directory:
            file = Path(directory) / 'native-record.json'
            with file.open('wb') as stream:
                stream.write(b'{"value":'); stream.flush(); time.sleep(.02); stream.write(b'123}')
            self.assertEqual(supervisor.bounded_json(file), {'value': 123})
            script = "const a=require('node:assert/strict');a.deepEqual(JSON.parse(require(process.argv[1]).readBoundedFile(process.argv[2],1024)),{value:123})"
            subprocess.run([supervisor.shutil.which('node'), '-e', script, str(Path(__file__).with_name('file-evidence.cjs')), str(file)], check=True, timeout=5)

    def test_descriptor_reader_rejects_real_mutation_or_name_replacement(self):
        for kind in ['mutation', 'replacement']:
            with preserved_directory() as directory:
                file = Path(directory) / 'record.json'; file.write_bytes(b'{"a":1}')
                initial = os.stat(file)
                original_fstat = os.fstat; changed = False
                def fstat_then_change(descriptor):
                    nonlocal changed
                    result = original_fstat(descriptor)
                    if not changed:
                        changed = True
                        time.sleep(.02)
                        if kind == 'replacement':
                            # On Windows the open descriptor may itself deny rename.
                            file.rename(Path(directory) / 'preserved-original.json')
                        file.write_bytes(b'{"a":2}')
                        os.utime(file, ns=(initial.st_atime_ns, initial.st_mtime_ns))
                    return result
                with patch.object(os, 'fstat', side_effect=fstat_then_change):
                    with self.assertRaises((RuntimeError, PermissionError)):
                        supervisor.bounded_json(file)

    def test_bootstrap_binds_real_os_identity_and_refuses_forged_or_unsettled_records(self):
        contract = {'bootstrapNonce': 'a' * 48, 'sourceHead': 'head', 'harnessSha256': 'harness', 'profileSha256': 'profile'}
        identity = {'pid': os.getpid(), 'processInstanceId': '11111111-1111-4111-8111-111111111111',
                    'processBirthMarkerV2': supervisor.native_process_birth_marker(os.getpid())}
        record = {'version': 'runtime-bootstrap-v1', 'nonce': contract['bootstrapNonce'], 'pid': os.getpid(),
                  'identity': identity, 'settlement': {'sealed': True, 'probes': [{'closed': True, 'exitCode': 0,
                      'signal': None, 'killed': False, 'stdoutEnded': True, 'stderrEnded': True}]},
                  'source': {}, 'sourceManifestSha256': 'a' * 64,
                  **{key: contract[key] for key in ['sourceHead', 'harnessSha256', 'profileSha256']}}
        self.assertEqual(supervisor.validate_runtime_bootstrap(record, contract, os.getpid())['identity'], identity)
        changes = [{'nonce': 'wrong'}, {'pid': os.getpid()+1}, {'sourceHead': 'changed'}, {'harnessSha256': 'changed'},
                   {'identity': {**identity, 'processBirthMarkerV2': identity['processBirthMarkerV2'] + '1'}},
                   {'settlement': {'sealed': False, 'probes': []}},
                   {'settlement': {'sealed': True, 'probes': [{**record['settlement']['probes'][0], 'stdoutEnded': False}]}}]
        for change in changes:
            with self.assertRaises(RuntimeError): supervisor.validate_runtime_bootstrap({**record, **change}, contract, os.getpid())

    @unittest.skipUnless(os.name == 'nt', 'Requires actual Windows Job accounting')
    def test_bootstrap_job_refuses_extra_live_descendant_before_second_admission(self):
        envelope = supervisor.WindowsEnvelope()
        children = []
        try:
            for _ in range(2):
                children.append(envelope.spawn([supervisor.shutil.which('node'), '-e', 'process.stdin.resume()'],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE))
            with self.assertRaisesRegex(RuntimeError, 'retained descendants'):
                supervisor.require_runtime_only(envelope, children[0].pid)
            children[1].communicate(timeout=5)
            self.assertEqual(supervisor.require_runtime_only(envelope, children[0].pid)['jobActiveProcesses'], 1)
            children[0].communicate(timeout=5)
            self.assertFalse(envelope.settlement()['forcedCleanup'])
        finally:
            envelope.close()
            for child in children:
                child.communicate(timeout=5)

    def test_provider_ready_requires_owned_pid_token_and_canonical_loopback_port(self):
        token = 'a' * 48
        ready = {'pid': 123, 'origin': 'http://127.0.0.1:45678', 'tokenSha256': supervisor.hashlib.sha256(token.encode()).hexdigest()}
        self.assertEqual(supervisor.owned_provider_environment(ready, 123, token),
                         {'FLUJO_569_PROVIDER_PORT': '45678', 'FLUJO_569_PROVIDER_PID': '123'})
        for changed in [{**ready, 'pid': 124}, {**ready, 'tokenSha256': 'wrong'}, {**ready, 'extra': 1}] + [
            {**ready, 'origin': origin} for origin in ['https://127.0.0.1:45678', 'http://localhost:45678',
                'http://u@127.0.0.1:45678', 'http://127.0.0.1:0', 'http://127.0.0.1:65536',
                'http://127.0.0.1:45678/path', 'http://127.0.0.1:45678?q=x', 'http://127.0.0.1:45678#x']]:
            with self.assertRaises(RuntimeError): supervisor.owned_provider_environment(changed, 123, token)

    def test_dependency_preflight_rechecks_each_child_and_rejects_changed_target_or_helper(self):
        expected = {'importBridge': {'entries': {'core': {'sha256': 'initial'}}}}
        initial = {'harnessSha256': 'harness', 'dependencies': expected}
        def result(value):
            return subprocess.CompletedProcess([], 0, json.dumps(value).encode(), b'')
        for changed in [{'harnessSha256': 'changed-helper', 'dependencies': expected},
                        {'harnessSha256': 'harness', 'dependencies': {'importBridge': {'entries': {'core': {'sha256': 'changed'}}}}}]:
            for admission in [0, 1]:
                with patch('envelope_evidence.subprocess.run', side_effect=[result(initial)] * admission + [result(changed)]) as run:
                    for _ in range(admission):
                        self.assertEqual(require_dependency_manifest('node', Path('.'), Path('.'), Path('.'), 'harness', expected), expected)
                    with self.assertRaisesRegex(RuntimeError, 'changed before child admission'):
                        require_dependency_manifest('node', Path('.'), Path('.'), Path('.'), 'harness', expected)
                    self.assertEqual(run.call_count, admission + 1)

    def test_full_duration_os_evidence_fits_without_reducing_guard_polling(self):
        # uint64 maxima exceed real memory, process and FD counters on both platforms.
        maximum = 2 ** 64 - 1
        process = {'rss': maximum, 'peakRss': maximum, 'handles': maximum}
        cgroup = {key: maximum for key in ['memory.current', 'memory.peak', 'pids.current']}
        record = {'elapsedSeconds': 92640.12345678901,
                  **{key: process for key in ['provider', 'runtime', 'supervisor']},
                  'cgroup': {'aggregate': cgroup, 'workload': cgroup}}
        encoded = supervisor.encode_os_sample(record)
        self.assertLessEqual(len(encoded.encode()), supervisor.OS_SAMPLE_MAX_BYTES)
        self.assertLessEqual(92640 + 2, supervisor.OS_SAMPLE_MAX_COUNT)
        projected = supervisor.os_evidence_projection(supervisor.OS_SAMPLE_MAX_BYTES,
            supervisor.OS_SAMPLE_MAX_COUNT, 64 * supervisor.MIB)
        self.assertEqual(projected, 65_600_000)
        with self.assertRaisesRegex(RuntimeError, 'projection'):
            supervisor.os_evidence_projection(741, 92642, 64 * supervisor.MIB)
        with self.assertRaisesRegex(RuntimeError, 'record bound'):
            supervisor.encode_os_sample({**record, 'unexpected': 'x' * 656})

    def test_dataset_path_rejects_drvfs_and_other_phase_before_writing(self):
        expected='/opt/flujo569/qualification/owned/output'
        self.assertEqual(str(validate_dataset_path(expected,'owned')),str(Path(expected)))
        for path in ['/mnt/c/evidence/output','/opt/flujo569/qualification/other/output',
                     '/opt/flujo569/qualification/owned/../owned/output']:
            with self.assertRaisesRegex(RuntimeError,'exact owned ext4'):
                validate_dataset_path(path,'owned')
        with patch('dataset_evidence.inspect_linux_dataset',return_value={'filesystemMagic':'0xef53'}), \
                patch('dataset_evidence.shutil.disk_usage',return_value=type('Space',(),{'free':1})()):
            with self.assertRaisesRegex(RuntimeError,'Guest ext4'):
                guest_disk_admission(expected,'owned',22*supervisor.GIB)

    def test_each_admission_rechecks_executable_instead_of_reusing_first_version(self):
        with patch('envelope_evidence.subprocess.check_output', side_effect=['v22.23.4\n', 'v24.22.1\n']) as check:
            self.assertEqual(require_current_node('owned-node', 'v22.23.4'), 'v22.23.4')
            with self.assertRaisesRegex(RuntimeError, 'Current Node'):
                require_current_node('owned-node', 'v22.23.4')
            self.assertEqual(check.call_count, 2)
    def test_disk_admission_requires_current_guard_measurement_bound_to_nonce_and_plan(self):
        request = {'token': 'a' * 32, 'nonce': 'unique', 'planSha256': 'plan', 'requiredFreeBytes': 22 * supervisor.GIB, 'launcherSha256': 'a' * 64}
        receipt = {'request': request, 'kind': 'windows-physical-volume-v1', 'watcherPid': 123,
                   'currentLauncherSha256': 'a' * 64, 'volume': 'C:\\', 'admitted': True, 'freeBytes': 30 * supervisor.GIB, 'measuredAtMs': 10000}
        lease = {'token': request['token'], 'state': 'running', 'pid': 123, 'time': 10000}
        self.assertEqual(validate_disk_receipt(request, receipt, lease, 11000), receipt)
        for changed in [{**receipt, 'freeBytes': 1}, {**receipt, 'measuredAtMs': 1},
                        {**receipt, 'request': {**request, 'nonce': 'stale'}},
                        {**receipt, 'request': {**request, 'planSha256': 'other'}},
                        {**receipt, 'currentLauncherSha256': 'b' * 64}, {**receipt, 'volume': '/virtual'}, {**receipt, 'admitted': False}]:
            with self.assertRaises(RuntimeError): validate_disk_receipt(request, changed, lease, 11000)
        with self.assertRaises(RuntimeError): validate_disk_receipt(request, receipt, {**lease, 'state': 'stopped'}, 11000)

    def test_cgroup_binding_uses_aggregate_and_rejects_unrelated_membership_or_limits(self):
        with preserved_directory() as directory:
            mount = Path(directory); parent = mount / 'owned'; aggregate = parent / 'phase'; work = aggregate / 'workload'
            work.mkdir(parents=True); (aggregate / 'guardian').mkdir()
            env = {'FLUJO_569_CGROUP': str(aggregate), 'FLUJO_569_CGROUP_PARENT': str(parent),
                   'FLUJO_569_WORKLOAD_CGROUP': str(work)}
            self.assertEqual(cgroup_paths('/owned/phase/workload', env, mount), (aggregate, work, parent))
            with self.assertRaises(RuntimeError): cgroup_paths('/owned/phase/guardian', env, mount)
            with self.assertRaises(RuntimeError): cgroup_paths('/owned/phase/workload', {**env, 'FLUJO_569_CGROUP_PARENT': str(mount)}, mount)
            with self.assertRaises(RuntimeError): cgroup_paths('/owned/phase/workload', {**env, 'FLUJO_569_CGROUP': str(parent)}, mount)
            for name, value in {'memory.max': str(2 * supervisor.GIB), 'cpu.max': '200000 100000',
                                'memory.swap.max': '0', 'memory.oom.group': '1', 'pids.max': '256'}.items():
                (aggregate / name).write_text(value)
            self.assertEqual(cgroup_controls(aggregate)['memoryMax'], 2 * supervisor.GIB)
            (aggregate / 'memory.max').write_text('max')
            with self.assertRaises(RuntimeError): cgroup_controls(aggregate)

    def test_kernel_reclaim_pressure_is_reported_without_inventing_an_oom(self):
        before = 'low 1\nhigh 2\nmax 3\noom 4\noom_kill 5\noom_group_kill 6\n'
        after = 'low 9\nhigh 12\nmax 103\noom 4\noom_kill 5\noom_group_kill 6\n'
        report = supervisor.memory_event_report(before, after)
        self.assertFalse(report['oomObserved'])
        self.assertEqual(report['oomIncreases'], {})
        self.assertEqual(report['reclaimPressure'], {'low': 8, 'high': 10, 'max': 100})
        self.assertEqual(report['before']['oom'], 4)
        self.assertEqual(report['after']['max'], 103)

    def test_each_oom_counter_increase_is_a_failure_signal_even_without_other_changes(self):
        before = 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n'
        for counter in ['oom', 'oom_kill', 'oom_group_kill']:
            with self.subTest(counter=counter):
                report = supervisor.memory_event_report(before, before.replace(counter + ' 0', counter + ' 1'))
                self.assertTrue(report['oomObserved'])
                self.assertEqual(report['oomIncreases'], {counter: 1})

    def test_kernel_counter_reordering_and_optional_group_counter_are_supported(self):
        before = 'low 0\nhigh 0\nmax 1\noom 0\noom_kill 0\n'
        after = 'oom_kill 0\nmax 2\nlow 0\noom 0\nhigh 0\n'
        self.assertFalse(supervisor.memory_event_report(before, after)['oomObserved'])

    def test_invalid_or_reset_kernel_evidence_cannot_pass(self):
        valid = 'low 0\nhigh 0\nmax 1\noom 0\noom_kill 0\n'
        for changed in ['', valid + 'oom 0\n', valid.replace('max 1', 'max -1'),
                        valid.replace('max 1', 'max 0'), valid.replace('oom 0\n', ''), 'x' * (16 * 1024 + 1)]:
            with self.subTest(changed=changed[:64]):
                with self.assertRaises(RuntimeError):
                    supervisor.memory_event_report(valid, changed)

    def test_os_metrics_of_current_process_are_available(self):
        metrics = supervisor.process_metrics(os.getpid())
        self.assertGreater(metrics['rss'], 0)

    @unittest.skipUnless(os.name == 'nt', 'Windows Job Object smoke only')
    def test_windows_job_assigns_a_suspended_child_before_it_runs(self):
        envelope = supervisor.WindowsEnvelope()
        try:
            child = envelope.spawn([sys.executable, '-B', '-c', 'print("job-owned")'],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            out, err = child.communicate(timeout=10)
            self.assertEqual(child.returncode, 0); self.assertEqual(out.strip(), b'job-owned'); self.assertEqual(err, b'')
        finally:
            envelope.close()

    @unittest.skipUnless(os.name == 'nt', 'Windows Job orphan equipment only')
    def test_windows_job_detects_closed_stdio_orphan_before_cleanup(self):
        envelope = supervisor.WindowsEnvelope()
        try:
            code = ('import subprocess,sys; '
                'p=subprocess.Popen([sys.executable,"-B","-c","import time;time.sleep(60)"],'
                'stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);print(p.pid)')
            direct = envelope.spawn([sys.executable, '-B', '-c', code], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            out, err = direct.communicate(timeout=10)
            self.assertEqual(direct.returncode, 0); self.assertEqual(err, b''); self.assertTrue(out.strip().isdigit())
            before = envelope.settlement()
            self.assertGreaterEqual(before['activeProcessesBeforeCleanup'], 1)
            self.assertIsNotNone(supervisor.process_metrics(int(out.strip())))
            self.assertTrue(before['forcedCleanup'])
        finally:
            envelope.close()

    def test_process_exit_and_stream_end_are_independent_receipts(self):
        with preserved_directory() as directory:
            child = supervisor.Child.__new__(supervisor.Child)
            child.name = 'fixture'; child.errors = []; child.ended = {}; child.byte_counts = {}
            child.exit = None; child.process = FakeProcess(); child.threads = []; child.stdin_thread = None
            for stream in ['stdout', 'stderr']:
                thread = threading.Thread(target=child.copy, args=(stream, Path(directory)))
                thread.start(); child.threads.append(thread)
            result = child.settlement()
            self.assertEqual(result['code'], 0)
            self.assertTrue(result['stdoutEnded']); self.assertTrue(result['stderrEnded'])
            self.assertTrue(result['copyThreadsStopped']); self.assertEqual(result['streamErrors'], [])
            self.assertEqual(result['streamBytes'], {'stdout': 4, 'stderr': 4})

    def test_source_contract_receipt_reader_has_a_preallocation_limit(self):
        with preserved_directory() as directory:
            file = Path(directory) / 'receipt.json'
            with file.open('wb') as output:
                output.truncate(supervisor.MIB + 1)
            with self.assertRaisesRegex(RuntimeError, 'exceeds'):
                supervisor.bounded_json(file)


if __name__ == '__main__':
    unittest.main()

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
        self.stdout = io.BytesIO(b'out\n')
        self.stderr = io.BytesIO(b'err\n')

    def wait(self, timeout):
        return 0


class SupervisorTests(unittest.TestCase):
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
            child.exit = None; child.process = FakeProcess(); child.threads = []
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

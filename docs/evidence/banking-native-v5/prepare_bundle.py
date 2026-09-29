"""Project this historical private v5 receipt set; not a new-run packager."""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path

HTTP_CHECK_NAMES = {
    'own_history', 'foreign_GET_history', 'foreign_DELETE_history', 'foreign_POST_/cancel',
    'foreign_GET_/events', 'foreign_continue', 'fresh_assertion', 'replay', 'missing_assertion',
    'customer_admin_escape', 'forged_customer_body', 'forged_metadata', 'operator_graph_escape',
    'expired_history', 'expired_cancel', 'expired_revoke', 'expired_continue', 'forged_job_lease',
    'forged_job_metadata', 'own_completed_events', 'own_completed_cancel', 'revoke',
    'revoked_session_history', 'same_owner_fresh_session', 'revocation_survives_restart',
    'owner_survives_restart', 'delete_own_conversation', 'tombstone_history_denied',
}


def require(condition):
    if not condition:
        raise ValueError('evidence_projection_failed')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--private-input-dir', type=Path, required=True)
    p.add_argument('--export-metadata', type=Path, required=True)
    p.add_argument('--output-dir', type=Path, default=Path(__file__).parent)
    a = p.parse_args()
    sources = {}

    def read(name):
        b = (a.private_input_dir / name).read_bytes()
        sources[name] = hashlib.sha256(b).hexdigest()
        return json.loads(b)

    def write(name, value):
        (a.output_dir / name).write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8', newline='\n')

    phases = []
    for n in (1, 10, 50, 500):
        prefix = f'process-load-v5-{n}'
        proof, audit, lifetime = read(prefix + '-proof.json'), read(prefix + '-audit.json'), read(prefix + '-lifetime.json')
        phase = proof['phases'][0]
        require(phase['passed'] and audit['passed'] and lifetime['passed'] and not phase['errors'] and not audit['errors'])
        counts = {k: audit[k] for k in ['records', 'independent_tool_owner_matches', 'tool_calls',
            'completed_real_model_attempts', 'delivered_matches_actual_tool_results', 'distinct_conversations']}
        require(all(v == n for v in counts.values()))
        read(prefix + '-correlation.json')
        require(sources[prefix + '-correlation.json'] == audit['correlation_sha256'])
        start = (a.private_input_dir / f'native-v5-{n}-start.txt').read_text().strip()
        datetime.fromisoformat(start.replace('Z', '+00:00'))
        phases.append({'submitted': n, 'saved_audit_passed': True, 'counts': counts,
            'started_utc': start, 'response_seconds': {k: phase['full_response_seconds'][k] for k in ['p50', 'p95', 'p99']},
            'elapsed_seconds': phase['elapsed_seconds'], 'completed_requests_per_second': phase['completed_requests_per_second'],
            'source_correlation_sha256': audit['correlation_sha256'],
            'client_completed_after_ingress_expiry': lifetime['compound_successes_observed_complete_after_ingress_expiry'],
            'model_terminal_after_ingress_expiry': audit['server_completed_model_attempts_after_ingress_expiry'],
            'checked_authority_markers_absent': audit['authority_not_persisted_in_audited_states']})
    write('phases.json', phases)
    resource_name = 'process-load-v5-500-resources.jsonl'
    b = (a.private_input_dir / resource_name).read_bytes()
    sources[resource_name] = hashlib.sha256(b).hexdigest()
    samples = [json.loads(x) for x in b.decode().splitlines() if x.strip()]
    resource_origin = datetime.fromisoformat(samples[0]['at'].replace('Z', '+00:00'))
    fields = ['private_native_processes', 'private_native_rss_bytes', 'private_native_anonymous_bytes',
        'max_private_native_anonymous_bytes', 'worker_cgroup_memory_bytes']
    public_samples = []
    for s in samples:
        require(all(type(s[k]) is int and s[k] >= 0 for k in fields))
        public_samples.append({'elapsed_seconds': (datetime.fromisoformat(s['at'].replace('Z', '+00:00')) - resource_origin).total_seconds(),
            **{k: s[k] for k in fields}})
    (a.output_dir / 'resources-500.ndjson').write_text(''.join(json.dumps(s, separators=(',', ':')) + '\n' for s in public_samples), encoding='utf-8', newline='\n')
    security, lifecycle = read('normal-route-security-v5-proof.json'), read('normal-lifecycle-v5-proof.json')
    def http_checks(items):
        require(all(x['name'] in HTTP_CHECK_NAMES and type(x['status']) is int for x in items))
        return [{k: x[k] for k in ['name', 'status']} for x in items]
    privacy = read('process-load-v5-500-failed-states-proof.json')
    revocation = read('mcp-revocation-v5-proof.json')
    policy = read('runtime-policy-v5-receipt.json')
    roles = {'/run': 'runtime_parent', '/run/banking-runtime': 'protected_policy_directory',
        '/run/banking-runtime/policy.json': 'protected_policy_file'}
    permissions = []
    for item in policy['permissions']:
        require(item['path'] in roles)
        permissions.append({'role': roles[item['path']], **{k: item[k] for k in ['uid', 'gid', 'mode', 'symlink', 'writable']}})
    write('checks.json', {'scope': 'saved post-burst HTTP/completed-conversation lifecycle and privacy receipts',
        'http': http_checks(security['checks']), 'lifecycle_before_restart': http_checks(lifecycle['before_checks']),
        'lifecycle_after_restart': http_checks(lifecycle['after_checks']),
        'revocation_and_owner_durable': lifecycle['revocation_and_owner_durable'], 'tombstone_enforced': lifecycle['tombstone_enforced'],
        'mcp': {k: revocation[k] for k in ['mcp_authenticated_session_matches', 'owned_capabilities_created', 'mcp_revocation_durable', 'read_only_diagnostic']},
        'privacy': {k: privacy[k] for k in ['persisted_owner_states', 'states_audited', 'tool_results_audited', 'authority_leaks',
            'foreign_result_states', 'missing_ownership_markers', 'remaining_private_cli_homes', 'passed']},
        'policy': {'sha256': policy['policy_sha256'], 'exact_staging_bytes': policy['exact_staging_bytes'],
            'service_uid': policy['service_uid'], 'effective_capabilities': policy['effective_capabilities'], 'permissions': permissions}})
    export = json.loads(a.export_metadata.read_text())
    require(export['source_correlation_sha256'] == phases[-1]['source_correlation_sha256'])
    require(export['policy_sha256'] == policy['policy_sha256'])
    require(export['source_correlation_sha256'] == 'a75592e2f487c5dc4528b1c3b7c7c4890b3eb8b94cd1be8f3ab9c0c04fbd41d6')
    require(export['policy_sha256'] == 'a30e69338666e2605cefa7385c7c5d55cf3464314c6bd336b8f2566d1ca646af')
    require(export['expected_graph_sha256'] == 'cbf51fa327e97526cdd74364fbab6df18ef2623dd75ba85922d401655fcb8fbb')
    for name in ['process-load-audit.mjs', 'process-load-private.py', 'run-native-phases-private.py', 'banking-resource-loop.mjs']:
        sources[name] = hashlib.sha256((a.private_input_dir / name).read_bytes()).hexdigest()
    public_files = {f.name: {'sha256': hashlib.sha256(f.read_bytes()).hexdigest(), 'bytes': f.stat().st_size}
        for f in sorted(a.output_dir.iterdir()) if f.is_file() and f.name != 'manifest.json'}
    write('manifest.json', {'schema': 'banking-native-evidence/v1', 'scope': 'operator-captured single-worker native burst; not CI execution',
        'fresh_store_export_utc': export['captured_at'], 'request_relative_time_origin_utc': export['relative_time_origin_utc'],
        'resource_relative_time_origin_utc': resource_origin.isoformat(),
        'provenance': {'deployed_flujo_revision': '153a039185b1d303fb0853f1d4935980388a1903',
            'source_ci_revision': '0afeaf0b4168eb775eab2974b43f2b74872da8f2',
            'production_src_tree': '0d89cb75a201e5a233036885c10317eda9f5c2d4',
            'worker_image_sha256': 'f99c1998c60a69ea6572685b77ef80a74cb4834486b0fcd2455ff6dc7c9be2b8',
            'graph_sha256': export['expected_graph_sha256'], 'policy_sha256': policy['policy_sha256'],
            'cli_version': '0.157.1', 'cli_sha256': '3e2584f3f3829a43a0495011a1cecb2facbe64a2403e2b682351fd9c2983f970',
            'catalog_sha256': '5a1ddcef609e52bd057b247d9487f2c8c4d9453d3d802745ba5325c2e10700e0',
            'model': 'existing gpt-6-sol subscription model', 'bank_transport': 'stdio inside the existing worker',
            'gold_snapshot': '20260928T235012Z-ad5cf4', 'ownership_valid_transaction_rows': 4425008},
        'configured_limits': {'active_jobs': 128, 'queued_jobs': 512, 'queue_seconds': 300, 'active_seconds': 110,
            'total_seconds': 410, 'request_jwt_seconds': 120, 'client_timeout_seconds': 450},
        'observations': {'request_records': 500, 'resource_samples': len(samples),
            'native_process_peak': max(s['private_native_processes'] for s in samples),
            'worker_memory_peak_bytes': max(s['worker_cgroup_memory_bytes'] for s in samples)},
        'original_private_input_sha256': sources, 'public_files': public_files})
    print('Sanitized phases, samples, checks and digest manifest prepared.')


if __name__ == '__main__':
    try:
        main()
    except (KeyError, OSError, ValueError, TypeError):
        raise SystemExit('evidence_projection_failed')

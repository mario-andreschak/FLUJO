"""Verify public evidence hashes and consistency, offline; does not call a model."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re


def require(condition, check):
    if not condition:
        raise ValueError(check)


def number(value, check, nonnegative=False):
    require(type(value) in (int, float) and math.isfinite(value), check)
    require(not nonnegative or value >= 0, check)
    return value


def label(value, kind):
    require(isinstance(value, str) and re.fullmatch(kind + r'-[0-9]{4,}', value), 'opaque_label')
    return value


def references(values):
    require(isinstance(values, list) and bool(values), 'references_present')
    result = {label(v, 'reference') for v in values}
    require(len(result) == len(values), 'references_unique')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', nargs='?', type=Path, default=Path(__file__).parent)
    directory = parser.parse_args().directory

    def read(name):
        return json.loads((directory / name).read_text(encoding='utf-8'))

    def ndjson(name):
        return [json.loads(line) for line in (directory / name).read_text(encoding='utf-8').splitlines() if line.strip()]

    manifest = read('manifest.json')
    require(manifest['schema'] == 'banking-native-evidence/v1', 'manifest_schema')
    files = manifest['public_files']
    expected_files = {'.gitattributes', 'README.md', 'replay.md', 'audit_private_runtime.mjs', 'capture_native.py',
        'export_runtime.mjs', 'prepare_bundle.py', 'sample_resources.mjs', 'verify.py',
        'checks.json', 'phases.json', 'requests-500.ndjson', 'resources-500.ndjson'}
    require(set(files) == expected_files, 'file_inventory')
    require({f.name for f in directory.iterdir()} == expected_files | {'manifest.json'}, 'directory_inventory')
    for name, receipt in files.items():
        path = directory / name
        require(path.is_file() and not path.is_symlink(), 'regular_file')
        content = path.read_bytes()
        require(len(content) == receipt['bytes'], 'file_size')
        require(hashlib.sha256(content).hexdigest() == receipt['sha256'], 'file_sha256')

    phases, checks = read('phases.json'), read('checks.json')
    rows, resources = ndjson('requests-500.ndjson'), ndjson('resources-500.ndjson')
    require([p['submitted'] for p in phases] == [1, 10, 50, 500], 'phase_ladder')
    for phase in phases:
        n = phase['submitted']
        require(phase['saved_audit_passed'] is True and phase['checked_authority_markers_absent'] is True, 'saved_phase_audit')
        require(all(type(v) is int and v == n for v in phase['counts'].values()), 'saved_phase_counts')
        require(phase['source_correlation_sha256'] == manifest['original_private_input_sha256'][f'process-load-v5-{n}-correlation.json'], 'phase_source_hash')
        require(number(phase['elapsed_seconds'], 'phase_elapsed', True) > 0, 'phase_elapsed')

    require(len(rows) == 500 and {r['request'] for r in rows} == set(range(1, 501)), 'request_count')
    for field, kind in [('expected_owner', 'owner'), ('request_conversation', 'conversation'),
            ('session', 'session'), ('logical_run', 'run')]:
        require(len({label(r[field], kind) for r in rows}) == 500, 'distinct_' + field)

    tools = 0
    calls = set()
    reference_owners = {}
    client_after_expiry = model_after_expiry = 0
    durations = []
    for row in rows:
        require(row['expected_owner'] == row['stored_owner'], 'owner_join')
        require(row['request_conversation'] == row['stored_conversation'] == row['run_conversation'], 'conversation_join')
        require(row['logical_run'] == row['run_event'], 'run_join')
        require(label(row['expected_flow'], 'flow') == row['stored_flow'], 'flow_join')
        require(row['graph_sha256'] == manifest['provenance']['graph_sha256'], 'graph_join')
        require(row['completed_state'] is True and row['ownership_marker'] is True
            and row['checked_authority_markers_absent'] is True, 'state_checks')
        model = row['model']
        require(label(model['id'], 'model') == row['configured_model'] and model['outcome'] == 'completed', 'model_join')
        require(type(model['input_tokens']) is int and model['input_tokens'] > 0
            and type(model['output_tokens']) is int and model['output_tokens'] > 0, 'model_usage')
        require(isinstance(row['tools'], list) and len(row['tools']) == 1, 'actual_tool_count')
        result_refs = set()
        for tool in row['tools']:
            call = label(tool['call'], 'tool-call')
            require(call == tool['result_call'] and call not in calls, 'tool_call_join')
            calls.add(call)
            require(tool['tool'] == 'Banking_MCP__list_my_transactions' and tool['success'] is True
                and tool['synthetic'] is False and tool['operator_test'] is False, 'approved_actual_tool')
            result_refs.update(references(tool['references']))
            tools += 1
        require(result_refs == references(row['successful_tool_references']), 'tool_reference_union')
        for reference in references(row['oracle_references']):
            owner = reference_owners.setdefault(reference, row['expected_owner'])
            require(owner == row['expected_owner'], 'reference_owner_exclusivity')
        require(references(row['delivered_references']) == references(row['persisted_reply_references'])
            and references(row['delivered_references']) <= result_refs <= references(row['oracle_references']), 'owner_oracle_and_delivery')
        durations.append(number(row['full_response_seconds'], 'response_duration', True))
        timing = row['timing']
        iat = number(timing['assertion_iat_seconds'], 'assertion_iat')
        exp = number(timing['assertion_exp_seconds'], 'assertion_exp')
        header = number(timing['header_created_seconds'], 'header_created', True)
        session_exp = number(timing['session_exp_seconds'], 'session_exp')
        completed = number(timing['client_completed_seconds'], 'client_completed', True)
        terminal = number(model['terminal_seconds'], 'model_terminal', True)
        require(type(timing['assertions']) is int and timing['assertions'] == 1, 'single_assertion')
        require(0 < exp - iat <= manifest['configured_limits']['request_jwt_seconds'], 'jwt_lifetime')
        require(iat <= header < exp and header <= completed < session_exp
            and iat <= terminal < session_exp, 'assertion_and_session_timing')
        client_after_expiry += completed > exp
        model_after_expiry += terminal > exp
    require(tools == 500, 'approved_tool_total')
    phase = phases[-1]
    durations.sort()
    for name, percentile in [('p50', .5), ('p95', .95), ('p99', .99)]:
        value = durations[math.ceil(len(durations) * percentile) - 1]
        require(abs(value - phase['response_seconds'][name]) < 0.000001, 'response_' + name)
    require(client_after_expiry == phase['client_completed_after_ingress_expiry'] == 293, 'client_after_ingress_expiry')
    require(model_after_expiry == phase['model_terminal_after_ingress_expiry'] == 293, 'model_after_ingress_expiry')

    require(len(resources) == manifest['observations']['resource_samples'] == 510, 'resource_count')
    elapsed = -1
    for sample in resources:
        current = number(sample['elapsed_seconds'], 'resource_elapsed', True)
        require(current > elapsed, 'resource_order')
        elapsed = current
        for field in ['private_native_processes', 'private_native_rss_bytes', 'private_native_anonymous_bytes',
                'max_private_native_anonymous_bytes', 'worker_cgroup_memory_bytes']:
            require(type(sample[field]) is int and sample[field] >= 0, 'resource_integer')
    peak = max(s['private_native_processes'] for s in resources)
    memory = max(s['worker_cgroup_memory_bytes'] for s in resources)
    require(peak == manifest['observations']['native_process_peak'] == 88, 'native_process_peak')
    require(memory == manifest['observations']['worker_memory_peak_bytes'] == 4798410752, 'worker_memory_peak')

    expected_http = {'own_history': 200, 'foreign_GET_history': 404, 'foreign_DELETE_history': 404,
        'foreign_POST_/cancel': 404, 'foreign_GET_/events': 404, 'foreign_continue': 404,
        'fresh_assertion': 200, 'replay': 401, 'missing_assertion': 401, 'customer_admin_escape': 403,
        'forged_customer_body': 400, 'forged_metadata': 400, 'operator_graph_escape': 403,
        'expired_history': 401, 'expired_cancel': 401, 'expired_revoke': 401, 'expired_continue': 401,
        'forged_job_lease': 400, 'forged_job_metadata': 400}
    expected_before = {'own_completed_events': 200, 'own_completed_cancel': 200, 'revoke': 200,
        'revoked_session_history': 401, 'same_owner_fresh_session': 200}
    expected_after = {'revocation_survives_restart': 401, 'owner_survives_restart': 200,
        'delete_own_conversation': 204, 'tombstone_history_denied': 404}
    for field, expected in [('http', expected_http), ('lifecycle_before_restart', expected_before),
            ('lifecycle_after_restart', expected_after)]:
        actual = checks[field]
        require(len(actual) == len(expected) and {x['name']: x['status'] for x in actual} == expected, 'saved_' + field)
    require(checks['revocation_and_owner_durable'] is True and checks['tombstone_enforced'] is True, 'saved_durability')
    require(checks['mcp'] == {'mcp_authenticated_session_matches': True, 'owned_capabilities_created': 2,
        'mcp_revocation_durable': True, 'read_only_diagnostic': True}, 'saved_mcp_revocation')
    require(checks['privacy'] == {'persisted_owner_states': 500, 'states_audited': 500, 'tool_results_audited': 500,
        'authority_leaks': 0, 'foreign_result_states': 0, 'missing_ownership_markers': 0,
        'remaining_private_cli_homes': 0, 'passed': True}, 'saved_privacy')
    policy = checks['policy']
    require(policy['sha256'] == manifest['provenance']['policy_sha256'] and policy['exact_staging_bytes'] is True
        and policy['service_uid'] == 1000 and policy['effective_capabilities'] == '0000000000000000', 'saved_policy')
    require(policy['permissions'] == [
        {'role': 'runtime_parent', 'uid': 0, 'gid': 0, 'mode': '755', 'symlink': False, 'writable': False},
        {'role': 'protected_policy_directory', 'uid': 0, 'gid': 1000, 'mode': '750', 'symlink': False, 'writable': False},
        {'role': 'protected_policy_file', 'uid': 0, 'gid': 1000, 'mode': '440', 'symlink': False, 'writable': False}], 'saved_policy_permissions')
    print(json.dumps({'scope': 'offline public-file integrity and consistency; no native execution',
        'passed': True, 'requests': len(rows), 'approved_tool_results': tools, 'distinct_owners': 500,
        'response_seconds': phase['response_seconds'], 'resource_samples': len(resources),
        'observed_native_process_peak': peak, 'worker_memory_peak_bytes': memory,
        'client_completions_after_ingress_expiry': client_after_expiry,
        'model_terminals_after_ingress_expiry': model_after_expiry}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (KeyError, OSError, TypeError, ValueError) as error:
        raise SystemExit('Evidence verification failed: ' + (str(error) if isinstance(error, ValueError) else type(error).__name__))

"""Capture a new explicitly requested native run; raw output MUST stay private.

Delegates actual HTTP work to the committed banking_acceptance_load.py client.
This is a parameterized copy of the correlation wrapper used for the v5 run.
It does not supply fake model responses and never stores JWTs/signatures.
"""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import sys
import threading
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runner', type=Path, required=True)
    parser.add_argument('--private-correlation', type=Path, required=True)
    parser.add_argument('--allow-model-requests', action='store_true')
    args, remaining = parser.parse_known_args()
    if not args.allow_model_requests:
        parser.error('Real model requests require --allow-model-requests.')
    if not args.runner.is_file() or args.private_correlation.exists():
        parser.error('Runner must exist and private output must not already exist.')
    # Exclusively reserve a local private file before any request is submitted.
    fd = os.open(args.private_correlation, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    spec = importlib.util.spec_from_file_location('banking_acceptance_load', args.runner.resolve())
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    original = module.one
    original_audit = module.audit_response
    original_headers = module.request_headers
    records, lock, local = [], threading.Lock(), threading.local()

    def timed_headers(config, case, signing_key):
        headers = original_headers(config, case, signing_key)
        payload = headers['X-Flujo-User-Assertion'].split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        local.assertions.append({'iat': claims['iat'], 'exp': claims['exp'], 'created_at': time.time()})
        return headers

    def audit_delivered(case, body, oracle_scope='structured-tool'):
        conversation = original_audit(case, body, oracle_scope)
        choices = body.get('choices', [])
        answer = choices[0].get('message', {}).get('content', '') if choices else ''
        local.delivered_references = sorted(set(module.VISIBLE_REFERENCE.findall(answer) if isinstance(answer, str) else []))
        return conversation

    def correlated(config, case, signing_key, barrier, timeout):
        local.delivered_references, local.assertions = [], []
        sample = original(config, case, signing_key, barrier, timeout)
        completed_at = time.time()
        with lock:
            records.append({'subject': case['subject'], 'session_id': case['session_id'],
                'session_exp': case['session_exp'], 'phase': barrier.parties,
                'allowed_references': case['allowed_references'], 'ok': sample.ok, 'code': sample.code,
                'conversation': sample.conversation, 'request_assertions': local.assertions,
                'completed_at': completed_at, 'full_response_seconds': sample.seconds,
                'delivered_references': local.delivered_references})
        return sample

    module.request_headers, module.audit_response, module.one = timed_headers, audit_delivered, correlated
    sys.argv = [str(args.runner), *remaining]
    try:
        return module.main()
    finally:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as output:
            json.dump(records, output, indent=2)
            output.write('\n')


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, ImportError):
        print('native_capture_failed', file=sys.stderr)
        sys.exit(1)

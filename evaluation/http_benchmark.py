"""Isolated Flask route timing with real local inference and temporary SQLite.

This exercises session lookup, CSRF, planning reads, inference, revalidation and
JSON responses. It is not a real network, browser or concurrent-load benchmark.
"""
import json
from pathlib import Path
import tempfile
import time
from unittest.mock import patch

from sqlalchemy import insert, select

from app.planning.interpreter import validate_constraints
from evaluation.metrics import quantile
from app import create_app
from app.shared.storage import group_member_preferences, identifier, metadata


class NoPayments:
    """Any financial provider access makes this evaluation fail immediately."""
    configured = False
    client_id = ''
    merchant_id = ''

    def __getattr__(self, name):
        raise AssertionError('Financial provider access is forbidden in this benchmark.')


def _snapshot(store):
    with store.engine.connect() as connection:
        return {table.name: [dict(row) for row in connection.execute(select(table)).mappings()]
                for table in metadata.sorted_tables}


def run_http_benchmark(encoder, group_fixtures, repeats=5):
    """Return route measurements on synthetic fixtures, without app-state access.

    The caller supplies an encoder with already-prepared local assets. Its prior
    loaded state is reported: a reused encoder cannot establish cold-start cost.
    One complete fixture pass warms the route before repeated measurements.
    """
    if type(repeats) is not int or not 1 <= repeats <= 20:
        raise ValueError('Use between one and twenty repeated route passes.')
    groups = group_fixtures.get('groups', [])
    if not groups or any(not 2 <= len(group.get('members', [])) <= 4 for group in groups):
        raise ValueError('Provide nonempty synthetic groups with two to four members.')
    initial_status = encoder.status()
    if not initial_status.get('available'):
        raise ValueError('Prepare the local model before timing the HTTP route.')
    with tempfile.TemporaryDirectory(prefix='grouppay-http-evaluation-') as directory:
        # Explicit config selects only this temporary database. These guards also
        # catch future accidental dotenv loading or network access in the route.
        with patch('app.config.load_env', side_effect=AssertionError('Dotenv access is forbidden during evaluation.')), \
             patch('urllib.request.urlopen', side_effect=AssertionError('Network access is forbidden during evaluation.')):
            app = create_app(dict(DATABASE_URL='sqlite:///' + (Path(directory) / 'evaluation.db').as_posix(),
                APP_ENV='development', APP_ORIGIN='http://localhost', COOKIE_SECURE=False, TESTING=True,
                RECEIPT_VISION_PROVIDER='local_qwen', OLLAMA_API_KEY='', OLLAMA_VISION_MODEL=''),
                paypal=NoPayments(), encoder=encoder)
            store = app.extensions['store']
            try:
                client = app.test_client()
                response = client.get('/api/config')
                if response.status_code != 200:
                    raise AssertionError('Could not create an isolated benchmark session.')
                config = response.get_json()
                headers = {'Origin': 'http://localhost', 'X-CSRF-Token': config['csrfToken']}
                cases = []
                for case in groups:
                    group = app.extensions['groups'].create(config['participantID'], case['id'])
                    invite = group['inviteURL'].split('invite=')[1]
                    members = [config['participantID']]
                    for _ in case['members'][1:]:
                        participant, _ = store.new_participant()
                        app.extensions['groups'].join(participant['id'], invite)
                        members.append(participant['id'])
                    with store.engine.begin() as connection:
                        for participant_id, member in zip(members, case['members']):
                            constraints = validate_constraints(dict(budget_cents=100000,
                                timezone='UTC', soft_preferences=member['tastes']))
                            encoded = json.dumps(constraints, separators=(',', ':'))
                            connection.execute(insert(group_member_preferences).values(id=identifier(),
                                group_id=group['id'], participant_id=participant_id,
                                raw_text='Synthetic benchmark preferences', interpreted_json=encoded,
                                confirmed_constraints_json=encoded, is_confirmed=1, updated_at=time.time()))
                    cases.append(dict(id=case['id'], group_id=group['id'], domain=case['domain'],
                                      expected=set(case['candidateIDs'])))
                before = _snapshot(store)

                def request(case, pass_index):
                    started = time.perf_counter()
                    response = client.post(f'/api/groups/{case["group_id"]}/recommendations',
                                           json={'domain': case['domain']}, headers=headers)
                    payload = response.get_json()
                    elapsed = (time.perf_counter() - started) * 1000
                    if response.status_code != 200 or not isinstance(payload, dict):
                        raise AssertionError('The recommendation benchmark route did not succeed.')
                    ranking = payload.get('recommendation', {})
                    if ranking.get('mode') != 'semantic' or ranking.get('inferenceExecuted') is not True:
                        raise AssertionError('The recommendation benchmark did not execute real semantic ranking.')
                    ids = [offer['id'] for offer in payload['matches']]
                    if len(ids) != len(set(ids)) or set(ids) != case['expected']:
                        raise AssertionError('The benchmark returned an unexpected or missing catalog candidate.')
                    if (ranking.get('eligibleCount') != len(ids)
                            or ranking.get('catalogDocumentCount') != len(ids)
                            or not ranking.get('tasteTextCount')
                            or ranking.get('appliedOrder') != ids):
                        raise AssertionError('The route did not expose internally consistent inference evidence.')
                    serialized = json.dumps(payload)
                    if any(key in serialized for key in ('preferenceScore', 'similarities', 'embeddings', 'memberScores')):
                        raise AssertionError('The recommendation response exposed private score details.')
                    return dict(passIndex=pass_index, caseID=case['id'], elapsedMs=elapsed,
                                serverElapsedMs=ranking['elapsedMs'], mode=ranking['mode'],
                                objective=ranking['objective'], decision=ranking['decision'],
                                inferenceExecuted=ranking['inferenceExecuted'],
                                inferenceMs=ranking['inferenceMs'],
                                eligibleCount=ranking['eligibleCount'],
                                catalogDocumentCount=ranking['catalogDocumentCount'],
                                tasteTextCount=ranking['tasteTextCount'],
                                rulesOrder=ranking['rulesOrder'], appliedOrder=ranking['appliedOrder'],
                                appliedOrderChanged=ranking['appliedOrderChanged'],
                                semanticChangedRulesOrder=ranking['semanticChangedRulesOrder'],
                                firstListedID=ids[0])

                warmup = [request(case, -1) for case in cases]
                raw = [request(case, pass_index) for pass_index in range(repeats) for case in cases]
                if before != _snapshot(store):
                    raise AssertionError('Recommendation requests changed the isolated benchmark database.')
                samples = [row['elapsedMs'] for row in raw]
                return dict(scope='In-process Flask test client with session, CSRF, temporary SQLite, '
                                  'real local inference and JSON parsing; excludes network transport, browser, '
                                  'asset download and concurrent load.',
                            encoderLoadedBeforeFirstRequest=initial_status.get('loaded'),
                            firstRequest=warmup[0], warmupRequests=len(warmup), repeats=repeats,
                            databaseUnchanged=True, providerCalls=0,
                            latency=dict(n=len(samples), p50Ms=quantile(samples, .5),
                                         p95Ms=quantile(samples, .95), maxMs=max(samples),
                                         quantile='linear R-7', queryVectorCache=False), raw=raw)
            finally:
                store.engine.dispose()

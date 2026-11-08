"""Group ranking remains private, read-only and subordinate to verified constraints.

Encoder vectors below are fixtures, not real-model quality or latency evidence.
"""
import json
import math
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import event, select, update

from app.planning.interpreter import AIError
from app.recommendations.service import Recommendations, regret_order
from app.recommendations.semantic import SemanticUnavailable
from app import create_app
from app.shared.storage import (catalog_offers, catalog_resources, group_member_preferences,
                     group_memberships, metadata)
from test_workshop_slice import FakePayPal


class RegretOrderTests(unittest.TestCase):
    def test_balanced_compromise_beats_majority_average(self):
        # Mean scores favor majority (.70 versus .65), but minority regret is .55.
        matrix = [[1.0, .65], [1.0, .65], [.10, .65]]
        self.assertEqual(regret_order(matrix, ['majority', 'balanced'])[0], 'balanced')

    def test_member_order_does_not_create_organizer_priority(self):
        matrix = [[.9, .6, .5], [.4, .8, .3], [.7, .7, .8]]
        ids = ['a', 'b', 'c']
        self.assertEqual(regret_order(matrix, ids), regret_order(list(reversed(matrix)), ids))

    def test_pareto_dominator_precedes_dominated_offer(self):
        ids = ['dominated', 'dominator', 'alternative']
        matrix = [[.1, .3, .8], [.4, .5, .2], [-.4, -.2, .1]]
        ranked = regret_order(matrix, ids)
        self.assertLess(ranked.index('dominator'), ranked.index('dominated'))

    def test_negative_scores_remain_valid_and_single_offer_is_stable(self):
        self.assertEqual(regret_order([[-.9, -.2], [-.4, -.1]], ['a', 'b']), ['b', 'a'])
        self.assertEqual(regret_order([[-.9], [.2]], ['only']), ['only'])

    def test_nonfinite_and_wrong_shape_scores_are_rejected(self):
        for matrix in ([[math.nan, .2]], [[math.inf, .2]], [[.2]], [[.2, .3], [.4]], [['.2', .3]]):
            with self.subTest(matrix=matrix), self.assertRaises((ValueError, TypeError)):
                regret_order(matrix, ['a', 'b'])


class FixtureEncoder:
    """Normalized two-dimensional vectors isolate coordinator behavior."""
    def __init__(self, callback=None, available=True, vectors=None, error=None):
        self.callback, self.available = callback, available
        self.vectors, self.error = vectors, error
        self.inputs, self.catalog_inputs = [], []

    def status(self):
        return dict(available=self.available, model='fixture-encoder', revision='fixture-revision')

    def catalog(self, offers):
        self.catalog_inputs.append(offers)
        return [[1., 0.] if index % 2 == 0 else [0., 1.] for index, _ in enumerate(offers)]

    def encode(self, texts):
        self.inputs.append(list(texts))
        if self.callback:
            callback, self.callback = self.callback, None
            callback()
        if self.error:
            raise self.error
        if self.vectors is not None:
            return self.vectors
        return [[1., 0.] if 'space' in text else [0., 1.] for text in texts]


class RecommendationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'GEMINI_API_KEY': ''}); self.env.start()
        self.fake = FakePayPal()
        self.app = create_app(dict(DATABASE_URL='sqlite:///' + (Path(self.directory.name) / 'ranking.db').as_posix(),
            APP_ENV='development', APP_ORIGIN='http://localhost', COOKIE_SECURE=False, TESTING=True), paypal=self.fake)
        self.store = self.app.extensions['store']
        self.groups = self.app.extensions['groups']
        self.planning = self.app.extensions['booking'].planning
        self.owner, _ = self.store.new_participant(); self.member, _ = self.store.new_participant()
        self.outsider, _ = self.store.new_participant()
        group = self.groups.create(self.owner['id'], 'A fair plan'); self.gid = group['id']
        self.invite = group['inviteURL'].split('invite=')[1]
        self.groups.join(self.member['id'], self.invite)
        self.confirm(self.owner, ['space adventure'])
        self.confirm(self.member, ['private-member-taste'])

    def tearDown(self):
        self.store.engine.dispose(); self.directory.cleanup(); self.env.stop()

    def confirm(self, participant, tastes, **constraints):
        self.planning.submit_preference(participant['id'], self.gid, 'Private original wording', 'UTC')
        values = dict(budget_cents=10000, soft_preferences=tastes)
        values.update(constraints)
        self.planning.confirm_preference(participant['id'], self.gid, values)

    def snapshot(self):
        with self.store.engine.connect() as connection:
            return {table.name: [dict(row) for row in connection.execute(select(table)).mappings()]
                    for table in metadata.sorted_tables}

    def recommend(self, encoder=None, **kwargs):
        return Recommendations(self.store, encoder or FixtureEncoder()).recommend(self.owner['id'], self.gid, **kwargs)

    def assert_stale(self, mutation):
        encoder = FixtureEncoder(callback=mutation)
        with self.assertRaises(AIError) as error:
            self.recommend(encoder)
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(len(encoder.inputs), 1)

    def test_private_read_only_recommendation_without_provider_or_inference_network(self):
        before = self.snapshot()
        encoder = FixtureEncoder()
        with patch('urllib.request.urlopen') as network:
            result = self.recommend(encoder)
        network.assert_not_called()
        self.assertEqual(result['recommendation']['mode'], 'semantic')
        self.assertEqual(result['recommendation']['descriptiveMemberCount'], 2)
        self.assertFalse(result['recommendation']['availabilityReserved'])
        self.assertEqual(before, self.snapshot())
        self.assertEqual(self.fake.create_calls, 0)
        serialized = json.dumps(result)
        for private in ('private-member-taste', 'Private original wording', self.member['id'], self.outsider['id']):
            self.assertNotIn(private, serialized)
        self.assertNotIn('preferenceScore', serialized)
        self.assertNotIn('similarities', serialized)
        self.assertNotIn('embeddings', serialized)
        self.assertTrue(all('description' in offer for offer in encoder.catalog_inputs[0]))

    def test_model_runs_without_a_checked_out_database_connection(self):
        active = [0]
        def checkout(*_): active[0] += 1
        def checkin(*_): active[0] -= 1
        event.listen(self.store.engine, 'checkout', checkout)
        event.listen(self.store.engine, 'checkin', checkin)
        try:
            encoder = FixtureEncoder(callback=lambda: self.assertEqual(active[0], 0))
            self.assertEqual(self.recommend(encoder)['recommendation']['mode'], 'semantic')
        finally:
            event.remove(self.store.engine, 'checkout', checkout)
            event.remove(self.store.engine, 'checkin', checkin)

    def test_hard_budget_and_capacity_are_filtered_before_embedding(self):
        self.confirm(self.owner, ['space adventure'], budget_cents=1200)
        encoder = FixtureEncoder()
        result = self.recommend(encoder)
        self.assertEqual([offer['id'] for offer in result['matches']], ['movie-silent-echoes-sun'])
        self.assertEqual(result['recommendation']['eligibleCount'], 1)
        self.assertFalse(result['recommendation']['inferenceExecuted'])
        self.assertFalse(encoder.inputs)  # One verified choice needs no semantic comparison.
        with self.store.engine.begin() as connection:
            connection.execute(update(catalog_resources).where(
                catalog_resources.c.offer_id == 'movie-silent-echoes-sun').values(state='HELD'))
        result = self.recommend(encoder)
        self.assertEqual(result['matches'], [])
        self.assertEqual(result['recommendation']['mode'], 'no_matches')
        self.assertFalse(encoder.inputs)

    def test_timezone_and_exact_local_date_remain_authoritative(self):
        from datetime import datetime
        from zoneinfo import ZoneInfo
        with self.store.engine.connect() as connection:
            start = connection.execute(select(catalog_offers.c.schedule_time).where(
                catalog_offers.c.id == 'movie-cosmic-odyssey-fri')).scalar()
        local = datetime.fromisoformat(start).astimezone(ZoneInfo('Asia/Kolkata'))
        self.confirm(self.owner, ['space adventure'], timezone='Asia/Kolkata',
            dates=[local.date().isoformat()], time_window={'earliest': '00:00', 'latest': '01:30'})
        encoder = FixtureEncoder()
        result = self.recommend(encoder)
        self.assertEqual([offer['id'] for offer in result['matches']], ['movie-cosmic-odyssey-fri'])
        self.assertEqual(result['recommendation']['mode'], 'single_option')
        self.assertFalse(encoder.inputs)

    def test_free_but_nonadjacent_resources_do_not_become_ai_candidates(self):
        with self.store.engine.begin() as connection:
            connection.execute(update(catalog_resources).where(
                catalog_resources.c.offer_id.like('movie-%'),
                catalog_resources.c.col_number % 2 == 0).values(state='HELD'))
        encoder = FixtureEncoder()
        result = self.recommend(encoder)
        self.assertFalse(result['matches'])
        self.assertEqual(result['recommendation']['mode'], 'no_matches')
        self.assertFalse(encoder.inputs)
        for option in result['blockedOptions']:
            self.assertFalse(option['capacityAvailable'])
            self.assertEqual(option['ownConflicts'], [])
            self.assertFalse(option['otherConstraintsBlock'])

    def test_three_member_excursion_budget_uses_real_remainder_owner_share(self):
        self.groups.join(self.outsider['id'], self.invite)
        self.confirm(self.outsider, ['scenic river'])
        self.confirm(self.owner, ['space adventure'], budget_cents=3333)
        encoder = FixtureEncoder()
        result = self.recommend(encoder, domain='excursion')
        self.assertFalse(result['matches'])
        self.assertFalse(encoder.inputs)
        self.confirm(self.owner, ['space adventure'], budget_cents=3334)
        result = self.recommend(encoder, domain='excursion')
        self.assertEqual(len(result['matches']), 1)
        self.assertEqual(result['matches'][0]['shareCents'], [3334, 3333, 3333])
        self.assertEqual(sum(result['matches'][0]['shareCents']), 10000)

    def test_no_matches_explains_exact_costs_and_private_blockers_without_inference_or_writes(self):
        self.confirm(self.owner, ['space adventure'], budget_cents=2000)
        self.confirm(self.member, ['private-member-taste'], budget_cents=1739)
        encoder, before = FixtureEncoder(), self.snapshot()
        result = self.recommend(encoder, domain='excursion')
        self.assertEqual(result['recommendation']['mode'], 'no_matches')
        self.assertIn('No plan fits yet', result['explanation'])
        self.assertEqual([p['ownShareValue'] for p in result['blockedOptions']], ['50.00', '60.00'])
        for option in result['blockedOptions']:
            self.assertEqual([c['type'] for c in option['ownConflicts']], ['BUDGET_EXCEEDED'])
            self.assertTrue(option['capacityAvailable'])
            self.assertTrue(option['otherConstraintsBlock'])
        for private in ('1739', '17.39', 'private-member-taste', self.member['id'], 'confirmedConstraints'):
            self.assertNotIn(private, json.dumps(result))
        self.assertFalse(encoder.inputs)
        self.assertEqual(before, self.snapshot())

    def test_own_only_blocker_can_be_explicitly_resolved_and_compared(self):
        self.confirm(self.owner, ['scenic river'], budget_cents=2000)
        result = self.recommend(domain='excursion')
        self.assertTrue(all(not p['otherConstraintsBlock'] for p in result['blockedOptions']))
        self.confirm(self.owner, ['scenic river'], budget_cents=6000)
        result = self.recommend(domain='excursion')
        self.assertEqual(result['recommendation']['mode'], 'semantic')
        self.assertEqual(len(result['matches']), 2)
        self.assertEqual(result['blockedOptions'], [])

    def test_peer_only_blocker_is_not_presented_as_an_own_budget_problem(self):
        self.groups.join(self.outsider['id'], self.invite)
        self.confirm(self.outsider, ['scenic river'])
        self.confirm(self.owner, ['space adventure'], budget_cents=3333)
        recommender = Recommendations(self.store, FixtureEncoder())
        result = recommender.recommend(self.member['id'], self.gid, 'excursion')
        kayak = next(p for p in result['blockedOptions'] if p['offerID'] == 'excursion-kayak-canyon-sat')
        self.assertEqual(kayak['ownShareCents'], 3333)
        self.assertEqual(kayak['ownConflicts'], [])
        self.assertTrue(kayak['otherConstraintsBlock'])
        self.assertNotIn('3334', json.dumps(kayak))

    def test_diagnostics_include_all_own_schedule_failures_in_confirmed_timezone(self):
        self.confirm(self.owner, ['space adventure'], budget_cents=1, timezone='Asia/Kolkata',
            preferred_days=['monday'], dates=['2035-01-01'], time_window={'earliest': '17:00'})
        result = self.recommend()
        cosmic = next(p for p in result['blockedOptions'] if p['offerID'] == 'movie-cosmic-odyssey-fri')
        self.assertEqual({c['type'] for c in cosmic['ownConflicts']},
            {'BUDGET_EXCEEDED', 'SCHEDULE_DATE_MISMATCH', 'SCHEDULE_DAY_MISMATCH', 'SCHEDULE_TIME_EARLY'})
        self.assertEqual(cosmic['timezone'], 'Asia/Kolkata')
        self.assertIn('T01:00:00+05:30', cosmic['localSchedule'])
        self.assertFalse(cosmic['otherConstraintsBlock'])
        ordinary = self.planning.get_group_plan(self.owner['id'], self.gid, 'movie')
        self.assertEqual(ordinary['blockedOptions'], result['blockedOptions'])

    def test_no_future_catalog_is_explained_separately_from_budget_and_inventory(self):
        with self.store.engine.begin() as connection:
            connection.execute(update(catalog_offers).values(schedule_time='2000-01-01T12:00:00+00:00'))
        encoder = FixtureEncoder()
        result = self.recommend(encoder)
        self.assertEqual(result['blockedOptions'], [])
        self.assertIn('No upcoming experiences', result['explanation'])
        self.assertFalse(encoder.inputs)

    def test_empty_and_duplicate_tastes_have_explicit_coverage(self):
        self.confirm(self.owner, ['Space Adventure', 'space adventure', '  SPACE ADVENTURE  '])
        self.confirm(self.member, [])
        encoder = FixtureEncoder()
        result = self.recommend(encoder)
        self.assertEqual(encoder.inputs, [['space adventure']])
        self.assertEqual(result['recommendation']['descriptiveMemberCount'], 1)
        self.assertEqual(result['recommendation']['memberCount'], 2)
        self.confirm(self.owner, [])
        blank = FixtureEncoder()
        result = self.recommend(blank)
        self.assertEqual(result['recommendation']['mode'], 'needs_tastes')
        self.assertTrue(result['matches'])
        self.assertFalse(blank.inputs)

    def test_negative_requirement_is_clarified_before_model_inference(self):
        self.confirm(self.member, ['not horror'])
        encoder = FixtureEncoder()
        result = self.recommend(encoder)
        self.assertEqual(result['recommendation']['mode'], 'needs_clarification')
        self.assertFalse(result['matches'])
        self.assertFalse(encoder.inputs)
        self.assertNotIn('not horror', json.dumps(result))

    def test_missing_model_and_invalid_vectors_are_honest_fallbacks(self):
        for encoder in (FixtureEncoder(available=False), FixtureEncoder(error=SemanticUnavailable('fixture failure')),
                        FixtureEncoder(vectors=[[math.nan, 0.], [0., 1.]]),
                        FixtureEncoder(vectors=[[0., 0.], [0., 1.]]),
                        FixtureEncoder(vectors=[[1.], [0., 1.]]), FixtureEncoder(vectors=[[1., 0.]])):
            with self.subTest(encoder=encoder):
                before = self.snapshot()
                result = self.recommend(encoder)
                self.assertEqual(result['recommendation']['mode'], 'unavailable')
                self.assertTrue(result['matches'])
                self.assertNotIn('preferenceScore', json.dumps(result))
                self.assertEqual(before, self.snapshot())

    def test_membership_domain_and_confirmation_boundaries(self):
        with self.assertRaises(AIError) as error:
            Recommendations(self.store, FixtureEncoder()).recommend(self.outsider['id'], self.gid)
        self.assertEqual(error.exception.status, 404)
        with self.assertRaises(AIError):
            self.recommend(domain='invented')
        self.planning.submit_preference(self.member['id'], self.gid, 'Unconfirmed new draft')
        encoder = FixtureEncoder()
        result = self.recommend(encoder)
        self.assertEqual(result['recommendation']['mode'], 'needs_confirmation')
        self.assertFalse(result['matches'])
        self.assertFalse(encoder.inputs)

    def test_invalid_ranking_objective_is_rejected_before_inference(self):
        encoder = FixtureEncoder()
        for objective in ('maximize_spending', '', None, 7, ['average']):
            with self.subTest(objective=objective), self.assertRaises(AIError) as error:
                self.recommend(encoder, objective=objective)
            self.assertEqual(error.exception.status, 400)
        self.assertFalse(encoder.inputs)

    def test_compare_preserves_schedule_order_and_exposes_only_aggregate_lenses(self):
        with self.store.engine.connect() as connection:
            expected = [offer['id'] for offer in sorted(self.planning._offers(connection, 'movie'),
                key=lambda offer: (offer['scheduleTime'], offer['id']))]
        result = self.recommend(objective='compare')
        ranking = result['recommendation']
        self.assertEqual(ranking['objective'], 'compare')
        self.assertEqual([offer['id'] for offer in result['matches']], expected)
        self.assertEqual(set(ranking['views']), {'compromise', 'average'})
        for lens in ranking['views'].values():
            self.assertEqual(set(lens), set(expected))
            self.assertEqual(len(lens), len(expected))
        self.assertNotIn(self.member['id'], json.dumps(result))
        self.assertNotIn('private-member-taste', json.dumps(result))
        self.assertNotIn('preferenceScore', json.dumps(result))

    def test_explicit_objectives_can_select_different_aggregate_orders(self):
        self.confirm(self.member, ['space buddy'])
        self.groups.join(self.outsider['id'], self.invite)
        self.confirm(self.outsider, ['different descriptive taste'])
        class DifferentLensesEncoder(FixtureEncoder):
            def catalog(self, offers):
                return [[1., 0.], [.28, .96], [-1., 0.]]
        compromise = self.recommend(DifferentLensesEncoder(), objective='compromise')
        average = self.recommend(DifferentLensesEncoder(), objective='average')
        default = self.recommend(DifferentLensesEncoder())
        compromise_ids = [offer['id'] for offer in compromise['matches']]
        average_ids = [offer['id'] for offer in average['matches']]
        self.assertNotEqual(compromise_ids[0], average_ids[0])
        self.assertEqual(compromise_ids, compromise['recommendation']['views']['compromise'])
        self.assertEqual(average_ids, average['recommendation']['views']['average'])
        self.assertEqual(compromise['recommendation']['decision'], 'tradeoff_to_discuss')
        self.assertEqual(compromise['recommendation']['objective'], 'compromise')
        self.assertEqual(average['recommendation']['objective'], 'average')
        self.assertEqual(default['recommendation']['objective'], 'compromise')
        self.assertEqual([offer['id'] for offer in default['matches']], compromise_ids)
        evidence = compromise['recommendation']
        self.assertTrue(evidence['inferenceExecuted'])
        self.assertTrue(evidence['appliedOrderChanged'])
        self.assertTrue(evidence['semanticChangedRulesOrder'])
        self.assertEqual(evidence['catalogDocumentCount'], 3)
        self.assertEqual(evidence['tasteTextCount'], 3)
        self.assertEqual(evidence['appliedOrder'], compromise_ids)
        self.assertNotEqual(evidence['rulesOrder'], compromise_ids)

    def test_partial_taste_coverage_is_explicit_and_never_declares_satisfaction(self):
        self.confirm(self.member, [])
        result = self.recommend()
        self.assertEqual(result['recommendation']['descriptiveMemberCount'], 1)
        self.assertEqual(result['recommendation']['memberCount'], 2)
        self.assertIn('1 of 2 members supplied tastes', result['explanation'])
        self.assertIn('not an agreement or satisfaction score', result['explanation'])
        self.assertNotIn('every member is satisfied', result['explanation'])
        self.assertNotIn('private-member-taste', json.dumps(result))

    def test_preference_edit_during_inference_is_stale(self):
        self.assert_stale(lambda: self.planning.confirm_preference(self.member['id'], self.gid,
            {'budget_cents': 1200, 'soft_preferences': ['different taste']}))

    def test_resource_change_during_inference_is_stale(self):
        def mutate():
            with self.store.engine.begin() as connection:
                connection.execute(update(catalog_resources).where(
                    catalog_resources.c.id == 'res-movie-cosmic-odyssey-fri-A1').values(state='HELD'))
        self.assert_stale(mutate)

    def test_catalog_document_change_during_inference_is_stale(self):
        def mutate():
            with self.store.engine.begin() as connection:
                connection.execute(update(catalog_offers).where(
                    catalog_offers.c.id == 'movie-cosmic-odyssey-fri').values(description='Changed trusted description'))
        self.assert_stale(mutate)

    def test_roster_join_during_inference_is_stale(self):
        self.assert_stale(lambda: self.groups.join(self.outsider['id'], self.invite))

    def test_roster_order_change_during_inference_is_stale(self):
        def mutate():
            with self.store.engine.begin() as connection:
                connection.execute(update(group_memberships).where(
                    group_memberships.c.group_id == self.gid,
                    group_memberships.c.participant_id == self.member['id']).values(joined_at=0))
        self.assert_stale(mutate)

    def test_reservation_during_inference_rejects_recommendation(self):
        self.assert_stale(lambda: self.app.extensions['booking'].freeze(self.owner['id'], self.gid,
            'movie-cosmic-odyssey-fri', ['res-movie-cosmic-odyssey-fri-A1', 'res-movie-cosmic-odyssey-fri-A2']))

    def test_time_advancing_past_schedule_invalidates_result_without_data_change(self):
        from datetime import datetime, timezone
        before = self.snapshot()
        clock = patch('app.planning.service.datetime', wraps=datetime)
        def advance_time():
            mocked = clock.start()
            self.addCleanup(clock.stop)
            mocked.now.return_value = datetime(2099, 1, 1, tzinfo=timezone.utc)
        self.assert_stale(advance_time)
        self.assertEqual(before, self.snapshot())

    def test_inference_failure_after_concurrent_edit_must_not_label_old_matches_verified(self):
        encoder = FixtureEncoder(error=SemanticUnavailable('fixture model failure'), callback=lambda:
            self.planning.confirm_preference(self.member['id'], self.gid, {'budget_cents': 1}))
        with self.assertRaises(AIError) as error:
            self.recommend(encoder)
        self.assertEqual(error.exception.status, 409)

    def test_http_membership_csrf_and_identity_cannot_be_overridden_in_body(self):
        client = self.app.test_client()
        self.assertEqual(client.post(f'/api/groups/{self.gid}/recommendations', json={}).status_code, 401)
        config = client.get('/api/config').json
        group = self.groups.create(config['participantID'], 'One real member')
        endpoint = f'/api/groups/{group["id"]}/recommendations'
        self.assertEqual(client.post(endpoint, json={}).status_code, 403)
        headers = {'Origin': 'http://localhost', 'X-CSRF-Token': config['csrfToken']}
        result = client.post(endpoint, json={'participantID': self.owner['id'], 'groupID': self.gid}, headers=headers)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json['recommendation']['mode'], 'needs_members')
        self.assertEqual(result.json['memberCount'], 1)
        self.assertEqual(client.post(f'/api/groups/{self.gid}/recommendations', json={}, headers=headers).status_code, 404)
        self.assertEqual(client.post(endpoint, json={'domain': 'invented'}, headers=headers).status_code, 400)
        self.assertEqual(client.post(endpoint, json={'objective': 'maximize_spending'}, headers=headers).status_code, 400)

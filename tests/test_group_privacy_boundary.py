"""Every private group route hides existence and content from other browser identities."""
import json
import tempfile
import unittest
from pathlib import Path

from app import create_app
from test_workshop_slice import FakePayPal


class GroupPrivacyBoundaryTests(unittest.TestCase):
    POST_BODIES = {
        'groups.rescue_plan': {'domain': 'movie'},
        'groups.recommend_group': {'domain': 'movie', 'objective': 'compromise'},
        'groups.send_room_message': {'text': 'outsider probe'},
        'groups.contextual_group_chat': {'prompt': 'What should we do next?'},
        'groups.select_group_workshop': {'workshopID': 'web-basics'},
        'groups.set_group_profile': {'alias': 'Probe', 'shareProgress': False},
        'groups.get_group_quote': {'offerID': 'movie-cosmic-odyssey-fri', 'resourceIDs': []},
        'groups.freeze_group': {'offerID': 'movie-cosmic-odyssey-fri', 'resourceIDs': [
            'res-movie-cosmic-odyssey-fri-A1', 'res-movie-cosmic-odyssey-fri-A2']},
        'groups.freeze_merchant_checkout': {},
        'groups.give_group_consent': {},
        'groups.submit_group_preference': {'rawText': 'A quiet character-driven story', 'userTz': 'UTC'},
        'groups.confirm_group_preference': {'confirmedConstraints': {'budget_cents': 5000}},
        'groups.initiate_group_contribution_order': {},
        'groups.authorize_group_contribution': {},
        'groups.reconcile_group_contribution': {},
        'groups.void_group_booking': {},
        'groups.finalize_group_booking': {},
        'groups.recover_group_booking': {},
        'groups.check_group_ticket': {'ticketCode': 'private-ticket-code'},
    }

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.app = create_app(dict(
            DATABASE_URL='sqlite:///' + (Path(self.directory.name) / 'privacy.db').as_posix(),
            APP_ORIGIN='http://localhost', COOKIE_SECURE=False, APP_ENV='development', TESTING=True,
        ), paypal=FakePayPal())
        self.owner = self.app.test_client()
        self.outsider = self.app.test_client()
        self.anonymous = self.app.test_client()
        self.owner_config = self.owner.get('/api/config').json
        self.outsider_config = self.outsider.get('/api/config').json
        created = self._post(self.owner, self.owner_config, '/api/groups', {'name': 'Private planning vault'})
        self.group = created.json
        self.group_id = self.group['id']
        self.missing_id = '0' * len(self.group_id)
        self._post(self.owner, self.owner_config, f'/api/groups/{self.group_id}/profile', {
            'alias': 'Private Alice', 'shareProgress': False})
        self._post(self.owner, self.owner_config, f'/api/groups/{self.group_id}/preferences', {
            'rawText': 'Secret preference phrase under $17', 'userTz': 'UTC'})
        self._post(self.owner, self.owner_config, f'/api/groups/{self.group_id}/messages', {
            'text': 'Confidential group message'})

    def tearDown(self):
        self.app.extensions['store'].engine.dispose()
        self.directory.cleanup()

    @staticmethod
    def _post(client, config, path, body):
        return client.post(path, json=body, headers={
            'Origin': 'http://localhost', 'X-CSRF-Token': config['csrfToken']})

    def _call(self, client, rule, method, group_id, config=None):
        path = rule.rule.replace('<group_id>', group_id)
        if method == 'GET':
            return client.get(path)
        self.assertIn(rule.endpoint, self.POST_BODIES, f'Add a valid privacy probe for {rule.endpoint}')
        headers = {'Origin': 'http://localhost'}
        if config:
            headers['X-CSRF-Token'] = config['csrfToken']
        return client.post(path, json=self.POST_BODIES[rule.endpoint], headers=headers)

    def private_routes(self):
        for rule in self.app.url_map.iter_rules():
            if rule.rule.startswith('/api/groups/<group_id>'):
                for method in sorted(rule.methods.intersection({'GET', 'POST'})):
                    yield rule, method

    def test_outsider_cannot_enumerate_or_read_any_private_group_route(self):
        tested = []
        for rule, method in self.private_routes():
            existing = self._call(self.outsider, rule, method, self.group_id, self.outsider_config)
            missing = self._call(self.outsider, rule, method, self.missing_id, self.outsider_config)
            self.assertEqual(existing.status_code, 404, (rule.endpoint, existing.get_data(as_text=True)))
            self.assertEqual(existing.get_json(), {'error': 'GROUP_NOT_FOUND'}, rule.endpoint)
            self.assertEqual(existing.status_code, missing.status_code, rule.endpoint)
            self.assertEqual(existing.get_data(), missing.get_data(), rule.endpoint)
            self.assertEqual(existing.headers['Cache-Control'], 'no-store')
            tested.append((rule.endpoint, method))
        self.assertGreaterEqual(len(tested), 25)
        serialized = json.dumps([self._call(
            self.outsider, rule, method, self.group_id, self.outsider_config).get_json()
            for rule, method in self.private_routes()])
        for private in ('Private planning vault', 'Private Alice', 'Secret preference phrase',
                        'Confidential group message', self.group['inviteURL'], self.owner_config['participantID']):
            self.assertNotIn(private, serialized)

    def test_missing_browser_identity_is_rejected_before_every_private_group_route(self):
        tested = []
        for rule, method in self.private_routes():
            response = self._call(self.anonymous, rule, method, self.group_id)
            self.assertEqual(response.status_code, 401, rule.endpoint)
            self.assertEqual(response.get_json(), {'error': 'PARTICIPANT_SESSION_REQUIRED'}, rule.endpoint)
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            tested.append((rule.endpoint, method))
        self.assertGreaterEqual(len(tested), 25)


if __name__ == '__main__':
    unittest.main()

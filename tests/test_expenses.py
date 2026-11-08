"""HTTP-level tests for the informal expense-split feature: never PayPal-authoritative."""
import base64
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import create_app
from app.expenses.ocr import ReceiptScanError, ReceiptScanner
from test_workshop_slice import FakePayPal


class ExpensesTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.config = dict(DATABASE_URL='sqlite:///' + (Path(self.directory.name) / 'test.db').as_posix(),
                           APP_ORIGIN='http://localhost', COOKIE_SECURE=False, APP_ENV='development', TESTING=True,
                           RECEIPT_VISION_PROVIDER='local_qwen', OLLAMA_API_KEY='', OLLAMA_VISION_MODEL='')
        self.app = create_app(self.config, paypal=FakePayPal())
        self.owner = self.app.test_client()
        self.member = self.app.test_client()
        self.outsider = self.app.test_client()
        self.csrf = {client: client.get('/api/config').json['csrfToken']
                     for client in (self.owner, self.member, self.outsider)}

    def tearDown(self):
        self.app.extensions['store'].engine.dispose()
        self.directory.cleanup()

    def post(self, client, path, body):
        return client.post(path, json=body, headers={'Origin': 'http://localhost',
            'X-CSRF-Token': self.csrf[client]})

    def group(self):
        created = self.post(self.owner, '/api/groups', {'name': 'Trip crew'})
        self.assertEqual(created.status_code, 200)
        token = created.json['inviteURL'].split('invite=', 1)[1]
        self.post(self.member, '/api/groups/join', {'inviteToken': token})
        return created.json['id']

    def create_split(self, client, **overrides):
        body = dict(title='Dinner', category='food', currency='USD',
                    shares=[{'name': 'You', 'amountMinor': 2000, 'isPayer': True},
                            {'name': 'Dana', 'amountMinor': 1000, 'isPayer': False}])
        body.update(overrides)
        return self.post(client, '/api/expenses/splits', body)

    # ------------------------------------------------------------- profile
    def test_profile_defaults_then_saves(self):
        empty = self.owner.get('/api/expenses/profile').json['profile']
        self.assertEqual(empty, {'displayName': '', 'upiID': ''})
        saved = self.post(self.owner, '/api/expenses/profile', {'displayName': 'Asha', 'upiID': 'asha@upi'})
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json['profile'], {'displayName': 'Asha', 'upiID': 'asha@upi'})
        self.assertEqual(self.owner.get('/api/expenses/profile').json['profile']['displayName'], 'Asha')

    # ------------------------------------------------------------- friends
    def test_friend_lifecycle_and_duplicate_rejection(self):
        added = self.post(self.owner, '/api/expenses/friends', {'name': 'Dana', 'upiID': 'dana@upi'})
        self.assertEqual(added.status_code, 200)
        self.assertEqual(len(added.json['friends']), 1)
        duplicate = self.post(self.owner, '/api/expenses/friends', {'name': 'Dana'})
        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual(duplicate.json['error'], 'FRIEND_NAME_ALREADY_USED')
        friend_id = added.json['friends'][0]['id']
        removed = self.post(self.owner, f'/api/expenses/friends/{friend_id}/delete', {})
        self.assertEqual(removed.json['friends'], [])
        missing = self.post(self.owner, f'/api/expenses/friends/{friend_id}/delete', {})
        self.assertEqual(missing.status_code, 404)

    def test_friends_are_private_per_owner(self):
        self.post(self.owner, '/api/expenses/friends', {'name': 'Dana'})
        self.assertEqual(self.member.get('/api/expenses/friends').json['friends'], [])

    def test_new_split_links_selected_friend_by_owned_id_and_keeps_contact_snapshot(self):
        friend = self.post(self.owner, '/api/expenses/friends', {
            'name': 'Dana', 'upiID': 'dana@upi', 'whatsapp': '+91 98765 43210'}).json['friends'][0]
        split = self.create_split(self.owner, shares=[
            {'name': 'You', 'amountMinor': 2000, 'isPayer': True},
            {'name': 'Dana', 'amountMinor': 2000, 'isPayer': False, 'friendID': friend['id']}]).json['split']
        share = next(item for item in split['shares'] if not item['isPayer'])
        self.assertEqual((share['friendID'], share['whatsapp'], share['upiID']),
                         (friend['id'], friend['whatsapp'], friend['upiID']))
        self.post(self.owner, f"/api/expenses/friends/{friend['id']}/delete", {})
        saved = self.owner.get('/api/expenses/splits').json['splits'][0]
        self.assertEqual(next(item for item in saved['shares'] if not item['isPayer'])['whatsapp'],
                         '+91 98765 43210')

    def test_friend_reference_cannot_cross_owner_or_change_name(self):
        friend = self.post(self.member, '/api/expenses/friends', {'name': 'Dana'}).json['friends'][0]
        for name, friend_id in [('Dana', friend['id']), ('Fake', friend['id'])]:
            denied = self.create_split(self.owner, shares=[
                {'name': 'You', 'amountMinor': 100, 'isPayer': True},
                {'name': name, 'amountMinor': 100, 'isPayer': False, 'friendID': friend_id}])
            self.assertEqual(denied.status_code, 400)
            self.assertEqual(denied.json['error'], 'FRIEND_REFERENCE_MISMATCH')
        own = self.post(self.owner, '/api/expenses/friends', {'name': 'Dana'}).json['friends'][0]
        denied = self.create_split(self.owner, shares=[
            {'name': 'You', 'amountMinor': 100, 'isPayer': True},
            {'name': 'Not Dana', 'amountMinor': 100, 'isPayer': False, 'friendID': own['id']}])
        self.assertEqual(denied.json['error'], 'FRIEND_REFERENCE_MISMATCH')
        self.assertEqual(self.owner.get('/api/expenses/splits').json['splits'], [])

    def test_duplicate_or_payer_friend_reference_is_rejected(self):
        friend = self.post(self.owner, '/api/expenses/friends', {'name': 'Dana'}).json['friends'][0]
        duplicate = self.create_split(self.owner, shares=[
            {'name': 'You', 'amountMinor': 100, 'isPayer': True},
            {'name': 'Dana', 'amountMinor': 100, 'isPayer': False, 'friendID': friend['id']},
            {'name': 'D. Other', 'amountMinor': 100, 'isPayer': False, 'friendID': friend['id']}])
        self.assertEqual(duplicate.json['error'], 'DUPLICATE_FRIEND_REFERENCE')
        payer = self.create_split(self.owner, shares=[
            {'name': 'You', 'amountMinor': 100, 'isPayer': True, 'friendID': friend['id']},
            {'name': 'Dana', 'amountMinor': 100, 'isPayer': False}])
        self.assertEqual(payer.json['error'], 'INVALID_FRIEND_REFERENCE')

    def test_manual_receiving_handles_are_saved_without_payment_authority(self):
        result = self.create_split(self.owner, payee={
            'hostName': 'Asha', 'upiID': 'asha@upi', 'paypalEmail': 'asha@example.test'})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json['split']['payee'], {
            'hostName': 'Asha', 'upiID': 'asha@upi', 'paypalEmail': 'asha@example.test'})
        self.assertEqual(self.member.get('/api/expenses/splits').json['splits'], [])
        invalid = self.create_split(self.owner, payee={'paypalEmail': 'not-an-address'})
        self.assertEqual(invalid.json['error'], 'INVALID_PAYPAL_EMAIL')

    # ------------------------------------------------------------- splits
    def test_create_split_requires_exactly_one_payer_and_unique_names(self):
        zero_payers = self.create_split(self.owner, shares=[
            {'name': 'You', 'amountMinor': 1000, 'isPayer': False},
            {'name': 'Dana', 'amountMinor': 1000, 'isPayer': False}])
        self.assertEqual(zero_payers.status_code, 400)
        self.assertEqual(zero_payers.json['error'], 'EXACTLY_ONE_PAYER_REQUIRED')

        two_payers = self.create_split(self.owner, shares=[
            {'name': 'You', 'amountMinor': 1000, 'isPayer': True},
            {'name': 'Dana', 'amountMinor': 1000, 'isPayer': True}])
        self.assertEqual(two_payers.status_code, 400)
        self.assertEqual(two_payers.json['error'], 'EXACTLY_ONE_PAYER_REQUIRED')

        duplicate_names = self.create_split(self.owner, shares=[
            {'name': 'You', 'amountMinor': 1000, 'isPayer': True},
            {'name': 'you', 'amountMinor': 1000, 'isPayer': False}])
        self.assertEqual(duplicate_names.status_code, 400)
        self.assertEqual(duplicate_names.json['error'], 'DUPLICATE_SHARE_NAME')

    def test_create_split_persists_exact_total_and_payer_share_is_auto_settled(self):
        result = self.create_split(self.owner)
        self.assertEqual(result.status_code, 200)
        split = result.json['split']
        self.assertEqual(split['totalMinor'], 3000)
        self.assertEqual(split['pendingMinor'], 1000)
        self.assertFalse(split['allSettled'])
        payer_share = next(s for s in split['shares'] if s['isPayer'])
        self.assertTrue(payer_share['settled'])

    def test_split_requires_group_membership(self):
        gid = self.group()
        denied = self.create_split(self.outsider, groupID=gid)
        self.assertEqual(denied.status_code, 404)
        self.assertEqual(denied.json['error'], 'GROUP_NOT_FOUND')
        allowed = self.create_split(self.member, groupID=gid)
        self.assertEqual(allowed.status_code, 200)

    def test_list_splits_filters_by_group(self):
        gid = self.group()
        self.create_split(self.owner, title='Individual dinner')
        self.create_split(self.owner, title='Group dinner', groupID=gid)
        everything = self.owner.get('/api/expenses/splits').json['splits']
        self.assertEqual(len(everything), 2)
        individual_only = self.owner.get('/api/expenses/splits?group=none').json['splits']
        self.assertEqual([s['title'] for s in individual_only], ['Individual dinner'])
        group_only = self.owner.get(f'/api/expenses/splits?group={gid}').json['splits']
        self.assertEqual([s['title'] for s in group_only], ['Group dinner'])

    def test_splits_are_private_to_their_owner(self):
        self.create_split(self.owner)
        self.assertEqual(self.member.get('/api/expenses/splits').json['splits'], [])

    def test_settle_share_rejects_payer_toggle_and_requires_ownership(self):
        split = self.create_split(self.owner).json['split']
        non_payer_share = next(s for s in split['shares'] if not s['isPayer'])
        payer_share = next(s for s in split['shares'] if s['isPayer'])

        payer_toggle = self.post(self.owner, f"/api/expenses/splits/{split['id']}/settle",
                                 {'shareID': payer_share['id'], 'settled': False})
        self.assertEqual(payer_toggle.status_code, 409)
        self.assertEqual(payer_toggle.json['error'], 'PAYER_SHARE_ALWAYS_SETTLED')

        outsider_attempt = self.post(self.outsider, f"/api/expenses/splits/{split['id']}/settle",
                                     {'shareID': non_payer_share['id'], 'settled': True})
        self.assertEqual(outsider_attempt.status_code, 404)

        settled = self.post(self.owner, f"/api/expenses/splits/{split['id']}/settle",
                            {'shareID': non_payer_share['id'], 'settled': True})
        self.assertEqual(settled.status_code, 200)
        self.assertTrue(settled.json['split']['allSettled'])
        self.assertEqual(settled.json['split']['pendingMinor'], 0)

    # ------------------------------------------------------------- groups summary
    def test_groups_summary_includes_individual_bucket(self):
        gid = self.group()
        self.create_split(self.owner, groupID=gid)
        self.create_split(self.owner)
        summary = {g['id']: g['splitCount'] for g in self.owner.get('/api/expenses/groups').json['groups']}
        self.assertEqual(summary[gid], 1)
        self.assertEqual(summary[None], 1)

    # ------------------------------------------------------------- subscriptions
    def test_subscription_lifecycle_and_validation(self):
        bad_day = self.post(self.owner, '/api/expenses/subscriptions',
                            {'name': 'Streaming', 'monthlyAmountMinor': 999, 'billingDay': 31, 'participants': []})
        self.assertEqual(bad_day.status_code, 400)
        self.assertEqual(bad_day.json['error'], 'INVALID_BILLING_DAY')

        created = self.post(self.owner, '/api/expenses/subscriptions', {
            'name': 'Streaming', 'monthlyAmountMinor': 1599, 'billingDay': 5,
            'participants': [{'name': 'Dana', 'whatsapp': '+1-555'}]})
        self.assertEqual(created.status_code, 200)
        sub = created.json['subscriptions'][0]
        self.assertEqual(sub['monthlyAmountMinor'], 1599)
        self.assertEqual(sub['participants'][0]['name'], 'Dana')

        removed = self.post(self.owner, f"/api/expenses/subscriptions/{sub['id']}/delete", {})
        self.assertEqual(removed.json['subscriptions'], [])

    def test_subscription_host_and_upi_survive_reload_and_are_private(self):
        saved = self.post(self.owner, '/api/expenses/subscriptions', {
            'name': 'Netflix', 'monthlyAmountMinor': 1599, 'billingDay': 12,
            'hostName': 'Asha', 'upiID': 'asha@upi',
            'participants': [{'name': 'Dana', 'whatsapp': '+919876543210'}]})
        self.assertEqual(saved.status_code, 200)
        sub = self.owner.get('/api/expenses/subscriptions').json['subscriptions'][0]
        self.assertEqual((sub['hostName'], sub['upiID'], sub['participants'][0]['whatsapp']),
                         ('Asha', 'asha@upi', '+919876543210'))
        self.assertEqual(self.member.get('/api/expenses/subscriptions').json['subscriptions'], [])

    def test_revision_seven_to_eight_preserves_existing_contact_and_ledger_rows(self):
        from sqlalchemy import insert, select
        from app.shared.storage import (Store, expense_friends, expense_shares, expense_splits,
                                        expense_share_contacts, versions)
        old = Store('sqlite:///' + (Path(self.directory.name) / 'old-revision.db').as_posix())
        try:
            old.migrate(target=7)
            participant, _ = old.new_participant()
            with old.engine.begin() as connection:
                connection.execute(insert(expense_friends).values(
                    id='old-friend', owner_id=participant['id'], name='Dana', upi_id='dana@upi',
                    whatsapp='1234567890', created_at=1))
                connection.execute(insert(expense_splits).values(
                    id='old-split', owner_id=participant['id'], group_id=None, title='Prior bill',
                    category='food', total_minor=2000, currency='USD', source='manual',
                    receipt_meta_json='{}', created_at=1))
                connection.execute(insert(expense_shares).values(
                    id='old-share', split_id='old-split', name='Dana', amount_minor=2000,
                    is_payer=0, settled=0, settled_at=None))
            old.migrate(target=8)
            old.migrate(target=8)
            with old.engine.connect() as connection:
                self.assertEqual(connection.execute(select(versions.c.revision)).scalar_one(), 8)
                self.assertEqual(connection.execute(select(expense_friends.c.name)).scalar_one(), 'Dana')
                self.assertEqual(connection.execute(select(expense_splits.c.total_minor)).scalar_one(), 2000)
                self.assertEqual(connection.execute(select(expense_shares.c.name)).scalar_one(), 'Dana')
                self.assertEqual(connection.execute(select(expense_share_contacts)).all(), [])
        finally:
            old.engine.dispose()

    def test_expense_only_local_revision_seven_gains_merchant_columns_and_snapshots(self):
        from sqlalchemy import inspect, select
        from app.shared.storage import (Store, expense_friends, expense_profiles, expense_shares,
                                        expense_splits, expense_subscription_participants,
                                        expense_subscriptions, expense_share_contacts, versions)
        old = Store('sqlite:///' + (Path(self.directory.name) / 'local-seven.db').as_posix())
        try:
            old.migrate(target=5)
            with old.engine.begin() as connection:
                for table in (expense_profiles, expense_friends, expense_splits, expense_shares,
                              expense_subscriptions, expense_subscription_participants):
                    table.create(connection, checkfirst=True)
                connection.execute(versions.update().where(versions.c.id == 1).values(revision=7))
            old.migrate(target=8)
            with old.engine.connect() as connection:
                self.assertEqual(connection.execute(select(versions.c.revision)).scalar_one(), 8)
                columns = {column['name'] for column in inspect(connection).get_columns('workshop_groups')}
                self.assertTrue({'checkout_mode', 'target_member_count', 'merchant_offer_id'} <= columns)
                self.assertEqual(connection.execute(select(expense_share_contacts)).all(), [])
        finally:
            old.engine.dispose()

    # ------------------------------------------------------------- analytics
    def test_analytics_aggregates_by_category_and_month(self):
        self.create_split(self.owner, title='Dinner', category='food')
        self.create_split(self.owner, title='Cab', category='travel',
                          shares=[{'name': 'You', 'amountMinor': 500, 'isPayer': True}])
        analytics = self.owner.get('/api/expenses/analytics').json['analytics']
        self.assertEqual(analytics['totalMinor'], 3500)
        self.assertEqual(analytics['splitCount'], 2)
        self.assertEqual(analytics['byCategory']['food'], 3000)
        self.assertEqual(analytics['byCategory']['travel'], 500)
        self.assertEqual(sum(analytics['byMonth'].values()), 3500)

    # ------------------------------------------------------------- receipt scan
    def test_scan_requires_an_image_file(self):
        response = self.owner.post('/api/expenses/scan-receipt', headers={
            'Origin': 'http://localhost', 'X-CSRF-Token': self.csrf[self.owner]})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json['error'], 'RECEIPT_IMAGE_REQUIRED')

    def test_scan_success_returns_unsaved_editable_preview(self):
        fake_body = json.dumps({
            'merchant': 'Luigi\u2019s', 'date': '2024-01-05', 'currency': 'usd', 'total': 42.5,
            'category': 'food', 'items': [{'name': 'Pizza', 'amount': 42.5}]})

        with patch('app.expenses.ocr.ReceiptScanner._infer', return_value=fake_body):
            response = self.owner.post('/api/expenses/scan-receipt',
                data={'receipt': (io.BytesIO(b'\xff\xd8\xfffake-bytes'), 'receipt.jpg', 'image/jpeg')},
                content_type='multipart/form-data',
                headers={'Origin': 'http://localhost', 'X-CSRF-Token': self.csrf[self.owner]})
        self.assertEqual(response.status_code, 200)
        body = response.json
        self.assertTrue(body['parsed'])
        self.assertFalse(body['saved'])
        self.assertEqual(body['fields']['category'], 'food')
        self.assertEqual(body['fields']['currency'], 'USD')
        self.assertEqual(body['fields']['total'], 42.5)

    def test_scan_unavailable_model_surfaces_as_503(self):
        with patch('app.expenses.ocr.ReceiptScanner._infer',
                   side_effect=ReceiptScanError('LOCAL_MODEL_UNAVAILABLE', 503)):
            response = self.owner.post('/api/expenses/scan-receipt',
                data={'receipt': (io.BytesIO(b'\xff\xd8\xfffake-bytes'), 'receipt.jpg', 'image/jpeg')},
                content_type='multipart/form-data',
                headers={'Origin': 'http://localhost', 'X-CSRF-Token': self.csrf[self.owner]})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json['error'], 'LOCAL_MODEL_UNAVAILABLE')

    def test_scan_status_reports_local_model_readiness(self):
        status = self.owner.get('/api/expenses/scan-status').json
        self.assertIn('available', status)
        self.assertEqual(status['model'], 'Qwen/Qwen3-VL-2B-Instruct')
        self.assertIn('modelPrepared', status)

    def test_scan_missing_total_stays_unsaved_and_unparsed(self):
        with patch('app.expenses.ocr.ReceiptScanner._infer',
                   return_value='{"merchant":"Cafe","total":null}'):
            response = self.owner.post('/api/expenses/scan-receipt',
                data={'receipt': (io.BytesIO(b'\xff\xd8\xfffake-bytes'), 'receipt.jpg', 'image/jpeg')},
                content_type='multipart/form-data',
                headers={'Origin': 'http://localhost', 'X-CSRF-Token': self.csrf[self.owner]})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json['parsed'])
        self.assertIsNone(response.json['fields'])

    def test_ollama_cloud_uses_only_server_configuration_and_returns_preview(self):
        scanner = ReceiptScanner(provider='ollama_cloud', ollama_api_key='server-secret',
                                 ollama_model='vision-model')
        response_body = json.dumps({'message': {'content': json.dumps({
            'merchant': 'Cafe', 'date': '2026-11-06', 'currency': 'usd',
            'total': 12.5, 'category': 'food', 'items': []})}}).encode()
        with patch('app.expenses.ocr.urllib.request.urlopen', return_value=io.BytesIO(response_body)) as network:
            preview = scanner.scan(b'\xff\xd8\xffreceipt', 'image/jpeg')
        self.assertTrue(preview['parsed'])
        self.assertEqual(preview['fields']['total'], 12.5)
        request = network.call_args.args[0]
        self.assertEqual(request.full_url, 'https://ollama.com/api/chat')
        self.assertEqual(request.get_header('Authorization'), 'Bearer server-secret')
        sent = json.loads(request.data)
        self.assertEqual(sent['model'], 'vision-model')
        self.assertEqual(base64.b64decode(sent['messages'][0]['images'][0]), b'\xff\xd8\xffreceipt')
        status = scanner.status()
        self.assertTrue(status['available'])
        self.assertNotIn('server-secret', json.dumps(status))

    def test_ollama_cloud_missing_server_key_never_calls_network(self):
        scanner = ReceiptScanner(provider='ollama_cloud', ollama_model='vision-model')
        self.assertFalse(scanner.status()['available'])
        with patch('app.expenses.ocr.urllib.request.urlopen') as network:
            with self.assertRaisesRegex(ReceiptScanError, 'RECEIPT_MODEL_NOT_CONFIGURED'):
                scanner.scan(b'\x89PNG\r\n\x1a\nreceipt', 'image/png')
        network.assert_not_called()

    def test_factory_wires_operator_ollama_config_without_exposing_the_key(self):
        config = dict(self.config,
            DATABASE_URL='sqlite:///' + (Path(self.directory.name) / 'ollama.db').as_posix(),
            RECEIPT_VISION_PROVIDER='ollama_cloud', OLLAMA_API_KEY='operator-only-secret',
            OLLAMA_VISION_MODEL='vision-model')
        cloud_app = create_app(config, paypal=FakePayPal())
        try:
            client = cloud_app.test_client()
            client.get('/api/config')
            status = client.get('/api/expenses/scan-status')
            self.assertEqual(status.status_code, 200)
            self.assertEqual(status.json['provider'], 'ollama_cloud')
            self.assertTrue(status.json['available'])
            self.assertNotIn('operator-only-secret', status.get_data(as_text=True))
            self.assertNotIn('operator-only-secret', client.get('/api/config').get_data(as_text=True))
        finally:
            cloud_app.extensions['store'].engine.dispose()

    def test_receipt_content_type_must_match_image_signature_before_inference(self):
        scanner = ReceiptScanner(provider='ollama_cloud', ollama_api_key='server-secret',
                                 ollama_model='vision-model')
        with patch('app.expenses.ocr.urllib.request.urlopen') as network:
            with self.assertRaisesRegex(ReceiptScanError, 'INVALID_RECEIPT_IMAGE'):
                scanner.scan(b'not-an-image', 'image/jpeg')
        network.assert_not_called()

    # ------------------------------------------------------------- auth boundaries
    def test_missing_session_is_unauthorized(self):
        anonymous = self.app.test_client()
        self.assertEqual(anonymous.get('/api/expenses/friends').status_code, 401)

    def test_missing_csrf_token_is_forbidden(self):
        response = self.owner.post('/api/expenses/friends', json={'name': 'Dana'},
                                   headers={'Origin': 'http://localhost'})
        self.assertEqual(response.status_code, 403)


if __name__ == '__main__':
    unittest.main()

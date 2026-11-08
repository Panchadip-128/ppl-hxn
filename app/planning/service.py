"""Owner-private preference lifecycle and consented group planning."""
import json
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from sqlalchemy import insert, select, update

from .interpreter import (AIError, FIELDS, DeterministicCatalogMatcher, GroupPlanExplainer,
                        PreferenceInterpreter, validate_constraints)
from app.shared.storage import (catalog_offers, catalog_resources, group_member_preferences,
                     group_member_profiles, group_memberships, identifier, money,
                     shared_purchases, workshop_groups)


class Planning:
    def __init__(self, store):
        self.store = store

    def _member(self, connection, participant_id, group_id, editable=False):
        if editable:
            # The no-op write locks the parent on both PostgreSQL and SQLite,
            # matching roster freeze/join before inspecting mutable state.
            connection.execute(update(workshop_groups).where(
                workshop_groups.c.id == group_id).values(id=group_id))
        member = connection.execute(select(group_memberships.c.id).where(
            group_memberships.c.group_id == group_id,
            group_memberships.c.participant_id == participant_id)).scalar()
        if not member:
            raise AIError('GROUP_NOT_FOUND', 404)
        if editable:
            frozen = connection.execute(select(shared_purchases.c.id).where(
                shared_purchases.c.group_id == group_id,
                shared_purchases.c.state.in_(['AWAITING_AUTHORIZATIONS', 'FINALIZING', 'CONFIRMED',
                                            'RECOVERY_REQUIRED', 'CANCELLING']),
                shared_purchases.c.frozen_at.is_not(None))).scalar()
            if frozen:
                raise AIError('ROSTER_ALREADY_FROZEN', 409)

    def _own_row(self, connection, participant_id, group_id):
        return connection.execute(select(group_member_preferences).where(
            group_member_preferences.c.group_id == group_id,
            group_member_preferences.c.participant_id == participant_id)).mappings().first()

    def get_preference(self, participant_id, group_id):
        with self.store.engine.connect() as connection:
            self._member(connection, participant_id, group_id)
            row = self._own_row(connection, participant_id, group_id)
            interpretation = json.loads(row['interpreted_json']) if row else None
            confirmed = json.loads(row['confirmed_constraints_json']) if row and row['confirmed_constraints_json'] else None
            current = dict(interpretation, **confirmed) if interpretation and confirmed else interpretation
            return dict(rawText=row['raw_text'] if row else '',
                        interpretation=interpretation,
                        confirmedConstraints=confirmed,
                        isConfirmed=bool(row and row['is_confirmed']),
                        guidance=self._guidance(connection, participant_id, group_id, current))

    def _offers(self, connection, domain=None):
        query = select(catalog_offers)
        if domain:
            query = query.where(catalog_offers.c.domain == domain)
        offers = []
        for row in connection.execute(query.order_by(
                catalog_offers.c.schedule_time, catalog_offers.c.id)).mappings():
            schedule = datetime.fromisoformat(row['schedule_time'])
            if schedule.tzinfo is None or schedule <= datetime.now(timezone.utc):
                continue
            resources = [{k: r[k] for k in ('id', 'label', 'row_label', 'col_number', 'state')}
                         for r in connection.execute(select(catalog_resources).where(
                             catalog_resources.c.offer_id == row['id']).order_by(
                                 catalog_resources.c.row_label,
                                 catalog_resources.c.col_number,
                                 catalog_resources.c.id)).mappings()]
            offers.append(dict(id=row['id'], domain=row['domain'], title=row['title'], description=row['description'],
                               merchantID=row['merchant_id'], scheduleTime=row['schedule_time'],
                               priceMinor=row['price_minor'], value=money(row['price_minor']),
                               currency=row['currency'], meta=json.loads(row['meta_json']), resources=resources))
        return offers

    def _guidance(self, connection, participant_id, group_id, interpretation):
        """Private preview uses only this member's constraints and trusted offers."""
        mode = interpretation.get('processingMode', 'manual_fallback') if interpretation else 'manual_fallback'
        base = dict(processingMode=mode, label='Gemini interpretation' if mode == 'gemini' else 'Local preference helper',
                    summary='Describe your budget, days and time window, or choose any day and time.',
                    clarifications=interpretation.get('clarifications', []) if interpretation else [],
                    catalogSuggestions=[], scope='private_preview', requiresConfirmation=True,
                    nextAction='Enter preferences, then review and confirm the editable fields.')
        if not interpretation:
            return base
        members = connection.execute(select(group_memberships.c.participant_id).where(
            group_memberships.c.group_id == group_id).order_by(
                group_memberships.c.joined_at, group_memberships.c.id)).scalars().all()
        constraints = [{} for _ in members]
        own = validate_constraints({key: value for key, value in interpretation.items() if key in FIELDS})
        constraints[members.index(participant_id)] = own
        offers = self._offers(connection)
        result = DeterministicCatalogMatcher().match(constraints, offers, len(members))
        index = members.index(participant_id)
        base['memberCount'] = len(members)
        base['catalogSuggestions'] = [dict(offerID=o['id'], title=o['title'], domain=o['domain'],
            scheduleTime=o['scheduleTime'], localSchedule=datetime.fromisoformat(o['scheduleTime']).astimezone(
                ZoneInfo(own['timezone'])).isoformat(), yourShareValue=o['shareValues'][index],
            reason='Fits your structured preferences and current available resources; other members have not been evaluated here.')
            for o in result['matches'][:5]]
        base['summary'] = (f"{len(result['matches'])} catalog option(s) fit your current structured preferences for "
                           f"{len(members)} member(s). This private preview does not establish group agreement.")
        if not result['matches']:
            available = DeterministicCatalogMatcher().match([{} for _ in members], offers, len(members))['matches']
            minimums = []
            for domain, label in (('movie', 'movie'), ('excursion', 'excursion')):
                choices = [o for o in available if o['domain'] == domain]
                if choices:
                    cheapest = min(choices, key=lambda o: o['shareCents'][index])
                    minimums.append(f"{label} shares start at ${cheapest['shareValues'][index]} USD")
            if minimums:
                base['summary'] += ' With your current roster, ' + '; '.join(minimums) + '. Review the schedule and your fields before changing a constraint.'
        if base['clarifications']:
            base['nextAction'] = 'Resolve the clarification questions in the editable fields before confirming.'
        elif len(members) < 2:
            base['nextAction'] = 'Review your fields, then invite another participant; excursion shares change with the roster.'
        elif not result['matches']:
            base['nextAction'] = 'Review your budget, allowed dates or time window; no current option fits. Only you can change your constraints.'
        else:
            base['nextAction'] = 'Confirm your editable constraints, then ask the other members to confirm theirs.'
        base['conflicts'] = result['conflicts']
        return base

    def submit_preference(self, participant_id, group_id, raw_text, user_tz='UTC', reference_date=None):
        with self.store.engine.connect() as connection:
            self._member(connection, participant_id, group_id, editable=True)
        # Never hold a database transaction across an external model request.
        interpreted = PreferenceInterpreter().interpret(raw_text, user_tz, reference_date)
        encoded = json.dumps(interpreted, separators=(',', ':'))
        if len(encoded) > 2000:
            raise AIError('INTERPRETATION_TOO_LARGE')
        with self.store.engine.begin() as connection:
            self._member(connection, participant_id, group_id, editable=True)
            row = self._own_row(connection, participant_id, group_id)
            values = dict(raw_text=raw_text.strip(), interpreted_json=encoded,
                          confirmed_constraints_json=None, is_confirmed=0, updated_at=time.time())
            if row:
                connection.execute(update(group_member_preferences).where(
                    group_member_preferences.c.id == row['id']).values(**values))
            else:
                connection.execute(insert(group_member_preferences).values(
                    id=identifier(), group_id=group_id, participant_id=participant_id, **values))
            guidance = self._guidance(connection, participant_id, group_id, interpreted)
        return dict(groupID=group_id, participantID=participant_id, status='INTERPRETED',
                    isConfirmed=False, interpretation=interpreted, guidance=guidance)

    def confirm_preference(self, participant_id, group_id, confirmed_constraints):
        if not isinstance(confirmed_constraints, dict):
            raise AIError('CONSTRAINTS_REQUIRED')
        with self.store.engine.begin() as connection:
            self._member(connection, participant_id, group_id, editable=True)
            row = self._own_row(connection, participant_id, group_id)
            if not row:
                raise AIError('PREFERENCE_NOT_FOUND', 404)
            interpretation = json.loads(row['interpreted_json'])
            confirmed = validate_constraints(confirmed_constraints, interpretation.get('timezone', 'UTC'))
            if confirmed['clarifications']:
                raise AIError('CLARIFICATION_REQUIRED')
            encoded = json.dumps(confirmed, separators=(',', ':'))
            if len(encoded) > 2000:
                raise AIError('CONSTRAINTS_TOO_LARGE')
            connection.execute(update(group_member_preferences).where(
                group_member_preferences.c.id == row['id']).values(
                    confirmed_constraints_json=encoded, is_confirmed=1, updated_at=time.time()))
        return dict(groupID=group_id, participantID=participant_id, status='CONFIRMED',
                    isConfirmed=True, confirmedConstraints=confirmed)

    def validate_selection(self, connection, group_id, offer_id, resource_ids):
        """Validate an actual quote/freeze selection inside its caller's transaction.

        Pure manual booking remains available until anyone starts preference
        planning. Once planning starts, every roster member must confirm and
        the selected resources/offer must satisfy their canonical constraints.
        The caller must hold the parent group lock before freezing the roster.
        """
        prefs = {row['participant_id']: row for row in connection.execute(
            select(group_member_preferences).where(
                group_member_preferences.c.group_id == group_id)).mappings()}
        if not prefs:
            return
        members = connection.execute(select(group_memberships.c.participant_id).where(
            group_memberships.c.group_id == group_id).order_by(
                group_memberships.c.joined_at, group_memberships.c.id)).scalars().all()
        constraints = []
        for pid in members:
            pref = prefs.get(pid)
            if not pref or not pref['is_confirmed'] or not pref['confirmed_constraints_json']:
                raise AIError('PREFERENCES_NOT_CONFIRMED', 409)
            constraints.append(validate_constraints(json.loads(pref['confirmed_constraints_json'])))
        offer = connection.execute(select(catalog_offers).where(
            catalog_offers.c.id == offer_id)).mappings().first()
        if not offer:
            raise AIError('OFFER_NOT_FOUND', 404)
        if (not isinstance(resource_ids, list) or any(not isinstance(r, str) for r in resource_ids)
                or len(resource_ids) != len(members) or len(set(resource_ids)) != len(resource_ids)):
            raise AIError('RESOURCE_COUNT_MISMATCH')
        resources = [dict(row) for row in connection.execute(select(catalog_resources).where(
            catalog_resources.c.offer_id == offer_id,
            catalog_resources.c.id.in_(resource_ids))).mappings()]
        if len(resources) != len(resource_ids):
            raise AIError('INVALID_RESOURCES')
        candidate = dict(id=offer['id'], domain=offer['domain'], title=offer['title'],
                         priceMinor=offer['price_minor'], currency=offer['currency'],
                         scheduleTime=offer['schedule_time'], meta=json.loads(offer['meta_json']),
                         resources=resources)
        result = DeterministicCatalogMatcher().match(constraints, [candidate], len(members))
        if not result['matches']:
            raise AIError('CONFIRMED_CONSTRAINTS_NOT_MET', 409)

    def get_group_plan(self, participant_id, group_id, domain='movie'):
        if domain not in ('movie', 'excursion'):
            raise AIError('INVALID_DOMAIN')
        with self.store.engine.connect() as connection:
            self._member(connection, participant_id, group_id)
            members = connection.execute(select(group_memberships.c.participant_id).where(
                group_memberships.c.group_id == group_id).order_by(
                    group_memberships.c.joined_at, group_memberships.c.id)).scalars().all()
            if not 1 <= len(members) <= 4:
                raise AIError('GROUP_SIZE_UNSUPPORTED')
            if len(members) == 1:
                own = self._own_row(connection, participant_id, group_id)
                return dict(groupID=group_id, domain=domain, groupSize=1, memberCount=1,
                            confirmedCount=int(bool(own and own['is_confirmed'])), unconfirmedMembers=[], allConfirmed=False,
                            needsMembers=True, matches=[], conflicts=[],
                            explanation='Invite another participant to plan a shared booking.',
                            nextAction='Copy the invite link and open it in a separate browser profile.')
            profiles = {r['participant_id']: r for r in connection.execute(select(group_member_profiles).where(
                group_member_profiles.c.group_id == group_id)).mappings()}
            prefs = {r['participant_id']: r for r in connection.execute(select(group_member_preferences).where(
                group_member_preferences.c.group_id == group_id)).mappings()}
            constraints, unconfirmed = [], []
            for index, pid in enumerate(members):
                row, profile = prefs.get(pid), profiles.get(pid)
                if row and row['is_confirmed'] and row['confirmed_constraints_json']:
                    constraints.append(validate_constraints(json.loads(row['confirmed_constraints_json'])))
                else:
                    alias = profile['alias'] if profile and profile['consent_coarse_progress'] else f'Member {index + 1}'
                    unconfirmed.append(alias)
            base = dict(groupID=group_id, domain=domain, groupSize=len(members), memberCount=len(members),
                        confirmedCount=len(constraints), unconfirmedMembers=unconfirmed,
                        allConfirmed=not unconfirmed, needsMembers=False, matches=[], conflicts=[])
            if unconfirmed:
                base['explanation'] = 'Waiting for every member to edit and confirm their own constraints. No group recommendation is available yet.'
                base['nextAction'] = 'Each unconfirmed member should open their private preference helper and confirm their fields.'
                return base
            offers = self._offers(connection, domain)
        result = DeterministicCatalogMatcher().match(constraints, offers, len(members),
                                                     own_index=members.index(participant_id))
        base.update(result)
        base['explanation'] = (GroupPlanExplainer().explain(result['matches'], result['conflicts'], constraints) if offers else
                               'No upcoming experiences are listed in this category. Check another category or ask the organizer about new dates.')
        base['nextAction'] = ('The organizer can select a matching option and review its exact quote.' if result['matches'] else
                              'Members can edit only their own constraints, or choose another activity. No booking has been selected.')
        return base


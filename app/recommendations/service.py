"""Constraint-first recommendations; semantic relevance never authorizes a booking."""
import hashlib
import json
import math
import re
import time

from sqlalchemy import select

from app.planning.interpreter import AIError, DeterministicCatalogMatcher, validate_constraints
from app.planning.service import Planning
from .semantic import SemanticUnavailable
from app.shared.storage import group_member_preferences, group_memberships, shared_purchases


ALGORITHM = 'verified_semantic_regret_v1'
# A conservative English clarification guard, not a general exclusion detector.
EXCLUSION = re.compile(r"\b(?:no|not|never|avoid|without|must|allergic|allergy)\b|\b(?:don|can|won)'t\b", re.I)


def regret_order(similarities, offer_ids):
    """Lexicographically minimize descending regrets; break ties by mean and ID.

    An entry is a modeled relevance score, not a probability or satisfaction.
    The IDs must already be in deterministic schedule/ID order for final ties.
    """
    if len(set(offer_ids)) != len(offer_ids):
        raise ValueError('Duplicate offer IDs')
    if any(len(row) != len(offer_ids) or any(type(x) not in (int, float) or
           not math.isfinite(x) or not -1 <= x <= 1 for x in row) for row in similarities):
        raise ValueError('Invalid relevance matrix')
    if not offer_ids or not similarities:
        return list(offer_ids)
    best = [max(row) for row in similarities]
    def key(index):
        regrets = sorted((round(best[i] - row[index], 12) for i, row in enumerate(similarities)), reverse=True)
        return (*regrets, -round(math.fsum(row[index] for row in similarities) / len(similarities), 12), index)
    return [offer_ids[index] for index in sorted(range(len(offer_ids)), key=key)]


def normalized_mean(vectors):
    if not vectors or not vectors[0] or len(vectors[0]) > 2048:
        raise ValueError('Invalid embedding')
    dimension = len(vectors[0])
    for row in vectors:
        if len(row) != dimension or any(type(x) not in (int, float) or not math.isfinite(x) for x in row):
            raise ValueError('Invalid embedding')
        norm = math.sqrt(math.fsum(x * x for x in row))
        if abs(norm - 1) > .001:
            raise ValueError('Expected normalized embedding')
    mean = [math.fsum(row[i] for row in vectors) / len(vectors) for i in range(dimension)]
    norm = math.sqrt(math.fsum(x * x for x in mean))
    if norm < 1e-9:
        raise ValueError('Ambiguous descriptive preferences')
    return [x / norm for x in mean]


class Recommendations:
    def __init__(self, store, encoder):
        self.store, self.encoder = store, encoder
        self.planning = Planning(store)

    def _read(self, participant_id, group_id, domain):
        with self.store.engine.connect() as connection:
            self.planning._member(connection, participant_id, group_id)
            active = connection.execute(select(shared_purchases.c.id).where(
                shared_purchases.c.group_id == group_id,
                shared_purchases.c.state.not_in(('CANCELLED', 'EXPIRED')))).first()
            if active:
                raise AIError('ROSTER_ALREADY_FROZEN', 409)
            members = connection.execute(select(group_memberships.c.participant_id).where(
                group_memberships.c.group_id == group_id).order_by(
                group_memberships.c.joined_at, group_memberships.c.id)).scalars().all()
            if not 1 <= len(members) <= 4:
                raise AIError('GROUP_SIZE_UNSUPPORTED')
            rows = {r['participant_id']: r for r in connection.execute(select(group_member_preferences).where(
                group_member_preferences.c.group_id == group_id)).mappings()}
            constraints = [validate_constraints(json.loads(rows[pid]['confirmed_constraints_json']))
                           if pid in rows and rows[pid]['is_confirmed'] and rows[pid]['confirmed_constraints_json']
                           else None for pid in members]
            offers = self.planning._offers(connection, domain)
        offers.sort(key=lambda offer: (offer['scheduleTime'], offer['id']))
        for offer in offers:
            offer['resources'].sort(key=lambda resource: resource['id'])
        return dict(members=members, constraints=constraints, offers=offers)

    @staticmethod
    def _fingerprint(snapshot):
        return hashlib.sha256(json.dumps(snapshot, sort_keys=True, separators=(',', ':'),
                                         allow_nan=False).encode()).hexdigest()

    def recommend(self, participant_id, group_id, domain='movie', objective='compromise'):
        started = time.perf_counter()
        if domain not in ('movie', 'excursion'):
            raise AIError('INVALID_DOMAIN')
        if objective not in ('compare', 'compromise', 'average'):
            raise AIError('INVALID_RECOMMENDATION_OBJECTIVE')
        snapshot = self._read(participant_id, group_id, domain)
        constraints = snapshot['constraints']
        member_count = len(constraints)
        base = dict(groupID=group_id, domain=domain, memberCount=member_count, groupSize=member_count,
                    confirmedCount=sum(c is not None for c in constraints),
                    needsMembers=member_count < 2, allConfirmed=all(c is not None for c in constraints),
                    unconfirmedMembers=[f'Member {i + 1}' for i, c in enumerate(constraints) if c is None],
                    matches=[], conflicts=[])
        metadata = dict(algorithm=ALGORITHM, mode='rules', descriptiveMemberCount=0,
                        memberCount=member_count, model=None, revision=None,
                        objective=objective,
                        scope='confirmed_soft_preferences', availabilityReserved=False,
                        eligibleCount=0, inferenceExecuted=False)
        def finish(mode, explanation, matches=None):
            metadata['mode'] = mode
            metadata['elapsedMs'] = round((time.perf_counter() - started) * 1000, 3)
            base.update(explanation=explanation, recommendation=metadata)
            if matches is not None:
                base['matches'] = matches
            return base
        if member_count < 2:
            return finish('needs_members', 'Invite another participant before requesting a group recommendation.')
        if not base['allConfirmed']:
            return finish('needs_confirmation', 'Every member must confirm their own structured preferences first.')
        result = DeterministicCatalogMatcher().match(constraints, snapshot['offers'], member_count,
                                                     own_index=snapshot['members'].index(participant_id))
        base.update(result)
        # Legacy matcher scores summarize private peer tags. They are an
        # internal sorting aid, never public recommendation evidence.
        base['matches'] = [{key: value for key, value in offer.items() if key != 'preferenceScore'}
                           for offer in result['matches']]
        eligible = sorted(base['matches'], key=lambda offer: (offer['scheduleTime'], offer['id']))
        rules_order = [offer['id'] for offer in eligible]
        metadata['eligibleCount'] = len(eligible)
        metadata['rulesOrder'] = rules_order
        if not eligible:
            explanation = ('No upcoming experiences are listed in this category. Check another category or ask the organizer about new dates.'
                           if not snapshot['offers'] else
                           'No plan fits yet. See the exact shares and blockers below, review your own constraints, or check another category. Each member decides whether to change their own limits.')
            return finish('no_matches', explanation)
        tastes = [list(dict.fromkeys(tag.strip().casefold() for tag in c['soft_preferences'] if tag.strip()))
                  for c in constraints]
        metadata['descriptiveMemberCount'] = sum(bool(tags) for tags in tastes)
        if any(EXCLUSION.search(tag) for tags in tastes for tag in tags):
            return finish('needs_clarification', 'Some taste descriptions include exclusions or requirements. Semantic similarity cannot enforce these. Each member should review their own fields; use positive descriptive tastes only.', [])
        if not any(tastes):
            return finish('needs_tastes', 'Your constraints fit. Add and confirm descriptive tastes such as science fiction or scenic hiking for semantic group ranking.')
        if len(eligible) == 1:
            return finish('single_option', 'Only one option satisfies every confirmed constraint. AI ranking would not add a choice.', eligible)
        status = self.encoder.status()
        if not status.get('available'):
            return finish('unavailable', 'The local semantic model is not prepared. These are verified rules-based matches; no AI ranking ran.')
        # Only trusted catalog documents are cached. No member text or query vector
        # leaves this request or is returned to another participant.
        tags = list(dict.fromkeys(tag for member_tags in tastes for tag in member_tags))
        def recheck():
            latest = self._read(participant_id, group_id, domain)
            if self._fingerprint(snapshot) != self._fingerprint(latest):
                raise AIError('RECOMMENDATION_STALE', 409)
            return latest
        inference_started = time.perf_counter()
        try:
            documents = self.encoder.catalog(eligible)
            vectors = self.encoder.encode(tags)
            if len(documents) != len(eligible) or len(vectors) != len(tags):
                raise ValueError('Invalid embedding count')
            documents = [normalized_mean([row]) for row in documents]
            mapping = dict(zip(tags, vectors))
            similarities = []
            for member_tags in tastes:
                if not member_tags:
                    continue
                vector = normalized_mean([mapping[tag] for tag in member_tags])
                if any(len(document) != len(vector) for document in documents):
                    raise ValueError('Embedding dimension mismatch')
                similarities.append([max(-1, min(1, math.fsum(x * y for x, y in zip(vector, document))))
                                     for document in documents])
            ids = regret_order(similarities, [offer['id'] for offer in eligible])
            average_ids = [eligible[i]['id'] for i in sorted(range(len(eligible)), key=lambda i:
                (-math.fsum(row[i] for row in similarities) / len(similarities), i))]
            shared_top = set(range(len(eligible)))
            for row in similarities:
                shared_top.intersection_update(i for i, value in enumerate(row) if abs(value - max(row)) <= 1e-12)
        except (SemanticUnavailable, ValueError, TypeError, KeyError, OverflowError):
            recheck()
            return finish('unavailable', 'Semantic ranking could not run. These are verified rules-based matches; your saved preferences were not changed.')
        metadata['inferenceMs'] = round((time.perf_counter() - inference_started) * 1000, 3)
        metadata['inferenceExecuted'] = True
        # Inference never holds a DB connection. Recheck roster order, canonical
        # preferences, current time, trusted offer documents, prices and resources.
        latest = recheck()
        verified = DeterministicCatalogMatcher().match(latest['constraints'], latest['offers'], member_count)['matches']
        by_id = {offer['id']: {key: value for key, value in offer.items() if key != 'preferenceScore'}
                 for offer in verified}
        if set(ids) != set(by_id):
            raise AIError('RECOMMENDATION_STALE', 409)
        metadata['decision'] = 'shared_semantic_top' if shared_top else 'tradeoff_to_discuss'
        metadata['views'] = dict(compromise=ids, average=average_ids)
        ordered = average_ids if objective == 'average' else ids if objective == 'compromise' else [offer['id'] for offer in eligible]
        metadata.update(
            catalogDocumentCount=len(documents), tasteTextCount=len(tags), appliedOrder=ordered,
            appliedOrderChanged=ordered != rules_order,
            semanticChangedRulesOrder=ids != rules_order or average_ids != rules_order,
        )
        ranked = []
        for offer_id in ordered:
            labels = []
            if offer_id == ids[0]:
                labels.append('Smallest worst modeled compromise')
            if offer_id == average_ids[0]:
                labels.append('Highest average modeled fit')
            ranked.append(dict(by_id[offer_id], recommendationLabel=' / '.join(labels) or 'Verified alternative'))
        metadata.update(model=status['model'], revision=status['revision'])
        agreement = 'One option is the top semantic match for every member who supplied tastes.' if shared_top else 'No option is the top semantic match for every member who supplied tastes; compare the tradeoff together.'
        effect = ('The displayed order changed from the verified schedule order.' if metadata['appliedOrderChanged'] else
                  'The displayed order stayed the same; the model still evaluated every eligible option.' if objective != 'compare' else
                  'Both semantic views were computed while the neutral comparison keeps schedule order.')
        policy = {'compare': 'Showing both ranking lenses in schedule order, without choosing for your group.',
                  'compromise': 'Ordered by the smallest worst modeled compromise.',
                  'average': 'Ordered by highest average modeled fit.'}[objective]
        return finish('semantic', f'{len(ranked)} plans satisfy every confirmed constraint. {policy} {effect} {metadata["descriptiveMemberCount"]} of {member_count} members supplied tastes. {agreement} This is not an agreement or satisfaction score; places are not reserved.', ranked)


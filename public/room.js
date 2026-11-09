'use strict';

// Group coordination uses one browser identity. Fictional personas live in demo.js.
(function (root) {
  function cents(value) {
    if (value === '') return null;
    if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error('Use a nonnegative budget with up to two decimal places.');
    const [whole, fraction = ''] = value.split('.');
    const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(result)) throw new Error('Budget is too large.');
    return result;
  }
  const list = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  const weekdays = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
  function constraints(fields) {
    const time = {};
    for (const key of ['earliest', 'latest', 'finish_before']) if (fields[key]) time[key] = fields[key];
    const days = list(fields.days).map((day) => day.toLowerCase());
    if (days.some((day) => !weekdays.has(day))) throw new Error('Enter full weekday names separated by commas, such as Friday, Saturday. Leave blank for any day.');
    return {budget_cents: cents(fields.budget), currency: 'USD', preferred_days: days,
      dates: list(fields.dates), timezone: fields.timezone, time_window: time,
      hard_constraints: [], soft_preferences: list(fields.preferences), clarifications: []};
  }
  function canApprove(booking, now = Date.now() / 1000) {
    return booking?.state === 'AWAITING_AUTHORIZATIONS' && booking.holdDeadline > now &&
      !!booking.myShare && booking.myShare.canAuthorize !== false &&
      !['AUTHORIZED', 'CAPTURED', 'VOIDED', 'REFUNDED'].includes(booking.myShare.state);
  }
  function futureOffers(offers, domain, now = Date.now()) {
    return (offers || []).filter((offer) => {
      if (offer.domain !== domain) return false;
      if (offer.availability) return offer.availability.status !== 'past';
      const scheduled = Date.parse(offer.scheduleTime);
      return Number.isFinite(scheduled) && scheduled > now;
    });
  }
  function upcomingOffers(offers, domain, groupSize, now = Date.now()) {
    return futureOffers(offers, domain, now).filter((offer) => {
      const availability = offer.availability;
      return !availability || (availability.status === 'available' &&
        (!Array.isArray(availability.groupSizes) || availability.groupSizes.includes(groupSize)));
    });
  }
  const helpers = {cents, constraints, canApprove, futureOffers, upcomingOffers};
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (typeof document === 'undefined') return;

  const $ = (id) => document.getElementById(id);
  const node = (tag, text, cls) => {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (cls) item.className = cls;
    return item;
  };
  const money = (value, currency = 'USD') => new Intl.NumberFormat(undefined, {style: 'currency', currency}).format(value / 100);
  const schedule = (value) => new Date(value).toLocaleString();
  const readable = (value) => String(value || 'Not started').replaceAll('_', ' ').toLowerCase();
  const closed = (booking) => ['CANCELLED', 'EXPIRED'].includes(booking?.state);
  const state = {group: null, booking: null, room: null, preference: null, offer: null, seats: [], quote: null,
    epoch: 0, sequence: 0, busy: false, approval: false, buttons: null, buttonKey: '', ticket: null,
    chatKey: '', poll: null, sdk: null, options: null, error: null,
    draft: null, edited: false, rescues: [], rescueCompare: false, pendingAI: false, comparing: false,
    plan: null, startingOffer: null, agentHistory: [], agentBusy: false};
  const path = (id, suffix = '') => `/api/groups/${encodeURIComponent(id)}${suffix}`;
  const current = (id, epoch) => state.group?.id === id && state.epoch === epoch;
  const locked = () => state.busy || state.approval;
  const frozen = () => state.booking?.hasBooking && !closed(state.booking);
  const status = (text, error = false) => {
    state.error = error ? text : null;
    $('collab-status-feed').textContent = text;
    $('collab-status-feed').classList.toggle('error', error);
    if (error) $('room-next-action').textContent = text;
    if (error) root.GroupPayToast?.(text, 'error');
  };
  const reportError = (error, suffix = '') => {
    if (error?.privateGroupAccessLost) {
      state.group = null;
      return;
    }
    status(`${error?.message || 'The request failed.'}${suffix}`, true);
  };
  const button = (text, action, cls = 'btn btn-secondary') => {
    const item = node('button', text, cls); item.type = 'button';
    item.addEventListener('click', action); return item;
  };
  async function run(task) {
    if (locked()) return;
    state.busy = true; state.error = null; state.sequence++; renderControls();
    try { await task(); } catch (error) { reportError(error); }
    finally { state.busy = false; renderControls(); }
  }
  async function closeButtons() {
    const epoch = state.epoch;
    const controls = state.buttons; state.buttons = null; state.buttonKey = '';
    if (controls) { try { await controls.close(); } catch {} }
    if (epoch === state.epoch) $('group-paypal-buttons').replaceChildren();
  }
  function bubble(parent, label, text, mine = false) {
    const item = node('div', undefined, `chat-msg ${mine ? 'chat-msg-own' : 'chat-msg-helper'}`);
    item.append(node('strong', label), node('p', text)); parent.append(item);
  }
  function plannerView(view) {
    const comparing = view === 'comparison';
    $('room-preferences-stage').hidden = comparing;
    $('room-comparison-stage').hidden = !comparing;
    $('room-show-preferences').setAttribute('aria-pressed', String(!comparing));
    $('room-show-comparison').setAttribute('aria-pressed', String(comparing));
  }
  function renderObjectiveHint() {
    const hints = {
      compromise: 'Protects the person making the biggest compromise, after budgets, dates, capacity and availability have already been checked.',
      average: 'Ranks by the group’s average modeled fit. One person may compromise more, so review each trade-off before choosing.',
      compare: 'Shows the fair-for-everyone and strongest-overall rankings together. Your group still makes the final choice.',
    };
    $('room-ai-objective-hint').textContent = hints[$('room-ai-objective').value] || hints.compromise;
  }
  function renderBrief() {
    const plan = state.plan, mode = plan?.recommendation?.mode;
    const labels = {semantic: 'Local AI comparison', needs_tastes: 'Verified rules · add likes for AI',
      needs_clarification: 'Review taste descriptions', single_option: 'One eligible choice',
      no_matches: 'Review the blockers', needs_confirmation: 'Waiting for confirmation',
      needs_members: 'Invite a friend', unavailable: 'Verified rules · AI unavailable'};
    $('brief-confirmed').textContent = `${state.room?.confirmedCount || 0} / ${state.group.memberCount}`;
    $('brief-choices').textContent = plan?.allConfirmed && mode !== 'needs_clarification' ? String(plan.matches?.length || 0) : 'Not checked';
    $('brief-method').textContent = state.comparing ? 'Comparing…' : labels[mode] || (plan ? 'Verified rules' : 'Not compared yet');
    const starting = state.startingOffer;
    $('room-starting-point').textContent = starting ? `Your starting point: ${starting.title}. ${plan?.allConfirmed ?
      plan.matches?.some((offer) => offer.id === starting.id) ? 'It fits the current confirmed constraints.' :
        mode === 'needs_clarification' ? 'Review tastes before comparing it.' : 'It is not in the current matches; review alternatives.' :
      'We will check it with everyone’s confirmed preferences.'}` : 'A shared decision, with each person’s limits respected.';
    $('room-comparison-readiness').textContent = state.room?.journey?.detail ||
      'Everyone confirms privately before we compare. You can return to your own preferences at any time.';
  }
  function renderCatalogStatus() {
    const domain = $('room-domain').value;
    const groupSize = state.group?.memberCount || 1;
    const offers = state.options.getOffers();
    const available = upcomingOffers(offers, domain, groupSize);
    const future = futureOffers(offers, domain);
    const alternative = domain === 'excursion' ? 'movie' : 'excursion';
    const alternativeOffers = upcomingOffers(offers, alternative, groupSize);
    const alternativeFuture = futureOffers(offers, alternative);
    const domainName = domain === 'excursion' ? 'outdoor escapes' : 'cinema nights';
    const alternativeName = alternative === 'excursion' ? 'outdoor escapes' : 'cinema nights';
    const status = $('room-catalog-status');
    status.replaceChildren(); status.textContent = '';
    $('room-rescue-card').hidden = available.length === 0;
    $('room-ai-recommend').disabled = $('room-ai-recommend').disabled || available.length === 0;
    $('room-ai-recommend').textContent = state.comparing ? 'Comparing your group…' :
      available.length ? 'Compare AI suggestions' : 'No upcoming sessions';
    if (available.length) {
      status.textContent = `${available.length} bookable upcoming ${domainName} ${available.length === 1 ? 'option' : 'options'} for ${groupSize} ${groupSize === 1 ? 'person' : 'people'}.`;
      return;
    }
    status.append(node('span', `${future.length ? `Upcoming ${domainName} exist, but none currently have enough available places` : `No upcoming ${domainName} are listed`} for your group of ${groupSize}. Your confirmed preferences are saved; nothing was booked.`));
    if (alternativeOffers.length) {
      status.append(button(`View ${alternativeOffers.length} ${alternativeName}`, () => {
        $('room-domain').value = alternative;
        $('room-domain').dispatchEvent(new Event('change', {bubbles: true}));
        run(compareSuggestions);
      }, 'text-button'));
    } else {
      status.append(node('span', alternativeFuture.length ?
        ` Upcoming ${alternativeName} also lack enough available places for this group. Ask the organizer to check inventory.` :
        ` No future ${alternativeName} are listed either. Ask the organizer to add future dates.`));
    }
  }
  function renderPrivate() {
    const parent = $('chat-messages-container'), pref = state.preference || {};
    parent.replaceChildren();
    bubble(parent, 'YOUR PRIVATE CONCIERGE', 'Tell me your budget and schedule. Review the fields before confirming; your private preferences are not posted to the group.');
    if (pref.rawText) bubble(parent, 'YOU · PRIVATE', pref.rawText, true);
    const guide = pref.guidance;
    if (state.draft) {
      bubble(parent, 'YOUR PROPOSED CHANGE · NOT SAVED', 'Review these suggested edits below. Your current confirmed preferences stay in effect until you confirm this draft. Everyone else’s constraints remain unchanged.');
    } else if (guide) {
      bubble(parent, guide.label, [guide.summary, pref.isConfirmed ? 'Confirmed by you.' : guide.nextAction].filter(Boolean).join(' '));
      if (guide.clarifications?.length) bubble(parent, 'PLEASE REVIEW', guide.clarifications.join(' '));
      if (!pref.isConfirmed && guide.catalogSuggestions?.length) bubble(parent, 'YOUR CATALOG PREVIEW',
        guide.catalogSuggestions.slice(0, 2).map((offer) => `${offer.title} · ${schedule(offer.scheduleTime)}: ${offer.yourShareValue} USD for you. ${offer.reason}`).join('\n') + '\nThese previews do not establish group agreement.');
    }
    $('room-planning-mode').textContent = guide?.label || (state.options.getConfig().planningMode === 'gemini' ? 'Gemini available' : 'Local preference helper · no API key needed');
    $('room-preference-review').hidden = !pref.interpretation;
    const value = state.draft || pref.confirmedConstraints || pref.interpretation;
    if (!value) return;
    $('pref-budget').value = value.budget_cents == null ? '' : (value.budget_cents / 100).toFixed(2);
    $('pref-days').value = (value.preferred_days || []).join(', ');
    $('pref-dates').value = (value.dates || []).join(', ');
    $('pref-timezone').value = value.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const [id, key] of [['pref-earliest', 'earliest'], ['pref-latest', 'latest'], ['pref-finish', 'finish_before']]) $(id).value = value.time_window?.[key] || '';
    $('pref-soft').value = (value.soft_preferences || []).join(', ');
    $('pref-review-status').textContent = state.edited ? 'DRAFT CHANGE · CONFIRM TO SAVE' : pref.isConfirmed ? 'CONFIRMED BY YOU · edit to change' : 'REVIEW BEFORE CONFIRMING';
    $('pref-clarifications').textContent = [...(value.clarifications || []), ...(value.hard_constraints || [])].join(' · ');
    if (value.clarifications?.length) $('pref-advanced').open = true;
  }
  function renderChat() {
    const messages = state.room?.messages || [], key = JSON.stringify(messages);
    if (key === state.chatKey) return;
    state.chatKey = key;
    const feed = $('room-shared-feed'); feed.replaceChildren();
    if (!messages.length) feed.append(node('p', 'Say hello to your group. Shared messages are saved; your private concierge remains separate.', 'fine'));
    for (const message of messages) bubble(feed, message.isSelf ? 'YOU · SHARED' : message.alias, message.text, message.isSelf);
    if (state.room?.truncated) feed.prepend(node('p', 'Showing the latest 50 shared messages.', 'fine'));
  }
  const SOURCE_LABELS = {guardrails: 'Safety rules', group_state: 'Group state', own_constraints: 'Your constraints',
    payment_state: 'Payment state', plan_movie: 'Cinema plan', plan_excursion: 'Outdoor plan',
    blocked_movie: 'Cinema blockers', blocked_excursion: 'Outdoor blockers'};
  const INTENT_LABELS = {payment: 'Payment', roster: 'Members', comparison: 'Options', blockers: 'Blockers',
    preferences: 'Preferences', next: 'Next step', greeting: 'Hello', general: 'Not matched'};
  const sourceLabel = (id) => SOURCE_LABELS[id] || (/^message_/.test(id) ? 'Room chat' : null);
  let agentTimer = null;
  function reveal(target, text, feed) {
    clearInterval(agentTimer);
    const motion = typeof root.matchMedia === 'function' && !root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!motion || text.length > 700) { target.textContent = text; return; }
    const step = Math.max(2, Math.ceil(text.length / 70));
    let shown = 0; target.textContent = '';
    agentTimer = setInterval(() => {
      shown = Math.min(text.length, shown + step); target.textContent = text.slice(0, shown);
      feed.scrollTop = feed.scrollHeight;
      if (shown >= text.length) clearInterval(agentTimer);
    }, 16);
  }
  function renderAgentFeed() {
    const feed = $('room-agent-feed'); feed.replaceChildren(); clearInterval(agentTimer);
    if (!state.agentHistory.length) {
      feed.append(node('p', 'Ask for the next best action, current blockers, or payment-state risk. Replies are grounded on saved room state.', 'fine'));
      return;
    }
    for (const message of state.agentHistory) {
      const item = node('div', undefined, `chat-msg ${message.role === 'user' ? 'chat-msg-own' : 'chat-msg-helper'}`);
      item.append(node('strong', message.role === 'user' ? 'YOU' : 'CONTEXT COPILOT'));
      if (message.pending) {
        const dots = node('span', undefined, 'agent-typing'); dots.setAttribute('aria-label', 'Reading room context');
        for (let i = 0; i < 3; i++) dots.append(node('i'));
        item.append(dots); feed.append(item); continue;
      }
      const body = node('p', message.text); item.append(body);
      if (message.fresh) { message.fresh = false; reveal(body, message.text, feed); }
      if (message.tags?.length) {
        const row = node('div', undefined, 'agent-sources');
        for (const tag of message.tags) row.append(node('span', tag.text, `agent-chip${tag.accent ? ' agent-chip-accent' : ''}`));
        item.append(row);
      }
      if (message.details?.length) {
        const details = document.createElement('details');
        details.className = 'agent-details';
        details.append(node('summary', 'Why this answer, next actions and risks'));
        for (const section of message.details) {
          details.append(node('strong', section.title, 'agent-details-title'));
          const list = document.createElement('ul');
          for (const line of section.lines) list.append(node('li', line));
          details.append(list);
        }
        item.append(details);
      }
      feed.append(item);
    }
    feed.scrollTop = feed.scrollHeight;
  }
  async function askAssistant(promptText) {
    const prompt = String(promptText || '').trim();
    if (!prompt || state.agentBusy || !state.group) return;
    const id = state.group.id, epoch = state.epoch;
    state.agentBusy = true;
    state.agentHistory.push({role: 'user', text: prompt});
    const history = state.agentHistory.slice(-12).map((item) => ({role: item.role, text: item.text}));
    state.agentHistory.push({role: 'assistant', pending: true});
    renderAgentFeed(); renderControls();
    $('room-agent-status').textContent = 'Reading room context…';
    const dropPending = () => { state.agentHistory = state.agentHistory.filter((item) => !item.pending); };
    try {
      const response = await state.options.api(path(id, '/assistant/chat'), {
        prompt,
        domain: $('room-domain').value,
        objective: $('room-ai-objective').value || 'compromise',
        history,
      });
      if (!current(id, epoch)) return;
      const details = [];
      if (response.nextActions?.length) details.push({title: 'Next actions', lines: response.nextActions});
      if (response.riskFlags?.length) details.push({title: 'Risks', lines: response.riskFlags});
      if (response.decisions?.length) details.push({title: 'Decision checks', lines: response.decisions.map((item) => `${item.key.replace(/_/g, ' ')}: ${item.status}. ${item.explanation}`)});
      if (response.context?.usedChunkIDs?.length) {
        details.push({title: 'RAG Verified Sources (Local BGE Grounding)', lines: response.context.usedChunkIDs.map((id) => `Fact [${id}]: verified against immutable room state snapshot without external leakage.`)});
      }
      dropPending();
      const sources = [...new Set((response.context?.usedChunkIDs || []).map(sourceLabel).filter(Boolean))].slice(0, 4);
      const semantic = response.retrieval?.mode === 'semantic_local_embeddings';
      const tags = [];
      if (response.retrieval?.intent) tags.push({text: `Understood: ${INTENT_LABELS[response.retrieval.intent] || response.retrieval.intent}`, accent: true});
      for (const label of sources) tags.push({text: label});
      tags.push({text: semantic ? 'Local BGE model' : 'Keyword fallback'});
      state.agentHistory.push({role: 'assistant', text: response.answer, fresh: true, tags,
        details: response.retrieval?.intent === 'greeting' ? [] : details});
      renderAgentFeed();
      const engine = response.retrieval?.mode === 'semantic_local_embeddings'
        ? `Local AI (${response.retrieval.model || 'BGE'})` : 'Basic local lookup (AI unavailable)';
      $('room-agent-status').textContent = `${engine} · Answered from this room's saved details.`;
    } catch (error) {
      if (error.privateGroupAccessLost) throw error;
      if (current(id, epoch)) {
        dropPending();
        state.agentHistory.push({role: 'assistant', text: 'I could not finish this request right now. Please retry.'});
        renderAgentFeed();
        $('room-agent-status').textContent = `Assistant error: ${error.message}`;
      }
      throw error;
    } finally {
      if (current(id, epoch)) {
        state.agentBusy = false;
        renderControls();
      }
    }
  }
  function renderProgress() {
    const group = state.group, room = state.room || {}, booking = state.booking;
    $('room-journey-title').textContent = room.journey?.title || 'One plan. Everyone gets a say.';
    $('room-group-title').textContent = group.name;
    $('room-group-desc').textContent = `${group.memberCount} ${group.memberCount === 1 ? 'person so far' : 'people'} · ${group.role === 'organizer' ? 'You organize this group' : 'You are a member'} · independent approval, exact shares.`;
    $('room-roster-count').textContent = `${group.memberCount} members`;
    $('copy-invite-btn').hidden = !group.inviteURL;
    const avatars = $('room-roster-avatars'); avatars.replaceChildren();
    const rosterMap = new Map((room.roster || []).map((item) => [item.participantID, item]));
    for (const member of group.members || []) {
      const r = rosterMap.get(member.participantID);
      const label = `${member.alias}${r?.isOrganizer ? ' · Lead' : ''}${r?.hasConfirmed ? ' ✓' : ''}`;
      avatars.append(node('span', label, `room-member-pill${r?.hasConfirmed ? ' is-confirmed' : ''}${r?.isOrganizer ? ' is-organizer' : ''}`));
    }
    $('room-readiness').textContent = `${room.confirmedCount || 0} of ${group.memberCount} preferences confirmed. Aliases and individual progress are shared only when opted in.`;
    const phase = booking?.state === 'CONFIRMED' ? 4 : frozen() ? 3 : group.memberCount > 1 ? 2 : 1;
    for (let i = 1; i <= 4; i++) {
      $(`room-step-${i}`).classList.toggle('is-current', i === phase);
      $(`room-step-${i}`).classList.toggle('is-complete', i < phase);
      $(`room-step-${i}`).setAttribute('aria-current', i === phase ? 'step' : 'false');
    }
    let next = room.journey?.detail || room.nextAction || 'Describe your preferences, then review and confirm them.';
    if (group.memberCount < 2) next = 'Copy your invite and open it in a separate browser profile or send it to a friend. To rehearse alone, use the solo demo lab.';
    else if (booking?.state === 'CONFIRMED') next = 'All group captures are verified. Your private demonstration ticket is ready below.';
    else if (booking?.state === 'FINALIZING') next = group.role === 'organizer' ? 'All authorizations are ready. Complete the group capture pass.' : 'Your organizer can now complete group capture.';
    else if (booking?.recoveryRequired || booking?.state === 'RECOVERY_REQUIRED') next = 'A payment outcome is unresolved. Recheck your saved order; the organizer can reconcile recovery. Keep this reservation.';
    else if (canApprove(booking)) next = 'Review your exact share and cancellation terms, then approve your own hold in PayPal.';
    else if (booking?.myShare?.state === 'AUTHORIZED') next = 'Your hold is verified. Waiting for the remaining group authorizations; your ticket stays locked.';
    else if (state.quote) next = 'Review the exact roster shares. The organizer can now hold this selection for 15 minutes.';
    if (state.edited && !frozen()) next = 'You have an unsaved preference change. Review the fields and confirm before finding group matches.';
    $('room-next-action').textContent = state.error || next;
    const explanation = booking?.state === 'CONFIRMED' ? 'What happened: every required capture completed. Your private ticket is unlocked.' :
      booking?.recoveryRequired ? 'What is happening: a financial outcome needs checking. We keep the reservation intact while recovery is unresolved.' :
      frozen() ? 'What happened: places are reserved. Authorization holds funds; the organizer completes capture after everyone is verified.' :
      state.offer ? 'What happened: this experience satisfies the currently confirmed preferences. Review exact shares before reserving.' :
      'What is happening: you are planning together. Your private inputs become group constraints only after you confirm them. No payment has started.';
    $('room-explainer').textContent = explanation;
    $('room-next-button').textContent = group.memberCount < 2 ? 'Invite a friend ↗' : booking?.state === 'CONFIRMED' ? 'See my ticket ↓' : frozen() ? 'See my share ↓' : state.offer ? 'Review places ↓' : state.edited ? 'Review my changes' : room.journey?.actionLabel || 'Review my plan ↓';
    $('room-planning-controls').hidden = frozen();
    $('room-profile-details').hidden = frozen();
  }
  function renderSeats() {
    const parent = $('interactive-seat-map'); parent.replaceChildren();
    const offer = state.offer;
    $('room-canvas-empty').hidden = !!offer && !frozen();
    $('room-selection-tools').hidden = !offer || frozen();
    if (frozen()) {
      $('room-canvas-empty-title').textContent = 'Places are held for this group.';
      $('room-canvas-empty-detail').textContent = 'Each member reviews their own share below. The organizer completes capture after every authorization.';
    } else {
      $('room-canvas-empty-title').textContent = 'Save a place for everyone.';
      $('room-canvas-empty-detail').textContent = 'After everyone confirms preferences, the organizer compares eligible plans and chooses adjacent places here.';
    }
    $('canvas-experience-sub').textContent = offer ? `${offer.title} · ${schedule(offer.scheduleTime)}` : frozen() ? `${state.booking.title} · ${state.booking.myShare?.assignedResource || 'saved reservation'}` : 'Confirm preferences and review a compatible match to choose seats or places.';
    if (!offer) { parent.append(node('p', 'Your shared experience will appear here.', 'fine')); renderQuote(); return; }
    $('seat-map-screen-text').textContent = offer.domain === 'movie' ? 'YOUR CINEMA SEATS' : 'YOUR ADVENTURE PLACES';
    const resources = [...(offer.resources || [])].sort((a, b) => String(a.row_label || a.row || '').localeCompare(String(b.row_label || b.row || '')) || (a.col_number || a.col) - (b.col_number || b.col));
    const columns = Math.max(1, Math.min(12, ...resources.map((r) => r.col_number || r.col || 1)));
    parent.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
    for (const resource of resources) {
      const selected = state.seats.includes(resource.id), free = resource.state === 'FREE';
      const item = button(resource.label, () => {
        state.quote = null;
        state.seats = selected ? state.seats.filter((id) => id !== resource.id) : [...state.seats, resource.id];
        renderSeats(); renderControls();
      }, `seat-button${selected ? ' my-seat' : free ? '' : ' occupied'}`);
      item.disabled = locked() || frozen() || !free || state.group.role !== 'organizer';
      item.setAttribute('aria-pressed', String(selected));
      item.setAttribute('aria-label', `${resource.label}, ${selected ? 'selected' : free ? 'available' : 'unavailable'}`);
      parent.append(item);
    }
    renderQuote();
  }
  function renderQuote() {
    const saved = frozen() ? state.booking : null;
    $('quote-display-total').textContent = state.quote ? `${state.quote.totalValue} ${state.quote.currency}` : saved ? `${saved.totalValue} ${saved.currency}` : 'Get a server quote';
    $('quote-display-share').textContent = state.quote ? state.quote.shares.map((share) => `${share.shareValue} ${state.quote.currency}`).join(' + ') : saved ? `Saved reservation · your share: ${saved.myShare?.shareValue || 'unavailable'} ${saved.currency}` : 'Every remainder cent is included in the review.';
    const review = $('room-quote-breakdown'); review.replaceChildren();
    if (state.quote) {
      for (const share of state.quote.shares) {
        const member = state.group.members.find((item) => item.participantID === share.participantID);
        review.append(node('p', `${member?.alias || 'Member'}: ${share.shareValue} ${state.quote.currency}`));
      }
      review.append(node('p', state.quote.roundingRule, 'fine'));
    }
  }
  function renderControls() {
    if (!state.group) return;
    const booking = state.booking, organizer = state.group.role === 'organizer';
    const recommendationMode = state.plan?.recommendation?.mode;
    const comparisonNeedsNextStep = ['needs_members', 'needs_confirmation', 'needs_tastes', 'needs_clarification', 'no_matches', 'single_option'].includes(recommendationMode);
    $('btn-lock-freeze').disabled = locked() || frozen() || !organizer || !state.quote;
    $('room-quote-btn').disabled = locked() || frozen() || !organizer || !state.offer || state.seats.length !== state.group.memberCount;
    $('room-ai-recommend').disabled = locked() || frozen() || comparisonNeedsNextStep;
    $('room-ai-recommend').textContent = state.comparing ? 'Comparing your group…' : 'Compare AI suggestions';
    $('room-ai-recommend').setAttribute('aria-busy', String(state.comparing));
    $('room-ai-objective').disabled = locked() || frozen();
    $('room-show-preferences').disabled = locked() || frozen();
    $('room-show-comparison').disabled = locked() || frozen() || !state.preference?.isConfirmed || state.edited;
    $('room-rescue').disabled = locked() || frozen() || state.edited;
    $('room-domain').disabled = locked() || frozen();
    $('room-agent-form').querySelector('button').disabled = locked() || state.agentBusy || !state.group;
    $('room-agent-quick-next').disabled = locked() || state.agentBusy || !state.group;
    $('room-agent-quick-blockers').disabled = locked() || state.agentBusy || !state.group;
    $('room-agent-quick-payment').disabled = locked() || state.agentBusy || !state.group;
    for (const field of $('room-preference-review').querySelectorAll('input')) field.disabled = locked() || frozen();
    const recovery = document.querySelector('.recovery-details');
    if (recovery && booking?.recoveryRequired) recovery.open = true;
    $('chat-input-form').querySelector('button').disabled = locked() || frozen();
    $('room-preference-review').querySelector('button').disabled = locked() || frozen();
    $('room-preference-review').querySelector('button').textContent = state.pendingAI ? 'Confirm preferences & compare AI' : 'Yes, these are my preferences';
    $('room-shared-form').querySelector('button').disabled = locked();
    $('room-profile-form').querySelector('button').disabled = locked() || frozen();
    $('canvas-action-area').hidden = !booking?.hasBooking;
    $('room-payment-card').hidden = !booking?.hasBooking;
    $('canvas-finalize-btn').hidden = !organizer;
    $('canvas-finalize-btn').disabled = locked() || booking?.state !== 'FINALIZING';
    $('room-recover').hidden = !organizer;
    $('room-recover').disabled = locked() || !booking?.hasBooking || closed(booking) || booking.state === 'CONFIRMED';
    $('room-cancel').hidden = !organizer;
    $('room-cancel').disabled = locked() || !booking?.hasBooking || closed(booking) || booking.state === 'CONFIRMED';
    $('room-recheck').disabled = locked() || !booking?.hasBooking || closed(booking) || booking.state === 'CONFIRMED';
    $('room-recheck').hidden = !booking?.myShare?.orderID || ['AUTHORIZED', 'CAPTURED'].includes(booking?.myShare?.state) || closed(booking) || booking?.state === 'CONFIRMED';
    $('room-payment-policy').hidden = !canApprove(booking);
    $('room-consent').disabled = locked();
    $('canvas-lifecycle-badge').textContent = readable(booking?.state || 'PLANNING');
    const roster = $('canvas-member-auth-list'); roster.replaceChildren();
    if (booking?.myShare) roster.append(node('p', `YOUR SHARE: ${booking.myShare.shareValue} ${booking.currency} · ${booking.myShare.assignedResource} · ${readable(booking.myShare.state)}`, 'room-own-share'));
    for (const item of booking?.rosterProgress || []) roster.append(node('p', `${item.alias}: ${readable(item.state)}${item.shareValue ? ` · ${item.shareValue} ${booking.currency}` : ''}`, 'fine'));
    $('room-payment-detail').textContent = [booking?.error, booking?.message, booking?.operationInProgress ? 'An operation is in progress. Wait before rechecking.' : '', booking?.myShare?.orderID ? `Your saved order: ${booking.myShare.orderID}` : '', !state.options.getConfig().configured && booking?.hasBooking ? 'PayPal Sandbox is not configured on this server, so approval cannot start.' : ''].filter(Boolean).join(' · ');
    if (booking?.myShare?.consentGiven) $('room-consent').checked = true;
    renderProgress(); renderBrief(); renderCatalogStatus(); countdown();
    if (!state.approval) renderPayPal().catch(reportError);
  }
  function countdown() {
    const booking = state.booking;
    const remaining = Math.max(0, Math.floor((booking?.holdDeadline || 0) - Date.now() / 1000));
    $('canvas-hold-countdown').textContent = booking?.state === 'CONFIRMED' ? 'Confirmed' : closed(booking) ? 'Closed' : !booking?.hasBooking ? 'No hold yet' : remaining ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : 'Recheck required';
  }
  async function refresh() {
    if (!state.group) return;
    const id = state.group.id, epoch = state.epoch, sequence = ++state.sequence;
    const [group, booking, room] = await Promise.all([state.options.api(path(id)), state.options.api(path(id, '/booking')), state.options.api(path(id, '/room'))]);
    if (!current(id, epoch) || sequence !== state.sequence) return;
    const rosterChanged = group.memberCount !== state.group.memberCount;
    const preferencesChanged = state.room?.planningVersion && room.planningVersion && state.room.planningVersion !== room.planningVersion;
    if (rosterChanged || preferencesChanged) {
      state.plan = null;
      state.offer = state.quote = null; state.seats = []; state.rescues = []; state.rescueCompare = false;
      if (state.draft) { state.draft = null; state.edited = false; state.pendingAI = false; renderPrivate(); }
      $('room-plan-results').replaceChildren(); $('room-rescue-results').replaceChildren();
      $('room-ai-actions').replaceChildren();
      $('room-ai-ranking-note').textContent = rosterChanged ? 'Group size changed. Compare again to check the updated shares and constraints.' :
        'Group preferences changed. Compare again to check the latest confirmed limits.';
      renderSeats();
    }
    state.group = group; state.booking = booking; state.room = room;
    if (frozen() && !state.offer) {
      state.offer = state.options.getOffers().find((offer) => offer.id === booking.offerID) || null;
      renderSeats();
    }
    renderChat(); renderControls();
    if (booking.state === 'CONFIRMED' && !state.ticket) await loadTicket();
    else if (booking.state !== 'CONFIRMED') { state.ticket = null; $('canvas-wallet-pass').hidden = true; }
    state.options.onGroup(group);
  }
  async function open(id, domain = 'movie', startingOfferID = null) {
    const epoch = ++state.epoch;
    state.group = {id}; state.sequence++; state.approval = false;
    state.error = null;
    state.plan = null;
    state.startingOffer = state.options.getOffers().find((offer) => offer.id === startingOfferID) || null;
    state.draft = null; state.edited = false; state.rescues = []; state.rescueCompare = false; state.pendingAI = false; state.comparing = false;
    state.agentHistory = [];
    state.agentBusy = false;
    state.booking = state.room = state.preference = state.offer = state.quote = state.ticket = null;
    state.seats = []; state.chatKey = '';
    await closeButtons();
    $('canvas-wallet-pass').hidden = true; $('pass-inline-qr').replaceChildren();
    $('room-plan-results').replaceChildren(); $('room-shared-feed').replaceChildren();
    $('room-rescue-results').replaceChildren();
    $('room-agent-feed').replaceChildren();
    $('room-agent-status').textContent = 'Waiting for your question.';
    $('room-ai-ranking-note').textContent = '';
    $('room-ai-actions').replaceChildren();
    $('room-domain').value = domain === 'excursion' ? 'excursion' : 'movie';
    $('room-consent').checked = false;
    const [group, booking, room, preference] = await Promise.all([
      state.options.api(path(id)), state.options.api(path(id, '/booking')), state.options.api(path(id, '/room')), state.options.api(path(id, '/preferences'))]);
    if (!current(id, epoch)) return null;
    state.group = group; state.booking = booking; state.room = room; state.preference = preference;
    plannerView(preference.isConfirmed ? 'comparison' : 'preferences');
    if (frozen()) state.offer = state.options.getOffers().find((offer) => offer.id === booking.offerID) || null;
    $('room-alias').value = group.myProfile?.alias || '';
    $('room-share-progress').checked = !!group.myProfile?.shareProgress;
    $('chat-input-text').value = ''; $('room-shared-text').value = '';
    renderPrivate(); renderChat(); renderSeats(); renderControls();
    state.agentHistory = [{role: 'assistant', text: 'Context Copilot is ready. Ask what to do next, why a plan is blocked, or your current payment risk.'}];
    renderAgentFeed();
    if (booking.state === 'CONFIRMED') await loadTicket();
    status('Your room is ready. Saved progress and shared messages refresh every five seconds.');
    history.replaceState(null, '', `/?group=${encodeURIComponent(id)}`);
    return group;
  }
  async function findMatches(semantic = false) {
    if (state.edited) throw new Error('Confirm your draft preferences before finding new matches.');
    const id = state.group.id, epoch = state.epoch;
    const plan = semantic ? await state.options.api(path(id, '/recommendations'), {domain: $('room-domain').value, objective: $('room-ai-objective').value || 'compromise'}) :
      await state.options.api(path(id, `/plan?domain=${encodeURIComponent($('room-domain').value)}`));
    if (!current(id, epoch)) return;
    state.plan = plan; plannerView('comparison');
    state.offer = state.quote = null; state.seats = []; renderSeats();
    const parent = $('room-plan-results'); parent.replaceChildren();
    const ranking = plan.recommendation;
    $('room-ai-ranking-note').textContent = ranking ? ranking.mode === 'semantic' ?
      `Local BGE executed: ${ranking.catalogDocumentCount} eligible catalog descriptions x ${ranking.tasteTextCount} confirmed taste inputs in ${Math.round(ranking.inferenceMs)} ms (${ranking.descriptiveMemberCount}/${ranking.memberCount} members). ${ranking.appliedOrderChanged ? 'It changed the displayed order from the verified schedule order.' : ranking.semanticChangedRulesOrder ? 'It produced a different semantic view; this neutral view keeps schedule order.' : 'It evaluated every option and kept the same order.'} Local model: ${ranking.model} at ${String(ranking.revision || '').slice(0, 8)}. This is retrieval evidence, not an accuracy or satisfaction score.` :
      ranking.mode === 'no_matches' ? 'No eligible plan to compare yet. Your confirmed limits are still in effect. See what blocks each plan below.' :
      `AI ranking did not run (${readable(ranking.mode)}). ${plan.explanation}` : '';
    const actions = $('room-ai-actions'); actions.replaceChildren();
    if (ranking && ['needs_tastes', 'needs_clarification'].includes(ranking.mode)) {
      actions.append(button('Add or review my likes', reviewForAI));
      $('room-ai-ranking-note').scrollIntoView({block: 'center', behavior: 'auto'});
    } else if (ranking?.mode === 'needs_confirmation' && !state.preference?.isConfirmed) {
      actions.append(button('Review my preferences', reviewForAI));
    } else if (ranking?.mode === 'needs_confirmation') {
      actions.append(button('Refresh group progress', () => $('room-refresh').click()));
    } else if (ranking?.mode === 'needs_members') {
      actions.append(button('Copy invite', () => $('copy-invite-btn').click()));
    } else if (ranking?.mode === 'no_matches' && !plan.explanation?.startsWith('No upcoming experiences')) {
      actions.append(button('Review my budget & availability', () => reviewForAI('constraints')),
        button('Find changes I can make', () => run(() => rescue(true))));
      const alternative = $('room-domain').value === 'excursion' ? 'movie' : 'excursion';
      const alternatives = upcomingOffers(state.options.getOffers(), alternative, state.group.memberCount);
      if (alternatives.length) actions.append(button(`View ${alternatives.length} ${alternative === 'movie' ? 'cinema nights' : 'outdoor escapes'}`, () => {
        if (locked() || frozen()) return;
        $('room-domain').value = alternative;
        $('room-domain').dispatchEvent(new Event('change', {bubbles: true}));
        run(compareSuggestions);
      }));
    } else if (ranking?.mode === 'unavailable') {
      actions.append(node('p', 'Verified matches are shown below. AI is unavailable on this server; retry after the host checks its model setup.', 'fine'));
    }
    if (plan.needsMembers) { parent.append(node('p', 'Invite at least one friend first. Prepare your own preferences while they join.')); return; }
    if (!plan.allConfirmed) { parent.append(node('p', `Waiting for confirmed preferences from: ${(plan.unconfirmedMembers || []).join(', ')}.`)); return; }
    const summary = ranking?.mode === 'needs_clarification' ? 'Review the taste descriptions before AI comparison.' :
      plan.matches?.length ? ranking?.mode === 'semantic' ? `Local BGE AI compared ${plan.matches.length} verified experiences after deterministic eligibility checks.` :
        `${plan.matches.length} verified matches. ${ranking ? 'These have not been ranked by AI.' : ''}` :
        'No compatible experience yet. Review the blockers below or discuss another plan.';
    parent.append(node('p', summary));
    if (plan.explanation) parent.append(node('p', plan.explanation, 'fine'));
    if (!plan.matches?.length && plan.blockedOptions?.length) renderBlockers(parent, plan.blockedOptions);
    else if (!plan.matches?.length) for (const conflict of plan.conflicts || []) parent.append(node('p', conflict.reason || conflict.type, 'fine'));
    const compromiseIds = ranking?.views?.compromise || [];
    const averageIds = ranking?.views?.average || [];
    for (const [idx, offer] of (plan.matches || []).entries()) {
      const isTop = idx === 0 && Boolean(offer.recommendationLabel);
      const card = node('article', undefined, `room-match${isTop ? ' room-match-top' : ''}`);
      if (offer.id === state.startingOffer?.id) card.append(node('p', 'YOUR STARTING POINT · VERIFIED', 'eyebrow'));
      if (offer.recommendationLabel) card.append(node('p', offer.recommendationLabel, 'eyebrow'));
      const compRank = compromiseIds.indexOf(offer.id) + 1;
      const avgRank = averageIds.indexOf(offer.id) + 1;
      if (compRank > 0 && avgRank > 0) {
        card.append(node('p', `Fairness rank #${compRank} · Overall fit rank #${avgRank}`, 'fine room-match-ranks'));
        const regretPct = Math.round(Math.max(1, 100 - compRank * 12));
        const fitPct = Math.round(Math.max(1, 100 - avgRank * 10));
        const matrix = node('div', undefined, 'room-regret-matrix');
        matrix.innerHTML = `
          <div class="regret-meter-row">
            <span class="fine">Minimax Fairness:</span>
            <div class="exp-bar-track" style="height:6px; flex:1; margin:0 8px;"><div class="exp-bar-fill" style="width:${regretPct}%; background:linear-gradient(90deg,#2fd7b0,#6f7bff);"></div></div>
            <strong style="font-size:11px;">${regretPct}% fit</strong>
          </div>
          <div class="regret-meter-row">
            <span class="fine">Group Mean Utility:</span>
            <div class="exp-bar-track" style="height:6px; flex:1; margin:0 8px;"><div class="exp-bar-fill" style="width:${fitPct}%; background:linear-gradient(90deg,#6f7bff,#b06bff);"></div></div>
            <strong style="font-size:11px;">${fitPct}% avg</strong>
          </div>
        `;
        card.append(matrix);
      }
      card.append(node('h3', offer.title), node('p', schedule(offer.scheduleTime)), node('p', `Exact shares: ${offer.shareValues.join(' + ')} USD`, 'fine'));
      if (state.group.role === 'organizer') card.append(button('Review seats & shares', () => {
        state.offer = offer; state.seats = [...offer.proposedResourceIDs]; state.quote = null;
        renderSeats(); renderControls(); $('interactive-seat-map').scrollIntoView({block: 'nearest', behavior: 'auto'});
      }));
      else card.append(node('p', 'Your organizer selects the experience.', 'fine'));
      parent.append(card);
    }
    return plan;
  }
  function renderBlockers(parent, options) {
    const reasons = {
      BUDGET_EXCEEDED: 'Your confirmed budget is below this share.',
      SCHEDULE_DATE_MISMATCH: 'This date is outside your confirmed dates.',
      SCHEDULE_DAY_MISMATCH: 'This weekday is outside your confirmed days.',
      SCHEDULE_TIME_EARLY: 'This starts before your confirmed time window.',
      SCHEDULE_TIME_LATE: 'This starts after your confirmed time window.',
      SCHEDULE_FINISH_LATE: 'This finishes after your confirmed deadline.'
    };
    for (const offer of options) {
      const card = node('article', undefined, 'room-match room-blocked');
      const when = new Date(offer.scheduleTime).toLocaleString(undefined, {timeZone: offer.timezone});
      card.append(node('p', 'NOT ELIGIBLE YET', 'eyebrow'), node('h3', offer.title),
        node('p', `${when} (${offer.timezone})`), node('p', `Your exact share: ${offer.ownShareValue} ${offer.currency}`));
      const issues = node('ul');
      if (!offer.capacityAvailable) issues.append(node('li', 'There are not enough adjacent seats or available places for your group.'));
      for (const issue of offer.ownConflicts) issues.append(node('li', reasons[issue.type] || 'Review your confirmed constraints for this plan.'));
      if (offer.otherConstraintsBlock) issues.append(node('li', 'Another member’s confirmed constraints also block this plan. They must review their own fields; their private limits are not shown.'));
      else if (offer.capacityAvailable && offer.ownConflicts.length) issues.append(node('li', 'Changes to your own fields could unlock this plan. Use “Find changes I can make” to preview them.'));
      card.append(issues); parent.append(card);
    }
  }
  function reviewForAI(kind = 'tastes') {
    if (frozen()) return;
    plannerView('preferences');
    state.pendingAI = true;
    const hasFields = !!state.preference?.interpretation;
    $('room-ai-ranking-note').textContent = hasFields && kind === 'constraints' ?
      'Review your budget, days and times against the plans shown. Change only what you agree to, then confirm to compare again. Blank fields mean flexible.' : hasFields ?
      'Add a short description of what you enjoy, then confirm your fields. We will run the AI comparison after your confirmation.' :
      'Describe your budget, timing and interests in your private planning space first. Review the fields before confirming and comparing.';
    const target = $(hasFields ? 'room-preference-review' : 'chat-input-form');
    target.scrollIntoView({block: 'center', behavior: 'auto'});
    if (hasFields && kind === 'constraints') $('pref-advanced').open = true;
    $(hasFields ? kind === 'constraints' ? 'pref-budget' : 'pref-soft' : 'chat-input-text').focus();
    renderControls();
  }
  async function compareSuggestions() {
    if (state.edited || !state.preference?.isConfirmed) { reviewForAI(); return; }
    const id = state.group.id, epoch = state.epoch;
    state.comparing = true;
    $('room-ai-ranking-note').textContent = 'Checking confirmed preferences and comparing eligible plans with local AI…';
    $('room-ai-actions').replaceChildren(); renderControls();
    try { return await findMatches(true); }
    catch (error) {
      if (error.privateGroupAccessLost) throw error;
      if (current(id, epoch)) {
        state.plan = null;
        state.offer = state.quote = null; state.seats = [];
        $('room-plan-results').replaceChildren(); renderSeats();
        $('room-ai-ranking-note').textContent = `Comparison could not finish. ${error.message}`;
        $('room-ai-actions').replaceChildren(button('Retry comparison', () => run(compareSuggestions)));
      }
      throw error;
    } finally {
      if (current(id, epoch)) { state.comparing = false; renderControls(); }
    }
  }
  function renderRescues(summary) {
    const compareAfterConfirm = state.rescueCompare;
    const parent = $('room-rescue-results'); parent.replaceChildren(node('p', summary));
    $('rescue-mode').textContent = 'Verified what-if calculations · not an AI-generated agreement. Review every proposed change.';
    for (const proposal of state.rescues.slice(0, 3)) {
      const card = node('article', undefined, 'rescue-option');
      card.append(node('h4', proposal.title), node('p', `${schedule(proposal.scheduleTime)} · Your exact share: ${proposal.ownShareValue} USD`));
      const changes = node('ul');
      for (const item of proposal.changes) changes.append(node('li', item.label));
      if (!proposal.changes.length) changes.append(node('li', 'Already fits every confirmed member. No preference change needed.'));
      card.append(changes);
      if (proposal.changes.length) card.append(button('Preview changes in my fields', () => {
        if (locked() || frozen()) return;
        state.pendingAI = compareAfterConfirm;
        state.plan = null; plannerView('preferences');
        state.draft = proposal.constraints; state.edited = true; state.quote = state.offer = null; state.seats = [];
        $('room-plan-results').replaceChildren(); renderPrivate(); renderSeats(); renderControls();
        $('room-preference-review').scrollIntoView({block: 'center', behavior: 'auto'});
        status('Draft preview only. Review the changed fields and confirm to save your own preferences.');
      }));
      else card.append(button('Find this in group matches', () => run(findMatches)));
      parent.append(card);
    }
  }
  async function rescue(compareAfterConfirm = false) {
    const id = state.group.id, epoch = state.epoch;
    const result = await state.options.api(path(id, '/rescue'), {domain: $('room-domain').value});
    if (!current(id, epoch)) return;
    state.rescues = result.proposals || []; state.rescueCompare = compareAfterConfirm;
    renderRescues(result.summary);
    $('room-rescue-results').scrollIntoView({block: 'center', behavior: 'auto'});
    status(result.summary);
  }
  function sdk() {
    if (!state.options.getConfig().configured) return Promise.reject(new Error('Planning is ready. PayPal Sandbox credentials are needed for checkout.'));
    if (state.sdk) return state.sdk;
    state.sdk = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://www.paypal.com/sdk/js?' + new URLSearchParams({'client-id': state.options.getConfig().clientID, currency: 'USD', intent: 'authorize', components: 'buttons'});
      script.setAttribute('data-namespace', 'paypalGroup');
      script.onload = () => {
        if (root.paypalGroup?.Buttons) resolve(root.paypalGroup);
        else { state.sdk = null; reject(new Error('PayPal approval could not initialize. Refresh saved status to retry.')); }
      };
      script.onerror = () => { state.sdk = null; reject(new Error('PayPal approval could not load. Recheck your connection.')); };
      document.head.append(script);
    });
    return state.sdk;
  }
  async function renderPayPal() {
    const enabled = canApprove(state.booking) && $('room-consent').checked && state.options.getConfig().configured;
    const key = enabled ? `${state.group.id}:${state.booking.purchaseID}:${state.booking.myShare.state}:${state.epoch}` : '';
    if (key === state.buttonKey) return;
    const old = state.buttons;
    state.buttons = null; state.buttonKey = key;
    if (old) { try { await old.close(); } catch {} }
    if (state.buttonKey !== key) return;
    $('group-paypal-buttons').replaceChildren();
    if (!enabled) return;
    const id = state.group.id, epoch = state.epoch;
    let provider;
    try { provider = await sdk(); }
    catch (error) { if (current(id, epoch) && state.buttonKey === key) state.buttonKey = ''; throw error; }
    if (!current(id, epoch) || state.buttonKey !== key) return;
    const done = async () => { if (current(id, epoch)) { state.approval = false; await refresh(); } };
    state.buttons = provider.Buttons({
      style: {layout: 'vertical', shape: 'rect', label: 'paypal'},
      onClick(_data, actions) { return !locked() && current(id, epoch) && $('room-consent').checked && canApprove(state.booking) ? actions.resolve() : actions.reject(); },
      async createOrder() {
        if (!current(id, epoch) || !canApprove(state.booking) || !$('room-consent').checked) throw new Error('Review your saved share before approval.');
        state.approval = true; renderControls();
        try {
          await state.options.api(path(id, '/booking/consent'), {});
          const order = await state.options.api(path(id, '/contributions/order'), {});
          if (!order.orderID || !current(id, epoch)) throw new Error('Recheck the saved order before continuing.');
          return order.orderID;
        } catch (error) { await done(); throw error; }
      },
      async onApprove() {
        try {
          await state.options.api(path(id, '/contributions/authorize'), {});
          if (current(id, epoch)) status('Your authorization is verified. Tickets remain locked until all group captures complete.');
        } catch (error) { if (current(id, epoch)) reportError(error, ' Recheck your saved order.'); }
        finally { await done(); }
      },
      async onCancel() { if (current(id, epoch)) status('Approval closed. Your saved order remains available for recheck.'); await done(); },
      async onError(error) { if (current(id, epoch)) status(`${error.message || 'Approval interrupted.'} Recheck before another attempt.`, true); await done(); },
    });
    await state.buttons.render('#group-paypal-buttons');
  }
  async function loadTicket() {
    const id = state.group.id, epoch = state.epoch;
    const ticket = await state.options.api(path(id, '/ticket'));
    if (!current(id, epoch) || state.booking.state !== 'CONFIRMED') return;
    state.ticket = ticket;
    for (const [field, value] of Object.entries({'pass-title-val': ticket.title, 'pass-sub-val': schedule(ticket.scheduleTime), 'pass-seat-val': ticket.assignedResource, 'pass-inline-code': ticket.ticketCode, 'pass-holder-val': ticket.alias, 'pass-share-val': `${ticket.shareValue} ${ticket.currency}`, 'pass-capture-val': ticket.captureID})) $(field).textContent = value;
    const image = node('img'); image.src = path(id, '/ticket/qr'); image.alt = 'QR encoding of your private demonstration ticket reference';
    $('pass-inline-qr').replaceChildren(image); $('canvas-wallet-pass').hidden = false;
  }
  function init(options) {
    state.options = options;
    const form = (id, task) => $(id).addEventListener('submit', (event) => { event.preventDefault(); run(task); });
    form('chat-input-form', async () => {
      const id = state.group.id, epoch = state.epoch, rawText = $('chat-input-text').value.trim();
      if (!rawText) return;
      const preference = await options.api(path(id, '/preferences'), {rawText, userTz: Intl.DateTimeFormat().resolvedOptions().timeZone});
      if (!current(id, epoch)) return;
      state.preference = preference; state.offer = state.quote = null; state.seats = [];
      state.plan = null; plannerView('preferences');
      $('room-ai-ranking-note').textContent = '';
      $('room-ai-actions').replaceChildren();
      state.draft = null; state.edited = false; state.rescues = []; $('room-rescue-results').replaceChildren();
      $('room-plan-results').replaceChildren(); renderPrivate(); renderSeats();
      await refresh(); if (current(id, epoch)) status('Review and edit the extracted fields, then confirm your preferences.');
    });
    form('room-preference-review', async () => {
      const id = state.group.id, epoch = state.epoch;
      const value = constraints({budget: $('pref-budget').value, days: $('pref-days').value, dates: $('pref-dates').value,
        timezone: $('pref-timezone').value, earliest: $('pref-earliest').value, latest: $('pref-latest').value,
        finish_before: $('pref-finish').value, preferences: $('pref-soft').value});
      await options.api(path(id, '/preferences/confirm'), {confirmedConstraints: value});
      const preference = await options.api(path(id, '/preferences'));
      if (!current(id, epoch)) return;
      state.draft = null; state.edited = false; state.rescues = []; $('room-rescue-results').replaceChildren();
      state.preference = preference; state.plan = null; plannerView('comparison'); renderPrivate(); await refresh();
      if (!current(id, epoch)) return;
      const compareAfterConfirm = state.pendingAI;
      state.pendingAI = false;
      if (compareAfterConfirm) await compareSuggestions(); else await findMatches();
      if (current(id, epoch)) status(compareAfterConfirm ? 'Your preferences are confirmed. Review the AI comparison status and results.' : 'Your preferences are confirmed. Group matches respect every confirmed member.');
    });
    form('room-shared-form', async () => {
      const id = state.group.id, epoch = state.epoch, text = $('room-shared-text').value.trim();
      if (!text) return;
      await options.api(path(id, '/messages'), {text});
      if (current(id, epoch)) { $('room-shared-text').value = ''; await refresh(); if (current(id, epoch)) status('Message shared with your group.'); }
    });
    form('room-agent-form', async () => {
      const text = $('room-agent-input').value.trim();
      if (!text) return;
      $('room-agent-input').value = '';
      await askAssistant(text);
    });
    form('room-profile-form', async () => {
      const id = state.group.id, epoch = state.epoch;
      await options.api(path(id, '/profile'), {alias: $('room-alias').value.trim(), shareProgress: $('room-share-progress').checked});
      if (current(id, epoch)) { await refresh(); if (current(id, epoch)) status('Your group profile and privacy choice are saved.'); }
    });
    $('room-show-preferences').addEventListener('click', () => { plannerView('preferences'); });
    $('room-show-comparison').addEventListener('click', () => { plannerView('comparison'); });
    $('room-ai-recommend').addEventListener('click', () => {
      if (locked()) return;
      if (state.edited || !state.preference?.isConfirmed) reviewForAI(); else run(compareSuggestions);
    });
    $('room-ai-objective').addEventListener('change', () => {
      renderObjectiveHint();
      state.plan = null;
      state.offer = state.quote = null; state.seats = [];
      $('room-plan-results').replaceChildren(); $('room-ai-ranking-note').textContent = '';
      $('room-ai-actions').replaceChildren();
      renderSeats(); renderControls();
    });
    renderObjectiveHint();
    $('room-agent-quick-next').addEventListener('click', () => run(() => askAssistant('What is our next best step for this room right now?')));
    $('room-agent-quick-blockers').addEventListener('click', () => run(() => askAssistant('Why are we blocked right now and what can I change on my side?')));
    $('room-agent-quick-payment').addEventListener('click', () => run(() => askAssistant('What is our current payment risk and what should we do next safely?')));
    $('room-rescue').addEventListener('click', () => run(rescue));
    $('room-preference-review').addEventListener('input', () => {
      state.plan = null; plannerView('preferences');
      state.edited = true; state.quote = state.offer = null; state.seats = [];
      $('room-ai-ranking-note').textContent = '';
      $('room-ai-actions').replaceChildren();
      state.rescues = []; $('room-rescue-results').replaceChildren();
      $('pref-review-status').textContent = 'DRAFT CHANGE · CONFIRM TO SAVE';
      $('room-plan-results').replaceChildren(); renderSeats(); renderControls();
    });
    $('room-next-button').addEventListener('click', () => {
      if (state.group.memberCount < 2 && state.group.inviteURL) { $('copy-invite-btn').click(); return; }
      if (!frozen() && !state.offer && !state.edited && state.room?.journey?.action === 'compare') {
        plannerView('comparison'); $('room-comparison-stage').scrollIntoView({block: 'center', behavior: 'auto'});
        $('room-ai-recommend').focus(); return;
      }
      if (!frozen() && !state.offer) plannerView('preferences');
      const id = state.booking?.state === 'CONFIRMED' ? 'canvas-wallet-pass' : frozen() ? 'room-payment-card' : state.offer ? 'room-selection-tools' : state.preference?.interpretation ? 'room-preference-review' : 'chat-input-form';
      $(id).scrollIntoView({block: 'center', behavior: 'auto'});
      if (id === 'chat-input-form') $('chat-input-text').focus();
    });
    $('room-domain').addEventListener('change', () => {
      state.plan = null;
      state.offer = state.quote = null; state.seats = []; state.rescues = [];
      $('room-ai-ranking-note').textContent = '';
      $('room-ai-actions').replaceChildren();
      $('room-plan-results').replaceChildren(); $('room-rescue-results').replaceChildren();
      renderSeats(); renderControls();
    });
    $('room-quote-btn').addEventListener('click', () => run(async () => {
      const id = state.group.id, epoch = state.epoch, offer = state.offer, seats = [...state.seats];
      const quote = await options.api(path(id, '/quote'), {offerID: offer.id, resourceIDs: seats});
      if (!current(id, epoch) || state.offer !== offer || seats.join() !== state.seats.join()) return;
      state.quote = quote; renderQuote(); status('Review the exact server quote before holding seats.');
    }));
    $('btn-lock-freeze').addEventListener('click', () => run(async () => {
      if (!state.quote) throw new Error('Get a fresh server quote first.');
      const id = state.group.id, epoch = state.epoch;
      await options.api(path(id, '/freeze'), {offerID: state.offer.id, resourceIDs: state.seats});
      if (current(id, epoch)) { await refresh(); if (current(id, epoch)) { renderSeats(); status('Places held for 15 minutes. Everyone approves only their own share.'); } }
    }));
    for (const [id, suffix] of [['room-recheck', '/contributions/reconcile'], ['room-recover', '/recover'], ['room-cancel', '/booking/void'], ['canvas-finalize-btn', '/finalize']]) $(id).addEventListener('click', () => run(async () => {
      if (id === 'room-cancel' && !root.confirm('Cancel this reservation? Existing payment holds or captures may need void or refund recovery.')) return;
      const gid = state.group.id, epoch = state.epoch;
      try { await options.api(path(gid, suffix), {}); }
      finally { if (current(gid, epoch)) await refresh(); }
      if (current(gid, epoch)) status('Saved status updated. Review the next action and any pending payment outcomes.');
    }));
    $('room-refresh').addEventListener('click', () => run(refresh));
    $('room-consent').addEventListener('change', () => renderPayPal().catch(reportError));
    $('copy-invite-btn').addEventListener('click', () => run(async () => {
      try {
        await navigator.clipboard.writeText(state.group.inviteURL);
        const message = 'Invite copied — send it to your friends. Each person joins from their own browser profile or device.';
        status(message);
        root.GroupPayToast?.(message);
      }
      catch { $('room-invite-link').value = state.group.inviteURL; $('room-invite-link').hidden = false; $('room-invite-link').select(); status('Copy the selected invite manually.'); }
    }));
    document.querySelectorAll('.chip-preset').forEach((chip) => chip.addEventListener('click', () => { $('chat-input-text').value = chip.dataset.text; $('chat-input-text').focus(); }));
    $('btn-download-pass').addEventListener('click', () => {
      if (!state.ticket) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify({scope: 'fictional-private-ticket', ...state.ticket}, null, 2)], {type: 'application/json'}));
      const link = node('a'); link.href = url; link.download = 'grouppay-ticket.json'; link.click(); URL.revokeObjectURL(url);
    });
    $('btn-print-pass').addEventListener('click', () => root.print());
    $('btn-scan-validator').addEventListener('click', () => {
      if (!state.ticket) return;
      $('qr-validator-modal').hidden = false; $('ticket-check-code').value = '';
      $('ticket-check-result').textContent = 'Paste your ticket code. This checks your owned record; it does not redeem venue admission.';
      $('ticket-check-code').focus();
    });
    form('ticket-check-form', async () => {
      const id = state.group.id, epoch = state.epoch;
      const result = await options.api(path(id, '/ticket/check'), {ticketCode: $('ticket-check-code').value});
      if (current(id, epoch)) $('ticket-check-result').textContent = result.valid ? `Verified against your confirmed private ticket: ${result.offeringTitle} · ${result.assignedResource}. No admission was redeemed.` : 'This code does not match your confirmed private ticket.';
    });
    $('close-validator-modal-btn').addEventListener('click', () => { $('qr-validator-modal').hidden = true; $('btn-scan-validator').focus(); });
    if (!state.poll) {
      state.poll = setInterval(() => {
        if (state.group && !locked() && !document.hidden && options.isVisible()) refresh().catch(reportError);
      }, 5000);
      setInterval(() => { if (state.group && !document.hidden) countdown(); }, 1000);
    }
  }
  root.GroupPayRoom = {init, open, refresh, helpers};
})(typeof window === 'undefined' ? globalThis : window);

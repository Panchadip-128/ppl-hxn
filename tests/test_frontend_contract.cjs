'use strict';
// Behavioral HTTP/DOM/SDK checks. This adapter does not render a browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const helpers = require('../public/room.js');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const sources = Object.fromEntries(['discovery', 'guide', 'demo', 'room', 'merchant', 'app'].map((name) => [name, fs.readFileSync(path.join(__dirname, `../public/${name}.js`), 'utf8')]));
assert.doesNotMatch(html, /ai-worker\.mjs|Enable on-device AI|Rank options with my AI vibe/i, 'The product exposes one group AI model, not a second unverified browser model');
assert.doesNotMatch(sources.discovery, /GroupPayAI|rankVerified|aiReady/, 'Discovery is explicit keyword search');
assert.equal(helpers.cents('33.34'), 3334);
assert.equal(helpers.cents(''), null);
assert.throws(() => helpers.cents('1.001'));
assert.throws(() => helpers.cents('-1'));
assert.equal(helpers.constraints({budget: '0', days: '', dates: '', timezone: 'UTC'}).budget_cents, 0);
assert.deepEqual(helpers.constraints({budget: '', days: 'Friday, Saturday', dates: '', timezone: 'UTC'}).preferred_days, ['friday', 'saturday']);
assert.throws(() => helpers.constraints({budget: '', days: 'Any day', dates: '', timezone: 'UTC'}), /weekday names/);
assert.equal(helpers.canApprove({state: 'AWAITING_AUTHORIZATIONS', holdDeadline: 200, myShare: {state: 'ACCEPTED'}}, 100), true);
assert.equal(helpers.canApprove({state: 'RECOVERY_REQUIRED', holdDeadline: 200, myShare: {state: 'ACCEPTED'}}, 100), false);
assert.equal(helpers.canApprove({state: 'AWAITING_AUTHORIZATIONS', holdDeadline: 99, myShare: {state: 'ACCEPTED'}}, 100), false);
assert.equal(helpers.upcomingOffers([
  {domain: 'excursion', scheduleTime: '2030-11-01T19:00:00Z', availability: {status: 'available', groupSizes: [2]}},
  {domain: 'excursion', scheduleTime: '2030-11-01T19:00:00Z', availability: {status: 'available', groupSizes: [3]}},
  {domain: 'excursion', scheduleTime: '2030-11-01T19:00:00Z', availability: {status: 'unavailable', groupSizes: []}},
  {domain: 'excursion', scheduleTime: '2030-11-01T19:00:00Z', availability: {status: 'past', groupSizes: []}},
], 'excursion', 2, Date.parse('2030-01-01T00:00:00Z')).length, 1, 'Only future, group-size-compatible catalog sessions are offered');
assert.equal(helpers.futureOffers([
  {domain: 'excursion', availability: {status: 'unavailable'}},
  {domain: 'excursion', availability: {status: 'past'}},
], 'excursion').length, 1, 'Future sessions lacking inventory are distinguished from expired catalog dates');

let context;
let redirectTarget = null, privateGroupFailure = false;
const sdk = {}, events = {}, requests = [], failures = [];
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.handlers = {}; this.attributes = {}; this.value = '';
    this.textContent = ''; this._html = ''; this.hidden = false; this.checked = false; this.disabled = false;
    this.style = {}; this.dataset = {}; this.classList = {toggle() {}, add() {}, remove() {}};
  }
  set innerHTML(value) { this._html = value; this.children = []; }
  get innerHTML() { return this._html || String(this.textContent).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
  append(...items) {
    this.children.push(...items);
    if (this === head && items[0]?.tagName === 'script') {
      const script = items[0], intent = new URL(script.src).searchParams.get('intent');
      const namespace = script.attributes['data-namespace'] || 'paypal';
      context[namespace] = {Buttons(options) { sdk[intent] = options; return {render: async () => {}, close: async () => {}}; }};
      script.onload();
    }
  }
  appendChild(item) { this.append(item); }
  prepend(...items) { this.children.unshift(...items); }
  replaceChildren(...items) { this.children = items; this._html = ''; }
  addEventListener(name, callback) { (this.handlers[name] ||= []).push(callback); }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  removeAttribute(key) { delete this.attributes[key]; }
  querySelector(selector) { if (selector === 'button') return this.formButton ||= new Element('button'); return null; }
  querySelectorAll() { return []; }
  focus() {} select() {} scrollIntoView() {} click() {}
}
const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], new Element()]));
for (const source of [sources.app, sources.room, sources.merchant]) for (const match of source.matchAll(/\$\('([^']+)'\)/g)) assert.ok(elements.has(match[1]), `Missing HTML element: ${match[1]}`);
elements.get('room-domain').value = 'movie';
elements.get('room-consent').checked = false;
const head = new Element('head');
const offer = {id: 'movie-one', domain: 'movie', title: 'An actual catalog screening', description: 'Fictional cinema', merchantID: 'fictional-cinema', value: '16.00', priceMinor: 1600, currency: 'USD', scheduleTime: '2030-11-01T19:00:00Z',
  resources: [1, 2].map((i) => ({id: `seat-${i}`, row_label: 'A', col_number: i, label: `Seat A${i}`, state: 'FREE'})), proposedResourceIDs: ['seat-1', 'seat-2'], shareValues: ['16.00', '16.00']};
const group = {id: 'g1', name: 'Friends', role: 'organizer', memberCount: 2, inviteURL: 'http://localhost/?invite=opaque', members: [{participantID: 'owner', alias: 'Alice'}, {participantID: 'friend', alias: 'Member 2'}], myProfile: {alias: 'Alice', shareProgress: false}};
const room = {memberCount: 2, confirmedCount: 0, messages: [{id: 'm1', participantID: 'friend', alias: 'Member 2', text: '<img src=x onerror=alert(1)>', isSelf: false}], nextAction: 'Review preferences.'};
const interpretation = {budget_cents: 1237, currency: 'USD', preferred_days: ['monday'], dates: [], time_window: {earliest: '19:00'}, timezone: 'UTC', soft_preferences: [], hard_constraints: [], clarifications: [], processingMode: 'manual_fallback'};
let preference = {interpretation: null, confirmedConstraints: null, isConfirmed: false, rawText: '', guidance: {label: 'Local preference helper'}};
let booking = {hasBooking: false}, matches = [], rejectNextQuote = false, recommendationMode = 'semantic';
const ticket = {ticketID: 'private-ticket', ticketCode: 'TICKET-private', title: offer.title, scheduleTime: offer.scheduleTime, assignedResource: 'Seat A1', alias: 'Alice', shareValue: '16.00', currency: 'USD', captureID: 'CAPTUREOWN'};
const document = {head, hidden: false,
  getElementById(id) { assert.ok(elements.has(id), id); return elements.get(id); },
  createElement(tag) { return new Element(tag); }, querySelectorAll() { return []; }, querySelector() { return null; },
  addEventListener(name, callback) { (events[name] ||= []).push(callback); }};
context = vm.createContext({console: {log: console.log, warn: console.warn, error(...args) { failures.push(args); }}, document, URL, URLSearchParams, Intl, Date, Map, Set, JSON, Number, String, Promise, Blob,
  setInterval() { return 1; }, clearInterval() {}, setTimeout, clearTimeout, navigator: {}, confirm() { return true; }, print() {}, alert() {},
  location: {search: '', origin: 'http://localhost', replace(target) { redirectTarget = target; }}, history: {replaceState() {}},
  fetch: async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined; requests.push({url, body, options});
    let result;
    if (privateGroupFailure && url.startsWith('/api/groups/lost')) {
      return {ok: false, status: 404, json: async () => ({error: 'GROUP_NOT_FOUND'})};
    }
    if (url === '/api/config') result = {participantID: 'owner', csrfToken: 'csrf', configured: true, clientID: 'public-client', planningMode: 'local', workshops: [], bookings: []};
    else if (url === '/api/groups/g2') result = {...group, id: 'g2', name: 'Another group'};
    else if (url === '/api/groups/g2/booking') result = {hasBooking: false};
    else if (url === '/api/groups/g2/room') result = {memberCount: 2, confirmedCount: 0, messages: []};
    else if (url === '/api/groups/g2/preferences') result = {interpretation: null, confirmedConstraints: null, rawText: '', isConfirmed: false};
    else if (url === '/api/catalog/offers') result = {offers: [offer]};
    else if (url === '/api/groups') result = {groups: [group]};
    else if (url === '/api/groups/g1') result = group;
    else if (url.endsWith('/booking')) result = booking;
    else if (url.endsWith('/room')) result = room;
    else if (url.endsWith('/preferences') && body) { preference = {rawText: body.rawText, interpretation, confirmedConstraints: null, isConfirmed: false, guidance: {label: 'Local preference helper', summary: 'Draft budget $12.37', nextAction: 'Review.'}}; result = preference; }
    else if (url.endsWith('/preferences')) result = preference;
    else if (url.endsWith('/preferences/confirm')) { preference = {...preference, confirmedConstraints: body.confirmedConstraints, isConfirmed: true, guidance: {label: 'Local preference helper', summary: `Confirmed budget $${(body.confirmedConstraints.budget_cents / 100).toFixed(2)}`}}; room.confirmedCount = 2; result = preference; }
    else if (url.endsWith('/rescue')) result = {summary: 'An explicit change to your own budget can unlock this plan.', proposals: [{...offer, ownShareValue: '20.00', changes: [{label: 'Raise your ceiling from $18.99 to $20.00.'}], constraints: {...preference.confirmedConstraints, budget_cents: 2000}}]};
    else if (url.includes('/plan?')) result = {allConfirmed: true, matches, conflicts: matches.length ? [] : [{reason: 'No offer fits the confirmed constraints.'}], explanation: 'Actual catalog result.'};
    else if (url.endsWith('/recommendations')) result = {allConfirmed: true, matches: matches.map((item) => ({...item, recommendationLabel: 'Balanced pick'})), conflicts: [], explanation: recommendationMode === 'semantic' ? 'Verified eligible plans, ordered by modeled compromise.' : 'Add and confirm descriptive tastes before AI comparison.', recommendation: {mode: recommendationMode, model: 'test-model', revision: '1234567890', elapsedMs: 25, inferenceMs: 12, inferenceExecuted: recommendationMode === 'semantic', eligibleCount: matches.length, catalogDocumentCount: matches.length, tasteTextCount: 2, descriptiveMemberCount: 2, memberCount: 2, appliedOrderChanged: true, semanticChangedRulesOrder: true}};
    else if (url.endsWith('/messages')) { room.messages.push({id: 'm2', isSelf: true, text: body.text}); result = room.messages.at(-1); }
    else if (url.endsWith('/quote')) {
      if (rejectNextQuote) { rejectNextQuote = false; return {ok: false, status: 409, json: async () => ({error: 'SEAT_UNAVAILABLE'})}; }
      result = {totalValue: '32.00', totalCents: 3200, currency: 'USD', shares: [{participantID: 'owner', shareValue: '16.00'}, {participantID: 'friend', shareValue: '16.00'}], roundingRule: 'Frozen roster order.'};
    }
    else if (url.endsWith('/freeze')) { booking = {hasBooking: true, state: 'AWAITING_AUTHORIZATIONS', purchaseID: 'saved-purchase', title: offer.title, offerID: offer.id, totalValue: '32.00', holdDeadline: Date.now() / 1000 + 900, currency: 'USD', myShare: {state: 'ACCEPTED', shareValue: '16.00', assignedResource: 'Seat A1'}, rosterProgress: []}; result = booking; }
    else if (url.endsWith('/booking/consent')) result = booking;
    else if (url.endsWith('/contributions/order')) result = {orderID: 'SAVEDORDER'};
    else if (url.endsWith('/contributions/authorize')) { booking = {...booking, state: 'FINALIZING', myShare: {...booking.myShare, state: 'AUTHORIZED'}}; result = booking; }
    else if (url.endsWith('/finalize')) { booking = {...booking, state: 'RECOVERY_REQUIRED', recoveryRequired: true}; result = booking; }
    else if (url.endsWith('/recover')) { booking = {...booking, state: 'CONFIRMED', recoveryRequired: false}; result = booking; }
    else if (url.endsWith('/ticket')) result = ticket;
    else if (url.endsWith('/ticket/check')) result = {valid: body.ticketCode === ticket.ticketCode, offeringTitle: ticket.title, assignedResource: ticket.assignedResource};
    else if (url === '/api/planning/preview') result = {scope: 'interpretation_preview', saved: false, interpretation: {injection_detected: true}};
    else throw new Error(`Unexpected API: ${url}`);
    return {ok: true, json: async () => result};
  }});
context.window = context;
const settle = async () => { for (let i = 0; i < 180; i++) await Promise.resolve(); };
async function event(element, name = 'click') {
  const item = typeof element === 'string' ? elements.get(element) : element;
  assert.ok(item.handlers[name]?.length, `Missing ${name} handler`);
  for (const callback of item.handlers[name]) callback({preventDefault() {}});
  await settle();
}
const text = (element) => [element.textContent, ...element.children.map(text)].join(' ');
(async () => {
  for (const source of Object.values(sources)) new vm.Script(source).runInContext(context);
  for (const callback of events.DOMContentLoaded) await callback();
  await settle();
  assert.deepEqual(failures, [], 'Original application bootstrap completes without swallowed errors');
  context.GroupPayDiscover.render('all', [{...offer, availability: {status: 'available', groupSizes: [2]}}]);
  const tooSmall = elements.get('catalog-offers-grid').children.find((item) => item.tagName === 'article');
  assert.equal(tooSmall.children.find((item) => item.className === 'card-body').children.find((item) => item.tagName === 'button').disabled, true, 'Discovery uses backend adjacency for the chosen group size');
  context.GroupPayDiscover.render('all', [{...offer, availability: {status: 'past', groupSizes: []}}]);
  assert.match(text(elements.get('catalog-offers-grid')), /no upcoming sessions/i);
  context.GroupPayDiscover.render('all', [offer]);
  context.GroupPayMerchant.openOffer(offer);
  assert.equal(elements.get('merchant-view').hidden, false, 'Merchant checkout opens before the PayPal approval flow');
  assert.match(text(elements.get('merchant-choice')), /Pay together with PayPal/, 'Merchant checkout offers the group-payment choice');
  assert.ok(text(elements.get('catalog-offers-grid')).includes(offer.title), 'Discovery displays the real catalog');
  await event('show-guide-btn');
  assert.equal(elements.get('guide-modal').hidden, false, 'Walkthrough opens');
  await event('guide-next');
  assert.match(elements.get('guide-description').textContent, /budget and timing/i);
  await event('guide-close');
  elements.get('catalog-search-query').value = 'cinema screening';
  await event('catalog-search-form', 'submit');
  assert.ok(text(elements.get('catalog-offers-grid')).includes(offer.title), 'Keyword search matches actual catalog descriptions');
  elements.get('catalog-search-query').value = 'zzzzzzzz';
  await event('catalog-search-form', 'submit');
  assert.ok(!text(elements.get('catalog-offers-grid')).includes(offer.title), 'Basic search does not invent results');
  await event('catalog-search-clear');
  assert.ok(text(elements.get('catalog-offers-grid')).includes(offer.title));
  await context.selectGroup('g1', {domain: 'excursion'}); await settle();
  assert.equal(elements.get('room-domain').value, 'excursion', 'Discovery choice reaches the group room');
  elements.get('room-domain').value = 'movie';
  assert.equal(elements.get('collab-view').hidden, false);
  assert.ok(text(elements.get('room-shared-feed')).includes('<img src=x onerror=alert(1)>'), 'Shared content stays text');
  assert.ok(!elements.get('room-shared-feed')._html, 'Shared history does not inject HTML');
  elements.get('chat-input-text').value = 'Monday movie under $12.37 after 7pm';
  await event('chat-input-form', 'submit');
  assert.equal(elements.get('pref-budget').value, '12.37');
  assert.equal(elements.get('pref-days').value, 'monday');
  assert.equal(elements.get('pref-earliest').value, '19:00');
  elements.get('pref-budget').value = '18.99';
  await event('room-preference-review', 'submit');
  const confirmed = requests.find((request) => request.url.endsWith('/preferences/confirm'));
  assert.equal(confirmed.body.confirmedConstraints.budget_cents, 1899);
  assert.deepEqual(confirmed.body.confirmedConstraints.preferred_days, ['monday']);
  assert.ok(text(elements.get('chat-messages-container')).includes('Confirmed budget $18.99'));
  assert.equal(elements.get('room-preferences-stage').hidden, true);
  assert.equal(elements.get('room-comparison-stage').hidden, false, 'Confirmation advances to comparison');
  assert.ok(!text(elements.get('chat-messages-container')).includes('Draft budget $12.37'));
  assert.ok(text(elements.get('room-plan-results')).includes('No compatible experience'));
  assert.equal(elements.get('interactive-seat-map').children.length, 1, 'No false first-catalog fallback');
  assert.equal(elements.get('btn-lock-freeze').disabled, true);
  await event('room-rescue');
  const rescueCard = elements.get('room-rescue-results').children.find((item) => item.tagName === 'article');
  const confirmationsBeforePreview = requests.filter((request) => request.url.endsWith('/preferences/confirm')).length;
  await event(rescueCard.children.find((item) => item.tagName === 'button'));
  assert.equal(elements.get('pref-budget').value, '20.00');
  assert.equal(requests.filter((request) => request.url.endsWith('/preferences/confirm')).length, confirmationsBeforePreview, 'Preview never saves or confirms');
  await event('room-preference-review', 'submit');
  assert.equal(requests.filter((request) => request.url.endsWith('/preferences/confirm')).at(-1).body.confirmedConstraints.budget_cents, 2000);
  elements.get('room-shared-text').value = 'Let us choose together';
  await event('room-shared-form', 'submit');
  assert.deepEqual(requests.find((request) => request.url.endsWith('/messages')).body, {text: 'Let us choose together'});
  matches = [offer];
  recommendationMode = 'needs_tastes';
  await event('room-ai-recommend');
  assert.match(elements.get('room-ai-ranking-note').textContent, /did not run/);
  await event(elements.get('room-ai-actions').children.find((item) => item.tagName === 'button'));
  assert.match(elements.get('room-preference-review').querySelector('button').textContent, /Confirm.*compare/);
  elements.get('pref-soft').value = 'science fiction';
  await event('room-preference-review', 'input');
  const comparisonRequests = () => requests.filter((request) => request.url.endsWith('/recommendations')).length;
  const beforeDraft = comparisonRequests();
  await event('room-ai-recommend');
  assert.equal(comparisonRequests(), beforeDraft, 'Unsaved tastes require explicit confirmation, with actionable guidance');
  recommendationMode = 'semantic';
  await event('room-preference-review', 'submit');
  assert.equal(comparisonRequests(), beforeDraft + 1, 'Confirmation resumes the requested AI comparison automatically');
  assert.match(elements.get('room-ai-ranking-note').textContent, /test-model/);
  assert.match(elements.get('room-ai-ranking-note').textContent, /not an accuracy or satisfaction score/);
  assert.equal(comparisonRequests(), 2, 'AI ranking runs on the explicit request and its confirmed continuation, never polling');
  matches = []; recommendationMode = 'no_matches';
  await event('room-ai-recommend');
  assert.match(elements.get('room-ai-ranking-note').textContent, /No eligible plan/);
  assert.equal(elements.get('room-ai-recommend').disabled, true, 'A completed no-match result directs the user to blockers instead of repeating the same request');
  await event(elements.get('room-ai-actions').children.find((item) => item.textContent === 'Find changes I can make'));
  const verifiedRescue = elements.get('room-rescue-results').children.find((item) => item.tagName === 'article');
  await event(verifiedRescue.children.find((item) => item.tagName === 'button'));
  assert.match(elements.get('room-preference-review').querySelector('button').textContent, /Confirm.*compare/, 'A verified tradeoff remains an explicit unsaved draft');
  matches = [offer]; recommendationMode = 'semantic';
  const beforeRescueConfirmation = comparisonRequests();
  await event('room-preference-review', 'submit');
  assert.equal(comparisonRequests(), beforeRescueConfirmation + 1);
  assert.match(elements.get('room-ai-ranking-note').textContent, /Local BGE executed:.*changed the displayed order.*not an accuracy/i,
    'The UI distinguishes executed semantic reranking from accuracy claims');
  const card = elements.get('room-plan-results').children.find((item) => item.tagName === 'article');
  await event(card.children.find((item) => item.tagName === 'button'));
  assert.equal(elements.get('interactive-seat-map').children.length, 2);
  rejectNextQuote = true;
  await event('room-quote-btn');
  assert.match(elements.get('room-next-action').textContent, /no longer available/, 'Errors remain visible at the next-action panel after controls re-render');
  assert.equal(elements.get('btn-lock-freeze').disabled, true);
  await event('room-quote-btn');
  assert.equal(elements.get('quote-display-total').textContent, '32.00 USD');
  assert.equal(elements.get('btn-lock-freeze').disabled, false);
  await event('btn-lock-freeze');
  assert.deepEqual(requests.find((request) => request.url.endsWith('/freeze')).body.resourceIDs, ['seat-1', 'seat-2']);
  assert.equal(elements.get('room-selection-tools').hidden, true, 'Seat selection closes after a saved hold');
  assert.equal(elements.get('room-canvas-empty-title').textContent, 'Places are held for this group.');
  assert.equal(elements.get('room-recheck').hidden, true, 'No redundant approval recheck before a saved order exists');
  await context.selectGroup('g1'); await settle();
  assert.equal(elements.get('quote-display-total').textContent, '32.00 USD', 'Reload restores saved reservation money');
  assert.equal(elements.get('interactive-seat-map').children.length, 2, 'Reload restores the reserved experience canvas');
  elements.get('room-consent').checked = true;
  await event('room-consent', 'change');
  assert.ok(sdk.authorize, 'Group SDK loads AUTHORIZE intent in a separate namespace');
  assert.equal(await sdk.authorize.createOrder(), 'SAVEDORDER');
  assert.equal(requests.filter((request) => request.url.endsWith('/contributions/authorize')).length, 0, 'No server authorization before buyer approval');
  await sdk.authorize.onApprove(); await settle();
  assert.equal(requests.filter((request) => request.url.endsWith('/contributions/authorize')).length, 1);
  await event('canvas-finalize-btn');
  assert.equal(elements.get('canvas-wallet-pass').hidden, true, 'Unresolved captures cannot display a ticket');
  assert.match(elements.get('room-next-action').textContent, /unresolved/);
  await event('room-recover');
  assert.equal(elements.get('canvas-wallet-pass').hidden, false);
  assert.equal(elements.get('pass-capture-val').textContent, 'CAPTUREOWN');
  assert.equal(elements.get('pass-inline-qr').children[0].src, '/api/groups/g1/ticket/qr');
  await event('btn-scan-validator'); elements.get('ticket-check-code').value = 'another-members-code';
  await event('ticket-check-form', 'submit');
  assert.match(elements.get('ticket-check-result').textContent, /does not match/);
  elements.get('ticket-check-code').value = ticket.ticketCode; await event('ticket-check-form', 'submit');
  assert.match(elements.get('ticket-check-result').textContent, /Verified against/);
  await context.runProbe('price-zero');
  assert.match(elements.get('ai-probe-badge').textContent, /FLAGGED/);
  await context.selectGroup('g2'); await settle();
  assert.equal(elements.get('canvas-wallet-pass').hidden, true, 'Switching groups clears the previous private pass');
  assert.equal(elements.get('pass-inline-qr').children.length, 0);
  assert.equal(elements.get('room-consent').checked, false, 'Consent cannot carry to another group');
  assert.ok(!text(elements.get('chat-messages-container')).includes('Confirmed budget $18.99'));
  assert.ok(!text(elements.get('room-shared-feed')).includes('Let us choose together'));
  elements.get('room-domain').value = 'excursion';
  await event('room-domain', 'change');
  vm.runInContext('catalogOffers.splice(0)', context);
  await event('room-refresh');
  assert.match(text(elements.get('room-catalog-status')), /No upcoming outdoor escapes.*no future cinema nights.*ask the organizer/i,
    'An empty catalog gives one clear explanation instead of category and preference detours');
  assert.equal(elements.get('room-ai-recommend').disabled, true, 'AI compare is unavailable when there is nothing to rank');
  assert.equal(elements.get('room-rescue-card').hidden, true, 'Preference rescue is hidden when the catalog has no future options');
  assert.equal(elements.get('room-catalog-status').children.filter((item) => item.tagName === 'button').length, 0,
    'No dead-end category switch is offered');
  privateGroupFailure = true;
  await context.selectGroup('lost'); await settle();
  assert.equal(redirectTarget, '/', 'Lost private group access returns to the base URL');
  assert.doesNotMatch(elements.get('collab-status-feed').textContent, /GROUP_NOT_FOUND/);
  assert.doesNotMatch(elements.get('app-toast').textContent, /GROUP_NOT_FOUND/);
  assert.ok(requests.filter((request) => request.body).every((request) => request.options.headers['X-CSRF-Token'] === 'csrf'));
  assert.ok(!requests.some((request) => /simulate-authorizations|preflight-reserve|add-demo|\/api\/demo\//.test(request.url)));
  assert.deepEqual(failures, []);
  console.log('Guided discovery, walkthrough, unsaved Plan Rescue, private planning, shared chat, exact quote, approval callbacks, recovery and private ticket contracts passed. DOM/HTTP/SDK mocked; no rendered browser or live purchase.');
})().catch((error) => { console.error(error); process.exitCode = 1; });

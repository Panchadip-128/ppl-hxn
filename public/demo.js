'use strict';

// A deliberately separate, ephemeral teaching model. It never talks to the app service.
(function (root) {
  const PEOPLE = ['Alice', 'Bob', 'Charlie'];
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const money = (cents) => `$${(cents / 100).toFixed(2)}`;

  function cents(value) {
    if (!/^\d+(\.\d{1,2})?$/.test(String(value))) throw new Error('Enter a nonnegative amount with up to two decimal places.');
    const [whole, fraction = ''] = String(value).split('.');
    const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(result)) throw new Error('Amount is too large.');
    return result;
  }

  function split(total, count = 3) {
    if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(count) || count < 1) throw new Error('Invalid cent allocation.');
    return Array.from({length: count}, (_, i) => Math.floor(total / count) + (i < total % count ? 1 : 0));
  }

  function normalizeOffers(offers) {
    const normalized = (Array.isArray(offers) ? offers : []).filter((offer) =>
      ['movie', 'excursion'].includes(offer.domain) && offer.currency === 'USD' &&
      Number.isSafeInteger(offer.priceMinor) && offer.priceMinor > 0 &&
      Array.isArray(offer.resources) && offer.resources.length >= 3).map((offer, i) => ({
      id: `SIM-OFFER-${i + 1}`, title: String(offer.title), description: String(offer.description || ''), domain: offer.domain,
      total: offer.priceMinor * (offer.domain === 'movie' ? 3 : 1),
      source: 'Catalog snapshot copied for simulation; real availability is not reserved.',
      resources: offer.resources.map((r, j) => ({id: `SIM-RESOURCE-${i + 1}-${j + 1}`, label: String(r.label), row: String(r.row), col: Number(r.col)})),
    })).filter((offer) => Number.isSafeInteger(offer.total));
    // Fixtures keep the lab available without credentials or an initialized catalog.
    for (const [domain, title, total] of [['movie', 'Fictional cinema screening', 4800], ['excursion', 'Fictional $100 group excursion', 10000]]) {
      if (!normalized.some((o) => o.domain === domain)) normalized.push({
        id: `SIM-FIXTURE-${domain}`, domain, title, description: domain === 'movie' ? 'A cinema night with a story to share.' : 'An outdoor adventure with scenic places.', total,
        source: 'Standalone fictional fixture, not a live catalog offer.',
        resources: Array.from({length: 6}, (_, i) => ({id: `SIM-${domain}-${i + 1}`, label: domain === 'movie' ? `A${i + 1}` : `Place ${i + 1}`, row: 'A', col: i + 1})),
      });
    }
    return normalized;
  }

  function initialResources(offer) {
    if (offer.domain !== 'movie') return offer.resources.slice(0, 3).map((r) => r.id);
    for (const resource of offer.resources) {
      const run = offer.resources.filter((r) => r.row === resource.row && r.col >= resource.col && r.col <= resource.col + 2);
      if (run.length === 3 && new Set(run.map((r) => r.col)).size === 3) return run.sort((a, b) => a.col - b.col).map((r) => r.id);
    }
    return [];
  }

  function createState(offers, scenario = 'movie', run = 1) {
    const catalog = normalizeOffers(offers);
    return start(catalog, scenario, run);
  }

  function start(catalog, scenario, run) {
    if (!['movie', 'excursion', 'chaos'].includes(scenario)) throw new Error('Unknown demo scenario.');
    const selected = catalog.find((o) => o.domain === (scenario === 'excursion' ? 'excursion' : 'movie'));
    return {
      offers: copy(catalog), scenario, run, phase: 'PLANNING', selected: selected.id,
      resources: initialResources(selected), inventory: 'FREE', active: 0, splitView: false,
      members: PEOPLE.map((name, i) => ({name, budget: 5000,
        notes: ['science fiction cinema', 'movie night', 'outdoor adventure'][i],
        confirmed: false, payment: 'NOT_STARTED', available: 5000})),
      shares: [], ledger: [], captureIndex: 0, scan: '',
      timeline: [`SIM session ${run} started. Nothing is saved or sent to a provider.`],
    };
  }

  const offerFor = (state) => state.offers.find((offer) => offer.id === state.selected);

  function suggestions(state) {
    if (state.members.some((member) => !member.confirmed)) return [];
    return state.offers.map((offer) => {
      const shares = split(offer.total, state.members.length);
      const blockers = state.members.filter((member, i) => member.budget < shares[i]).map((member) => member.name);
      const haystack = `${offer.title} ${offer.description || ''} ${offer.domain}`.toLowerCase();
      const matching = state.members.map((member) => {
        const words = [...new Set(member.notes.toLowerCase().match(/[a-z]{3,}/g) || [])];
        return words.filter((word) => haystack.includes(word));
      });
      return {id: offer.id, title: offer.title, shares, blockers,
        matching: matching.map((words, i) => `${state.members[i].name}: ${words.length ? words.join(', ') : 'no keyword overlap'}`),
        coverage: matching.filter((words) => words.length).length};
    }).sort((a, b) => Number(Boolean(a.blockers.length)) - Number(Boolean(b.blockers.length)) ||
      b.coverage - a.coverage || a.title.localeCompare(b.title));
  }

  function quote(state) {
    const offer = offerFor(state);
    const shares = split(offer.total);
    const conflicts = state.members.flatMap((member, i) => !member.confirmed ? [`${member.name}: confirm preferences.`] :
      member.budget < shares[i] ? [`${member.name}: ${money(shares[i] - member.budget)} over confirmed budget.`] : []);
    const resources = state.resources.map((id) => offer.resources.find((r) => r.id === id));
    if (resources.length !== 3 || resources.some((r) => !r)) conflicts.push('Select exactly three places.');
    else if (offer.domain === 'movie') {
      const cols = resources.map((r) => r.col).sort((a, b) => a - b);
      if (new Set(resources.map((r) => r.row)).size !== 1 || new Set(cols).size !== 3 || cols[2] - cols[0] !== 2) conflicts.push('Movie seats must be adjacent in one row.');
    }
    return {total: offer.total, shares, conflicts, resources};
  }

  function readiness(state, index) {
    const required = (state.shares.length ? state.shares : quote(state).shares)[index];
    const available = state.members[index].available;
    const alternatives = state.offers.filter((offer) => offer.id !== state.selected &&
      Math.max(...split(offer.total)) <= available && offer.total < offerFor(state).total).map((offer) => offer.title);
    return {required, available, gap: Math.max(0, required - available), alternatives};
  }

  function participantView(state, index) {
    if (!Number.isInteger(index) || !state.members[index]) throw new Error('Unknown demo participant.');
    const own = state.members[index];
    return {name: own.name, payment: own.payment, share: (state.shares.length ? state.shares : quote(state).shares)[index],
      ticket: copy(state.ledger.find((ticket) => ticket.owner === index) || null)};
  }

  function reduce(state, action) {
    if (action.type === 'RESET') return start(state.offers, state.scenario, state.run + 1);
    if (action.type === 'SCENARIO') return start(state.offers, action.scenario, state.run + 1);
    const next = copy(state);
    const log = (message) => next.timeline.push(message);
    const person = (index) => {
      if (!Number.isInteger(index) || !next.members[index]) throw new Error('Unknown demo participant.');
      return next.members[index];
    };
    const requirePhase = (phase) => { if (next.phase !== phase) throw new Error(`This action requires ${phase.toLowerCase()} state.`); };
    switch (action.type) {
      case 'PERSONA': person(action.index); next.active = action.index; next.splitView = false; return next;
      case 'SPLIT_VIEW': next.splitView = !next.splitView; return next;
      case 'PREFERENCE': {
        requirePhase('PLANNING');
        const member = person(action.index);
        if (!Number.isSafeInteger(action.budget) || action.budget < 0) throw new Error('Invalid budget.');
        member.budget = action.budget; member.notes = String(action.notes || '').slice(0, 500); member.confirmed = true;
        log(`${member.name} confirmed a ${money(member.budget)} ceiling and their example likes. The lab compares budget and keyword overlap; the saved group uses verified constraints and local BGE.`);
        break;
      }
      case 'SELECT': {
        requirePhase('PLANNING');
        const offer = next.offers.find((o) => o.id === action.id);
        if (!offer) throw new Error('Unknown demo offer.');
        next.selected = offer.id; next.resources = initialResources(offer);
        log(`Selected ${offer.title} for this local model.`); break;
      }
      case 'RESOURCE': {
        requirePhase('PLANNING');
        if (!offerFor(next).resources.some((r) => r.id === action.id)) throw new Error('Unknown place.');
        next.resources = next.resources.includes(action.id) ? next.resources.filter((id) => id !== action.id) : [...next.resources, action.id];
        break;
      }
      case 'AVAILABLE': {
        if (!Number.isSafeInteger(action.amount) || action.amount < 0) throw new Error('Invalid hypothetical available amount.');
        person(action.index).available = action.amount; break;
      }
      case 'FREEZE': {
        requirePhase('PLANNING');
        const result = quote(next);
        if (result.conflicts.length) throw new Error(result.conflicts.join(' '));
        next.shares = result.shares; next.phase = 'HELD'; next.inventory = 'HELD';
        next.members.forEach((member) => { member.payment = 'AWAITING_APPROVAL'; });
        log(`SIM quote frozen: ${money(result.total)} = ${result.shares.map(money).join(' + ')}. Three local places held; real inventory untouched.`); break;
      }
      case 'AUTHORIZE': {
        requirePhase('HELD'); const member = person(action.index);
        if (member.payment !== 'AWAITING_APPROVAL') throw new Error('This demo share was already authorized.');
        member.payment = 'AUTHORIZED'; member.authorization = `SIM-AUTH-${next.run}-${action.index + 1}`;
        log(`${member.name} simulated approval and authorization of ${money(next.shares[action.index])}; no provider call.`); break;
      }
      case 'FINALIZE':
        requirePhase('HELD');
        if (next.members.some((m) => m.payment !== 'AUTHORIZED')) throw new Error('Each fictional participant must authorize their own share first.');
        next.phase = 'CAPTURING'; log('SIM finalization started. Captures are sequential; no ticket exists yet.'); break;
      case 'CAPTURE': {
        requirePhase('CAPTURING');
        const index = next.captureIndex;
        const member = next.members[index];
        if (next.scenario === 'chaos' && index === 2) {
          next.phase = 'RECOVERY';
          next.members.forEach((m) => { m.payment = m.payment === 'CAPTURED' ? 'REFUND_PENDING' : 'VOID_PENDING'; });
          log('SIM Charlie capture declined. Alice/Bob refunds and Charlie void are pending. Inventory stays held; tickets stay locked.');
        } else {
          member.payment = 'CAPTURED'; member.capture = `SIM-CAPTURE-${next.run}-${index + 1}`;
          next.captureIndex += 1; log(`${member.name}: SIM completed exact capture ${money(next.shares[index])}.`);
          if (next.captureIndex === 3) {
            next.phase = 'CONFIRMED'; next.inventory = 'BOOKED';
            next.ledger = next.members.map((m, i) => ({code: `SIM-TICKET-${next.run}-${i + 1}`, owner: i,
              holder: m.name, resource: offerFor(next).resources.find((r) => r.id === next.resources[i]).label, used: false}));
            log('All three SIM captures completed. Local inventory booked and three local ticket references issued.');
          }
        }
        break;
      }
      case 'RECOVER': {
        requirePhase('RECOVERY');
        const member = next.members.find((m) => ['REFUND_PENDING', 'VOID_PENDING'].includes(m.payment));
        if (!member) throw new Error('No recovery item remains.');
        const refund = member.payment === 'REFUND_PENDING'; member.payment = refund ? 'REFUNDED' : 'VOIDED';
        log(`${member.name}: SIM ${refund ? 'refund' : 'void'} completed in the local model.`);
        if (next.members.every((m) => ['REFUNDED', 'VOIDED'].includes(m.payment))) {
          next.phase = 'CANCELLED'; next.inventory = 'FREE'; log('All SIM compensation completed. Local places released; no tickets issued.');
        }
        break;
      }
      case 'SCAN': {
        const ticket = next.ledger.find((t) => t.code === String(action.code).trim());
        if (next.phase !== 'CONFIRMED' || !ticket) next.scan = 'Rejected: no confirmed ticket with this reference in this local ledger.';
        else if (ticket.used) next.scan = 'Rejected: this demo ticket was already admitted.';
        else { ticket.used = true; next.scan = `Admitted ${ticket.holder} to ${ticket.resource} in this simulation only.`; }
        log(`SIM scanner: ${next.scan}`); break;
      }
      default: throw new Error('Unknown demo action.');
    }
    return next;
  }

  function mount(element, options = {}) {
    if (!element || typeof element.replaceChildren !== 'function') throw new Error('A demo mount element is required.');
    let state = createState(copy(options.offers || []), options.scenario || 'movie');
    let feedback = '';
    const doc = element.ownerDocument;
    const make = (tag, text, className) => {
      const node = doc.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    const act = (action) => {
      try { state = reduce(state, action); feedback = ''; } catch (error) { feedback = error.message; }
      render();
    };
    const button = (text, action, disabled = false) => {
      const node = make('button', text); node.type = 'button'; node.disabled = disabled;
      node.setAttribute('data-demo-focus', `button-${text}`);
      node.addEventListener('click', () => act(action)); return node;
    };
    const section = (title) => { const node = make('section', undefined, 'demo-panel'); node.append(make('h3', title)); return node; };
    function field(parent, text, value, type = 'text', key = text) {
      const label = make('label', text); const input = make('input'); input.type = type; input.value = value;
      input.setAttribute('data-demo-focus', `field-${key}`);
      if (type === 'number') { input.min = '0'; input.step = '0.01'; }
      label.append(input); parent.append(label); return input;
    }
    function panel(index) {
      const view = participantView(state, index); const member = state.members[index];
      const node = section(`${view.name}${index === 0 ? ' · organizer' : ' · member'}`);
      node.append(make('p', `${money(view.share)} share · ${view.payment.replaceAll('_', ' ')}`, 'demo-member-status'));
      if (state.phase === 'PLANNING') {
        const form = make('form');
        const budget = field(form, 'My maximum share (USD)', (member.budget / 100).toFixed(2), 'number', `${view.name}-budget`);
        const notes = field(form, 'My preference notes (descriptive only)', member.notes, 'text', `${view.name}-notes`); notes.maxLength = 500;
        const confirm = make('button', member.confirmed ? 'Update confirmed preferences' : 'Confirm my preferences'); confirm.type = 'submit'; form.append(confirm);
        confirm.setAttribute('data-demo-focus', `confirm-${view.name}`);
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          try { act({type: 'PREFERENCE', index, budget: cents(budget.value), notes: notes.value}); }
          catch (error) { feedback = error.message; render(); }
        });
        node.append(form, make('p', member.confirmed ? 'Preferences confirmed in this demo.' : 'Awaiting confirmation.', 'demo-note'));
      }
      if (state.phase === 'HELD') node.append(button(`Simulate ${view.name}'s approval`, {type: 'AUTHORIZE', index}, member.payment !== 'AWAITING_APPROVAL'));
      if (view.ticket) {
        const pass = make('div', undefined, 'demo-pass');
        pass.append(make('p', 'SIMULATION PASS'), make('h4', offerFor(state).title), make('p', `${view.ticket.holder} · ${view.ticket.resource}`),
          make('code', view.ticket.code), make('p', view.ticket.used ? 'Already admitted in demo' : 'Ready for local ledger verification'));
        node.append(pass);
      } else node.append(make('p', 'Private pass locked until all exact simulated captures complete.', 'demo-note'));
      return node;
    }
    function render() {
      const focused = doc.activeElement;
      const focusKey = element.contains(focused) ? focused.getAttribute('data-demo-focus') : null;
      const shell = make('div', undefined, 'demo-shell');
      shell.append(make('p', 'JUDGE HUB / LOCAL SIMULATION', 'demo-eyebrow'), make('h2', 'See the coordination, feel the difference'));
      shell.append(make('p', '1. Confirm each fictional person. 2. Compare matching plans. 3. Select one and hold places. 4. Switch people to approve their shares. 5. Capture and see tickets. All actions stay in browser memory; the payment steps represent the real PayPal sequence without contacting PayPal.', 'demo-disclosure'));
      const scenarios = make('div', undefined, 'demo-toolbar');
      for (const [id, label] of [['movie', 'Cinema walkthrough'], ['excursion', '$100 excursion split'], ['chaos', 'Chaos Lab · third capture fails']]) {
        const control = button(label, {type: 'SCENARIO', scenario: id}); control.setAttribute('aria-pressed', String(state.scenario === id)); scenarios.append(control);
      }
      scenarios.append(button('Reset local demo', {type: 'RESET'})); shell.append(scenarios);
      const alert = make('p', feedback, 'demo-feedback'); alert.setAttribute('role', 'alert'); shell.append(alert);
      const status = make('p', `State: ${state.phase} · local inventory: ${state.inventory}`, 'demo-state'); status.setAttribute('role', 'status'); shell.append(status);
      const nav = make('div', undefined, 'demo-toolbar'); nav.setAttribute('aria-label', 'Fictional participant views');
      PEOPLE.forEach((name, index) => { const control = button(name, {type: 'PERSONA', index}); control.setAttribute('aria-pressed', String(state.active === index && !state.splitView)); nav.append(control); });
      const splitButton = button(state.splitView ? 'Return to one participant' : 'Show all three · teaching view', {type: 'SPLIT_VIEW'});
      splitButton.setAttribute('aria-pressed', String(state.splitView)); nav.append(splitButton); shell.append(nav);
      if (state.splitView) shell.append(make('p', 'Teaching view explicitly shows three fictional private panels together. Real participants use independent browser sessions.', 'demo-disclosure'));
      const members = make('div', undefined, state.splitView ? 'demo-people demo-people-split' : 'demo-people');
      (state.splitView ? [0, 1, 2] : [state.active]).forEach((i) => members.append(panel(i))); shell.append(members);

      const booking = section('1. Match, select & hold a plan'); const offer = offerFor(state); const result = quote(state);
      if (state.phase === 'PLANNING') {
        const compared = suggestions(state);
        booking.append(make('p', compared.length ? 'Teaching preview: exact example shares filter budgets first; simple keyword overlap orders the remaining plans. This is separate from the saved group’s local AI comparison.' : 'Confirm Alice, Bob and Charlie above to compare plans. Their example likes are editable.', 'demo-note'));
        for (const candidate of compared) {
          const row = make('div', undefined, 'demo-match');
          row.append(make('strong', `${candidate.title}${candidate.id === state.selected ? ' · selected' : ''}`),
            make('p', `${candidate.shares.map(money).join(' + ')} · ${candidate.blockers.length ? `Over budget for ${candidate.blockers.join(', ')}` : `Keyword overlap for ${candidate.coverage} of 3 people`}`, 'demo-note'));
          if (candidate.matching?.length) row.append(make('p', candidate.matching.join(' · '), 'demo-note'));
          if (!candidate.blockers.length) row.append(button(candidate.id === state.selected ? 'Selected for review' : 'Select this plan', {type: 'SELECT', id: candidate.id}, candidate.id === state.selected));
          booking.append(row);
        }
        booking.append(make('p', `Selected plan: ${offer.title}. The organizer can change the example places below before holding.`, 'demo-note'));
        const places = make('fieldset', undefined, 'demo-resources'); places.append(make('legend', 'Choose three local places (movie seats must be adjacent)'));
        offer.resources.forEach((resource) => {
          const label = make('label', resource.label); const input = make('input'); input.type = 'checkbox'; input.checked = state.resources.includes(resource.id);
          input.setAttribute('data-demo-focus', resource.id); input.addEventListener('change', () => act({type: 'RESOURCE', id: resource.id})); label.prepend(input); places.append(label);
        }); booking.append(places);
      }
      booking.append(make('p', offer.source, 'demo-note'), make('p', `${money(result.total)} = ${result.shares.map(money).join(' + ')} USD`));
      if (state.phase === 'PLANNING') {
        const conflicts = make('ul'); result.conflicts.forEach((conflict) => conflicts.append(make('li', conflict))); booking.append(conflicts);
        booking.append(button('Freeze local quote & hold places', {type: 'FREEZE'}, result.conflicts.length > 0));
      }
      shell.append(booking);

      const ready = section('2. Readiness calculator · hypothetical'); const index = state.active;
      ready.append(make('p', `Explore ${PEOPLE[index]}'s affordability. This is your entered example amount, never a bank balance or a payment decision.`));
      const readyForm = make('form'); const available = field(readyForm, 'Hypothetical amount available (USD)', (state.members[index].available / 100).toFixed(2), 'number');
      const calculate = make('button', 'Calculate gap'); calculate.type = 'submit'; calculate.setAttribute('data-demo-focus', 'calculate'); readyForm.append(calculate);
      readyForm.addEventListener('submit', (event) => { event.preventDefault(); try { act({type: 'AVAILABLE', index, amount: cents(available.value)}); } catch (error) { feedback = error.message; render(); } });
      const check = readiness(state, index); ready.append(readyForm, make('p', `${money(check.required)} required · ${money(check.available)} entered · ${money(check.gap)} gap`));
      if (check.gap) ready.append(make('p', check.alternatives.length ? `Cheaper copied offers to discuss: ${check.alternatives.join(', ')}. Return to planning to choose.` : 'No cheaper copied offer covers this example amount. Discuss a different activity or amount.'));
      shell.append(ready);

      const settlement = section('3. Sequential capture & recovery');
      if (state.phase === 'HELD') settlement.append(button('Start local finalization', {type: 'FINALIZE'}, state.members.some((m) => m.payment !== 'AUTHORIZED')));
      else if (state.phase === 'CAPTURING') settlement.append(button(`Simulate capture ${state.captureIndex + 1} of 3 · ${PEOPLE[state.captureIndex]}`, {type: 'CAPTURE'}));
      else if (state.phase === 'RECOVERY') settlement.append(make('p', 'Refunds and void are pending. Places remain held until each local recovery outcome completes.'), button('Complete next simulated recovery item', {type: 'RECOVER'}));
      else settlement.append(make('p', state.phase === 'CONFIRMED' ? 'Every simulated share captured. Passes are now available in their owner panels.' : state.phase === 'CANCELLED' ? 'Compensation completed in the model. Local places released.' : 'Confirm preferences, freeze, then approve individually in each fictional participant view.'));
      shell.append(settlement);

      const scanner = section('4. Local ledger admission simulator');
      scanner.append(make('p', 'Paste a SIM ticket reference from an owner panel. Validates this in-memory confirmed ledger and rejects duplicates. No QR, signature, camera or real venue validation is claimed.'));
      const scanForm = make('form'); const code = field(scanForm, 'Demo ticket reference', ''); code.autocomplete = 'off';
      const scan = make('button', 'Verify & admit locally'); scan.type = 'submit'; scan.setAttribute('data-demo-focus', 'scan'); scanForm.append(scan);
      scanForm.addEventListener('submit', (event) => { event.preventDefault(); act({type: 'SCAN', code: code.value}); });
      scanner.append(scanForm); const scanResult = make('p', state.scan); scanResult.setAttribute('role', 'status'); scanner.append(scanResult); shell.append(scanner);
      const audit = section('Audit timeline · events actually applied'); const list = make('ol'); state.timeline.forEach((line) => list.append(make('li', line))); audit.append(list); shell.append(audit);
      element.replaceChildren(shell);
      if (focusKey) {
        const control = [...element.querySelectorAll('[data-demo-focus]')].find((node) => node.getAttribute('data-demo-focus') === focusKey);
        if (control) control.focus();
      }
    }
    render();
    return {getState: () => copy(state), destroy: () => element.replaceChildren()};
  }

  const api = {mount, createState, reduce, quote, suggestions, readiness, participantView, split, cents};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GroupPayDemo = api;
})(typeof window !== 'undefined' ? window : globalThis);

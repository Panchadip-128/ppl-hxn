'use strict';
/* Focused merchant checkout. It deliberately delegates every money mutation
 * to the existing group booking routes and never calculates shares client-side. */
(function (root) {
  const $ = (id) => document.getElementById(id);
  const el = (tag, text, cls) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (cls) item.className = cls; return item; };
  const money = (cents, currency = 'USD') => new Intl.NumberFormat(undefined, {style: 'currency', currency}).format(cents / 100);
  const state = {options: null, offer: null, group: null, booking: null, sdk: null, buttons: null, buttonKey: ''};

  async function request(path, body) { return state.options.api(path, body); }
  async function refresh() {
    if (!state.group) return;
    state.group = await request(`/api/groups/${encodeURIComponent(state.group.id)}`);
    state.booking = await request(`/api/groups/${encodeURIComponent(state.group.id)}/booking`);
    render();
  }
  function summary(total, currency, title, merchant) {
    const box = $('merchant-order-summary'); box.replaceChildren();
    box.append(el('p', merchant || 'Fictional merchant', 'eyebrow'), el('h2', title || 'Your order'),
      el('strong', money(total, currency), 'merchant-total'), el('p', 'The merchant controls this price, currency, inventory, and confirmation.', 'fine'));
  }
  function button(label, action, cls = 'btn btn-primary') { const item = el('button', label, cls); item.type = 'button'; item.addEventListener('click', () => action().catch(showError)); return item; }
  function showError(error) { $('merchant-group-status').replaceChildren(el('p', error.message || String(error), 'error')); }
  function detail(message) { const box = $('merchant-group-status'); box.replaceChildren(el('p', message, 'fine')); }
  function rememberGroup(groupId) {
    if (!groupId || !root.history?.replaceState) return;
    const params = new URLSearchParams(root.location.search || '');
    params.delete('invite'); params.delete('join'); params.set('group', groupId);
    root.history.replaceState(null, '', `/?${params.toString()}`);
  }

  function renderChoice() {
    const box = $('merchant-choice'); box.replaceChildren();
    const direct = el('article', undefined, 'merchant-payment-option');
    direct.append(el('h2', 'Pay with PayPal'), el('p', 'Pay the full amount yourself in the normal PayPal approval window.'),
      button('Pay with PayPal', () => start(1)));
    const together = el('article', undefined, 'merchant-payment-option');
    const label = el('label', 'People paying together'); const select = el('select'); select.id = 'merchant-payer-count';
    for (const count of [2, 3, 4]) { const option = el('option', `${count} people`); option.value = String(count); select.append(option); }
    label.append(select);
    together.append(el('h2', 'Pay together with PayPal'), el('p', 'Invite friends. Everyone approves only their own exact share in PayPal.'), label,
      button('Create group checkout', () => start(Number(select.value))));
    const planning = el('article', undefined, 'merchant-payment-option');
    planning.append(el('h2', 'Plan & check fit first'), el('p', 'Need to compare budgets, schedules, and tastes with local BGE AI before reserving? Start a planning room with this experience as your starting point.'),
      button('Start a planning room →', async () => { state.options.planOfferInRoom?.(state.offer); }, 'btn btn-outline'));
    box.append(direct, together, planning);
  }
  async function start(payerCount) {
    state.group = await request('/api/merchant-checkouts', {offerID: state.offer.id, payerCount});
    rememberGroup(state.group.id);
    state.booking = {hasBooking: false}; state.options.show();
    if (payerCount === 1) { detail('Holding your merchant order and preparing its PayPal approval.'); await freeze(); }
    else render();
  }
  async function freeze() { await request(`/api/groups/${encodeURIComponent(state.group.id)}/merchant-freeze`, {}); await refresh(); }
  async function copyInvite() {
    const url = state.group.inviteURL;
    if (!url) throw new Error('Only the organizer can share this invite.');
    try {
      await navigator.clipboard.writeText(url);
      const message = 'Payment invite copied — each payer joins and approves only their own exact share.';
      detail(message);
      root.GroupPayToast?.(message);
    }
    catch { detail(`Copy this invite: ${url}`); }
  }
  function renderWaiting(checkout) {
    const choice = $('merchant-choice'); choice.replaceChildren();
    const box = el('article', undefined, 'merchant-payment-option');
    box.append(el('h2', 'Group checkout'), el('p', `${state.group.memberCount} of ${checkout.targetMemberCount} payers have joined.`));
    if (state.group.members?.length) {
      const rosterRow = el('div', undefined, 'roster-avatar-row');
      for (const m of state.group.members) rosterRow.append(el('span', m.alias, 'room-member-pill'));
      box.append(rosterRow);
    }
    const actionRow = el('div', undefined, 'button-row');
    if (state.group.role === 'organizer' && state.group.memberCount < checkout.targetMemberCount) actionRow.append(button('Copy payment invite', copyInvite, 'btn btn-outline'));
    if (state.group.role === 'organizer' && checkout.readyToFreeze) actionRow.append(button('Hold order & show exact shares', freeze));
    actionRow.append(button('Refresh status', refresh, 'btn btn-outline'));
    box.append(actionRow);
    if (state.group.role !== 'organizer') box.append(el('p', 'The organizer will hold the merchant order once every intended payer has joined.', 'fine'));
    choice.append(box);
    detail('The roster is not frozen yet. Joining or leaving cannot change an already-held order.');
  }
  function sdk() {
    if (!state.options.getConfig().configured) return Promise.reject(new Error('PayPal Sandbox credentials are needed for payment approval.'));
    if (state.sdk) return state.sdk;
    state.sdk = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://www.paypal.com/sdk/js?' + new URLSearchParams({'client-id': state.options.getConfig().clientID, currency: 'USD', intent: 'authorize', components: 'buttons'});
      script.setAttribute('data-namespace', 'paypalMerchant');
      script.onload = () => root.paypalMerchant?.Buttons ? resolve(root.paypalMerchant) : reject(new Error('PayPal approval could not initialize.'));
      script.onerror = () => reject(new Error('PayPal approval could not load.'));
      document.head.append(script);
    });
    return state.sdk;
  }
  async function renderPayPal(container, consent) {
    const own = state.booking.myShare;
    const enabled = consent.checked && own?.state !== 'AUTHORIZED' && own?.state !== 'CAPTURED' && state.booking.state === 'AWAITING_AUTHORIZATIONS';
    const key = enabled ? `${state.group.id}:${state.booking.purchaseID}:${own.state}` : '';
    if (key === state.buttonKey) return;
    if (state.buttons) { try { await state.buttons.close(); } catch {} }
    state.buttons = null; state.buttonKey = key; container.replaceChildren();
    if (!enabled) return;
    const provider = await sdk();
    if (key !== state.buttonKey) return;
    state.buttons = provider.Buttons({
      style: {layout: 'vertical', shape: 'rect', label: 'paypal'},
      onClick(_data, actions) { return consent.checked ? actions.resolve() : actions.reject(); },
      async createOrder() { await request(`/api/groups/${encodeURIComponent(state.group.id)}/booking/consent`, {}); const order = await request(`/api/groups/${encodeURIComponent(state.group.id)}/contributions/order`, {}); return order.orderID; },
      async onApprove() { await request(`/api/groups/${encodeURIComponent(state.group.id)}/contributions/authorize`, {}); await refresh(); },
      async onCancel() { detail('Approval closed. Your saved order can be rechecked without creating a replacement.'); },
      async onError(error) { detail(`${error.message || 'Approval interrupted.'} Recheck the saved order before retrying.`); }
    });
    await state.buttons.render(container);
  }
  function renderPayment() {
    const booking = state.booking, choice = $('merchant-choice'); choice.replaceChildren();
    summary(booking.totalCents, booking.currency, booking.title, state.group.merchantCheckout?.merchantID);
    if (booking.state === 'CONFIRMED') {
      const confirmed = el('article', undefined, 'merchant-confirmation');
      confirmed.append(el('h2', 'Order confirmed'), el('p', 'Every required PayPal capture is verified. The fictional merchant order is confirmed.'));
      if (booking.myShare) {
        confirmed.append(el('p', `Assigned place: ${booking.myShare.assignedResource || 'Reserved'} · Paid share: ${booking.myShare.shareValue} ${booking.currency}${booking.myShare.captureID ? ` · Capture: ${booking.myShare.captureID}` : ''}`, 'fine'));
      }
      if (state.options.openRoom && state.group?.id) {
        confirmed.append(button('View private ticket in Group Room →', async () => { await state.options.openRoom(state.group.id); }, 'btn btn-primary'));
      }
      choice.append(confirmed);
      detail('Group-payment receipt: all required captures completed.'); return;
    }
    const own = booking.myShare, card = el('article', undefined, 'merchant-payment-option');
    card.append(el('h2', 'Your payment'), el('p', `Your exact share: ${own.shareValue} ${booking.currency}${own.assignedResource ? ` · ${own.assignedResource}` : ''}.`),
      el('p', 'No other payer can approve or pay this amount for you.', 'fine'));
    if (booking.rosterProgress?.length) {
      const rosterBox = el('div', undefined, 'member-auth-list');
      for (const item of booking.rosterProgress) {
        rosterBox.append(el('p', `${item.alias}: ${String(item.state || '').replaceAll('_', ' ').toLowerCase()}${item.shareValue ? ` · ${item.shareValue} ${booking.currency}` : ''}`, 'fine'));
      }
      card.append(rosterBox);
    }
    const consent = el('input'); consent.type = 'checkbox'; consent.id = 'merchant-consent';
    if (own.consentGiven) consent.checked = true;
    const consentLabel = el('label', ' I agree to my displayed share and the cancellation terms.'); consentLabel.prepend(consent); card.append(consentLabel);
    const paypal = el('div'); paypal.id = 'merchant-paypal-buttons'; card.append(paypal);
    consent.addEventListener('change', () => renderPayPal(paypal, consent).catch(showError));
    const actionRow = el('div', undefined, 'button-row');
    if (booking.state === 'FINALIZING' && state.group.role === 'organizer') actionRow.append(button('Complete verified group payment', async () => { await request(`/api/groups/${encodeURIComponent(state.group.id)}/finalize`, {}); await refresh(); }));
    if ((booking.recoveryRequired || booking.state === 'RECOVERY_REQUIRED') && state.group.role === 'organizer') actionRow.append(button('Reconcile group recovery', async () => { await request(`/api/groups/${encodeURIComponent(state.group.id)}/recover`, {}); await refresh(); }, 'btn btn-outline'));
    if (own.orderID) actionRow.append(button('Recheck saved payment', async () => { await request(`/api/groups/${encodeURIComponent(state.group.id)}/contributions/reconcile`, {}); await refresh(); }, 'btn btn-outline'));
    actionRow.append(button('Refresh status', refresh, 'btn btn-outline'));
    card.append(actionRow);
    choice.append(card);
    detail(booking.state === 'FINALIZING' ? 'All authorizations are ready. The organizer can complete the capture pass.' : (booking.recoveryRequired || booking.state === 'RECOVERY_REQUIRED') ? 'A payment outcome is unresolved. Keep this reservation and reconcile group recovery.' : own.orderID ? 'Each payer must independently approve their displayed share. You can recheck this saved PayPal order if approval was interrupted.' : 'Check the consent box, then use PayPal to start your own approval.');
  }
  function render() {
    state.options.show();
    const checkout = state.group?.merchantCheckout;
    const offer = state.offer || checkout;
    if (!offer) return;
    $('merchant-title').textContent = checkout ? checkout.title : offer.title;
    $('merchant-description').textContent = 'Choose PayPal for yourself, or invite friends to split this merchant order equally.';
    summary(checkout?.totalCents ?? offer.priceMinor, checkout?.currency ?? offer.currency, checkout?.title ?? offer.title, checkout?.merchantID ?? offer.merchantID);
    if (!state.group) { renderChoice(); detail('Pay together is a merchant checkout option before the normal PayPal approval window.'); }
    else if (!state.booking?.hasBooking) renderWaiting(checkout);
    else renderPayment();
  }
  function init(options) {
    state.options = options;
    $('merchant-back').addEventListener('click', () => options.showDiscover());
    root.setInterval?.(() => {
      if (!document.hidden && !$('merchant-view')?.hidden && state.group && state.booking?.state !== 'CONFIRMED') {
        refresh().catch(() => {});
      }
    }, 5000);
  }
  function openOffer(offer) { state.offer = offer; state.group = null; state.booking = null; render(); }
  async function openGroup(groupId) { state.group = await request(`/api/groups/${encodeURIComponent(groupId)}`); rememberGroup(groupId); state.offer = state.group.merchantCheckout; state.booking = await request(`/api/groups/${encodeURIComponent(groupId)}/booking`); render(); }
  root.GroupPayMerchant = {init, openOffer, openGroup};
})(window);

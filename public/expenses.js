'use strict';

// Informal personal expense splitting. A private ledger between named people, not PayPal
// payment state: nothing here owns consent, prices, inventory or tickets. Receipt scanning
// uses an operator-configured vision provider; its output is an editable, unsaved preview.
(function (root) {
  const CATEGORIES = ['food', 'travel', 'rent', 'entertainment', 'shopping', 'other'];
  const CATEGORY_LABEL = {food: 'Food', travel: 'Travel', rent: 'Rent', entertainment: 'Entertainment', shopping: 'Shopping', other: 'Other'};
  // Geometric text glyphs (with explicit text-presentation selectors) so no platform substitutes an emoji.
  const CATEGORY_ICON = {food: '\u25C9', travel: '\u2708\uFE0E', rent: '\u2302', entertainment: '\u266A', shopping: '\u25A3', other: '\u25C7'};
  // Inline stroked bell so reminder buttons keep the app's icon language instead of an emoji glyph.
  const BELL_ICON = '<svg class="icon-bell" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 8.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5"/><path d="M13.7 19a2 2 0 0 1-3.4 0"/></svg>';

  function cents(value) {
    const trimmed = String(value || '').trim();
    if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) throw new Error('Enter a positive amount with up to two decimal places.');
    const [whole, fraction = ''] = trimmed.split('.');
    const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(result) || result <= 0) throw new Error('Enter an amount greater than zero.');
    return result;
  }

  function money(minor, currency = 'USD') {
    return new Intl.NumberFormat(undefined, {style: 'currency', currency}).format((minor || 0) / 100);
  }

  // Mirrors app/shared/storage.py's split_equal_cents: largest-remainder-first, exact sum.
  function splitEqualCents(totalMinor, names) {
    const n = names.length;
    const base = Math.floor(totalMinor / n);
    const remainder = totalMinor % n;
    const result = {};
    names.forEach((name, i) => { result[name] = base + (i < remainder ? 1 : 0); });
    return result;
  }

  function readinessFor(input = {}) {
    const profile = input.profile || {};
    const friends = Array.isArray(input.friends) ? input.friends : [];
    const splits = Array.isArray(input.splits) ? input.splits : [];
    const steps = [
      {key: 'details', label: 'Add your name', detail: 'Shown as the bill host and payer.', done: !!String(profile.displayName || '').trim(), action: 'nav', view: 'account'},
      {key: 'people', label: 'Add at least one person', detail: 'Save a name and optional reminder details.', done: friends.length > 0, action: 'nav', view: 'friends'},
      {key: 'bill', label: 'Create and review a split', detail: 'Enter or scan a bill, then verify every share.', done: splits.length > 0, action: 'new-split'},
    ];
    const openCount = splits.filter((split) => !split.allSettled).length;
    const doneCount = steps.filter((step) => step.done).length;
    let next = steps.find((step) => !step.done);
    if (!next) {
      next = openCount
        ? {label: 'Review pending repayments', detail: `${openCount} open split${openCount === 1 ? '' : 's'} need attention.`, action: 'nav', view: 'activity'}
        : {label: 'Create another split', detail: 'Everyone is marked settled.', action: 'new-split'};
    }
    return {steps, doneCount, total: steps.length, openCount, next};
  }

  function splitDraftReadiness(draft) {
    let amountReady = false;
    try { cents(draft?.total); amountReady = true; } catch { /* incomplete draft */ }
    return {
      bill: !!String(draft?.title || '').trim() && amountReady,
      people: Array.isArray(draft?.selected) && draft.selected.length > 0,
      repayment: !!String(draft?.hostName || '').trim(),
    };
  }

  function mount(container, ctx) {
    if (!container) return null;
    const api = ctx.api;
    const escapeHtml = ctx.escapeHtml || ((s) => String(s === null || s === undefined ? '' : s));
    const getCsrfToken = ctx.getCsrfToken || (() => '');

    const state = {
      view: 'dashboard', groups: [], friends: [], splits: [], subscriptions: [], analytics: null,
      profile: {displayName: '', upiID: ''}, busy: false, loaded: false, error: '', notice: '',
      activityGroup: 'ALL', friendQuery: '', modal: null, draft: null, saving: false,
    };

    function $$(selector) { return container.querySelector(selector); }

    async function refreshAll() {
      state.busy = true; state.error = ''; render();
      try {
        const [groups, friends, splits, subs, analytics, profile] = await Promise.all([
          api('/api/expenses/groups'), api('/api/expenses/friends'), api('/api/expenses/splits'),
          api('/api/expenses/subscriptions'), api('/api/expenses/analytics'), api('/api/expenses/profile'),
        ]);
        state.groups = groups.groups; state.friends = friends.friends; state.splits = splits.splits;
        state.subscriptions = subs.subscriptions; state.analytics = analytics.analytics; state.profile = profile.profile;
        state.loaded = true;
      } catch (err) {
        state.error = err.message;
      }
      state.busy = false;
      render();
    }

    async function refreshSplitsAndAnalytics() {
      try {
        const [splits, analytics] = await Promise.all([api('/api/expenses/splits'), api('/api/expenses/analytics')]);
        state.splits = splits.splits; state.analytics = analytics.analytics;
      } catch (err) { state.error = err.message; }
    }

    // ------------------------------------------------- reminders (local only; never touches payment/consent state)
    async function copyText(text) {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch { /* fall through to legacy path */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch { return false; }
    }

    function friendWhatsappDigits(share) {
      const digits = (share.whatsapp || '').replace(/[^\d]/g, '');
      return digits.length >= 8 ? digits : '';
    }

    async function remindShare(split, share) {
      const message = 'Hi ' + share.name + '! Quick reminder \u2014 you owe ' + money(share.amountMinor, split.currency) + ' for "' + split.title + '" from our GroupPay split. Thanks!';
      const digits = friendWhatsappDigits(share);
      if (digits) {
        window.open('https://wa.me/' + digits + '?text=' + encodeURIComponent(message), '_blank', 'noopener,noreferrer');
        state.notice = 'Opened WhatsApp to remind ' + share.name + '.';
      } else {
        const copied = await copyText(message);
        state.notice = copied ? ('Reminder copied \u2014 send it to ' + share.name + ' however you reach them.') : message;
      }
      render();
    }

    async function remindAllPending(split) {
      const pending = split.shares.filter((s) => !s.isPayer && !s.settled);
      if (!pending.length) return;
      const lines = pending.map((s) => '- ' + s.name + ': ' + money(s.amountMinor, split.currency)).join('\n');
      const message = 'Reminder for "' + split.title + '":\n' + lines + '\nStill pending: ' + money(split.pendingMinor, split.currency);
      const copied = await copyText(message);
      state.notice = copied ? 'Reminder summary copied \u2014 paste it wherever your group chats.' : message;
      render();
    }

    // ----------------------------------------------------------- new-split draft
    function openSplitModal() {
      state.modal = 'split';
      state.notice = '';
      state.draft = {
        title: '', category: 'food', currency: 'USD', groupId: '',
        hostName: state.profile.displayName || '', upiID: state.profile.upiID || '', paypalEmail: '',
        total: '', selected: [], scanBusy: false, scanError: '', scanInfo: '', receiptMeta: null, formError: '',
        scanStatus: null, scanPreviewUrl: '',
      };
      render();
      api('/api/expenses/scan-status').then((status) => { if (state.draft) { state.draft.scanStatus = status; render(); } }).catch(() => {});
    }

    function syncSplitDraftFromForm() {
      if (!state.draft) return;
      const title = $$('#exp-split-title'); if (title) state.draft.title = title.value;
      const total = $$('#exp-split-total'); if (total) state.draft.total = total.value;
      const group = $$('#exp-split-group'); if (group) state.draft.groupId = group.value;
      const category = $$('#exp-split-category'); if (category) state.draft.category = category.value;
      const host = $$('#exp-split-host'); if (host) state.draft.hostName = host.value;
      const upi = $$('#exp-split-upi'); if (upi) state.draft.upiID = upi.value;
      const paypal = $$('#exp-split-paypal'); if (paypal) state.draft.paypalEmail = paypal.value;
    }

    function participantNames() {
      const you = state.profile.displayName || 'You';
      return [you, ...state.draft.selected.map((id) => state.friends.find((friend) => friend.id === id)?.name).filter(Boolean)];
    }

    // Object URLs for the local receipt preview are revoked whenever the draft is replaced or closed.
    function releaseScanPreview() {
      if (state.draft && state.draft.scanPreviewUrl) {
        try { URL.revokeObjectURL(state.draft.scanPreviewUrl); } catch { /* already revoked */ }
        state.draft.scanPreviewUrl = '';
      }
    }

    function closeModal() {
      releaseScanPreview();
      state.modal = null;
      state.draft = null;
    }

    async function handleScan(file) {
      syncSplitDraftFromForm();
      releaseScanPreview();
      try { state.draft.scanPreviewUrl = URL.createObjectURL(file); } catch { state.draft.scanPreviewUrl = ''; }
      state.draft.scanBusy = true; state.draft.scanError = ''; state.draft.scanInfo = ''; render();
      try {
        const formData = new FormData();
        formData.append('receipt', file);
        const response = await fetch('/api/expenses/scan-receipt', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: {'X-CSRF-Token': getCsrfToken()}, body: formData,
        });
        let data;
        try { data = await response.json(); } catch { throw new Error('Server response could not be parsed.'); }
        if (!response.ok) throw new Error(data.message || data.error || 'Receipt scan failed.');
        if (data.parsed && data.fields) {
          const fields = data.fields;
          if (fields.merchant) state.draft.title = fields.merchant;
          if (fields.category) state.draft.category = fields.category;
          if (fields.currency) state.draft.currency = fields.currency;
          if (typeof fields.total === 'number') state.draft.total = fields.total.toFixed(2);
          state.draft.receiptMeta = fields;
          const provider = state.draft.scanStatus?.provider === 'ollama_cloud' ? 'Ollama Cloud' : 'Server-local AI';
          state.draft.scanInfo = provider + ' suggested these fields from the photo. Review every value before saving — nothing is saved yet.';
        } else {
          state.draft.scanError = 'The configured receipt model could not read a clear total from this photo. Enter the details manually.';
        }
      } catch (err) {
        state.draft.scanError = err.message;
      }
      state.draft.scanBusy = false;
      render();
    }

    async function saveSplit() {
      syncSplitDraftFromForm();
      state.draft.formError = '';
      let totalMinor;
      try { totalMinor = cents(state.draft.total); }
      catch (err) { state.draft.formError = err.message; render(); return; }
      if (!state.draft.title.trim()) { state.draft.formError = 'Give this split a title.'; render(); return; }
      if (!state.draft.selected.length) {
        state.draft.formError = 'Choose at least one person so this bill has an individual share to track.';
        render(); return;
      }
      if (!state.draft.hostName.trim()) {
        state.draft.formError = 'Add the host name so everyone knows who paid the bill.';
        render(); return;
      }
      const names = participantNames();
      const uniqueNames = new Set(names.map((n) => n.toLowerCase()));
      if (uniqueNames.size !== names.length) { state.draft.formError = 'Each person in a split needs a distinct name.'; render(); return; }
      const amounts = splitEqualCents(totalMinor, names);
      const payer = names[0];
      if (names.length !== state.draft.selected.length + 1) { state.draft.formError = 'A selected friend changed. Reopen the split and choose again.'; render(); return; }
      const shares = names.map((name, index) => ({name, amountMinor: amounts[name], isPayer: name === payer,
        ...(index ? {friendID: state.draft.selected[index - 1]} : {})}));
      state.saving = true; render();
      try {
        const activityGroup = state.draft.groupId || 'none';
        await api('/api/expenses/splits', {
          title: state.draft.title.trim(), category: state.draft.category, currency: state.draft.currency,
          shares, groupID: state.draft.groupId || null,
          payee: {hostName: state.draft.hostName.trim(), upiID: state.draft.upiID.trim(), paypalEmail: state.draft.paypalEmail.trim()},
          source: state.draft.receiptMeta ? 'scan' : 'manual', receiptMeta: state.draft.receiptMeta,
        });
        closeModal();
        state.view = 'activity';
        state.activityGroup = activityGroup;
        state.notice = 'Split saved. Review each individual share below, then remind or mark people settled.';
        state.saving = false;
        await refreshAll();
        root.GroupPayToast?.('Split saved — individual shares are ready in Activity.');
        return;
      } catch (err) {
        state.draft.formError = err.message;
      }
      state.saving = false;
      render();
    }

    // ----------------------------------------------------------- subscription draft
    function openSubscriptionModal() {
      state.modal = 'subscription';
      state.draft = {name: '', monthlyAmount: '', billingDay: '1',
        hostName: state.profile.displayName || '', upiID: state.profile.upiID || '', participants: [], formError: ''};
      render();
    }

    function syncSubscriptionDraftFromForm() {
      if (!state.draft) return;
      const name = $$('#exp-sub-name'); if (name) state.draft.name = name.value;
      const amount = $$('#exp-sub-amount'); if (amount) state.draft.monthlyAmount = amount.value;
      const day = $$('#exp-sub-day'); if (day) state.draft.billingDay = day.value;
      const host = $$('#exp-sub-host'); if (host) state.draft.hostName = host.value;
      const upi = $$('#exp-sub-upi'); if (upi) state.draft.upiID = upi.value;
      state.draft.participants.forEach((p, i) => {
        const nameField = $$(`#exp-sub-p-name-${i}`); if (nameField) p.name = nameField.value;
        const waField = $$(`#exp-sub-p-wa-${i}`); if (waField) p.whatsapp = waField.value;
      });
    }

    async function saveSubscription() {
      syncSubscriptionDraftFromForm();
      state.draft.formError = '';
      let monthlyMinor;
      try { monthlyMinor = cents(state.draft.monthlyAmount); }
      catch (err) { state.draft.formError = err.message; render(); return; }
      if (!state.draft.name.trim()) { state.draft.formError = 'Give this subscription a name.'; render(); return; }
      const billingDay = Number(state.draft.billingDay);
      if (!Number.isInteger(billingDay) || billingDay < 1 || billingDay > 28) {
        state.draft.formError = 'Billing day must be between 1 and 28.'; render(); return;
      }
      const participants = state.draft.participants.filter((p) => p.name.trim()).map((p) => ({name: p.name.trim(), whatsapp: p.whatsapp.trim()}));
      if (!participants.length) {
        state.draft.formError = 'Add at least one participant to this recurring bill.';
        render(); return;
      }
      state.saving = true; render();
      try {
        await api('/api/expenses/subscriptions', {
          name: state.draft.name.trim(), monthlyAmountMinor: monthlyMinor, billingDay, currency: 'USD', participants,
          hostName: state.draft.hostName.trim(), upiID: state.draft.upiID.trim(),
        });
        state.modal = null; state.draft = null;
        state.notice = 'Subscription reminder saved. Nothing is charged automatically.';        state.saving = false;
        await refreshAll();
        root.GroupPayToast?.('Recurring bill saved as a reminder. No payment was scheduled.');
        return;
      } catch (err) {
        state.draft.formError = err.message;
      }
      state.saving = false;
      render();
    }

    // ----------------------------------------------------------- actions
    async function onClick(event) {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      try {
        if (action === 'nav') { state.view = button.dataset.view; state.notice = ''; render(); }
        else if (action === 'new-split') { openSplitModal(); }
        else if (action === 'new-split-with-friend') {
          openSplitModal();
          state.draft.selected = [button.dataset.id];
          render();
        }
        else if (action === 'new-subscription') { openSubscriptionModal(); }
        else if (action === 'open-friends') { closeModal(); state.view = 'friends'; render(); }
        else if (action === 'new-sub-cycle') {
          const sub = state.subscriptions.find((item) => item.id === button.dataset.id);
          if (!sub) return;
          openSplitModal();
          state.draft.title = `${sub.name} · monthly bill`;
          state.draft.category = 'entertainment';
          state.draft.total = (sub.monthlyAmountMinor / 100).toFixed(2);
          state.draft.hostName = sub.hostName || state.profile.displayName || '';
          state.draft.upiID = sub.upiID || state.profile.upiID || '';
          const participantNames = new Set(sub.participants.map((participant) => participant.name.trim().toLowerCase()));
          state.draft.selected = state.friends.filter((friend) => participantNames.has(friend.name.trim().toLowerCase())).map((friend) => friend.id);
          const unmatched = sub.participants.filter((participant) => !state.friends.some(
            (friend) => friend.name.trim().toLowerCase() === participant.name.trim().toLowerCase()));
          state.draft.formError = unmatched.length
            ? `Choose saved people for: ${unmatched.map((participant) => participant.name).join(', ')}. Names in recurring reminders are not verified contact links.`
            : '';
          render();
        }
        else if (action === 'close-modal') { closeModal(); render(); }
        else if (action === 'toggle-participant') {
          syncSplitDraftFromForm();
          const friendID = button.dataset.id;
          const i = state.draft.selected.indexOf(friendID);
          if (i >= 0) state.draft.selected.splice(i, 1); else state.draft.selected.push(friendID);
          render();
        }
        else if (action === 'trigger-scan') { $$('#exp-scan-input')?.click(); }
        else if (action === 'save-split') { await saveSplit(); }
        else if (action === 'save-subscription') { await saveSubscription(); }
        else if (action === 'add-sub-participant') {
          syncSubscriptionDraftFromForm();
          state.draft.participants.push({name: '', whatsapp: ''});
          render();
        }
        else if (action === 'add-sub-friend') {
          syncSubscriptionDraftFromForm();
          const friend = state.friends.find((item) => item.id === button.dataset.id);
          if (friend && !state.draft.participants.some((item) => item.name.toLowerCase() === friend.name.toLowerCase())) {
            state.draft.participants.push({name: friend.name, whatsapp: friend.whatsapp || ''});
          }
          render();
        }
        else if (action === 'remove-sub-participant') {
          syncSubscriptionDraftFromForm();
          state.draft.participants.splice(Number(button.dataset.index), 1);
          render();
        }
        else if (action === 'delete-friend') {
          button.disabled = true;
          const result = await api('/api/expenses/friends/' + encodeURIComponent(button.dataset.id) + '/delete', {});
          state.friends = result.friends; render();
        }
        else if (action === 'delete-subscription') {
          button.disabled = true;
          const result = await api('/api/expenses/subscriptions/' + encodeURIComponent(button.dataset.id) + '/delete', {});
          state.subscriptions = result.subscriptions; render();
        }
        else if (action === 'toggle-settle') {
          button.disabled = true;
          await api(`/api/expenses/splits/${button.dataset.split}/settle`, {
            shareID: button.dataset.share, settled: button.dataset.settled !== 'true',
          });
          await refreshSplitsAndAnalytics();
          render();
        }
        else if (action === 'remind-share') {
          const split = state.splits.find((s) => s.id === button.dataset.split);
          const share = split && split.shares.find((sh) => sh.id === button.dataset.share);
          if (split && share) await remindShare(split, share);
        }
        else if (action === 'remind-split') {
          const split = state.splits.find((s) => s.id === button.dataset.split);
          if (split) await remindAllPending(split);
        }
        else if (action === 'filter-activity-group') { state.activityGroup = button.dataset.group; state.view = 'activity'; render(); }
      } catch (err) {
        state.error = err.message;
        render();
      }
    }

    async function onSubmit(event) {
      const form = event.target.closest('form');
      if (!form) return;
      event.preventDefault();
      try {
        if (form.id === 'exp-friend-form') {
          const name = $$('#exp-friend-name').value.trim();
          const upiID = $$('#exp-friend-upi').value.trim();
          const whatsapp = $$('#exp-friend-whatsapp').value.trim();
          if (!name) return;
          const result = await api('/api/expenses/friends', {name, upiID, whatsapp});
          state.friends = result.friends;
          form.reset();
          state.notice = `${name} is ready to add to a split.`;
          render();
          root.GroupPayToast?.(`${name} added to People.`);
        } else if (form.id === 'exp-profile-form') {
          const displayName = $$('#exp-profile-name').value.trim();
          const upiID = $$('#exp-profile-upi').value.trim();
          const result = await api('/api/expenses/profile', {displayName, upiID});
          state.profile = result.profile;
          state.notice = 'Account details saved.';
          render();
          root.GroupPayToast?.('Your settlement details were saved. They do not authorize payment.');
        }
      } catch (err) {
        state.error = err.message;
        render();
      }
    }

    async function onChange(event) {
      const input = event.target.closest('#exp-scan-input');
      if (input && input.files && input.files[0]) {
        const file = input.files[0];
        input.value = '';
        await handleScan(file);
        return;
      }
      if (state.modal === 'split' && /^exp-split-(title|total|group|category|host|upi|paypal)$/.test(event.target.id)) {
        syncSplitDraftFromForm();
        render();
      } else if (state.modal === 'subscription' && event.target.id?.startsWith('exp-sub-')) {
        syncSubscriptionDraftFromForm();
        render();
      }
    }

    function onInput(event) {
      if (event.target.id !== 'exp-friend-search') return;
      state.friendQuery = event.target.value;
      const query = state.friendQuery.trim().toLowerCase();
      for (const row of container.querySelectorAll('.exp-friend-row')) {
        row.hidden = !!query && !row.textContent.toLowerCase().includes(query);
      }
    }

    container.addEventListener('click', onClick);
    container.addEventListener('submit', onSubmit);
    container.addEventListener('change', onChange);
    container.addEventListener('input', onInput);

    // ----------------------------------------------------------- rendering
    function pendingForGroup(groupId) {
      return state.splits.filter((s) => s.groupID === groupId).reduce((sum, s) => sum + s.pendingMinor, 0);
    }

    function renderDashboard() {
      const totalPending = state.splits.reduce((sum, s) => sum + s.pendingMinor, 0);
      const readiness = readinessFor(state);
      const recent = state.splits.slice(0, 2);
      const cards = state.groups.map((g) => `
        <button type="button" class="exp-group-card" data-action="filter-activity-group" data-group="${g.id === null ? 'none' : escapeHtml(g.id)}">
          <strong>${escapeHtml(g.name)}</strong>
          <span class="fine">${g.splitCount} split${g.splitCount === 1 ? '' : 's'}</span>
          <span class="exp-pending">${money(pendingForGroup(g.id))} pending</span>
        </button>`).join('');
      return `
        <section class="exp-readiness-card" aria-labelledby="exp-readiness-title">
          <div class="exp-readiness-head">
            <div><p class="eyebrow">START HERE</p><h2 id="exp-readiness-title">${readiness.doneCount === readiness.total ? 'You are ready to split a bill.' : 'Get ready for your first shared bill.'}</h2>
              <p>${readiness.doneCount} of ${readiness.total} setup steps complete. Nothing is charged automatically.</p></div>
            <div class="exp-readiness-progress" aria-label="${readiness.doneCount} of ${readiness.total} setup steps complete"><span style="width:${(readiness.doneCount / readiness.total) * 100}%"></span></div>
          </div>
          <div class="exp-readiness-steps">
            ${readiness.steps.map((step, index) => `<button type="button" class="exp-readiness-step ${step.done ? 'is-done' : ''}" data-action="${step.action}"${step.view ? ` data-view="${step.view}"` : ''}>
              <span class="exp-step-state">${step.done ? '&#10003;' : index + 1}</span><span><strong>${escapeHtml(step.label)}</strong><small>${escapeHtml(step.detail)}</small></span><em>${step.done ? 'Done' : 'Open'}</em>
            </button>`).join('')}
          </div>
          <div class="exp-next-action"><div><strong>Next best action</strong><span>${escapeHtml(readiness.next.detail)}</span></div>
            <button type="button" class="btn btn-primary" data-action="${readiness.next.action}"${readiness.next.view ? ` data-view="${readiness.next.view}"` : ''}>${escapeHtml(readiness.next.label)} &rarr;</button></div>
        </section>
        <div class="exp-clarity-grid">
          <div><strong>What this tab does</strong><p>Calculates exact shares, keeps a private ledger, opens reminders and records your manual settlement updates.</p></div>
          <div><strong>How payment works</strong><p>Friends pay outside this ledger using the shown UPI or PayPal receiving handle. You then mark their share settled.</p></div>
        </div>
        <div class="exp-summary-row">
          <div class="exp-summary-card"><span class="fine">Total bill value logged</span><strong>${money(state.analytics ? state.analytics.totalMinor : 0)}</strong></div>
          <div class="exp-summary-card"><span class="fine">Still pending settlement</span><strong>${money(totalPending)}</strong></div>
          <div class="exp-summary-card"><span class="fine">Splits logged</span><strong>${state.analytics ? state.analytics.splitCount : 0}</strong></div>
        </div>
        <div class="section-header"><div><h2 class="exp-subheading">Recent splits</h2><p class="fine">Open a share to remind someone or record a manual settlement.</p></div>
          ${state.splits.length > 2 ? '<button type="button" class="btn btn-quiet" data-action="nav" data-view="history">View all history</button>' : ''}</div>
        <div class="exp-split-list">${recent.length ? recent.map(renderSplitCard).join('') : '<div class="exp-empty-state"><strong>No bills logged yet.</strong><p>Add a person, then create a split to see exact individual shares here.</p><button type="button" class="btn btn-primary" data-action="nav" data-view="friends">Add your first person</button></div>'}</div>
        <h2 class="exp-subheading">Booking groups <span class="fine">(optional organization)</span></h2>
        <div class="exp-group-grid">${cards || '<p class="fine">No booking groups yet. A split can still be saved without attaching it to a booking group.</p>'}</div>`;
    }

    function renderShareRow(split, share) {
      const toggleable = !share.isPayer;
      const canRemind = toggleable && !share.settled;
      const initial = escapeHtml((String(share.name).trim().charAt(0) || '?').toUpperCase());
      return `
        <li class="exp-share-row ${share.settled ? 'exp-settled' : ''}">
          <span class="exp-share-who">
            <span class="exp-avatar">${initial}</span>
            <span>${escapeHtml(share.name)}${share.upiID ? ` <small class="fine">${escapeHtml(share.upiID)}</small>` : ''}</span>
            ${share.isPayer ? '<span class="badge">payer · manual record</span>' : ''}
          </span>
          <span class="exp-share-amount">${money(share.amountMinor, split.currency)}</span>
          <span class="exp-share-actions">
            ${canRemind ? `<button type="button" class="btn btn-quiet exp-remind-btn" data-action="remind-share" data-split="${split.id}" data-share="${share.id}">${BELL_ICON}Remind</button>` : ''}
            ${toggleable ? `<button type="button" class="btn btn-quiet" data-action="toggle-settle" data-split="${split.id}" data-share="${share.id}" data-settled="${share.settled}">${share.settled ? 'Mark unsettled' : 'Mark settled'}</button>` : '<span class="fine">Always settled</span>'}
          </span>
        </li>`;
    }

    function renderSplitCard(split) {
      const groupName = split.groupID === null ? 'Individual' : (state.groups.find((g) => g.id === split.groupID)?.name || 'Group');
      const icon = CATEGORY_ICON[split.category] || CATEGORY_ICON.other;
      return `
        <div class="exp-split-card ${split.allSettled ? 'is-settled' : 'is-pending'}">
          <div class="exp-split-head">
            <div class="exp-split-ident">
              <span class="exp-cat-icon exp-cat-${escapeHtml(split.category)}" aria-hidden="true">${icon}</span>
              <div>
                <strong>${escapeHtml(split.title)}</strong>
                <span class="fine">${CATEGORY_LABEL[split.category] || split.category} &middot; ${groupName} &middot; ${new Date(split.createdAt * 1000).toLocaleDateString()}</span>
              </div>
            </div>
            <div class="exp-split-total">
              <span class="exp-split-amount">${money(split.totalMinor, split.currency)}</span>
              ${split.allSettled ? '<span class="badge badge-success">All settled</span>' : `<span class="badge badge-gold">${money(split.pendingMinor, split.currency)} pending</span>`}
              ${!split.allSettled ? `<button type="button" class="btn btn-outline exp-remind-all-btn" data-action="remind-split" data-split="${split.id}">${BELL_ICON}Remind all pending</button>` : ''}
            </div>
          </div>
          <ul class="exp-share-list">${split.shares.map((s) => renderShareRow(split, s)).join('')}</ul>
          ${(split.payee?.upiID || split.payee?.paypalEmail) ? `<p class="fine">${escapeHtml(split.payee.hostName || 'Payer')} can receive a manual repayment at ${escapeHtml([split.payee.upiID, split.payee.paypalEmail].filter(Boolean).join(' or '))}. These handles are unverified; marking settled is manual.</p>` : ''}
        </div>`;
    }

    function renderActivity() {
      const filtered = state.activityGroup === 'ALL' ? state.splits
        : state.splits.filter((s) => (state.activityGroup === 'none' ? s.groupID === null : s.groupID === state.activityGroup));
      const active = filtered.filter((split) => !split.allSettled);
      const pills = [{key: 'ALL', label: 'All'}, {key: 'none', label: 'Individual'},
        ...state.groups.filter((g) => g.id !== null).map((g) => ({key: g.id, label: g.name}))];
      return `
        <div class="section-header"><div><h2 class="exp-subheading">Activity</h2><p class="fine">Open repayments only: remind someone, or mark a share settled after you verify it yourself.</p></div>
          <button type="button" class="btn btn-primary" data-action="new-split">+ New split</button></div>
        <div class="filter-row exp-filter-row">${pills.map((p) => `
          <button type="button" class="filter-pill ${state.activityGroup === p.key ? 'active' : ''}" data-action="filter-activity-group" data-group="${escapeHtml(p.key)}">${escapeHtml(p.label)}</button>`).join('')}
        </div>
        <p class="exp-boundary-note"><strong>Manual status only.</strong> A settled mark means you recorded repayment; it is not evidence from UPI or PayPal.</p>
        <div class="exp-split-list">${active.length ? active.map(renderSplitCard).join('') : '<div class="exp-empty-state"><strong>No open repayments here.</strong><p>Completed records stay in History. Start another bill whenever you are ready.</p><button type="button" class="btn btn-primary" data-action="new-split">Create a split</button></div>'}</div>`;
    }

    function renderHistory() {
      return `<h2 class="exp-subheading">Split history</h2>
        <p class="fine">All your saved splits, newest first. Settled means you marked the repayment complete; it is not PayPal evidence.</p>
        <div class="exp-split-list">${state.splits.length ? state.splits.map(renderSplitCard).join('') : '<div class="exp-empty-state"><strong>No split history yet.</strong><p>Your saved bills and individual shares will appear here.</p><button type="button" class="btn btn-primary" data-action="new-split">Create your first split</button></div>'}</div>`;
    }

    function renderFriends() {
      const query = state.friendQuery.trim().toLowerCase();
      const matching = state.friends.filter((f) => !query || [f.name, f.upiID, f.whatsapp].some((v) => String(v || '').toLowerCase().includes(query)));
      const rows = matching.map((f) => `
        <li class="exp-friend-row">
          <span class="exp-friend-person"><span class="exp-avatar">${escapeHtml((f.name.trim().charAt(0) || '?').toUpperCase())}</span><span><strong>${escapeHtml(f.name)}</strong><small>${f.whatsapp ? `WhatsApp ${escapeHtml(f.whatsapp)}` : 'No WhatsApp number'}${f.upiID ? ` · Settlement ID ${escapeHtml(f.upiID)}` : ''}</small></span></span>
          <span class="exp-friend-actions"><button type="button" class="btn btn-outline" data-action="new-split-with-friend" data-id="${escapeHtml(f.id)}">Split with ${escapeHtml(f.name)}</button>
          <button type="button" class="btn btn-quiet" data-action="delete-friend" data-id="${escapeHtml(f.id)}">Remove</button></span>
        </li>`).join('');
      return `
        <div class="section-header"><div><h2 class="exp-subheading">People <span class="fine">${state.friends.length} saved</span></h2><p class="fine">Your private address book for bills and reminders. Add someone once, then select them by name in future splits.</p></div>
          ${state.friends.length ? '<button type="button" class="btn btn-primary" data-action="new-split">Create a split</button>' : ''}</div>
        <p class="exp-boundary-note"><strong>Contact details are not identity or payment authorization.</strong> WhatsApp opens a reminder; a UPI ID is only shown as an unverified receiving handle.</p>
        <label class="exp-search-label" for="exp-friend-search">Search people<input id="exp-friend-search" type="search" value="${escapeHtml(state.friendQuery)}" placeholder="Search name, number or settlement ID"></label>
        <form id="exp-friend-form" class="exp-inline-form exp-friend-form">
          <label>Name<input id="exp-friend-name" type="text" placeholder="e.g. Aisha" maxlength="80" required></label>
          <label>WhatsApp number <small class="fine">for reminders</small><input id="exp-friend-whatsapp" type="tel" placeholder="e.g. +91 98765 43210" maxlength="40"></label>
          <label>UPI ID / settlement handle <small class="fine">optional, unverified</small><input id="exp-friend-upi" type="text" placeholder="name@bank" maxlength="80"></label>
          <button type="submit" class="btn btn-primary">Save person</button>
        </form>
        <ul class="exp-friend-list">${rows || `<p class="fine">${query ? 'No people match this search.' : 'No people saved yet. Add someone before creating a shared bill.'}</p>`}</ul>`;
    }

    function renderSubscriptions() {
      const cards = state.subscriptions.map((s) => `
        <div class="exp-sub-card">
          <div>
            <strong>${escapeHtml(s.name)}</strong>
            <span class="fine">${money(s.monthlyAmountMinor, s.currency)} / month &middot; billed on day ${s.billingDay}</span>
            <span class="fine">Host: ${escapeHtml(s.hostName || 'You')}${s.upiID ? ` · UPI: ${escapeHtml(s.upiID)}` : ''}</span>
            <span class="fine">${s.participants.map((p) => escapeHtml(p.name)).join(', ') || 'Just you'}</span>
            <span class="fine">Example equal share: ${money(Math.floor(s.monthlyAmountMinor / (s.participants.length + 1)), s.currency)} each, with remainder cents assigned in order. Create a new split on each billing cycle to track actual repayment.</span>
          </div>
          <div><button type="button" class="btn btn-outline" data-action="new-sub-cycle" data-id="${escapeHtml(s.id)}">Log this month’s split</button>
          <button type="button" class="btn btn-quiet" data-action="delete-subscription" data-id="${escapeHtml(s.id)}">Remove</button></div>
        </div>`).join('');
      return `
        <div class="section-header"><div><h2 class="exp-subheading">Recurring bills</h2><p class="fine">Netflix, Spotify, rent or any monthly shared cost.</p></div>
          <button type="button" class="btn btn-outline" data-action="new-subscription">+ Add recurring bill</button></div>
        <p class="exp-boundary-note"><strong>Reminder schedule only.</strong> The host and participants still settle manually; nothing here charges a UPI or PayPal account.</p>
        <div class="exp-sub-grid">${cards || '<div class="exp-empty-state"><strong>No recurring bills yet.</strong><p>Save Netflix, Spotify, rent or another monthly amount, then log each month as a reviewed split.</p><button type="button" class="btn btn-primary" data-action="new-subscription">Add a recurring bill</button></div>'}</div>`;
    }

    function renderAnalytics() {
      const a = state.analytics || {totalMinor: 0, byCategory: {}, byMonth: {}, splitCount: 0};
      const maxCategory = Math.max(1, ...Object.values(a.byCategory));
      const categoryRows = CATEGORIES.filter((c) => a.byCategory[c]).map((c) => `
        <li><span>${CATEGORY_LABEL[c]}</span>
          <div class="exp-bar-track"><div class="exp-bar-fill" style="width:${(a.byCategory[c] / maxCategory) * 100}%"></div></div>
          <span>${money(a.byCategory[c])}</span></li>`).join('');
      const monthRows = Object.entries(a.byMonth).map(([month, amount]) => `<li><span>${escapeHtml(month)}</span><span>${money(amount)}</span></li>`).join('');
      return `
        <h2 class="exp-subheading">Analytics</h2>
        <p class="fine">Totals across the splits you created. Not a financial or tax record.</p>
        <h3 class="exp-mini-heading">By category</h3>
        <ul class="exp-bar-list">${categoryRows || '<p class="fine">Nothing logged yet.</p>'}</ul>
        <h3 class="exp-mini-heading">By month</h3>
        <ul class="exp-month-list">${monthRows || '<p class="fine">Nothing logged yet.</p>'}</ul>`;
    }

    function renderAccount() {
      return `
        <h2 class="exp-subheading">My settlement details</h2>
        <p class="fine">Used to label you as the bill host and show where friends can settle manually. This is not identity verification and it never authorizes UPI or PayPal.</p>
        <form id="exp-profile-form" class="exp-form-grid">
          <label>Display name<input id="exp-profile-name" type="text" maxlength="80" value="${escapeHtml(state.profile.displayName)}"></label>
           <label>UPI ID / settlement handle<input id="exp-profile-upi" type="text" maxlength="80" value="${escapeHtml(state.profile.upiID)}" placeholder="Optional · unverified"></label>
           <button type="submit" class="btn btn-primary">Save my details</button>
        </form>`;
    }

    function renderSplitModal() {
      const d = state.draft;
      const groupOptions = state.groups.filter((g) => g.id !== null).map((g) => `<option value="${escapeHtml(g.id)}" ${d.groupId === g.id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join('');
      const friendChecks = state.friends.map((f) => `
        <label class="exp-check"><input type="checkbox" data-action="toggle-participant" data-id="${escapeHtml(f.id)}" ${d.selected.includes(f.id) ? 'checked' : ''}><span class="exp-avatar">${escapeHtml((f.name.trim().charAt(0) || '?').toUpperCase())}</span>${escapeHtml(f.name)}${f.whatsapp ? ` <small>${escapeHtml(f.whatsapp)}</small>` : ''}</label>`).join('');
      const you = state.profile.displayName || 'You';
      const names = participantNames();
      let previewLine = '';
      try {
        const totalMinor = d.total ? cents(d.total) : 0;
        if (totalMinor > 0) {
          const amounts = splitEqualCents(totalMinor, names);
          previewLine = `<div class="exp-share-preview"><strong>Who owes what</strong>${names.map((n, index) => `<span><span>${escapeHtml(n)}${index === 0 ? ' <small>(you · paid the bill)</small>' : ''}</span><b>${money(amounts[n])}</b></span>`).join('')}</div>`;
        }
      } catch { /* shown via formError on save */ }
      const scanStatus = d.scanStatus;
      const scanDisabledNote = scanStatus && !scanStatus.available ? `<p class="fine exp-warn">Receipt scanning is not configured on this server (${escapeHtml(scanStatus.model || scanStatus.provider || 'model')}). Enter details manually.</p>` : '';
      const scanProviderCopy = scanStatus?.provider === 'ollama_cloud'
        ? 'Ollama Cloud is configured by the app operator. This receipt photo is sent to Ollama for an unsaved preview; no user model key is collected.'
        : 'Qwen3-VL runs on this app server. Your photo is sent to this server for an unsaved preview.';
      const draftStatus = splitDraftReadiness(d);
      return `
        <div class="modal-backdrop" id="exp-split-modal-backdrop">
          <div class="modal-card modal-card-wide">
            <div class="modal-header">
              <div class="split-modal-title">
                <span class="badge badge-gold">NEW LEDGER ENTRY</span>
                <h2>New split</h2>
              </div>
              <button type="button" class="modal-close-btn" data-action="close-modal">&times;</button></div>
            <div class="modal-body">
              ${d.formError ? `<p class="exp-error">${escapeHtml(d.formError)}</p>` : ''}
              ${d.scanInfo ? `<p class="exp-notice">${escapeHtml(d.scanInfo)}</p>` : ''}
              ${d.scanError ? `<p class="exp-warn">${escapeHtml(d.scanError)}</p>` : ''}
              ${scanDisabledNote}
              <div class="exp-draft-checks" aria-label="Split readiness">
                <span class="${draftStatus.bill ? 'is-ready' : ''}">${draftStatus.bill ? '&#10003;' : '1'} Bill details</span>
                <span class="${draftStatus.people ? 'is-ready' : ''}">${draftStatus.people ? '&#10003;' : '2'} People</span>
                <span class="${draftStatus.repayment ? 'is-ready' : ''}">${draftStatus.repayment ? '&#10003;' : '3'} Repayment details</span>
              </div>
              <section class="exp-modal-step" aria-labelledby="exp-step-bill">
                <div class="exp-modal-step-head"><span>1</span><div><h3 id="exp-step-bill">Bill details</h3><p>Scan a receipt or enter the trusted total yourself. Review AI suggestions before saving.</p></div></div>
                <div class="exp-scan-card">
                  <div class="exp-scan-icon" aria-hidden="true">&#9638;</div>
                  <div class="exp-scan-copy">
                    <strong>Optional receipt scan</strong>
                    <span class="fine">${scanProviderCopy}</span>
                  </div>
                  <input id="exp-scan-input" type="file" accept="image/jpeg,image/png,image/webp" hidden>
                  <button type="button" class="btn btn-outline" data-action="trigger-scan" ${d.scanBusy || (scanStatus && !scanStatus.available) ? 'disabled' : ''}>${d.scanBusy ? 'Scanning…' : 'Scan receipt'}</button>
                  ${d.scanPreviewUrl ? `
                    <figure class="exp-scan-preview ${d.scanBusy ? 'is-scanning' : ''}">
                      <img src="${escapeHtml(d.scanPreviewUrl)}" alt="Receipt you selected, previewed locally">
                      ${d.scanBusy ? '<span class="exp-scan-beam" aria-hidden="true"></span><span class="exp-scan-veil" aria-hidden="true"></span>' : ''}
                      <figcaption class="fine">${d.scanBusy ? 'Reading this receipt on the app server…' : 'Preview only — the selected photo is not saved with the split.'}</figcaption>
                    </figure>` : ''}
                </div>
                <label>Bill title<input id="exp-split-title" type="text" maxlength="160" value="${escapeHtml(d.title)}" placeholder="Dinner at Luigi's"></label>
                <div class="exp-form-row">
                  <label>Category<select id="exp-split-category">${CATEGORIES.map((c) => `<option value="${c}" ${d.category === c ? 'selected' : ''}>${CATEGORY_LABEL[c]}</option>`).join('')}</select></label>
                  <label>Booking group <small class="fine">optional</small><select id="exp-split-group"><option value="" ${!d.groupId ? 'selected' : ''}>No booking group</option>${groupOptions}</select></label>
                  <label>Total amount (USD)<input id="exp-split-total" type="text" inputmode="decimal" value="${escapeHtml(d.total)}" placeholder="0.00"></label>
                </div>
              </section>
              <section class="exp-modal-step" aria-labelledby="exp-step-people">
                <div class="exp-modal-step-head"><span>2</span><div><h3 id="exp-step-people">Choose people</h3><p>Select at least one saved person. Exact cents are assigned in the displayed order.</p></div></div>
                <div class="exp-check-grid">${friendChecks || '<div class="exp-empty-inline"><p class="fine">No people saved yet. Add someone before saving a shared bill.</p><button type="button" class="btn btn-outline" data-action="open-friends">Add people</button></div>'}</div>
                ${previewLine || '<p class="fine">Enter a total and choose people to preview every individual share.</p>'}
              </section>
              <section class="exp-modal-step" aria-labelledby="exp-step-repayment">
                <div class="exp-modal-step-head"><span>3</span><div><h3 id="exp-step-repayment">Show where to repay</h3><p>These receiving details are copied into this ledger record; they do not authorize or verify payment.</p></div></div>
                <div class="exp-form-row"><label>Host name<input id="exp-split-host" value="${escapeHtml(d.hostName)}" maxlength="80" placeholder="Your name"></label><label>UPI ID (optional)<input id="exp-split-upi" value="${escapeHtml(d.upiID)}" maxlength="80" placeholder="name@bank"></label></div>
                <label>PayPal email (optional, not a login)<input id="exp-split-paypal" type="email" value="${escapeHtml(d.paypalEmail)}" maxlength="160"></label>
                <p class="exp-boundary-note"><strong>No automatic payment.</strong> Friends pay outside this ledger. Mark a share settled only after you verify repayment yourself.</p>
              </section>
            </div>
            <div class="modal-actions-row">
              <button type="button" class="btn btn-outline" data-action="close-modal">Cancel</button>
              <button type="button" class="btn btn-primary" data-action="save-split" ${state.saving ? 'disabled' : ''}>${state.saving ? 'Saving…' : 'Save & view individual shares'}</button>
            </div>
          </div>
        </div>`;
    }

    function renderSubscriptionModal() {
      const d = state.draft;
      const rows = d.participants.map((p, i) => `
        <div class="exp-form-row">
          <input id="exp-sub-p-name-${i}" type="text" placeholder="Name" value="${escapeHtml(p.name)}">
          <input id="exp-sub-p-wa-${i}" type="text" placeholder="WhatsApp (optional)" value="${escapeHtml(p.whatsapp)}">
          <button type="button" class="btn btn-quiet" data-action="remove-sub-participant" data-index="${i}">Remove</button>
        </div>`).join('');
      const availableFriends = state.friends.filter((friend) => !d.participants.some((p) => p.name.toLowerCase() === friend.name.toLowerCase()));
      const friendButtons = availableFriends.map((friend) => `<button type="button" class="filter-pill" data-action="add-sub-friend" data-id="${escapeHtml(friend.id)}">+ ${escapeHtml(friend.name)}</button>`).join('');
      const host = state.profile.displayName || 'You';
      return `
        <div class="modal-backdrop" id="exp-sub-modal-backdrop">
          <div class="modal-card">
            <div class="modal-header">
              <div class="split-modal-title">
                <span class="badge badge-gold">RECURRING REMINDER</span>
                <h2>New recurring bill</h2>
              </div>
              <button type="button" class="modal-close-btn" data-action="close-modal">&times;</button></div>
            <div class="modal-body">
              ${d.formError ? `<p class="exp-error">${escapeHtml(d.formError)}</p>` : ''}
               <p class="exp-boundary-note"><strong>Host:</strong> ${escapeHtml(host)}${state.profile.upiID ? ` · settle to ${escapeHtml(state.profile.upiID)}` : ' · add a settlement handle in My details if you want it shown'}. This creates reminders, not an automatic charge.</p>
               <label>Service or bill name<input id="exp-sub-name" type="text" maxlength="80" value="${escapeHtml(d.name)}" placeholder="Netflix, Spotify, rent…"></label>
              <div class="exp-form-row">
                <label>Monthly amount (USD)<input id="exp-sub-amount" type="text" inputmode="decimal" value="${escapeHtml(d.monthlyAmount)}" placeholder="0.00"></label>
                <label>Billing day<input id="exp-sub-day" type="number" min="1" max="28" value="${escapeHtml(d.billingDay)}"></label>
              </div>
              <div class="exp-form-row"><label>Host name<input id="exp-sub-host" value="${escapeHtml(d.hostName)}" maxlength="80"></label><label>Host UPI ID (optional)<input id="exp-sub-upi" value="${escapeHtml(d.upiID)}" maxlength="80"></label></div>
              <p class="exp-mini-heading">Who shares this</p>
               ${friendButtons ? `<div class="filter-row exp-saved-friends"><span class="fine">Add saved people:</span>${friendButtons}</div>` : ''}
              ${rows}
              <button type="button" class="btn btn-quiet" data-action="add-sub-participant">+ Add person</button>
            </div>
            <div class="modal-actions-row">
              <button type="button" class="btn btn-outline" data-action="close-modal">Cancel</button>
              <button type="button" class="btn btn-primary" data-action="save-subscription" ${state.saving ? 'disabled' : ''}>${state.saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>`;
    }

    function render() {
      const openCount = state.splits.filter((split) => !split.allSettled).length;
      const navItems = [['dashboard', 'Start'], ['activity', 'Activity', openCount], ['friends', 'People', state.friends.length],
        ['subscriptions', 'Recurring'], ['history', 'History'], ['analytics', 'Insights'], ['account', 'My details']];
      const body = {
        dashboard: renderDashboard, activity: renderActivity, history: renderHistory, friends: renderFriends,
        subscriptions: renderSubscriptions, analytics: renderAnalytics, account: renderAccount,
      }[state.view]();
      container.innerHTML = `
        <div class="exp-wrap">
          <div class="section-header page-intro">
            <div>
               <p class="eyebrow">BILLS &amp; SHARED EXPENSES</p>
               <h1>Scan it. Split it.<br>Know who owes what.</h1>
               <p>Add people, scan or enter a bill, review exact individual shares, and track settlement history.</p>
            </div>
             <span class="badge badge-gold">LEDGER &amp; REMINDERS &mdash; NO AUTOMATIC CHARGE</span>
          </div>
          <div class="exp-toolbar">
            <div class="filter-row exp-primary-nav" aria-label="Bills and splits sections">${navItems.map(([key, label, count]) => `<button type="button" class="filter-pill ${state.view === key ? 'active' : ''}" data-action="nav" data-view="${key}">${label}${count ? ` <span class="exp-nav-count">${count}</span>` : ''}</button>`).join('')}</div>
            <button type="button" class="btn btn-primary" data-action="new-split">+ New split</button>
          </div>
          ${state.error ? `<p class="exp-error">${escapeHtml(state.error)}</p>` : ''}
          ${state.notice ? `<p class="exp-notice">${escapeHtml(state.notice)}</p>` : ''}
          ${state.busy ? '<p class="fine">Loading…</p>' : body}
        </div>
        ${state.modal === 'split' ? renderSplitModal() : ''}
        ${state.modal === 'subscription' ? renderSubscriptionModal() : ''}`;
    }

    refreshAll();
    return {refresh: refreshAll};
  }

  root.GroupPayExpenses = {mount, test: {cents, splitEqualCents, readinessFor, splitDraftReadiness}};
})(window);

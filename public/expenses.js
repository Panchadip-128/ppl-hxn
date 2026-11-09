'use strict';

// Informal personal expense splitting. A private ledger between named people, not PayPal
// payment state: nothing here owns consent, prices, inventory or tickets. Receipt scanning
// uses an operator-configured vision provider; its output is an editable, unsaved preview.
(function (root) {
  const CATEGORIES = ['food', 'travel', 'rent', 'entertainment', 'shopping', 'other'];
  const CATEGORY_LABEL = {food: 'Food', travel: 'Travel', rent: 'Rent', entertainment: 'Entertainment', shopping: 'Shopping', other: 'Other'};
  const CATEGORY_COLOR = {
    food: '#8b5cf6',
    travel: '#06b6d4',
    rent: '#ec4899',
    entertainment: '#a855f7',
    shopping: '#f59e0b',
    other: '#10b981',
  };
  // Geometric text glyphs (with explicit text-presentation selectors) so no platform substitutes an emoji.
  const CATEGORY_ICON = {food: '\u25C9', travel: '\u2708\uFE0E', rent: '\u2302', entertainment: '\u266A', shopping: '\u25A3', other: '\u25C7'};
  // Inline stroked bell so reminder buttons keep the app's icon language instead of an emoji glyph.
  const BELL_ICON = '<svg class="icon-bell" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 8.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5"/><path d="M13.7 19a2 2 0 0 1-3.4 0"/></svg>';

  const DEMO_ANALYTICS_SAMPLE = {
    totalMinor: 148500,
    splitCount: 12,
    settledMinor: 116000,
    pendingMinor: 32500,
    byCategory: {
      food: 42500,
      rent: 54000,
      entertainment: 21500,
      travel: 19500,
      shopping: 11000,
    },
    byMonth: {
      '2026-06': 24000,
      '2026-07': 31500,
      '2026-08': 28000,
      '2026-09': 34500,
      '2026-10': 30500,
    },
  };

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

  function greetingByTime() {
    try {
      const hr = new Date().getHours();
      if (hr < 12) return 'GOOD MORNING';
      if (hr < 17) return 'GOOD AFTERNOON';
      return 'GOOD EVENING';
    } catch {
      return 'GOOD MORNING';
    }
  }

  function mount(container, ctx) {
    if (!container) return null;
    const api = ctx.api;
    const escapeHtml = ctx.escapeHtml || ((s) => String(s === null || s === undefined ? '' : s));
    const getCsrfToken = ctx.getCsrfToken || (() => '');

    const state = {
      view: ctx.initialView || 'dashboard', groups: [], friends: [], splits: [], subscriptions: [], analytics: null,
      profile: {displayName: '', upiID: ''}, busy: false, loaded: false, error: '', notice: '',
      activityGroup: 'ALL', friendQuery: '', groupQuery: '', historyFilter: 'ALL', historyQuery: '',
      analyticsDemo: false, modal: null, draft: null, saving: false,
    };

    const chartInstances = {};

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

    async function remindSubscriptionParticipant(sub, participant) {
      const names = [sub.hostName || state.profile.displayName || 'Host', ...sub.participants.map((p) => p.name)];
      const shares = splitEqualCents(sub.monthlyAmountMinor, names);
      const shareMinor = shares[participant.name] || Math.floor(sub.monthlyAmountMinor / Math.max(1, names.length));
      const handleNote = sub.upiID ? ` (Settle to ${sub.upiID})` : '';
      const message = `Hi ${participant.name}! Reminder for ${sub.name} (billing day ${sub.billingDay}): your share is ${money(shareMinor, sub.currency)}${handleNote}.`;
      const digits = friendWhatsappDigits(participant);
      if (digits) {
        window.open('https://wa.me/' + digits + '?text=' + encodeURIComponent(message), '_blank', 'noopener,noreferrer');
        state.notice = `Opened WhatsApp to remind ${participant.name} for ${sub.name}.`;
      } else {
        const copied = await copyText(message);
        state.notice = copied ? `Subscription reminder for ${participant.name} copied to clipboard.` : message;
        root.GroupPayToast?.(`Reminder for ${participant.name} copied!`);
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
    function openSplitModal(autoTriggerScan = false) {
      state.modal = 'split';
      state.notice = '';
      state.draft = {
        title: '', category: 'food', currency: 'USD', groupId: '',
        hostName: state.profile.displayName || '', upiID: state.profile.upiID || '', paypalEmail: '',
        total: '', selected: [], scanBusy: false, scanError: '', scanInfo: '', receiptMeta: null, formError: '',
        scanStatus: null, scanPreviewUrl: '',
      };
      render();
      if (autoTriggerScan && typeof setTimeout === 'function') {
        setTimeout(() => { $$('#exp-scan-input')?.click(); }, 60);
      }
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
        const scanErrors = {
          LOCAL_MODEL_UNAVAILABLE: 'The server-local Qwen receipt vision model is not prepared on this machine. Enter the bill details manually below.',
          RECEIPT_MODEL_NOT_CONFIGURED: 'Receipt scanning is not configured on this server. Enter the bill details manually below.',
          RECEIPT_IMAGE_TOO_LARGE: 'That receipt photo is over the 6 MB limit. Choose a smaller image or enter the bill manually.',
          UNSUPPORTED_IMAGE_TYPE: 'Choose a JPEG, PNG, or WebP receipt image.',
          INVALID_RECEIPT_IMAGE: 'The selected file could not be decoded as a valid image. Enter the bill details manually.',
        };
        if (!response.ok) throw new Error(data.message || scanErrors[data.error] || data.error || 'Receipt scan failed.');
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
    function openSubscriptionModal(existingSub = null) {
      state.modal = 'subscription';
      if (existingSub) {
        state.draft = {
          editId: existingSub.id,
          name: existingSub.name || '',
          monthlyAmount: ((existingSub.monthlyAmountMinor || 0) / 100).toFixed(2),
          billingDay: String(existingSub.billingDay || 10),
          hostName: existingSub.hostName || state.profile.displayName || '',
          upiID: existingSub.upiID || state.profile.upiID || '',
          participants: (existingSub.participants || []).map((p) => ({name: p.name || '', whatsapp: p.whatsapp || ''})),
          formError: '',
        };
      } else {
        state.draft = {
          editId: null,
          name: '',
          monthlyAmount: '',
          billingDay: '10',
          hostName: state.profile.displayName || '',
          upiID: state.profile.upiID || '',
          participants: [{name: '', whatsapp: ''}],
          formError: '',
        };
      }
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
        const editId = state.draft.editId;
        await api('/api/expenses/subscriptions', {
          name: state.draft.name.trim(), monthlyAmountMinor: monthlyMinor, billingDay, currency: 'USD', participants,
          hostName: state.draft.hostName.trim(), upiID: state.draft.upiID.trim(),
        });
        if (editId) {
          try { await api('/api/expenses/subscriptions/' + encodeURIComponent(editId) + '/delete', {}); } catch { /* ignore if already removed */ }
        }
        state.modal = null; state.draft = null;
        state.notice = editId ? 'Subscription updated. Nothing is charged automatically.' : 'Subscription reminder saved. Nothing is charged automatically.';
        state.saving = false;
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
        else if (action === 'new-split') { openSplitModal(false); }
        else if (action === 'quick-scan') { openSplitModal(true); }
        else if (action === 'open-guide') {
          if (typeof ctx.onOpenGuide === 'function') ctx.onOpenGuide();
          else document.getElementById('show-guide-btn')?.click();
        }
        else if (action === 'new-split-with-friend') {
          openSplitModal(false);
          state.draft.selected = [button.dataset.id];
          render();
        }
        else if (action === 'new-subscription') { openSubscriptionModal(null); }
        else if (action === 'edit-subscription') {
          const sub = state.subscriptions.find((item) => item.id === button.dataset.id);
          if (sub) openSubscriptionModal(sub);
        }
        else if (action === 'remind-sub-participant') {
          const sub = state.subscriptions.find((item) => item.id === button.dataset.id);
          const idx = Number(button.dataset.index);
          const participant = sub && sub.participants[idx];
          if (sub && participant) await remindSubscriptionParticipant(sub, participant);
        }
        else if (action === 'remind-sub-first') {
          const sub = state.subscriptions.find((item) => item.id === button.dataset.id);
          const first = sub && sub.participants[0];
          if (sub && first) await remindSubscriptionParticipant(sub, first);
        }
        else if (action === 'open-friends') { closeModal(); state.view = 'friends'; render(); }
        else if (action === 'new-sub-cycle') {
          const sub = state.subscriptions.find((item) => item.id === button.dataset.id);
          if (!sub) return;
          openSplitModal(false);
          state.draft.title = `${sub.name} · monthly bill`;
          state.draft.category = 'entertainment';
          state.draft.total = (sub.monthlyAmountMinor / 100).toFixed(2);
          state.draft.hostName = sub.hostName || state.profile.displayName || '';
          state.draft.upiID = sub.upiID || state.profile.upiID || '';
          const pNames = new Set(sub.participants.map((participant) => participant.name.trim().toLowerCase()));
          state.draft.selected = state.friends.filter((friend) => pNames.has(friend.name.trim().toLowerCase())).map((friend) => friend.id);
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
            const emptySlot = state.draft.participants.find((item) => !item.name.trim() && !item.whatsapp.trim());
            if (emptySlot) {
              emptySlot.name = friend.name;
              emptySlot.whatsapp = friend.whatsapp || '';
            } else {
              state.draft.participants.push({name: friend.name, whatsapp: friend.whatsapp || ''});
            }
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
        else if (action === 'filter-history-status') { state.historyFilter = button.dataset.status; render(); }
        else if (action === 'copy-history-audit') {
          const lines = state.splits.map((s) => `${new Date(s.createdAt * 1000).toLocaleDateString()} | ${s.title} | ${money(s.totalMinor, s.currency)} | ${s.allSettled ? 'SETTLED' : 'PENDING (' + money(s.pendingMinor, s.currency) + ')'}`);
          const text = `GroupPay Personal Ledger Summary (${state.splits.length} splits — Manual records, not PayPal payment evidence):\n` + (lines.join('\n') || 'No splits logged.');
          await copyText(text);
          state.notice = 'Ledger history summary copied to clipboard.';
          root.GroupPayToast?.('Audit history copied to clipboard.');
          render();
        }
        else if (action === 'toggle-analytics-demo') {
          state.analyticsDemo = !state.analyticsDemo;
          render();
        }
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

    function updateLiveSplitPreview() {
      if (!state.draft || state.modal !== 'split') return;
      syncSplitDraftFromForm();
      const d = state.draft;
      const draftStatus = splitDraftReadiness(d);
      const checks = $$('.exp-draft-checks');
      if (checks) {
        checks.innerHTML = `
          <span class="${draftStatus.bill ? 'is-ready' : ''}">${draftStatus.bill ? '&#10003;' : '1'} Bill details</span>
          <span class="${draftStatus.people ? 'is-ready' : ''}">${draftStatus.people ? '&#10003;' : '2'} People</span>
          <span class="${draftStatus.repayment ? 'is-ready' : ''}">${draftStatus.repayment ? '&#10003;' : '3'} Repayment details</span>`;
      }
      const previewSlot = $$('#exp-live-share-preview');
      if (previewSlot) {
        const names = participantNames();
        let html = '<p class="fine">Enter a total and choose people to preview every individual share.</p>';
        try {
          const totalMinor = d.total ? cents(d.total) : 0;
          if (totalMinor > 0) {
            const amounts = splitEqualCents(totalMinor, names);
            html = `<div class="exp-share-preview"><strong>Who owes what</strong>${names.map((n, index) => `<span><span>${escapeHtml(n)}${index === 0 ? ' <small>(you · paid the bill)</small>' : ''}</span><b>${money(amounts[n], d.currency || 'USD')}</b></span>`).join('')}</div>`;
          }
        } catch { /* validated on submit */ }
        previewSlot.innerHTML = html;
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
      if (state.modal === 'split' && /^exp-split-(group|category)$/.test(event.target.id)) {
        syncSplitDraftFromForm();
        render();
      } else if (state.modal === 'split' && /^exp-split-(title|total|host|upi|paypal)$/.test(event.target.id)) {
        updateLiveSplitPreview();
      } else if (state.modal === 'subscription' && event.target.id?.startsWith('exp-sub-')) {
        syncSubscriptionDraftFromForm();
      }
    }

    function onInput(event) {
      if (state.modal === 'split' && /^exp-split-(title|total|host|upi|paypal)$/.test(event.target.id)) {
        updateLiveSplitPreview();
        return;
      }
      if (event.target.id === 'exp-friend-search') {
        state.friendQuery = event.target.value;
        const query = state.friendQuery.trim().toLowerCase();
        for (const row of container.querySelectorAll('.exp-friend-row')) {
          row.hidden = !!query && !row.textContent.toLowerCase().includes(query);
        }
        return;
      }
      if (event.target.id === 'exp-dash-group-search') {
        state.groupQuery = event.target.value;
        const query = state.groupQuery.trim().toLowerCase();
        for (const row of container.querySelectorAll('.exp-neo-group-row')) {
          row.hidden = !!query && !row.textContent.toLowerCase().includes(query);
        }
        return;
      }
      if (event.target.id === 'exp-history-search') {
        state.historyQuery = event.target.value;
        const query = state.historyQuery.trim().toLowerCase();
        for (const card of container.querySelectorAll('.exp-history-item')) {
          card.hidden = !!query && !card.textContent.toLowerCase().includes(query);
        }
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
      const nonGroupSplits = state.splits.filter((s) => s.groupID === null);
      const nonGroupPending = pendingForGroup(null);

      const groupRows = [
        `<button type="button" class="exp-neo-group-row" data-action="filter-activity-group" data-group="none">
          <span class="exp-neo-group-avatar">NG</span>
          <span class="exp-neo-group-info">
            <strong>Non-group expenses</strong>
            <small>Individual expenses &middot; ${nonGroupSplits.length} split${nonGroupSplits.length === 1 ? '' : 's'}</small>
          </span>
          <span class="exp-neo-group-status ${nonGroupPending === 0 ? 'is-settled' : 'is-pending'}">${nonGroupPending === 0 ? 'SETTLED &rsaquo;' : money(nonGroupPending) + ' DUE &rsaquo;'}</span>
        </button>`,
        ...state.groups.filter((g) => g.id !== null).map((g) => {
          const pend = pendingForGroup(g.id);
          const code = escapeHtml((g.name || 'GP').trim().slice(0, 2).toUpperCase());
          return `<button type="button" class="exp-neo-group-row" data-action="filter-activity-group" data-group="${escapeHtml(g.id)}">
            <span class="exp-neo-group-avatar is-group">${code}</span>
            <span class="exp-neo-group-info">
              <strong>${escapeHtml(g.name)}</strong>
              <small>Booking group &middot; ${g.splitCount} split${g.splitCount === 1 ? '' : 's'}</small>
            </span>
            <span class="exp-neo-group-status ${pend === 0 ? 'is-settled' : 'is-pending'}">${pend === 0 ? 'SETTLED &rsaquo;' : money(pend) + ' DUE &rsaquo;'}</span>
          </button>`;
        }),
      ].join('');

      const cards = state.groups.map((g) => `
        <button type="button" class="exp-group-card" data-action="filter-activity-group" data-group="${g.id === null ? 'none' : escapeHtml(g.id)}">
          <strong>${escapeHtml(g.name)}</strong>
          <span class="fine">${g.splitCount} split${g.splitCount === 1 ? '' : 's'}</span>
          <span class="exp-pending">${money(pendingForGroup(g.id))} pending</span>
        </button>`).join('');

      return `
        <div class="exp-neo-greeting-header">
          <span class="exp-greeting-kicker">${greetingByTime()}</span>
          <h2 class="exp-greeting-hero"><span class="exp-neon-highlight">${escapeHtml(state.profile.displayName || 'You')}</span></h2>
        </div>
        <div class="exp-neo-dashboard-grid">
          <div class="exp-neo-left-col">
            <div class="exp-neo-settled-box ${totalPending > 0 ? 'has-pending' : ''}">
              <span class="exp-top-accent-strip" aria-hidden="true"></span>
              <span class="exp-neo-box-label">${totalPending === 0 ? 'ALL SETTLED' : 'PENDING REPAYMENTS'}</span>
              <strong class="exp-neo-box-value">${totalPending === 0 ? '&mdash;' : money(totalPending)}</strong>
              <span class="exp-neo-box-sub">${totalPending === 0 ? 'No pending amounts' : `${readiness.openCount} open split${readiness.openCount === 1 ? '' : 's'} awaiting manual settlement`}</span>
            </div>
            <div class="exp-neo-segmented-bar" role="group" aria-label="Quick expense actions">
              <button type="button" class="exp-seg-cell" data-action="quick-scan">
                <span class="exp-seg-icon" aria-hidden="true">&#9638;</span>
                <span>Scan</span>
              </button>
              <button type="button" class="exp-seg-cell" data-action="nav" data-view="history">
                <span class="exp-seg-icon" aria-hidden="true">&#9719;</span>
                <span>History</span>
              </button>
              <button type="button" class="exp-seg-cell" data-action="open-guide">
                <span class="exp-seg-icon" aria-hidden="true">&#9432;</span>
                <span>Guide</span>
              </button>
              <button type="button" class="exp-seg-cell is-primary-cell" data-action="new-split">
                <span class="exp-seg-icon is-neon-box" aria-hidden="true">+</span>
                <span>New<br>Split</span>
              </button>
            </div>
          </div>
          <div class="exp-neo-right-col">
            <div class="exp-neo-search-wrap">
              <span class="exp-neo-search-glyph" aria-hidden="true">&#8981;</span>
              <input id="exp-dash-group-search" type="search" value="${escapeHtml(state.groupQuery)}" placeholder="Search groups or members...">
            </div>
            <div class="exp-neo-groups-head">
              <span>GROUPS</span>
              <button type="button" class="exp-neo-create-link" data-action="new-split">+ CREATE SPLIT</button>
            </div>
            <div class="exp-neo-groups-list">${groupRows}</div>
          </div>
        </div>

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
        <div class="exp-split-card exp-history-item ${split.allSettled ? 'is-settled' : 'is-pending'}">
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
        <div class="exp-neo-page-head">
          <div class="exp-neo-title-group">
            <button type="button" class="exp-back-btn" data-action="nav" data-view="dashboard" aria-label="Back to Start">&lsaquo;</button>
            <h2 class="exp-neo-page-title">Activity</h2>
          </div>
          <button type="button" class="btn btn-primary exp-tactile-btn" data-action="new-split">+ New split</button>
        </div>
        <p class="fine exp-neo-lead">Open repayments only: remind someone, or mark a share settled after you verify it yourself.</p>
        <div class="filter-row exp-filter-row">${pills.map((p) => `
          <button type="button" class="filter-pill ${state.activityGroup === p.key ? 'active' : ''}" data-action="filter-activity-group" data-group="${escapeHtml(p.key)}">${escapeHtml(p.label)}</button>`).join('')}
        </div>
        <p class="exp-boundary-note"><strong>Manual status only.</strong> A settled mark means you recorded repayment; it is not evidence from UPI or PayPal.</p>
        <div class="exp-split-list">${active.length ? active.map(renderSplitCard).join('') : '<div class="exp-empty-state"><strong>No open repayments here.</strong><p>Completed records stay in History. Start another bill whenever you are ready.</p><button type="button" class="btn btn-primary exp-tactile-btn" data-action="new-split">Create a split</button></div>'}</div>`;
    }

    function renderHistory() {
      const totalVolume = state.splits.reduce((sum, s) => sum + s.totalMinor, 0);
      const pendingVolume = state.splits.reduce((sum, s) => sum + s.pendingMinor, 0);
      const settledVolume = Math.max(0, totalVolume - pendingVolume);
      const filtered = state.splits.filter((s) => {
        if (state.historyFilter === 'SETTLED' && !s.allSettled) return false;
        if (state.historyFilter === 'PENDING' && s.allSettled) return false;
        if (state.historyQuery.trim()) {
          const q = state.historyQuery.trim().toLowerCase();
          const hay = `${s.title} ${s.category} ${s.shares.map((sh) => sh.name).join(' ')}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      return `
        <div class="exp-neo-page-head">
          <div class="exp-neo-title-group">
            <button type="button" class="exp-back-btn" data-action="nav" data-view="dashboard" aria-label="Back to Start">&lsaquo;</button>
            <h2 class="exp-neo-page-title">History</h2>
          </div>
          <div class="button-row">
            <button type="button" class="btn btn-outline exp-tactile-btn-sm" data-action="copy-history-audit">Copy Audit Log</button>
            <button type="button" class="btn btn-primary exp-tactile-btn-sm" data-action="new-split">+ New split</button>
          </div>
        </div>
        <p class="fine exp-neo-lead">Chronological ledger of all saved splits and settlements. Settled means you marked the repayment complete; it is not PayPal evidence.</p>
        <div class="exp-summary-row">
          <div class="exp-summary-card"><span class="fine">Total historical volume</span><strong>${money(totalVolume)}</strong></div>
          <div class="exp-summary-card"><span class="fine">Marked settled</span><strong>${money(settledVolume)}</strong></div>
          <div class="exp-summary-card"><span class="fine">Still pending</span><strong>${money(pendingVolume)}</strong></div>
        </div>
        <div class="exp-history-controls">
          <div class="filter-row">
            <button type="button" class="filter-pill ${state.historyFilter === 'ALL' ? 'active' : ''}" data-action="filter-history-status" data-status="ALL">All (${state.splits.length})</button>
            <button type="button" class="filter-pill ${state.historyFilter === 'PENDING' ? 'active' : ''}" data-action="filter-history-status" data-status="PENDING">Pending (${state.splits.filter((s) => !s.allSettled).length})</button>
            <button type="button" class="filter-pill ${state.historyFilter === 'SETTLED' ? 'active' : ''}" data-action="filter-history-status" data-status="SETTLED">Settled (${state.splits.filter((s) => s.allSettled).length})</button>
          </div>
          <div class="exp-neo-search-wrap exp-history-search-wrap">
            <span class="exp-neo-search-glyph" aria-hidden="true">&#8981;</span>
            <input id="exp-history-search" type="search" value="${escapeHtml(state.historyQuery)}" placeholder="Filter history by title, category, or person...">
          </div>
        </div>
        <div class="exp-split-list">${filtered.length ? filtered.map(renderSplitCard).join('') : '<div class="exp-empty-state"><strong>No split history yet.</strong><p>Your saved bills and individual shares will appear here in chronological order.</p><button type="button" class="btn btn-primary exp-tactile-btn" data-action="new-split">Create your first split</button></div>'}</div>`;
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
        <div class="exp-neo-page-head">
          <div class="exp-neo-title-group">
            <button type="button" class="exp-back-btn" data-action="nav" data-view="dashboard" aria-label="Back to Start">&lsaquo;</button>
            <h2 class="exp-neo-page-title">Friends <span class="fine">${state.friends.length} saved</span></h2>
          </div>
          ${state.friends.length ? '<button type="button" class="btn btn-primary exp-tactile-btn-sm" data-action="new-split">+ New split</button>' : ''}
        </div>
        <p class="fine exp-neo-lead">Your private address book for bills and reminders. Add someone once, then select them by name in future splits.</p>
        <p class="exp-boundary-note"><strong>Contact details are not identity or payment authorization.</strong> WhatsApp opens a reminder; a UPI ID is only shown as an unverified receiving handle.</p>
        <label class="exp-search-label" for="exp-friend-search">Search people<input id="exp-friend-search" type="search" value="${escapeHtml(state.friendQuery)}" placeholder="Search name, number or settlement ID"></label>
        <form id="exp-friend-form" class="exp-inline-form exp-friend-form">
          <label>Name<input id="exp-friend-name" type="text" placeholder="e.g. Aisha" maxlength="80" required></label>
          <label>WhatsApp number <small class="fine">for reminders</small><input id="exp-friend-whatsapp" type="tel" placeholder="e.g. +91 98765 43210" maxlength="40"></label>
          <label>UPI ID / settlement handle <small class="fine">optional, unverified</small><input id="exp-friend-upi" type="text" placeholder="name@bank" maxlength="80"></label>
          <button type="submit" class="btn btn-primary exp-tactile-btn">Save person</button>
        </form>
        <ul class="exp-friend-list">${rows || `<p class="fine">${query ? 'No people match this search.' : 'No people saved yet. Add someone before creating a shared bill.'}</p>`}</ul>`;
    }

    function renderSubscriptions() {
      const cards = state.subscriptions.map((s) => {
        const names = [s.hostName || state.profile.displayName || 'You', ...s.participants.map((p) => p.name)];
        const equalMap = splitEqualCents(s.monthlyAmountMinor, names);
        const hostShare = equalMap[names[0]] || Math.floor(s.monthlyAmountMinor / Math.max(1, names.length));
        const participantRows = s.participants.map((p, idx) => {
          const shareAmt = equalMap[p.name] || Math.floor(s.monthlyAmountMinor / Math.max(1, names.length));
          return `
            <div class="exp-sub-person-row">
              <div class="exp-sub-person-meta">
                <strong>${escapeHtml(p.name)}</strong>
                <span class="exp-sub-mono">${money(shareAmt, s.currency)} &middot; ${p.whatsapp ? escapeHtml(p.whatsapp) : 'no phone'}</span>
              </div>
              <button type="button" class="exp-sub-remind-btn" data-action="remind-sub-participant" data-id="${escapeHtml(s.id)}" data-index="${idx}">Remind</button>
            </div>`;
        }).join('');
        return `
          <article class="exp-sub-card-neo is-due">
            <div class="exp-sub-card-top">
              <div>
                <div class="exp-sub-title-line">
                  <strong class="exp-sub-name">${escapeHtml(s.name)}</strong>
                  <span class="exp-due-pill">DUE</span>
                </div>
                <p class="exp-sub-mono">${money(s.monthlyAmountMinor, s.currency)} &middot; billing day ${s.billingDay} &middot; your share ${money(hostShare, s.currency)}</p>
              </div>
              <div class="exp-sub-top-actions">
                <button type="button" class="exp-text-action" data-action="edit-subscription" data-id="${escapeHtml(s.id)}">Edit</button>
                <button type="button" class="exp-text-action is-danger" data-action="delete-subscription" data-id="${escapeHtml(s.id)}">Remove</button>
                <button type="button" class="exp-text-action" data-action="new-sub-cycle" data-id="${escapeHtml(s.id)}">Log split</button>
              </div>
            </div>
            <hr class="exp-sub-divider">
            <div class="exp-sub-participants-list">
              ${participantRows}
            </div>
            ${s.participants.length ? `<button type="button" class="btn btn-primary exp-tactile-btn exp-sub-wa-cta" data-action="remind-sub-first" data-id="${escapeHtml(s.id)}">Remind first via WhatsApp</button>` : ''}
          </article>`;
      }).join('');

      return `
        <div class="exp-neo-page-head">
          <div class="exp-neo-title-group">
            <button type="button" class="exp-back-btn" data-action="nav" data-view="dashboard" aria-label="Back to Start">&lsaquo;</button>
            <h2 class="exp-neo-page-title">Subscriptions</h2>
          </div>
          <button type="button" class="btn btn-primary exp-tactile-btn-sm" data-action="new-subscription">+ Add</button>
        </div>
        <p class="fine exp-neo-lead">Recurring splits for Netflix, rent, and more. GroupPay marks them due &mdash; you send WhatsApp reminders. Reminder schedule only; nothing here charges a UPI or PayPal account.</p>
        <div class="exp-sub-grid">${cards || '<div class="exp-empty-state"><strong>No recurring bills yet.</strong><p>Save Netflix, Spotify, rent or another monthly amount, then send 1-click WhatsApp reminders or log each month as a reviewed split.</p><button type="button" class="btn btn-primary exp-tactile-btn" data-action="new-subscription">+ Add subscription</button></div>'}</div>`;
    }

    function renderAnalytics() {
      const realAnalytics = state.analytics || {totalMinor: 0, byCategory: {}, byMonth: {}, splitCount: 0};
      const useDemo = state.analyticsDemo || false;
      const a = useDemo ? DEMO_ANALYTICS_SAMPLE : realAnalytics;
      const totalPending = useDemo
        ? DEMO_ANALYTICS_SAMPLE.pendingMinor
        : state.splits.reduce((sum, s) => sum + s.pendingMinor, 0);
      const totalSettled = Math.max(0, (a.totalMinor || 0) - totalPending);
      const settledPct = a.totalMinor > 0 ? Math.round((totalSettled / a.totalMinor) * 100) : 0;
      const maxCategory = Math.max(1, ...Object.values(a.byCategory || {}));
      const categoryRows = CATEGORIES.filter((c) => a.byCategory && a.byCategory[c]).map((c) => `
        <li><span><span class="exp-cat-icon exp-cat-${c}" aria-hidden="true">${CATEGORY_ICON[c]}</span> ${CATEGORY_LABEL[c]}</span>
          <div class="exp-bar-track"><div class="exp-bar-fill" style="width:${(a.byCategory[c] / maxCategory) * 100}%; background:${CATEGORY_COLOR[c] || '#8b5cf6'}"></div></div>
          <span class="exp-sub-mono">${money(a.byCategory[c])}</span></li>`).join('');
      const monthRows = Object.entries(a.byMonth || {}).map(([month, amount]) => `<li><span>${escapeHtml(month)}</span><span class="exp-sub-mono">${money(amount)}</span></li>`).join('');

      return `
        <div class="exp-neo-page-head">
          <div class="exp-neo-title-group">
            <button type="button" class="exp-back-btn" data-action="nav" data-view="dashboard" aria-label="Back to Start">&lsaquo;</button>
            <h2 class="exp-neo-page-title">Spend Analytics</h2>
          </div>
          <button type="button" class="btn ${useDemo ? 'btn-primary' : 'btn-outline'} exp-tactile-btn-sm" data-action="toggle-analytics-demo">
            ${useDemo ? 'Showing Sample Preview (Reset)' : 'Preview Sample Charts'}
          </button>
        </div>
        ${useDemo ? '<p class="exp-boundary-note"><strong>Simulated Analytics Preview Active.</strong> Displaying sample multi-category and multi-month data to showcase Chart.js &amp; Canvas visualizations. Does not alter your saved ledger.</p>' : '<p class="fine exp-neo-lead">Totals across the splits you created. Manual ledger summary only &mdash; not a financial or tax record.</p>'}
        <div class="exp-neo-settled-box exp-analytics-hero-box">
          <span class="exp-top-accent-strip" aria-hidden="true"></span>
          <span class="exp-neo-box-label">TOTAL TRACKED SPEND</span>
          <strong class="exp-neo-box-value">${money(a.totalMinor)}</strong>
          <span class="exp-neo-box-sub">${a.splitCount} split${a.splitCount === 1 ? '' : 's'} logged &middot; ${settledPct}% marked settled (${money(totalSettled)})</span>
        </div>
        ${(!useDemo && a.splitCount === 0) ? `
          <div class="exp-neo-empty-analytics">
            <p>No expenses yet &mdash; create a split to see category breakdowns and monthly trends.</p>
            <div class="button-row" style="justify-content:center; margin-top:14px;">
              <button type="button" class="btn btn-primary exp-tactile-btn" data-action="new-split">Start a split</button>
              <button type="button" class="btn btn-outline exp-tactile-btn" data-action="toggle-analytics-demo">Load Sample Chart Preview</button>
            </div>
          </div>` : ''}
        <div class="exp-charts-grid">
          <div class="exp-chart-card">
            <div class="exp-chart-head">
              <div>
                <span class="eyebrow">CATEGORY DISTRIBUTION</span>
                <h3>Spend by Category</h3>
              </div>
              <span class="badge badge-sandbox">Chart.js / Canvas</span>
            </div>
            <div class="exp-canvas-wrap">
              <canvas id="exp-chart-category" width="380" height="240" aria-label="Category spend breakdown chart"></canvas>
            </div>
            <ul class="exp-bar-list">${categoryRows || '<p class="fine">Log a split or toggle Sample Preview above to populate category bars.</p>'}</ul>
          </div>
          <div class="exp-chart-card">
            <div class="exp-chart-head">
              <div>
                <span class="eyebrow">HISTORICAL VELOCITY</span>
                <h3>Monthly Spend &amp; Settlement Trend</h3>
              </div>
              <span class="badge badge-sandbox">Interactive</span>
            </div>
            <div class="exp-canvas-wrap">
              <canvas id="exp-chart-monthly" width="420" height="240" aria-label="Monthly spend trend chart"></canvas>
            </div>
            <ul class="exp-month-list">${monthRows || '<p class="fine">Log a split or toggle Sample Preview above to populate monthly history.</p>'}</ul>
          </div>
        </div>
        <div class="exp-summary-row" style="margin-top:18px;">
          <div class="exp-summary-card"><span class="fine">Total logged</span><strong>${money(a.totalMinor)}</strong></div>
          <div class="exp-summary-card"><span class="fine">Marked settled (${settledPct}%)</span><strong>${money(totalSettled)}</strong></div>
          <div class="exp-summary-card"><span class="fine">Pending repayment</span><strong>${money(totalPending)}</strong></div>
        </div>`;
    }

    function drawAnalyticsCharts() {
      if (state.view !== 'analytics' || typeof document === 'undefined') return;
      const catCanvas = $$('#exp-chart-category');
      const monthCanvas = $$('#exp-chart-monthly');
      if (!catCanvas || !monthCanvas || typeof catCanvas.getContext !== 'function') return;

      const realAnalytics = state.analytics || {totalMinor: 0, byCategory: {}, byMonth: {}, splitCount: 0};
      const a = state.analyticsDemo ? DEMO_ANALYTICS_SAMPLE : realAnalytics;
      const isLight = document.documentElement?.getAttribute('data-theme') === 'light';
      const textColor = isLight ? '#1e1b4b' : '#f8fafc';
      const mutedColor = isLight ? '#64748b' : '#b4a4d6';
      const gridColor = isLight ? 'rgba(124, 58, 237, 0.12)' : 'rgba(168, 85, 247, 0.16)';

      const catEntries = CATEGORIES.filter((c) => a.byCategory && a.byCategory[c] > 0).map((c) => ({
        key: c, label: CATEGORY_LABEL[c], value: a.byCategory[c] / 100, color: CATEGORY_COLOR[c] || '#8b5cf6',
      }));
      const monthEntries = Object.entries(a.byMonth || {}).map(([m, val]) => ({label: m, value: val / 100}));

      // If Chart.js is loaded globally, use it; otherwise use our built-in crisp 2D Canvas renderer
      if (root.Chart) {
        try {
          if (chartInstances.cat) chartInstances.cat.destroy();
          if (chartInstances.month) chartInstances.month.destroy();
          chartInstances.cat = new root.Chart(catCanvas.getContext('2d'), {
            type: 'doughnut',
            data: {
              labels: catEntries.length ? catEntries.map((e) => e.label) : ['No spend logged'],
              datasets: [{
                data: catEntries.length ? catEntries.map((e) => e.value) : [1],
                backgroundColor: catEntries.length ? catEntries.map((e) => e.color) : [gridColor],
                borderWidth: 2,
                borderColor: isLight ? '#ffffff' : '#130d26',
              }],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              cutout: '64%',
              plugins: {
                legend: {position: 'right', labels: {color: textColor, font: {weight: '600', size: 12}}},
              },
            },
          });
          chartInstances.month = new root.Chart(monthCanvas.getContext('2d'), {
            type: 'bar',
            data: {
              labels: monthEntries.length ? monthEntries.map((e) => e.label) : ['Current'],
              datasets: [{
                label: 'Tracked Spend ($)',
                data: monthEntries.length ? monthEntries.map((e) => e.value) : [0],
                backgroundColor: 'rgba(139, 92, 246, 0.78)',
                borderColor: '#7c3aed',
                borderWidth: 1.5,
                borderRadius: 8,
              }],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              scales: {
                x: {ticks: {color: mutedColor}, grid: {color: gridColor}},
                y: {ticks: {color: mutedColor}, grid: {color: gridColor}, beginAtZero: true},
              },
              plugins: {legend: {labels: {color: textColor}}},
            },
          });
          return;
        } catch { /* fallback to native 2D canvas renderer below */ }
      }

      // Native High-DPI 2D Canvas Renderer (guaranteed 0ms offline & sandbox execution)
      renderNativeDoughnut(catCanvas, catEntries, a.totalMinor, textColor, mutedColor, isLight);
      renderNativeBarTrend(monthCanvas, monthEntries, textColor, mutedColor, gridColor, isLight);

      // Lazily load Chart.js from CDN in browser if not yet present
      if (!root.Chart && !root._chartJsLoading && typeof document.createElement === 'function') {
        root._chartJsLoading = true;
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
        script.onload = () => { root._chartJsLoading = false; if (state.view === 'analytics') drawAnalyticsCharts(); };
        script.onerror = () => { root._chartJsLoading = false; };
        document.head?.appendChild(script);
      }
    }

    function renderNativeDoughnut(canvas, entries, totalMinor, textColor, mutedColor, isLight) {
      const ctx2d = canvas.getContext('2d');
      if (!ctx2d) return;
      const w = canvas.width || 380;
      const h = canvas.height || 240;
      ctx2d.clearRect(0, 0, w, h);
      const cx = 115;
      const cy = h / 2;
      const radius = 76;
      const inner = 48;

      if (!entries.length) {
        ctx2d.beginPath();
        ctx2d.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx2d.strokeStyle = isLight ? 'rgba(124, 58, 237, 0.18)' : 'rgba(168, 85, 247, 0.25)';
        ctx2d.lineWidth = radius - inner;
        ctx2d.stroke();
        ctx2d.fillStyle = mutedColor;
        ctx2d.font = '600 12px Inter, system-ui, sans-serif';
        ctx2d.textAlign = 'center';
        ctx2d.fillText('No data yet', cx, cy + 4);
        ctx2d.textAlign = 'left';
        ctx2d.fillText('Create a split or click', 215, cy - 8);
        ctx2d.fillText('"Preview Sample Charts"', 215, cy + 12);
        return;
      }

      const totalVal = entries.reduce((s, e) => s + e.value, 0) || 1;
      let startAngle = -Math.PI / 2;
      entries.forEach((e) => {
        const slice = (e.value / totalVal) * (Math.PI * 2);
        ctx2d.beginPath();
        ctx2d.arc(cx, cy, radius, startAngle, startAngle + slice);
        ctx2d.arc(cx, cy, inner, startAngle + slice, startAngle, true);
        ctx2d.closePath();
        ctx2d.fillStyle = e.color;
        ctx2d.fill();
        ctx2d.strokeStyle = isLight ? '#ffffff' : '#130d26';
        ctx2d.lineWidth = 2;
        ctx2d.stroke();
        startAngle += slice;
      });

      // Center total label
      ctx2d.fillStyle = textColor;
      ctx2d.font = '800 14px Inter, system-ui, sans-serif';
      ctx2d.textAlign = 'center';
      ctx2d.fillText(money(totalMinor), cx, cy + 5);

      // Right-side legend
      ctx2d.textAlign = 'left';
      entries.slice(0, 6).forEach((e, idx) => {
        const ly = 36 + idx * 32;
        ctx2d.fillStyle = e.color;
        ctx2d.beginPath();
        ctx2d.roundRect ? ctx2d.roundRect(212, ly - 10, 12, 12, 3) : ctx2d.rect(212, ly - 10, 12, 12);
        ctx2d.fill();
        ctx2d.fillStyle = textColor;
        ctx2d.font = '700 12px Inter, system-ui, sans-serif';
        const pct = Math.round((e.value / totalVal) * 100);
        ctx2d.fillText(`${e.label} (${pct}%)`, 232, ly);
        ctx2d.fillStyle = mutedColor;
        ctx2d.font = '500 11px Inter, system-ui, sans-serif';
        ctx2d.fillText(`$${e.value.toFixed(2)}`, 232, ly + 14);
      });
    }

    function renderNativeBarTrend(canvas, entries, textColor, mutedColor, gridColor) {
      const ctx2d = canvas.getContext('2d');
      if (!ctx2d) return;
      const w = canvas.width || 420;
      const h = canvas.height || 240;
      ctx2d.clearRect(0, 0, w, h);
      const padL = 48, padR = 20, padT = 24, padB = 38;
      const plotW = w - padL - padR;
      const plotH = h - padT - padB;

      // Grid lines
      ctx2d.strokeStyle = gridColor;
      ctx2d.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = padT + (plotH / 4) * i;
        ctx2d.beginPath();
        ctx2d.moveTo(padL, y);
        ctx2d.lineTo(w - padR, y);
        ctx2d.stroke();
      }

      if (!entries.length) {
        ctx2d.fillStyle = mutedColor;
        ctx2d.font = '600 12px Inter, system-ui, sans-serif';
        ctx2d.textAlign = 'center';
        ctx2d.fillText('Monthly trend bars appear once splits are logged', w / 2, h / 2);
        return;
      }

      const maxVal = Math.max(10, ...entries.map((e) => e.value)) * 1.15;
      const stepW = plotW / entries.length;
      const barW = Math.min(44, stepW * 0.56);

      const pts = [];
      entries.forEach((e, idx) => {
        const x = padL + idx * stepW + (stepW - barW) / 2;
        const bh = Math.max(4, (e.value / maxVal) * plotH);
        const y = padT + plotH - bh;
        pts.push({cx: x + barW / 2, cy: y});

        const grad = ctx2d.createLinearGradient(x, y, x, padT + plotH);
        grad.addColorStop(0, '#8b5cf6');
        grad.addColorStop(1, '#ec4899');
        ctx2d.fillStyle = grad;
        ctx2d.beginPath();
        ctx2d.roundRect ? ctx2d.roundRect(x, y, barW, bh, [6, 6, 0, 0]) : ctx2d.rect(x, y, barW, bh);
        ctx2d.fill();

        ctx2d.fillStyle = textColor;
        ctx2d.font = '700 11px Inter, system-ui, sans-serif';
        ctx2d.textAlign = 'center';
        ctx2d.fillText(`$${Math.round(e.value)}`, x + barW / 2, y - 6);

        ctx2d.fillStyle = mutedColor;
        ctx2d.font = '600 11px Inter, system-ui, sans-serif';
        ctx2d.fillText(e.label, x + barW / 2, padT + plotH + 20);
      });

      // Trend line overlay
      if (pts.length > 1) {
        ctx2d.beginPath();
        pts.forEach((pt, idx) => { if (idx === 0) ctx2d.moveTo(pt.cx, pt.cy); else ctx2d.lineTo(pt.cx, pt.cy); });
        ctx2d.strokeStyle = '#06b6d4';
        ctx2d.lineWidth = 2.2;
        ctx2d.stroke();
        pts.forEach((pt) => {
          ctx2d.beginPath();
          ctx2d.arc(pt.cx, pt.cy, 4, 0, Math.PI * 2);
          ctx2d.fillStyle = '#06b6d4';
          ctx2d.fill();
        });
      }
    }

    function renderAccount() {
      const hasName = Boolean(String(state.profile.displayName || '').trim());
      return `
        <div class="exp-neo-page-head">
          <div class="exp-neo-title-group">
            <button type="button" class="exp-back-btn" data-action="nav" data-view="dashboard" aria-label="Back to Start">&lsaquo;</button>
            <h2 class="exp-neo-page-title">Account &amp; Settlement Handle</h2>
          </div>
        </div>
        <p class="fine exp-neo-lead">Used to label you as the bill host and show where friends can settle manually. This is not identity verification and it never authorizes UPI or PayPal.</p>
        <form id="exp-profile-form" class="exp-form-grid">
          <label>Display name<input id="exp-profile-name" type="text" maxlength="80" value="${escapeHtml(state.profile.displayName)}" placeholder="Your name as bill host"></label>
           <label>UPI ID / settlement handle<input id="exp-profile-upi" type="text" maxlength="80" value="${escapeHtml(state.profile.upiID)}" placeholder="Optional · unverified"></label>
           <div class="button-row">
             <button type="submit" class="btn btn-primary exp-tactile-btn">Save my details</button>
             ${hasName ? `<button type="button" class="btn btn-outline exp-tactile-btn" data-action="${state.friends.length ? 'new-split' : 'nav'}" ${state.friends.length ? '' : 'data-view="friends"'}>${state.friends.length ? 'Next: Create a split →' : 'Next: Add people →'}</button>` : ''}
           </div>
        </form>`;
    }

    function renderSplitModal() {
      const d = state.draft;
      const groupOptions = state.groups.filter((g) => g.id !== null).map((g) => `<option value="${escapeHtml(g.id)}" ${d.groupId === g.id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join('');
      const friendChecks = state.friends.map((f) => `
        <label class="exp-check"><input type="checkbox" data-action="toggle-participant" data-id="${escapeHtml(f.id)}" ${d.selected.includes(f.id) ? 'checked' : ''}><span class="exp-avatar">${escapeHtml((f.name.trim().charAt(0) || '?').toUpperCase())}</span>${escapeHtml(f.name)}${f.whatsapp ? ` <small>${escapeHtml(f.whatsapp)}</small>` : ''}</label>`).join('');
      const names = participantNames();
      let previewLine = '';
      try {
        const totalMinor = d.total ? cents(d.total) : 0;
        if (totalMinor > 0) {
          const amounts = splitEqualCents(totalMinor, names);
          previewLine = `<div class="exp-share-preview"><strong>Who owes what</strong>${names.map((n, index) => `<span><span>${escapeHtml(n)}${index === 0 ? ' <small>(you · paid the bill)</small>' : ''}</span><b>${money(amounts[n], d.currency || 'USD')}</b></span>`).join('')}</div>`;
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
          <div class="modal-card modal-card-wide exp-neo-modal">
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
                  <button type="button" class="btn btn-outline exp-tactile-btn-sm" data-action="trigger-scan" ${d.scanBusy || (scanStatus && !scanStatus.available) ? 'disabled' : ''}>${d.scanBusy ? 'Scanning…' : 'Scan receipt'}</button>
                  ${d.scanPreviewUrl ? `
                    <figure class="exp-scan-preview ${d.scanBusy ? 'is-scanning' : ''}">
                      <img src="${escapeHtml(d.scanPreviewUrl)}" alt="Receipt you selected, previewed locally">
                      ${d.scanBusy ? '<span class="exp-scan-beam" aria-hidden="true"></span><span class="exp-scan-veil" aria-hidden="true"></span>' : ''}
                      <figcaption class="fine">${d.scanBusy ? 'Reading this receipt on the app server…' : 'Preview only — the selected photo is not saved with the split.'}</figcaption>
                    </figure>` : ''}
                  ${d.receiptMeta && (d.receiptMeta.date || (Array.isArray(d.receiptMeta.items) && d.receiptMeta.items.length)) ? `
                    <div class="exp-receipt-extracted">
                      <span class="fine"><strong>Extracted receipt preview (unsaved)</strong>${d.receiptMeta.date ? ` · Date: ${escapeHtml(d.receiptMeta.date)}` : ''}</span>
                      ${Array.isArray(d.receiptMeta.items) && d.receiptMeta.items.length ? `<ul class="exp-receipt-items">${d.receiptMeta.items.map((item) => `<li><span>${escapeHtml(item.name)}</span><b>${money(Math.round(Number(item.amount || 0) * 100), d.currency || 'USD')}</b></li>`).join('')}</ul>` : ''}
                    </div>` : ''}
                </div>
                <label>Bill title<input id="exp-split-title" type="text" maxlength="160" value="${escapeHtml(d.title)}" placeholder="Dinner at Luigi's"></label>
                <div class="exp-form-row">
                  <label>Category<select id="exp-split-category">${CATEGORIES.map((c) => `<option value="${c}" ${d.category === c ? 'selected' : ''}>${CATEGORY_LABEL[c]}</option>`).join('')}</select></label>
                  <label>Booking group <small class="fine">optional</small><select id="exp-split-group"><option value="" ${!d.groupId ? 'selected' : ''}>No booking group</option>${groupOptions}</select></label>
                  <label>Total amount (${escapeHtml(d.currency || 'USD')})<input id="exp-split-total" type="text" inputmode="decimal" value="${escapeHtml(d.total)}" placeholder="0.00"></label>
                </div>
              </section>
              <section class="exp-modal-step" aria-labelledby="exp-step-people">
                <div class="exp-modal-step-head"><span>2</span><div><h3 id="exp-step-people">Choose people</h3><p>Select at least one saved person. Exact cents are assigned in the displayed order.</p></div></div>
                <div class="exp-check-grid">${friendChecks || '<div class="exp-empty-inline"><p class="fine">No people saved yet. Add someone before saving a shared bill.</p><button type="button" class="btn btn-outline" data-action="open-friends">Add people</button></div>'}</div>
                <div id="exp-live-share-preview">${previewLine || '<p class="fine">Enter a total and choose people to preview every individual share.</p>'}</div>
              </section>
              <section class="exp-modal-step" aria-labelledby="exp-step-repayment">
                <div class="exp-modal-step-head"><span>3</span><div><h3 id="exp-step-repayment">Show where to repay</h3><p>These receiving details are copied into this ledger record; they do not authorize or verify payment.</p></div></div>
                <div class="exp-form-row"><label>Host name<input id="exp-split-host" value="${escapeHtml(d.hostName)}" maxlength="80" placeholder="Your name"></label><label>UPI ID (optional)<input id="exp-split-upi" value="${escapeHtml(d.upiID)}" maxlength="80" placeholder="name@bank"></label></div>
                <label>PayPal email (optional, not a login)<input id="exp-split-paypal" type="email" value="${escapeHtml(d.paypalEmail)}" maxlength="160"></label>
                <p class="exp-boundary-note"><strong>No automatic payment.</strong> Friends pay outside this ledger. Mark a share settled only after you verify repayment yourself.</p>
              </section>
            </div>
            <div class="modal-actions-row">
              <button type="button" class="btn btn-outline exp-tactile-btn" data-action="close-modal">Cancel</button>
              <button type="button" class="btn btn-primary exp-tactile-btn" data-action="save-split" ${state.saving ? 'disabled' : ''}>${state.saving ? 'Saving…' : 'Save & view individual shares'}</button>
            </div>
          </div>
        </div>`;
    }

    function renderSubscriptionModal() {
      const d = state.draft;
      const rows = d.participants.map((p, i) => `
        <div class="exp-sub-participant-input-row">
          <input id="exp-sub-p-name-${i}" type="text" placeholder="Name" value="${escapeHtml(p.name)}">
          <input id="exp-sub-p-wa-${i}" type="text" placeholder="WhatsApp" value="${escapeHtml(p.whatsapp)}">
          <button type="button" class="exp-sub-remove-x" data-action="remove-sub-participant" data-index="${i}" aria-label="Remove participant">&times;</button>
        </div>`).join('');
      const availableFriends = state.friends.filter((friend) => !d.participants.some((p) => p.name.toLowerCase() === friend.name.toLowerCase()));
      const friendButtons = availableFriends.map((friend) => `<button type="button" class="filter-pill" data-action="add-sub-friend" data-id="${escapeHtml(friend.id)}">+ ${escapeHtml(friend.name)}</button>`).join('');
      return `
        <div class="modal-backdrop" id="exp-sub-modal-backdrop">
          <div class="modal-card exp-neo-modal exp-sub-modal-card">
            <div class="modal-header">
              <div class="split-modal-title">
                <h2>${d.editId ? 'Edit subscription' : 'New subscription'}</h2>
              </div>
              <button type="button" class="modal-close-btn" data-action="close-modal">&times;</button>
            </div>
            <div class="modal-body exp-neo-form-stack">
              ${d.formError ? `<p class="exp-error">${escapeHtml(d.formError)}</p>` : ''}
              <label class="exp-neo-field-label">NAME
                <input id="exp-sub-name" type="text" maxlength="80" value="${escapeHtml(d.name)}" placeholder="Netflix">
              </label>
              <label class="exp-neo-field-label">MONTHLY AMOUNT ($)
                <input id="exp-sub-amount" type="text" inputmode="decimal" value="${escapeHtml(d.monthlyAmount)}" placeholder="649">
              </label>
              <label class="exp-neo-field-label">BILLING DAY (1&ndash;28)
                <input id="exp-sub-day" type="number" min="1" max="28" value="${escapeHtml(d.billingDay)}">
              </label>
              <label class="exp-neo-field-label">YOUR NAME (HOST)
                <input id="exp-sub-host" type="text" value="${escapeHtml(d.hostName)}" maxlength="80" placeholder="Your name">
              </label>
              <label class="exp-neo-field-label">YOUR UPI ID
                <input id="exp-sub-upi" type="text" value="${escapeHtml(d.upiID)}" maxlength="80" placeholder="you@upi">
              </label>
              <div class="exp-neo-field-label">
                <span>PARTICIPANTS (SPLIT EQUALLY WITH YOU)</span>
                ${friendButtons ? `<div class="filter-row exp-saved-friends" style="margin:6px 0;"><span class="fine">Quick add:</span>${friendButtons}</div>` : ''}
                <div class="exp-sub-rows-wrap">${rows}</div>
                <button type="button" class="exp-add-participant-btn" data-action="add-sub-participant">+ Participant</button>
              </div>
            </div>
            <div class="modal-actions-row exp-sub-modal-footer">
              <button type="button" class="btn btn-outline exp-tactile-btn" data-action="close-modal">Cancel</button>
              <button type="button" class="btn btn-primary exp-tactile-btn exp-sub-save-btn" data-action="save-subscription" ${state.saving ? 'disabled' : ''}>${state.saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>`;
    }

    function render() {
      const openCount = state.splits.filter((split) => !split.allSettled).length;
      const subCount = state.subscriptions.length;
      const navItems = [
        ['dashboard', 'Groups & Start'],
        ['friends', 'Friends', state.friends.length],
        ['activity', 'Activity', openCount],
        ['subscriptions', 'Subscriptions', subCount],
        ['account', 'Account'],
        ['history', 'History'],
        ['analytics', 'Analytics'],
      ];
      const bodyRenderer = {
        dashboard: renderDashboard, activity: renderActivity, history: renderHistory, friends: renderFriends,
        subscriptions: renderSubscriptions, analytics: renderAnalytics, account: renderAccount,
      }[state.view] || renderDashboard;
      const body = bodyRenderer();
      container.innerHTML = `
        <div class="exp-wrap">
          <div class="section-header page-intro">
            <div>
               <p class="eyebrow">BILLS &amp; SHARED EXPENSES</p>
               <h1>Scan it. Split it.<br>Know who owes what.</h1>
               <p>Add people, scan or enter a bill, manage recurring subscriptions, and track spend analytics &amp; history.</p>
            </div>
             <span class="badge badge-gold">LEDGER &amp; REMINDERS &mdash; NO AUTOMATIC CHARGE</span>
          </div>
          <div class="exp-toolbar">
            <div class="filter-row exp-primary-nav" aria-label="Bills and splits sections">${navItems.map(([key, label, count]) => `<button type="button" class="filter-pill ${state.view === key ? 'active' : ''}" data-action="nav" data-view="${key}">${label}${count ? ` <span class="exp-nav-count">${count}</span>` : ''}</button>`).join('')}</div>
            <button type="button" class="btn btn-primary exp-tactile-btn" data-action="new-split">+ New split</button>
          </div>
          ${state.error ? `<p class="exp-error">${escapeHtml(state.error)}</p>` : ''}
          ${state.notice ? `<p class="exp-notice">${escapeHtml(state.notice)}</p>` : ''}
          ${state.busy ? '<p class="fine">Loading…</p>' : body}
        </div>
        ${state.modal === 'split' ? renderSplitModal() : ''}
        ${state.modal === 'subscription' ? renderSubscriptionModal() : ''}`;

      if (!state.busy && state.view === 'analytics') {
        if (typeof setTimeout === 'function') setTimeout(drawAnalyticsCharts, 0);
        else drawAnalyticsCharts();
      }
    }

    refreshAll();
    return {
      refresh: refreshAll,
      navigate(targetView) {
        if (targetView) {
          state.view = targetView;
          state.notice = '';
          render();
        }
      },
    };
  }

  root.GroupPayExpenses = {mount, test: {cents, splitEqualCents, readinessFor, splitDraftReadiness}};
})(window);

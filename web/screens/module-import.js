const MAX_TEXT = 200;

/** Server text is untrusted. Keep it plain, short, and free of control characters. @param {unknown} value */
const text = value => (typeof value === 'string' || typeof value === 'number' ? String(value) : '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim().slice(0, MAX_TEXT);
/** @param {unknown} value */
const count = value => Array.isArray(value) ? value.length : Number.isSafeInteger(value) && /** @type {number} */(value) >= 0 ? /** @type {number} */(value) : 0;
/** @param {number} n @param {string} one @param {string} many */
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Minor units, such as cents, become a readable amount. The review only describes a price; it takes no payment. @param {unknown} price */
function priceText(price) {
  if (!isObject(price) || !Number.isSafeInteger(price.amount)) return 'No price listed';
  if (price.amount === 0) return 'Free';
  const currency = text(price.currency);
  try {
    const format = new Intl.NumberFormat('en', {style: 'currency', currency});
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(price.amount / 10 ** digits);
  } catch { return `${price.amount} ${currency} (smallest units)`; }
}
/** @param {unknown} license */
const licenseText = license => isObject(license) && text(license.id) ? text(license.id) : 'No license listed';

/** @param {Record<string, any>} item @param {Set<string>} present */
function warningsFor(item, present) {
  const missing = Array.isArray(item.missingPrerequisites)
    ? item.missingPrerequisites
    : (Array.isArray(item.prerequisites) ? item.prerequisites : []).filter((/** @type {unknown} */ id) => !present.has(text(id)));
  return missing.map((/** @type {unknown} */ id) => `This lesson builds on "${text(id)}". It is not in your library or in this import.`);
}

/** @param {string} moduleId @param {string} title @param {string} from @param {string} to @returns {PinOffer} */
function makeOffer(moduleId, title, from, to) {
  return {moduleId, title, fromVersion: from, toVersion: to, text: `Version ${to} of "${title}" is available. You use version ${from}. Nothing changes unless you choose to switch.`};
}

/**
 * A read-only view of what an import would add. It never calls the server.
 * @param {LessonPreview} preview @param {{restore?: boolean, filename?: string}} [options] @returns {LessonReviewModel}
 */
export function buildImportReview(preview, {restore = false} = {}) {
  const modules = Array.isArray(preview?.modules) ? preview.modules.filter(isObject) : [];
  const conflictKeys = new Set((Array.isArray(preview?.conflicts) ? preview.conflicts : []).filter(isObject).map(entry => `${text(entry.id)}@${text(entry.version)}`));
  const present = new Set([...modules.map(item => text(item.id)), ...(Array.isArray(preview?.knownModuleIds) ? preview.knownModuleIds.map(text) : [])]);
  /** @type {LessonReviewItem[]} */
  const items = modules.map(item => {
    const id = text(item.id); const version = text(item.version);
    /** @type {LessonItemState} */
    const state = conflictKeys.has(`${id}@${version}`) || item.state === 'conflict' ? 'conflict' : (item.state === 'present' ? 'present' : 'new');
    const title = text(item.title) || id;
    const pinned = text(item.pinnedVersion); const newer = text(item.newerVersionAvailable);
    return {
      id, version, title, state,
      stateText: state === 'conflict' ? 'Conflict. This version exists with different content.' : state === 'present' ? 'Already in your library. Nothing to add.' : 'New. Schola would add it.',
      tasks: count(item.taskCount), checks: count(item.checkCount),
      license: licenseText(item.license), price: priceText(item.price),
      harness: item.harness ? 'Includes a tutor harness (extra code that helps tutor you).' : 'No tutor harness.',
      warnings: warningsFor(item, present),
      offer: pinned && newer && pinned !== newer ? makeOffer(id, title, pinned, newer) : null,
    };
  });
  const conflicts = [...new Set([...conflictKeys, ...items.filter(item => item.state === 'conflict').map(item => `${item.id}@${item.version}`)])]
    .map(key => `Lesson "${key.split('@')[0]}" version ${key.split('@')[1] || ''} already exists with different content. Schola will not replace it.`);
  const fresh = items.filter(item => item.state === 'new').length;
  const packetTitle = text(preview?.packetTitle);
  const heading = restore ? 'Restore these lessons' : preview?.kind === 'packet' && packetTitle ? `Add the lesson set "${packetTitle}"` : items.length === 1 ? 'Add this lesson' : 'Add these lessons';
  return {
    heading,
    summary: `Schola would ${restore ? 'restore' : 'add'} ${plural(fresh, 'lesson', 'lessons')}. ${items.length - fresh} already in your library or blocked.`,
    items, conflicts,
    canConfirm: fresh > 0 && conflicts.length === 0,
  };
}

/** Newer imported versions become offers. Nothing here changes a pin. @param {LessonListing|null|undefined} listing @returns {PinOffer[]} */
export function updateOffers(listing) {
  if (!listing || !Array.isArray(listing.modules)) return [];
  /** @type {PinOffer[]} */
  const offers = [];
  for (const entry of listing.modules) {
    if (!isObject(entry)) continue;
    const pinned = text(entry.pinnedVersion); const newer = text(entry.newerVersionAvailable);
    if (pinned && newer && pinned !== newer) offers.push(makeOffer(text(entry.id), text(entry.title) || text(entry.id), pinned, newer));
  }
  return offers;
}

/** @param {unknown} problem @returns {LessonMessage} */
function errorMessage(problem) {
  const error = /** @type {{message?: unknown, detail?: unknown}} */(problem && typeof problem === 'object' ? problem : {});
  const detail = text(error.detail);
  return {kind: 'error', text: text(error.message) || 'Something went wrong. Nothing was confirmed.', ...(detail ? {detail} : {})};
}

/**
 * Walks one import from file to result. Preview and import are the only network calls, and import needs an explicit confirm.
 * Cancel never calls the server.
 * @param {{service: LessonService, source: unknown, filename?: string, restore?: boolean}} options
 */
export function createImportReviewController({service, source, filename = '', restore = false}) {
  /** @type {{phase: LessonPhase, model: LessonReviewModel|null, message: LessonMessage|null}} */
  let state = {phase: 'idle', model: null, message: null};
  return {
    getState: () => state,
    async start() {
      if (state.phase !== 'idle') return false;
      state = {phase: 'previewing', model: null, message: null};
      try {
        const preview = await (restore ? service.previewRestore(/** @type {LessonBackupFile} */(source), filename) : service.previewImport(source, filename));
        if (state.phase !== 'previewing') return false;
        state = {phase: 'reviewing', model: buildImportReview(preview, {restore, filename}), message: null};
        return true;
      } catch (problem) {
        if (state.phase !== 'previewing') return false;
        state = {phase: 'failed', model: null, message: errorMessage(problem)};
        return false;
      }
    },
    async confirm() {
      if (state.phase !== 'reviewing' || !state.model || !state.model.canConfirm) return false;
      const model = state.model;
      state = {phase: 'importing', model, message: null};
      try {
        const result = await (restore ? service.restoreBackup(/** @type {LessonBackupFile} */(source), filename) : service.importLessons(source, filename));
        const added = Array.isArray(result?.imported) ? result.imported.length : model.items.filter(item => item.state === 'new').length;
        state = {phase: 'done', model, message: {kind: 'success', text: `${restore ? 'Restored' : 'Added'} ${plural(added, 'lesson', 'lessons')}.`}};
        return true;
      } catch (problem) {
        state = {phase: 'failed', model, message: errorMessage(problem)};
        return false;
      }
    },
    cancel() {
      if (state.phase === 'importing' || state.phase === 'done') return false;
      state = {phase: 'cancelled', model: null, message: null};
      return true;
    },
  };
}

/**
 * An offer to use a newer imported version. Two explicit steps lead to the one call that changes a pin.
 * Declining at any step never calls the server.
 * @param {{service: LessonService, offer: PinOffer, expectedRevision?: number}} options
 */
export function createPinSwitchController({service, offer, expectedRevision}) {
  /** @type {{phase: 'offered'|'confirming'|'switching'|'done'|'failed'|'declined', offer: PinOffer, message: LessonMessage|null}} */
  let state = {phase: 'offered', offer, message: null};
  return {
    getState: () => state,
    review() {
      if (state.phase !== 'offered') return false;
      state = {phase: 'confirming', offer, message: {kind: 'info', text: `Switch "${offer.title}" from version ${offer.fromVersion} to version ${offer.toVersion}? You can switch back later.`}};
      return true;
    },
    async confirm() {
      if (state.phase !== 'confirming') return false;
      state = {phase: 'switching', offer, message: null};
      try {
        await service.switchPin(offer.moduleId, offer.toVersion, {confirm: true, ...(expectedRevision === undefined ? {} : {expectedRevision})});
        state = {phase: 'done', offer, message: {kind: 'success', text: `You now use version ${offer.toVersion} of "${offer.title}".`}};
        return true;
      } catch (problem) {
        state = {phase: 'failed', offer, message: errorMessage(problem)};
        return false;
      }
    },
    cancel() {
      if (state.phase === 'switching' || state.phase === 'done') return false;
      state = {phase: 'declined', offer, message: null};
      return true;
    },
  };
}

/**
 * Draws the review as text. Server words go through textContent, never innerHTML.
 * @param {HTMLElement} container
 * @param {{phase: LessonPhase, model: LessonReviewModel|null, message: LessonMessage|null}} state
 * @param {{onConfirm: () => unknown, onCancel: () => unknown}} actions
 */
export function renderImportReview(container, state, {onConfirm, onCancel}) {
  const doc = container.ownerDocument;
  /** @param {string} tag @param {string} [content] @param {Record<string,string>} [attributes] */
  const node = (tag, content = '', attributes = {}) => {
    const element = doc.createElement(tag);
    if (content) element.textContent = content;
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    return element;
  };
  /** @param {string} label @param {() => unknown} handler @param {boolean} [disabled] @param {boolean} [primary] */
  const button = (label, handler, disabled = false, primary = false) => {
    const element = node('button', label, {type: 'button', ...(primary ? {class: 'primary'} : {})});
    if (disabled) element.setAttribute('disabled', '');
    element.addEventListener('click', () => handler());
    return element;
  };
  const parts = [];
  const model = state.model;
  if (state.phase === 'cancelled') { container.replaceChildren(); return; }
  if (state.phase === 'previewing') parts.push(node('p', 'Checking the file. Nothing is saved yet.', {role: 'status'}));
  if (model) {
    parts.push(node('h2', model.heading), node('p', model.summary));
    for (const conflict of model.conflicts) parts.push(node('p', conflict, {class: 'import-conflict'}));
    const list = node('ul');
    for (const item of model.items) {
      const entry = node('li');
      entry.append(node('strong', `${item.title} (version ${item.version})`), node('p', item.stateText),
        node('p', `${item.tasks === 1 ? '1 task' : `${item.tasks} tasks`} · ${item.checks === 1 ? '1 check' : `${item.checks} checks`}`),
        node('p', `License: ${item.license}`), node('p', `Price: ${item.price}`), node('p', item.harness));
      for (const warning of item.warnings) entry.append(node('p', warning, {class: 'import-warning'}));
      if (item.offer) entry.append(node('p', item.offer.text));
      list.append(entry);
    }
    parts.push(list);
  }
  if (state.message) {
    parts.push(node('p', state.message.text, {role: state.message.kind === 'error' ? 'alert' : 'status'}));
    if (state.message.detail) parts.push(node('p', state.message.detail));
  }
  const busy = state.phase === 'importing' || state.phase === 'previewing';
  const actions = node('div', '', {class: 'learning-actions'});
  if (state.phase === 'reviewing' || state.phase === 'importing') actions.append(button(model?.heading.startsWith('Restore') ? 'Restore these lessons' : 'Add these lessons', onConfirm, busy || !model?.canConfirm, true));
  actions.append(button(state.phase === 'done' || state.phase === 'failed' ? 'Close' : 'Cancel', onCancel, state.phase === 'importing'));
  parts.push(actions);
  container.replaceChildren(...parts);
}

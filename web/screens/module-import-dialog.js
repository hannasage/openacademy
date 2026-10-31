import {createImportReviewController, createPinSwitchController, renderImportReview, renderModuleList, updateOffers} from './module-import.js';

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const BACKUP_FORMAT = 'schola-lesson-backup';

/**
 * Decides where a chosen file goes. A lesson module or packet carries a `schemaVersion`.
 * A lesson backup carries its own format name. Everything else keeps the older import path.
 * @param {unknown} value a parsed file
 * @returns {'lesson' | 'backup' | null}
 */
export function classifyLessonFile(value) {
  if (isObject(value)) {
    if (value.format === BACKUP_FORMAT) return 'backup';
    return typeof value.schemaVersion === 'string' ? 'lesson' : null;
  }
  if (Array.isArray(value) && value.length > 0 && value.every(item => isObject(item) && typeof item.schemaVersion === 'string')) return 'lesson';
  return null;
}

/**
 * A file that does not parse may still be a damaged lesson file. The server then explains the damage in plain words.
 * @param {string} fileText
 */
export const looksLikeLessonText = fileText => /"schemaVersion"|schola-lesson-backup/.test(fileText);

/**
 * The lesson import screen inside the existing review dialog.
 * It shows a read-only review first. Only the Add button imports. Cancel and Escape never call the server.
 * After an import it lists the modules and offers newer versions. A switch needs a second explicit step.
 * @param {HTMLDialogElement} dialog
 * @param {{service: LessonService, source: unknown, filename: string, restore?: boolean, onFinish?: (imported: boolean) => void}} options
 * @returns {() => void} a function that closes the dialog
 */
export function openModuleImport(dialog, {service, source, filename, restore = false, onFinish}) {
  const previous = document.activeElement;
  const heading = document.createElement('div');
  heading.className = 'import-heading';
  const title = document.createElement('h1');
  title.id = 'import-title';
  title.textContent = restore ? 'Restore lessons' : 'Add lessons';
  heading.append(title);
  const body = document.createElement('div');
  body.id = 'lesson-import';
  dialog.replaceChildren(heading, body);

  const controller = createImportReviewController({service, source: /** @type {LessonSource} */(source), filename, restore});
  /** @type {LessonListing | null} */ let listing = null;
  /** @type {LessonMessage | null} */ let listMessage = null;
  /** @type {Map<string, ReturnType<typeof createPinSwitchController>>} */ const switches = new Map();
  let imported = false;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    dialog.close();
    dialog.replaceChildren();
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    onFinish?.(imported);
  };
  const draw = () => {
    if (listing) {
      /** @type {Record<string, {phase: string, offer: PinOffer, message: LessonMessage | null}>} */
      const states = {};
      for (const [id, step] of switches) states[id] = step.getState();
      renderModuleList(body, {listing, switches: states, message: listMessage}, {onReview, onConfirm: onSwitch, onDecline, onClose: close});
    } else renderImportReview(body, controller.getState(), {onConfirm, onCancel});
  };
  const onCancel = () => {
    const phase = controller.getState().phase;
    if (phase === 'importing') return;
    controller.cancel();
    close();
  };
  const onConfirm = async () => {
    const pending = controller.confirm();
    draw();
    if (!(await pending)) { draw(); return; }
    imported = true;
    const result = controller.getState().result;
    listMessage = controller.getState().message;
    try {
      listing = result?.modules ? {revision: result.revision ?? 0, modules: result.modules} : await service.listLessons();
    } catch (problem) {
      listMessage = {kind: 'error', text: 'The lessons were added, but Schola could not read the lesson list.', detail: problem instanceof Error ? problem.message : ''};
      listing = {revision: result?.revision ?? 0, modules: []};
    }
    draw();
  };
  /** @param {string} moduleId */
  const onReview = moduleId => {
    const offer = listing ? updateOffers(listing).find(entry => entry.moduleId === moduleId) : undefined;
    if (!listing || !offer) return;
    const step = createPinSwitchController({service, offer, expectedRevision: listing.revision});
    step.review();
    switches.set(moduleId, step);
    draw();
  };
  /** @param {string} moduleId */
  const onSwitch = async moduleId => {
    const step = switches.get(moduleId);
    if (!step) return;
    const pending = step.confirm();
    draw();
    const switched = await pending;
    if (switched) {
      const next = step.getState().listing;
      if (next) listing = next;
      listMessage = step.getState().message;
      switches.delete(moduleId);
    } else {
      // The lessons may have changed under this screen. Read them again so a retry uses the current revision.
      try { listing = await service.listLessons(); } catch { /* The failure above stays on screen. */ }
    }
    draw();
  };
  /** @param {string} moduleId */
  const onDecline = moduleId => {
    switches.get(moduleId)?.cancel();
    switches.delete(moduleId);
    draw();
  };

  dialog.oncancel = event => {
    event.preventDefault();
    if (listing) close();
    else onCancel();
  };
  dialog.showModal();
  draw();
  const starting = controller.start();
  draw();
  void starting.then(() => { if (!closed && !listing) draw(); });
  return close;
}

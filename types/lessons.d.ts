/** Lesson module import and storage. The local server owns validation; the browser only shapes and shows. */
type LessonImportKind = 'module' | 'packet' | 'backup';
type LessonItemState = 'new' | 'present' | 'conflict';

/** One lesson module a preview says an import would add. Every field is untrusted text or numbers. */
interface LessonPreviewItem {
  id: string;
  version: string;
  title: string;
  state?: LessonItemState;
  taskCount?: number | unknown[];
  checkCount?: number | unknown[];
  harness?: boolean;
  license?: { id: string; url?: string } | null;
  price?: { amount: number; currency: string } | null;
  prerequisites?: string[];
  missingPrerequisites?: string[];
  pinnedVersion?: string | null;
  newerVersionAvailable?: string | null;
}

/** What the server says an import would do. A preview writes nothing. */
interface LessonPreview {
  kind?: LessonImportKind;
  packetTitle?: string;
  modules: LessonPreviewItem[];
  conflicts?: Array<{ id: string; version: string }>;
  knownModuleIds?: string[];
}

interface LessonImportResult {
  imported?: Array<{ id: string; version: string }>;
  revision?: number;
}

/** One module in the lesson listing. Reading it never changes a pin. */
interface LessonListEntry {
  id: string;
  title: string;
  versions: string[];
  pinnedVersion: string | null;
  newerVersionAvailable: string | null;
}

interface LessonListing {
  revision: number;
  modules: LessonListEntry[];
}

interface PinSwitchRequest {
  moduleId: string;
  version: string;
  confirm: true;
  expectedRevision?: number;
}

type LessonBackupFile = Record<string, unknown>;

type LessonErrorCode =
  | 'conflict' | 'too_large' | 'invalid' | 'network_error' | 'invalid_response'
  | 'confirmation_required' | 'request_failed';

type LessonPhase =
  | 'idle' | 'previewing' | 'reviewing' | 'importing' | 'done' | 'failed' | 'cancelled';

type LessonMessageKind = 'error' | 'success' | 'info';

interface LessonMessage { kind: LessonMessageKind; text: string; detail?: string }

interface LessonReviewItem {
  id: string;
  version: string;
  title: string;
  state: LessonItemState;
  stateText: string;
  tasks: number;
  checks: number;
  license: string;
  price: string;
  harness: string;
  warnings: string[];
  offer: PinOffer | null;
}

interface PinOffer {
  moduleId: string;
  title: string;
  fromVersion: string;
  toVersion: string;
  text: string;
}

interface LessonReviewModel {
  heading: string;
  summary: string;
  items: LessonReviewItem[];
  conflicts: string[];
  canConfirm: boolean;
}

interface LessonService {
  previewImport(source: unknown, filename?: string): Promise<LessonPreview>;
  importLessons(source: unknown, filename?: string): Promise<LessonImportResult>;
  listLessons(): Promise<LessonListing>;
  switchPin(moduleId: string, version: string, options: { confirm: boolean; expectedRevision?: number }): Promise<LessonListing>;
  exportLessons(): Promise<LessonBackupFile>;
  previewRestore(backup: LessonBackupFile, filename?: string): Promise<LessonPreview>;
  restoreBackup(backup: LessonBackupFile, filename?: string): Promise<LessonImportResult>;
}

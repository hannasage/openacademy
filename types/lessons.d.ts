/** Lesson module import and storage. The local server owns validation; the browser only shapes and shows. */
type LessonImportKind = 'module' | 'packet' | 'backup';
type LessonItemState = 'new' | 'present' | 'conflict';
/** What the server sends: one document as text, one parsed document, or a list of either. */
type LessonSource = string | Record<string, unknown> | Array<string | Record<string, unknown>>;

/** What an import would do to the pin of one module. */
type LessonPinEffect = 'will-pin' | 'newer-than-pin' | 'kept';

/** One file the server checked. Packets and modules both appear here. */
interface LessonPreviewFile {
  index?: number;
  name?: string;
  kind: 'module' | 'packet';
  id: string;
  version: string;
  title: string;
  sha256?: string;
  size?: number;
  status: 'new' | 'already-stored';
}

/** One lesson module a preview says an import would add. Every field is untrusted text or numbers. */
interface LessonPreviewItem extends Partial<LessonPreviewFile> {
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
  pin?: LessonPinEffect;
  pinnedVersion?: string | null;
  newerVersionAvailable?: string | null;
}

/** One finding about one file. The server writes `errors[].message` in plain words. */
interface LessonProblem {
  file?: string;
  index?: number;
  id?: string;
  version?: string;
  code?: string;
  status?: number;
  reason?: string;
  errors?: Array<{ pointer?: string; message?: string }>;
}

/** What the server says an import would do. A preview writes nothing. */
interface LessonPreview {
  importable?: boolean;
  kind?: LessonImportKind;
  packetTitle?: string;
  files?: LessonPreviewFile[];
  modules: LessonPreviewItem[];
  conflicts?: Array<{ id: string; version: string }>;
  problems?: LessonProblem[];
  /** A lesson backup preview also says how many pins and help files a restore would write. */
  pinsToSet?: string[];
  helpFilesToWrite?: number;
  knownModuleIds?: string[];
}

interface LessonImportedItem {
  kind: 'module' | 'packet';
  id: string;
  version: string;
  title?: string;
  status?: 'new' | 'already-stored';
}

interface LessonImportResult {
  imported?: LessonImportedItem[];
  revision?: number;
  /** An import answers with the module list. A backup restore does not. */
  modules?: LessonListEntry[];
}

/** The answer of the one-time progress migration. */
interface LessonMigration {
  status: 'migrated' | 'already-migrated';
  records?: number;
  snapshots?: number;
  files?: number;
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
  | 'conflict' | 'too_large' | 'invalid' | 'missing_module' | 'unsupported_version' | 'revision_conflict'
  | 'network_error' | 'invalid_response' | 'confirmation_required' | 'request_failed';

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
  pinText: string;
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
  problems: string[];
  canConfirm: boolean;
}

interface LessonService {
  previewImport(source: LessonSource, filename?: string): Promise<LessonPreview>;
  importLessons(source: LessonSource, filename?: string): Promise<LessonImportResult>;
  listLessons(): Promise<LessonListing>;
  switchPin(moduleId: string, version: string, options: { confirm: boolean; expectedRevision?: number }): Promise<LessonListing>;
  exportLessons(): Promise<LessonBackupFile>;
  previewRestore(backup: LessonBackupFile, filename?: string): Promise<LessonPreview>;
  restoreBackup(backup: LessonBackupFile, filename?: string): Promise<LessonImportResult>;
  migrate(): Promise<LessonMigration>;
}

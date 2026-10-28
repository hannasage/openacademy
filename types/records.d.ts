/** Versioned local and published records. UUIDs are checked at the data boundary. */
type LibraryStatus = 'active' | 'paused' | 'completed' | 'saved';

interface CloudOrigin {
  kind: 'cloud';
  hubId: string;
  backendOrigin: string;
  accountId: string;
}

type LocalRecordOrigin = { kind: 'local' } | CloudOrigin;

/** An unfinished form; an empty title is valid until the user submits it. */
interface ExperimentDraft {
  id: string | null;
  date: string;
  module: string;
  title: string;
  hypothesis: string;
  result: string;
}

interface LocalRecord {
  format: 'touchline-record';
  version: 2;
  recordId: string;
  origin: LocalRecordOrigin;
  curriculum: Curriculum;
  /** Local compare-and-swap revision; never the publication revision. */
  state: LearningState;
  status: LibraryStatus;
  view: { selectedModuleId: string };
  draft: { experiment: ExperimentDraft | null };
}

interface LibraryPreference {
  version: 1;
  revision: number;
  focusRecordId: string | null;
}

/** A separate publication pointer. Publishing never changes a local record's origin. */
interface PublicationBinding {
  recordId: string;
  hubId: string;
  backendOrigin: string;
  accountId: string;
  curriculumId: string;
  cloudRevision: number;
  publishedLocalRevision: number;
}

/** Explicit public projections of Curriculum and LearningState; no extension fields. */
interface PublishedCourse {
  format: 'touchline-snapshot';
  version: 1;
  curriculum: Curriculum;
  progress: LearningState;
  status: LibraryStatus;
  revision: number;
  publishedAt: string;
}

interface PublishedLibrary {
  version: 1;
  revision: number;
  focusCurriculumId: string | null;
}

interface HubDescription {
  format: 'touchline-hub';
  version: 1;
  hubId: string;
  name: string;
  hubOrigin: string;
  backend: { type: 'supabase'; url: string; publishableKey: string };
  contracts: { snapshot: 1; progress: 1 };
  auth: { email: 'otp'; providers: Array<'google' | 'apple'> };
}

interface ApiError {
  error: string;
  code: string;
  field?: string;
  retryable: boolean;
  currentRevision?: number;
}

interface LibrarySummary {
  recordId: string;
  origin: LocalRecordOrigin;
  curriculumId: string;
  title: string;
  status: LibraryStatus;
  revision: number;
  selectedModuleId: string;
}

interface LibraryResponse extends LibraryPreference {
  records: LibrarySummary[];
}

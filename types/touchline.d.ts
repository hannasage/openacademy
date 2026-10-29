interface CurriculumResource { title: string; url: string; use: string }
interface CurriculumModule {
  id: string; title: string; phase: string; question: string; outcome: string;
  math: string; evidence: string; challenge: string; reading: string; dataset: string;
  tasks: string[]; weeks: string[]; resources: string[]; prerequisites: string[];
  hours: number; weekStart: number; weekEnd: number;
}
interface Curriculum {
  id: string; version?: number; title: string; subtitle: string; description: string;
  weeks: number; weeklyHours: number; resources: Record<string, CurriculumResource>;
  modules: CurriculumModule[]; nextPhase?: string[]; researchDate?: string;
}
interface ModuleProgress {
  status: 'not-started' | 'active' | 'complete'; tasks: boolean[];
  notes: string; evidence: string; hours: number;
}
interface Experiment {
  id: string; date: string; module: string; title: string; hypothesis: string; result: string;
}
interface LearningState {
  version: 1; revision: number; curriculumId: string; weeklyHours: number;
  startDate: string; modules: Record<string, ModuleProgress>; experiments: Experiment[];
}
interface LearningBackup { format?: 'touchline-backup'; curriculum: Curriculum; state: LearningState }
interface HubConnection { url: string; publishableKey: string }
type CloudCourse = {
  user_id: string; id: string; curriculum: Curriculum; progress: LearningState;
  revision: number; updated_at: string;
}
interface TouchlineDatabase {
  public: {
    Tables: {
      learning_courses: {
        Row: CloudCourse;
        Insert: CloudCourse;
        Update: Partial<CloudCourse>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      save_learning_course: {
        Args: { course_id: string; course_content: Curriculum; course_progress: LearningState; expected_revision: number };
        Returns: CloudCourse;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
interface ExperimentControls extends HTMLFormControlsCollection {
  module: HTMLSelectElement;
  title: HTMLInputElement;
  hypothesis: HTMLTextAreaElement;
  result: HTMLTextAreaElement;
}
interface ExperimentForm extends HTMLFormElement { elements: ExperimentControls }
interface TouchlineElements {
  '#status': HTMLSelectElement;
  '#curriculum-select': HTMLSelectElement;
  '#experiment-module': HTMLSelectElement;
  '#study-hours': HTMLInputElement;
  '#start-date': HTMLInputElement;
  '#weekly-hours': HTMLInputElement;
  '#import': HTMLInputElement;
  '#curriculum-file': HTMLInputElement;
  '#cloud-url': HTMLInputElement;
  '#cloud-key': HTMLInputElement;
  '#cloud-email': HTMLInputElement;
  '#cloud-password': HTMLInputElement;
  '#prompt-fallback': HTMLTextAreaElement;
  '#notes': HTMLTextAreaElement;
  '#evidence': HTMLTextAreaElement;
  '#experiment-form': ExperimentForm;
  '#cloud-auth': HTMLFormElement;
  '#cloud-connection': HTMLFormElement;
}
interface Window {
  updateProjectionProgress?: (done: number, total: number) => void;
  touchline: {
    snapshot: () => Promise<LearningBackup>;
    publicationRecords: () => Promise<{records:LocalRecord[];focusRecordId:string|null}>;
    prepareCloudImport: (backup:LearningBackup,origin:CloudOrigin,status:LibraryStatus,targetRecordId?:string) => Promise<{token:string;local:LocalRecord|null}>;
    commitCloudImport: (token:string) => Promise<{recordId:string;revision:number}>;
    invalidateAccountScope: () => Promise<void>;
    setAccountScope: (origin: CloudOrigin | null) => Promise<void>;
    importCloud: (backup: LearningBackup, origin?: CloudOrigin) => Promise<boolean>;
    download: (value: unknown, name: string) => void;
  };
}

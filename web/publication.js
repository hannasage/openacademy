/** @param {string} field @param {string} detail @returns {never} */
function invalid(field, detail) {
  throw new TypeError(`Cannot publish ${field}: ${detail}.`);
}

/** @param {unknown} value @param {string} field @returns {Record<string, unknown>} */
function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field, 'expected an object');
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} field @param {number} [max] @returns {string} */
function text(value, field, max = Infinity) {
  if (typeof value !== 'string' || value.length > max) invalid(field, 'expected supported text');
  return value;
}

/** @param {unknown} value @param {string} field @returns {unknown[]} */
function array(value, field) {
  if (!Array.isArray(value)) invalid(field, 'expected a list');
  return value;
}

/** @param {unknown} value @param {string} field @returns {string[]} */
function strings(value, field) {
  return array(value, field).map((item, index) => text(item, `${field}[${index}]`));
}

/** @param {unknown} value @param {string} field @param {number} min @param {number} max @returns {number} */
function number(value, field, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid(field, 'number is outside its supported range');
  return value;
}

/** @param {unknown} value @param {string} field @param {number} min @param {number} max @returns {number} */
function integer(value, field, min, max) {
  const parsed = number(value, field, min, max);
  if (!Number.isInteger(parsed)) invalid(field, 'expected an integer');
  return parsed;
}

/** @param {unknown} value @param {string} field @param {RegExp} pattern @returns {string} */
function matching(value, field, pattern) {
  const parsed = text(value, field);
  if (!pattern.test(parsed)) invalid(field, 'unsupported value');
  return parsed;
}

/** @param {unknown} value @param {string} field @returns {string} */
function nonblank(value, field) {
  const parsed = text(value, field);
  if (!parsed.trim()) invalid(field, 'text cannot be blank');
  return parsed;
}

/** @param {unknown} value @returns {Curriculum} */
function curriculum(value) {
  const source = object(value, 'curriculum');
  if (source.version !== undefined && source.version !== 1) invalid('curriculum.version', 'unsupported version');
  const id = matching(source.id, 'curriculum.id', /^[a-z0-9][a-z0-9-]{0,59}$/);
  const weeks = integer(source.weeks, 'curriculum.weeks', 1, 520);
  const sourceResources = object(source.resources, 'curriculum.resources');
  const resources = Object.fromEntries(Object.entries(sourceResources).map(([key, raw]) => {
    const resource = object(raw, `resources.${key}`);
    return [key, {
      title: text(resource.title, `resources.${key}.title`),
      url: matching(resource.url, `resources.${key}.url`, /^https?:\/\/[^\s]+$/),
      use: text(resource.use, `resources.${key}.use`),
    }];
  }));
  const sourceModules = array(source.modules, 'curriculum.modules');
  if (sourceModules.length < 1 || sourceModules.length > 100) invalid('curriculum.modules', 'expected 1 to 100 modules');
  const modules = sourceModules.map((raw, index) => {
    const field = `curriculum.modules[${index}]`;
    const sourceModule = object(raw, field);
    const tasks = strings(sourceModule.tasks, `${field}.tasks`);
    if (tasks.length < 1 || tasks.length > 30) invalid(`${field}.tasks`, 'expected 1 to 30 tasks');
    const weekStart = number(sourceModule.weekStart, `${field}.weekStart`, Number.MIN_VALUE, 10000);
    const weekEnd = number(sourceModule.weekEnd, `${field}.weekEnd`, Number.MIN_VALUE, 10000);
    if (weekStart > weekEnd || weekEnd > weeks) invalid(field, 'module weeks must fit the curriculum');
    const resourceIds = strings(sourceModule.resources, `${field}.resources`);
    if (resourceIds.some((resourceId) => !Object.hasOwn(resources, resourceId))) invalid(`${field}.resources`, 'unknown resource');
    const module = {
      id: matching(sourceModule.id, `${field}.id`, /^[a-zA-Z0-9_-]{1,60}$/),
      title: text(sourceModule.title, `${field}.title`),
      phase: text(sourceModule.phase, `${field}.phase`),
      question: text(sourceModule.question, `${field}.question`),
      outcome: text(sourceModule.outcome, `${field}.outcome`),
      math: text(sourceModule.math, `${field}.math`),
      evidence: text(sourceModule.evidence, `${field}.evidence`),
      challenge: text(sourceModule.challenge, `${field}.challenge`),
      reading: text(sourceModule.reading, `${field}.reading`),
      dataset: text(sourceModule.dataset, `${field}.dataset`),
      tasks,
      weeks: strings(sourceModule.weeks, `${field}.weeks`),
      resources: resourceIds,
      prerequisites: strings(sourceModule.prerequisites, `${field}.prerequisites`),
      hours: number(sourceModule.hours, `${field}.hours`, Number.MIN_VALUE, 10000),
      weekStart,
      weekEnd,
      ...(sourceModule.number !== undefined ? { number: integer(sourceModule.number, `${field}.number`, 1, Number.MAX_SAFE_INTEGER) } : {}),
    };
    return module;
  });
  const moduleIds = new Set(modules.map((module) => module.id));
  if (moduleIds.size !== modules.length) invalid('curriculum.modules', 'module IDs must be unique');
  if (modules.some((module) => module.prerequisites.some((id) => !moduleIds.has(id)))) invalid('curriculum.modules', 'unknown prerequisite');
  return {
    id,
    ...(source.version !== undefined ? { version: 1 } : {}),
    title: nonblank(source.title, 'curriculum.title'),
    subtitle: nonblank(source.subtitle, 'curriculum.subtitle'),
    description: nonblank(source.description, 'curriculum.description'),
    weeks,
    weeklyHours: number(source.weeklyHours, 'curriculum.weeklyHours', 1, 40),
    resources,
    modules,
    ...(source.nextPhase !== undefined ? { nextPhase: strings(source.nextPhase, 'curriculum.nextPhase') } : {}),
    ...(source.researchDate !== undefined ? { researchDate: text(source.researchDate, 'curriculum.researchDate') } : {}),
    ...(source.totalHours !== undefined ? { totalHours: number(source.totalHours, 'curriculum.totalHours', 0, 20800) } : {}),
  };
}

/** @param {unknown} value @returns {string} */
function startDate(value) {
  const parsed = text(value, 'state.startDate', 10);
  if (parsed === '') return parsed;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) invalid('state.startDate', 'expected an ISO calendar date');
  const date = new Date(`${parsed}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== parsed) invalid('state.startDate', 'date does not exist');
  return parsed;
}

/** @param {unknown} value @param {Curriculum} course @returns {LearningState} */
function progress(value, course) {
  const source = object(value, 'state');
  if (source.version !== 1) invalid('state.version', 'unsupported version');
  if (source.curriculumId !== course.id) invalid('state.curriculumId', 'curriculum does not match');
  const moduleMap = new Map(course.modules.map((module) => [module.id, module]));
  const modules = Object.fromEntries(Object.entries(object(source.modules, 'state.modules')).map(([id, raw]) => {
    const field = `state.modules.${id}`;
    const courseModule = moduleMap.get(id);
    if (!courseModule) invalid(field, 'unknown module');
    const module = object(raw, field);
    const status = module.status;
    if (status !== 'not-started' && status !== 'active' && status !== 'complete') invalid(`${field}.status`, 'unsupported status');
    const tasks = array(module.tasks, `${field}.tasks`).map((task) => {
      if (typeof task !== 'boolean') invalid(`${field}.tasks`, 'expected boolean task values');
      return task;
    });
    if (tasks.length !== courseModule.tasks.length) invalid(`${field}.tasks`, 'task count does not match');
    const evidence = text(module.evidence, `${field}.evidence`, 50000);
    if (status === 'complete' && (!tasks.every(Boolean) || !evidence.trim())) invalid(field, 'complete tasks and record evidence first');
    /** @type {ModuleProgress} */
    const projected = { status, tasks, notes: text(module.notes, `${field}.notes`, 50000), evidence, hours: number(module.hours, `${field}.hours`, 0, 10000) };
    return [id, projected];
  }));
  const sourceExperiments = array(source.experiments, 'state.experiments');
  if (sourceExperiments.length > 2000) invalid('state.experiments', 'too many experiments');
  const experiments = sourceExperiments.map((raw, index) => {
    const field = `state.experiments[${index}]`;
    const experiment = object(raw, field);
    const module = text(experiment.module, `${field}.module`, 20000);
    if (!moduleMap.has(module)) invalid(`${field}.module`, 'unknown module');
    const title = text(experiment.title, `${field}.title`, 20000);
    if (!title.trim()) invalid(`${field}.title`, 'title cannot be blank');
    return {
      id: text(experiment.id, `${field}.id`, 20000),
      date: text(experiment.date, `${field}.date`, 20000),
      module,
      title,
      hypothesis: text(experiment.hypothesis, `${field}.hypothesis`, 20000),
      result: text(experiment.result, `${field}.result`, 20000),
    };
  });
  return {
    version: 1,
    revision: integer(source.revision, 'state.revision', 0, Number.MAX_SAFE_INTEGER),
    curriculumId: course.id,
    weeklyHours: number(source.weeklyHours, 'state.weeklyHours', 1, 40),
    startDate: startDate(source.startDate),
    modules,
    experiments,
  };
}

/**
 * Select only supported public content. Local metadata is never copied to the RPC.
 * @param {unknown} backup
 * @returns {LearningBackup}
 */
export function projectPublication(backup) {
  const source = object(backup, 'backup');
  if (source.format !== undefined && source.format !== 'touchline-backup') invalid('backup.format', 'unsupported format');
  const course = curriculum(source.curriculum);
  return { format: 'touchline-backup', curriculum: course, state: progress(source.state, course) };
}

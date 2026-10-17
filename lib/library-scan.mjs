import { HttpError } from './security.mjs';

// Jellyfin may hide or disable its manual media refresh task while still
// allowing administrators to start it explicitly. Filtered listings omit it.
const TASKS_PATH = '/ScheduledTasks';
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;

function taskIdentity(task) {
  return [task?.Key, task?.Name, task?.Description].filter(value => typeof value === 'string').join(' ').toLocaleLowerCase();
}

function isLibraryScanTask(task) {
  const identity = taskIdentity(task);
  if (/refreshmedialibrarytask/.test(identity)) return true;
  return /(?:scan|refresh|escane(?:ar|o)).{0,40}(?:media|library|biblioteca)|(?:media|library|biblioteca).{0,40}(?:scan|refresh|escane(?:ar|o))/.test(identity);
}

async function cancelBody(response) {
  await response.body?.cancel();
}

export async function startLibraryScan({ session, upstream, jsonResponse }) {
  const listed = await upstream(TASKS_PATH, { session });
  if (!listed.ok) {
    await cancelBody(listed);
    throw new HttpError(502, 'No se pudieron consultar las tareas de escaneo de Jellyfin.');
  }
  const payload = await jsonResponse(listed);
  const tasks = Array.isArray(payload) ? payload : payload?.Items;
  if (!Array.isArray(tasks)) throw new HttpError(502, 'Jellyfin devolvió una lista de tareas no válida.');

  const keyed = tasks.filter(task => /refreshmedialibrarytask/i.test(task?.Key || ''));
  const matches = keyed.length ? keyed : tasks.filter(isLibraryScanTask);
  if (matches.length !== 1 || !TASK_ID.test(matches[0]?.Id || '')) {
    throw new HttpError(503, 'No se pudo identificar de forma segura la tarea “Escanear la biblioteca” de Jellyfin.');
  }

  const task = matches[0];
  if (String(task.State).toLocaleLowerCase() === 'running') {
    return {
      scanRequested: true,
      alreadyRunning: true,
      taskName: task.Name || 'Escanear la biblioteca',
      ...(Number.isFinite(task.CurrentProgressPercentage) ? { progress: task.CurrentProgressPercentage } : {}),
    };
  }

  const started = await upstream('/ScheduledTasks/Running/' + encodeURIComponent(task.Id), { session, method: 'POST' });
  await cancelBody(started);
  if (!started.ok) {
    if (started.status === 409) {
      const latest = await upstream(TASKS_PATH, { session });
      if (latest.ok) {
        const latestPayload = await jsonResponse(latest);
        const latestTasks = Array.isArray(latestPayload) ? latestPayload : latestPayload?.Items;
        const current = Array.isArray(latestTasks) && latestTasks.find(candidate => candidate.Id === task.Id);
        if (String(current?.State).toLocaleLowerCase() === 'running') {
          return {
            scanRequested: true,
            alreadyRunning: true,
            taskName: current.Name || task.Name || 'Escanear la biblioteca',
            ...(Number.isFinite(current.CurrentProgressPercentage) ? { progress: current.CurrentProgressPercentage } : {}),
          };
        }
      } else await cancelBody(latest);
    }
    throw new HttpError(502, 'Jellyfin no pudo iniciar el escaneo de la biblioteca.');
  }
  return { scanRequested: true, alreadyRunning: false, taskName: task.Name || 'Escanear la biblioteca' };
}

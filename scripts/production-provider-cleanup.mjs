export function providerStatus(error) {
  return Number(error?.status || error?.$metadata?.httpStatusCode || 0);
}

export function providerNotFound(error) {
  return [404, 410].includes(providerStatus(error));
}

const transientFailure = (error) => {
  const status = providerStatus(error);
  return error?.name === "AbortError" || error?.name === "TimeoutError"
    || !status || status === 408 || status === 429 || status >= 500;
};

async function retryDelete(remove, id, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  if (!id) return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await remove(id);
      return;
    } catch (error) {
      if (providerNotFound(error)) return;
      if (!transientFailure(error) || attempt === 2) throw error;
      await wait(attempt === 0 ? 250 : 750);
    }
  }
}

export function safeDeleteCalendar(calendar, eventId, wait) {
  return retryDelete((id) => calendar.deleteEvent(id), eventId, wait);
}

export function safeDeleteTodoist(todoist, taskId, wait) {
  return retryDelete((id) => todoist.deleteTask(id), taskId, wait);
}

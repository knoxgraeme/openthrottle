import { getErrorMessage, supervisorRequest } from './util.js';

export default async function stop(ticket: string | undefined): Promise<void> {
  if (!ticket) {
    console.error('Usage: openthrottle stop <ticket>');
    process.exit(1);
  }
  try {
    const response = await supervisorRequest(
      `/tickets/${encodeURIComponent(ticket)}/stop`,
      { method: 'POST' }
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    console.log(`Stopped ${ticket}.`);
  } catch (error) {
    console.error(`Could not stop ${ticket}: ${getErrorMessage(error)}`);
    process.exit(1);
  }
}

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
    const body = await response.json() as { status?: string };
    console.log(body.status === 'stop_requested' || response.status === 202
      ? `Stop requested for ${ticket}.`
      : `Stopped ${ticket}.`);
  } catch (error) {
    console.error(`Could not stop ${ticket}: ${getErrorMessage(error)}`);
    process.exit(1);
  }
}

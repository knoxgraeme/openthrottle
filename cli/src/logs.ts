import { getErrorMessage, supervisorRequest } from './util.js';

export default async function logs(ticket: string | undefined): Promise<void> {
  if (!ticket) {
    console.error('Usage: openthrottle logs <ticket>');
    process.exit(1);
  }
  try {
    const response = await supervisorRequest(`/tickets/${encodeURIComponent(ticket)}/logs`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    process.stdout.write(await response.text());
  } catch (error) {
    console.error(`Could not fetch logs for ${ticket}: ${getErrorMessage(error)}`);
    process.exit(1);
  }
}

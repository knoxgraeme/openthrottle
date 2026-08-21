import { getErrorMessage, supervisorRequest } from './util.js';

export default async function stop(reference: string | undefined): Promise<void> {
  if (!reference) {
    console.error('Usage: openthrottle stop <run-or-source-reference>');
    process.exit(1);
    return;
  }
  try {
    const response = await supervisorRequest(
      `/runs/${encodeURIComponent(reference)}/control`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop', reason: 'operator CLI request' }),
      },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    const body = await response.json() as {
      accepted?: boolean;
      duplicate?: boolean;
      pipeline_run_id?: string;
    };
    if (body.accepted !== true) throw new Error('supervisor did not accept the stop request');
    console.log(
      body.duplicate
        ? `Stop was already requested for ${reference}.`
        : `Stop requested for ${reference}.`,
    );
  } catch (error) {
    console.error(`Could not stop ${reference}: ${getErrorMessage(error)}`);
    process.exit(1);
  }
}

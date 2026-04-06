/**
 * lib/roundtable-history.mjs — Autosave roundtable synthesis to markdown history
 */
import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

const HISTORY_DIR = '/root/.openclaw/workspace/roundtable/history';

/**
 * Save a completed roundtable synthesis to a daily markdown file.
 * @param {string} rtId
 * @param {object} meta — HGETALL result (topic, participants, constraints, template, ...)
 * @param {Array}  contributions — parseXread result
 * @param {string} synthesis — synthesis text
 * @returns {{ archived: boolean, archive_path?: string, archive_error?: string }}
 */
export async function saveRoundtableHistory(rtId, meta, contributions, synthesis) {
  try {
    await mkdir(HISTORY_DIR, { recursive: true });

    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const filePath = join(HISTORY_DIR, `${date}.md`);

    // Build participants list
    let participantStr = '';
    if (Array.isArray(meta.participants)) {
      participantStr = meta.participants.join(', ');
    } else if (typeof meta.participants === 'string') {
      participantStr = meta.participants;
    }

    const lines = [];
    lines.push(`## Roundtable: ${meta.topic || rtId}`);
    lines.push(`- **RT ID:** ${rtId}`);
    lines.push(`- **Completed:** ${new Date().toISOString()}`);
    lines.push(`- **Participants:** ${participantStr}`);
    if (meta.template) {
      lines.push(`- **Template:** ${meta.template}`);
    }
    if (meta.constraints) {
      lines.push(`- **Constraints:** ${meta.constraints}`);
    }
    lines.push('');
    lines.push('### Synthesis');
    lines.push(synthesis);
    lines.push('');
    lines.push('---');
    lines.push('');

    await appendFile(filePath, lines.join('\n'), 'utf8');

    return { archived: true, archive_path: filePath };
  } catch (err) {
    return { archived: false, archive_error: String(err.message || err) };
  }
}

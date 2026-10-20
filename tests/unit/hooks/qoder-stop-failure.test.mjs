import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findFailureTurnWindow,
  readTranscriptSnapshot,
} from '../../../assets/hooks/qoder-hook-processor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../assets/hooks/qoder-hook-processor.mjs');
const SESSION = 'failure-session';
const PRIVATE_DETAIL = 'private upstream detail';
const PRIVATE_MESSAGE = 'private rendered error';

let dataDir;
let transcriptPath;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-stop-failure-'));
  transcriptPath = path.join(dataDir, 'transcript.jsonl');
});

afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function ts(second) {
  return `2026-09-22T10:00:${String(second).padStart(2, '0')}.000Z`;
}

function writeTranscript(rows) {
  fs.writeFileSync(transcriptPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
}

function transcriptLineCount() {
  return fs.readFileSync(transcriptPath, 'utf-8').trim().split('\n').length;
}

function progressRow(uuid, second, hookEvent = 'UserPromptSubmit') {
  return {
    type: 'progress', sessionId: SESSION, uuid, timestamp: ts(second),
    data: { hookEvent, hookName: 'loongsuite-pilot' },
  };
}

function userRow(uuid, second, text) {
  return {
    type: 'user', sessionId: SESSION, uuid, timestamp: ts(second),
    entrypoint: 'cli', message: { role: 'user', content: text },
  };
}

function failureRow(second, { error = 'server_error', status = 529 } = {}) {
  return {
    type: 'assistant', sessionId: SESSION, uuid: 'asst-error', timestamp: ts(second),
    isApiErrorMessage: true,
    apiErrorStatus: status,
    error,
    errorDetails: PRIVATE_DETAIL,
    message: {
      id: 'synthetic-error-message',
      role: 'assistant',
      model: 'ultimate',
      content: [{ type: 'text', text: PRIVATE_DETAIL }],
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'stop_sequence',
    },
  };
}

function readHistory() {
  const historyDir = path.join(dataDir, 'logs', 'qoder', 'history');
  if (!fs.existsSync(historyDir)) return [];
  return fs.readdirSync(historyDir)
    .filter(file => file.endsWith('.jsonl'))
    .flatMap(file => fs.readFileSync(path.join(historyDir, file), 'utf-8').split('\n'))
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function responses() {
  return readHistory().filter(record => record['event.name'] === 'llm.response');
}

function requests() {
  return readHistory().filter(record => record['event.name'] === 'llm.request');
}

function runFailureRetry({ errorType = 'server_error', triggerEndLine } = {}) {
  const args = [
    PROCESSOR,
    '--agent-id', 'qoder',
    '--log-prefix', 'qoder',
    '--retry',
    '--failure',
    '--transcript', transcriptPath,
    '--session', SESSION,
    '--trigger-end-line', String(triggerEndLine ?? transcriptLineCount()),
    '--cwd', '/tmp/qoder-failure-project',
  ];
  if (errorType) args.push('--error-type', errorType);
  return spawnSync('node', args, {
    env: {
      ...process.env,
      LOONGSUITE_PILOT_DATA_DIR: dataDir,
      HOOK_RETRY_DELAY: '0',
      HOOK_FAILURE_STABILITY_INTERVAL_MS: '10',
    },
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for condition');
}

describe('qoder StopFailure export', () => {
  it('turns the synthetic API-error row into a structured failed LLM response', () => {
    writeTranscript([
      progressRow('prog-1', 0),
      userRow('user-1', 1, 'trigger error'),
      failureRow(2),
    ]);

    const result = runFailureRetry();
    expect(result.status, result.stderr).toBe(0);

    const reqs = requests();
    const resps = responses();
    expect(reqs).toHaveLength(1);
    expect(resps).toHaveLength(1);
    expect(resps[0]).toMatchObject({
      'gen_ai.response.finish_reasons': ['error'],
      'error.type': 'server_error',
      'http.response.status_code': 529,
      'agent.stop_reason': 'stop_sequence',
    });
    // Error text and zero usage tokens must not leak into the event log.
    expect(resps[0]['gen_ai.output.messages']).toBeUndefined();
    expect(resps[0]['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(resps[0]['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(JSON.stringify(readHistory())).not.toContain(PRIVATE_DETAIL);
  });

  it('keeps the failed turn single-shot when the same hook is replayed', () => {
    writeTranscript([
      progressRow('prog-1', 0),
      userRow('user-1', 1, 'trigger error'),
      failureRow(2),
    ]);

    expect(runFailureRetry().status).toBe(0);
    expect(runFailureRetry().status).toBe(0);

    expect(requests()).toHaveLength(1);
    expect(responses()).toHaveLength(1);
  });

  it('appends a failed call when the error happened after a completed tool step', () => {
    writeTranscript([
      progressRow('prog-1', 0),
      userRow('user-1', 1, 'list the files'),
      {
        type: 'assistant', sessionId: SESSION, uuid: 'asst-1', timestamp: ts(2),
        message: {
          id: 'resp_step1',
          role: 'assistant',
          model: 'ultimate',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } }],
        },
      },
      {
        type: 'user', sessionId: SESSION, uuid: 'result-1', timestamp: ts(3),
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'a.txt' }],
        },
      },
    ]);

    const result = runFailureRetry({ errorType: 'rate_limit_error' });
    expect(result.status, result.stderr).toBe(0);

    const resps = responses();
    expect(resps).toHaveLength(2);
    expect(resps[0]['error.type']).toBeUndefined();
    expect(resps[0]['gen_ai.response.finish_reasons']).toEqual(['tool_call']);
    expect(resps[1]).toMatchObject({
      'gen_ai.response.finish_reasons': ['error'],
      'error.type': 'rate_limit_error',
    });
    expect(resps[1]['gen_ai.output.messages']).toBeUndefined();
    expect(requests()).toHaveLength(2);
  });

  it('synthesizes the whole failed call when the transcript has no assistant row', () => {
    writeTranscript([
      progressRow('prog-1', 0),
      userRow('user-1', 1, 'trigger error'),
    ]);

    const result = runFailureRetry({ errorType: 'server_error', triggerEndLine: 2 });
    expect(result.status, result.stderr).toBe(0);

    const reqs = requests();
    const resps = responses();
    expect(reqs).toHaveLength(1);
    expect(resps).toHaveLength(1);
    expect(reqs[0]['gen_ai.input.messages_delta'][0].role).toBe('user');
    expect(resps[0]).toMatchObject({
      'gen_ai.response.finish_reasons': ['error'],
      'error.type': 'server_error',
    });
  });

  it('exports a StopFailure delivered on stdin without Stop or last-prompt markers', async () => {
    writeTranscript([
      progressRow('prog-1', 0),
      userRow('user-1', 1, 'trigger error'),
      failureRow(2),
    ]);
    const result = spawnSync('node', [PROCESSOR, '--agent-id', 'qoder', '--log-prefix', 'qoder'], {
      input: JSON.stringify({
        session_id: SESSION,
        transcript_path: transcriptPath,
        cwd: '/tmp/qoder-failure-project',
        hook_event_name: 'StopFailure',
        error: 'server_error',
        error_details: PRIVATE_DETAIL,
        last_assistant_message: PRIVATE_MESSAGE,
      }),
      env: {
        ...process.env,
        LOONGSUITE_PILOT_DATA_DIR: dataDir,
        HOOK_RETRY_DELAY: '0',
        HOOK_FAILURE_STABILITY_INTERVAL_MS: '10',
      },
      encoding: 'utf-8',
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);

    await waitFor(() => responses().length > 0);
    expect(responses()[0]).toMatchObject({
      'gen_ai.response.finish_reasons': ['error'],
      'error.type': 'server_error',
    });
    expect(JSON.stringify(readHistory())).not.toContain(PRIVATE_DETAIL);
    expect(JSON.stringify(readHistory())).not.toContain(PRIVATE_MESSAGE);
  });
});

describe('findFailureTurnWindow', () => {
  it('ends the failed turn before a prompt queued during the retry delay', () => {
    writeTranscript([
      progressRow('prog-1', 0),
      userRow('user-1', 1, 'first prompt'),
      failureRow(2),
      progressRow('prog-2', 3),
      userRow('user-2', 4, 'next prompt'),
    ]);

    const window = findFailureTurnWindow(readTranscriptSnapshot(transcriptPath), 3);
    expect(window).toMatchObject({
      status: 'complete',
      startLine: 0,
      endLine: 3,
    });
  });

  it('falls back to the real user row when the transcript has no progress marker', () => {
    writeTranscript([
      userRow('user-1', 1, 'first prompt'),
      failureRow(2),
    ]);

    const window = findFailureTurnWindow(readTranscriptSnapshot(transcriptPath), 2);
    expect(window).toMatchObject({ startLine: 0, endLine: 2 });
  });

  it('returns null when the transcript has no prompt to anchor on', () => {
    writeTranscript([progressRow('prog-1', 0)]);

    expect(findFailureTurnWindow(readTranscriptSnapshot(transcriptPath), 1)).toBeNull();
  });
});

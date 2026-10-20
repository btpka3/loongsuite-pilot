import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ExportResultCode } from '@opentelemetry/core';
import { SpanStatusCode } from '@opentelemetry/api';
import { ClientType } from '../../src/types/index.js';
import type { AgentActivityEntry } from '../../src/types/index.js';
import { OtlpTraceFlusher, type TraceExporterLike } from '../../src/flushers/otlp-trace-flusher.js';
import { buildCanonicalHookEntry } from '../../src/inputs/base/canonical-hook-record.js';
import { getTodayDateString } from '../../src/utils/fs-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../assets/hooks/qoder-hook-processor.mjs');
const SESSION = 'failure-span-session';

let dataDir: string;
let transcriptPath: string;
let captured: ReadableSpan[];
let flusher: OtlpTraceFlusher;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-failure-span-'));
  transcriptPath = path.join(dataDir, 'transcript.jsonl');
  captured = [];
  const exporter: TraceExporterLike = {
    export(spans, callback) { captured.push(...spans); callback({ code: ExportResultCode.SUCCESS }); },
    shutdown: async () => {},
  };
  flusher = new OtlpTraceFlusher({
    enabled: true,
    endpoints: [{ name: 'test', endpoint: 'http://localhost:4318/v1/traces', headers: {} }],
    protocol: 'http/protobuf',
    serviceName: 'qoder-failure-span-test',
  }, undefined, () => exporter);
});

afterEach(async () => {
  await flusher.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function ts(second: number): string {
  return `2026-09-22T10:00:${String(second).padStart(2, '0')}.000Z`;
}

function writeTranscript(rows: Record<string, unknown>[]): void {
  fs.writeFileSync(transcriptPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
}

function failureTranscript(withToolStep: boolean): void {
  const rows: Record<string, unknown>[] = [
    {
      type: 'progress', sessionId: SESSION, uuid: 'prog-1', timestamp: ts(0),
      data: { hookEvent: 'UserPromptSubmit', hookName: 'loongsuite-pilot' },
    },
    {
      type: 'user', sessionId: SESSION, uuid: 'user-1', timestamp: ts(1),
      entrypoint: 'cli', message: { role: 'user', content: 'trigger error' },
    },
  ];
  if (withToolStep) {
    rows.push(
      {
        type: 'assistant', sessionId: SESSION, uuid: 'asst-1', timestamp: ts(2),
        message: {
          id: 'resp_step1', role: 'assistant', model: 'ultimate', stop_reason: 'tool_use',
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
    );
  }
  rows.push({
    type: 'assistant', sessionId: SESSION, uuid: 'asst-error', timestamp: ts(4),
    isApiErrorMessage: true,
    apiErrorStatus: 529,
    error: 'server_error',
    errorDetails: 'private upstream detail',
    message: {
      id: 'synthetic-error-message',
      role: 'assistant',
      model: 'ultimate',
      content: [{ type: 'text', text: 'private upstream detail' }],
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'stop_sequence',
    },
  });
  writeTranscript(rows);
}

function runFailureExport(): void {
  const lineCount = fs.readFileSync(transcriptPath, 'utf-8').trim().split('\n').length;
  const result = spawnSync('node', [
    PROCESSOR,
    '--agent-id', 'qoder',
    '--log-prefix', 'qoder',
    '--retry',
    '--failure',
    '--transcript', transcriptPath,
    '--session', SESSION,
    '--trigger-end-line', String(lineCount),
    '--error-type', 'server_error',
    '--cwd', '/tmp/qoder-failure-project',
  ], {
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
}

async function exportHistory(): Promise<void> {
  const file = path.join(
    dataDir, 'logs', 'qoder', 'history', `qoder-${getTodayDateString()}.jsonl`,
  );
  const entries = fs.readFileSync(file, 'utf-8').trim().split('\n')
    .map((line) => buildCanonicalHookEntry(
      JSON.parse(line) as Record<string, unknown>,
      ClientType.QoderCli,
      undefined,
      { preserveSafeCustomTopLevelFields: true },
    ))
    .filter((entry): entry is AgentActivityEntry => entry !== null);
  await flusher.sendBatch(entries);
  await flusher.flush();
}

const spansOf = (kind: string) => captured.filter(span => span.attributes['gen_ai.span.kind'] === kind);

function llmSpansByStart() {
  return [...spansOf('LLM')].sort((left, right) => (
    left.startTime[0] - right.startTime[0] || left.startTime[1] - right.startTime[1]
  ));
}

describe('qoder StopFailure trace export', () => {
  it('marks the failed LLM, AGENT and ENTRY spans as errors', async () => {
    failureTranscript(false);
    runFailureExport();
    await exportHistory();

    const llm = spansOf('LLM');
    expect(llm).toHaveLength(1);
    expect(llm[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(llm[0].attributes['error.type']).toBe('server_error');
    expect(llm[0].attributes['error.message']).toBe('model request failed');

    for (const kind of ['AGENT', 'ENTRY']) {
      const spans = spansOf(kind);
      expect(spans.length, `missing ${kind} span`).toBeGreaterThan(0);
      for (const span of spans) {
        expect(span.status.code, `${kind} status`).toBe(SpanStatusCode.ERROR);
        expect(span.attributes['error.type']).toBe('server_error');
      }
    }
    expect(JSON.stringify(captured.map(span => span.attributes))).not.toContain('private upstream detail');
  });

  it('keeps the completed tool step green and only fails the appended error step', async () => {
    failureTranscript(true);
    runFailureExport();
    await exportHistory();

    const llm = llmSpansByStart();
    expect(llm).toHaveLength(2);
    expect(llm[0].status.code).not.toBe(SpanStatusCode.ERROR);
    expect(llm[0].attributes['error.type']).toBeUndefined();
    expect(llm[1].status.code).toBe(SpanStatusCode.ERROR);
    expect(llm[1].attributes['error.type']).toBe('server_error');

    expect(spansOf('TOOL')).toHaveLength(1);
    for (const span of [...spansOf('AGENT'), ...spansOf('ENTRY')]) {
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
    }
  });
});

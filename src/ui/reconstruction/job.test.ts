import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ReconstructionArtifacts } from './artifacts.ts';
import type { ReconstructionBilling } from './billing.ts';
import { ReconstructionJob } from './job.ts';
import type { ReconstructionView } from './view.ts';

class StubEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {}
}
(globalThis as { EventSource?: unknown }).EventSource = StubEventSource;

const button = () => ({
    hidden: false,
    disabled: false,
    textContent: '',
    title: '',
    addEventListener() {},
    setAttribute() {}
});

/** The shared progress card, recorded so a test can ask what the user would have seen. */
const stubView = (painted: string[]) => ({
    openPrimaryButton: button(),
    cancelButton: button(),
    progress: { showNotice() {} },
    setState: (title: string) => {
        painted.push(title);
    },
    setStage() {},
    setStageProgress() {},
    setWorkerStatus() {},
    resetStartLabel() {}
} as unknown as ReconstructionView);

const stubBilling = { refreshCredits: async () => {} } as unknown as ReconstructionBilling;

const stubArtifacts = {
    refreshRecentRuns: async () => {},
    showArtifacts() {},
    openArtifact: async () => ({ status: 'opened' }),
    cancelDownload() {}
} as unknown as ReconstructionArtifacts;

const serve = (body: unknown) => {
    globalThis.fetch = (async () => new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    })) as typeof fetch;
};

test('a watch let go of while the job is still running reports detached, never done', async () => {
    const painted: string[] = [];
    const job = new ReconstructionJob(stubView(painted), stubBilling, stubArtifacts);
    globalThis.fetch = (async () => {
        job.detach();                          // the user pressed "Luồng mới" mid-poll
        return new Response(JSON.stringify({ job: { status: 'running', terminal: false } }), {
            status: 200, headers: { 'content-type': 'application/json' }
        });
    }) as typeof fetch;

    assert.equal(await job.attach('job-running'), 'detached',
        'a watch that never saw the job end must not report the job as finished');
    assert.deepEqual(painted, [],
        'a let-go watch must leave the card to whoever took it');
});

test('a job the server calls done reports done', async () => {
    serve({
        job: { status: 'done', terminal: true },
        artifacts: [{ name: 'model.ply', primary: true }]
    });
    const job = new ReconstructionJob(stubView([]), stubBilling, stubArtifacts);
    assert.equal(await job.attach('job-done'), 'done');
});

test('a job the server calls failed throws rather than settling', async () => {
    serve({
        job: {
            status: 'failed',
            terminal: true,
            failure: {
                code: 'stage_failed',
                stage: 'global_mapper',
                message: 'Stage “global_mapper” exited with code 255',
                retryable: true
            }
        },
        artifacts: []
    });
    const job = new ReconstructionJob(stubView([]), stubBilling, stubArtifacts);
    await assert.rejects(job.attach('job-failed'), /reconstruction step stopped/i);
});

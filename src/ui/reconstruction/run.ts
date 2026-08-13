import { formatProgressAmount, stageLabel, type ProgressVisual } from './progress';
import type { JobGpu, JobStatus } from './types';

type RunState =
    | 'queued'
    | 'uploading'
    | 'paused'
    | 'quoting'
    | 'waiting-slot'
    | 'running'
    | 'done'
    | 'cancelled'
    | 'failed';

type Run = {
    id: string;
    state: RunState;
    /** null until a session is opened; set before the first byte moves. */
    datasetId: string | null;
    pipeline: string;
    preset: string;
    /** Seeded to the preset, replaced by the minted name at submit time (newRunName). */
    runName: string;
    submitKey: string | null;
    label: string;
    jobId: string | null;
    percent: number;
    detail: string;
};

type RunAction = 'pause' | 'resume' | 'repick' | 'cancel' | 'dismiss' | 'open' | 'retry';

const runKey = (run: Run): string => {
    if (run.jobId) return run.jobId;
    if ((run.state === 'uploading' || run.state === 'paused') && run.datasetId) {
        return `session:${run.datasetId}`;
    }
    return run.id;
};

const runControls = (run: Run, hasFolder: boolean): RunAction[] => {
    switch (run.state) {
        case 'queued': return ['cancel'];
        case 'uploading': return ['pause', 'cancel'];
        case 'paused': return [hasFolder ? 'resume' : 'repick', 'cancel'];
        case 'quoting': return ['dismiss'];
        case 'waiting-slot': return ['dismiss'];
        case 'running': return [];
        case 'done': return ['open', 'dismiss'];
        case 'cancelled': return ['retry', 'dismiss'];
        case 'failed': return ['retry', 'dismiss'];
    }
};

/**
 * The shared progress card for a run nothing is streaming. One card serves every run.
 */
const runCard = (run: Run): [string, string, ProgressVisual] => {
    const name = run.runName || run.preset;
    switch (run.state) {
        case 'queued':
            return ['Đang chờ tải lên',
                `${name} sẽ bắt đầu ngay khi luồng đang tải lên xong.`,
                { mode: 'idle', center: 'Chờ' }];
        case 'uploading':
            return ['Đang tải ảnh lên', `${name}: ${run.percent}% ảnh đã lên kho.`,
                { mode: 'determinate', value: run.percent }];
        case 'paused':
            return ['Đã tạm dừng',
                'Ảnh đã tải lên vẫn được giữ. Nhấn ▶ trên luồng để tiếp tục.',
                { mode: 'idle', center: 'Dừng' }];
        case 'quoting':
            return ['Đang báo giá', `Đang tính chi phí cho ${name}.`, { mode: 'indeterminate' }];
        case 'waiting-slot':
            return ['Đang chờ lượt',
                'Đã đạt số luồng chạy song song tối đa của gói. Luồng này tự bắt đầu khi có chỗ.',
                { mode: 'idle', center: 'Chờ' }];
        case 'running':
            return ['Đang chạy', run.detail || `${name} đang chạy trên GPU.`,
                { mode: 'indeterminate' }];
        case 'done':
            return ['Hoàn tất', `${name} đã xong. Nhấn “Mở” trên luồng để xem mô hình.`,
                { mode: 'done', center: '100%' }];
        case 'cancelled':
            return ['Đã huỷ', run.detail || `${name} đã được huỷ.`, { mode: 'failed' }];
        case 'failed':
            return ['Thất bại', run.detail || `${name} đã dừng trước khi hoàn tất.`,
                { mode: 'failed' }];
    }
};

const GPU_TEXT: Record<JobGpu['state'], string> = {
    creating: 'Đang thuê GPU',
    loading: 'Đang khởi tạo GPU',
    running: 'GPU đã sẵn sàng'
};

/**
 * The row detail for a run no stream is attached to. Only the selected run gets an SSE
 * stream, so for every other one this is the whole progress the user can see — built from
 * the status the poll already read rather than from the bare status word.
 */
const runPollDetail = (job: JobStatus): string => {
    const parts: string[] = [];
    if (job.gpu) parts.push(GPU_TEXT[job.gpu.state]);
    const stage = job.current_stage;
    if (stage) {
        parts.push(stage.total > 0 ?
            `${stage.index}/${stage.total} ${stageLabel(stage.step)}` :
            stageLabel(stage.step));
    }
    const amount = job.progress ? formatProgressAmount(job.progress) : '';
    if (amount) parts.push(amount);
    return parts.join(' · ') || job.status;
};

export { runCard, runControls, runKey, runPollDetail };
export type { Run, RunAction, RunState };

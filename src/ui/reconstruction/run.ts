import {
    formatProgressAmount, pullLayersDone, pullTitle, stageLabel, type ProgressVisual
} from './progress';
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
    runName: string;
    submitKey: string | null;
    datasetLabel: string;
    /** What the user calls this run. Display only; runName owns where its output lands. */
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

/** What to call a run on screen: the user's name, else the directory it writes to. */
const runTitle = (run: Run): string => run.label || run.runName || run.preset;

/**
 * The shared progress card for a run nothing is streaming. One card serves every run.
 */
const runCard = (run: Run): [string, string, ProgressVisual] => {
    const name = runTitle(run);
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

/** A row gets one line for the box: its image pull once that reports, else its state. */
const gpuDetail = (gpu: JobGpu): string => {
    const pull = gpu.pull;
    if (!pull) return GPU_TEXT[gpu.state];
    if (pull.phase === 'error' || pull.phase === 'loaded') return pullTitle(pull);
    return pull.layers_total ?
        `${pullTitle(pull)} ${pullLayersDone(pull)}/${pull.layers_total}` :
        `${pullTitle(pull)} (${pull.layers_done} layer)`;
};

/** What a row's detail is built from: a polled JobStatus, or a stream's running state. */
type RunDetailSource = Pick<JobStatus, 'status' | 'gpu' | 'current_stage' | 'progress'>;

/**
 * The row detail for a run, rebuilt on every event its stream delivers.
 */
const jobDetail = (job: RunDetailSource): string => {
    const parts: string[] = [];
    if (job.gpu) parts.push(gpuDetail(job.gpu));
    const stage = job.current_stage;
    if (stage) {
        parts.push(stage.total > 0 ?
            `${stage.index}/${stage.total} ${stageLabel(stage.step)}` :
            stageLabel(stage.step));
    }
    // A progress event outlives the stage that emitted it; pairing them keeps the last
    // count of a finished stage off the next one's row.
    const amount = job.progress && (!stage || job.progress.stage === stage.step) ?
        formatProgressAmount(job.progress) : '';
    if (amount) parts.push(amount);
    return parts.join(' · ') || job.status;
};

export { jobDetail, runCard, runControls, runKey, runTitle };
export type { Run, RunAction, RunDetailSource, RunState };

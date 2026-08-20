import type {
    JobHeartbeatEvent,
    JobProgressEvent,
    JobPullProgress,
    StageEvent
} from './types';
import { formatBytes } from './utils';

type ProgressVisual =
    | { mode: 'idle'; center?: string }
    | { mode: 'determinate'; value: number; center?: string }
    | { mode: 'indeterminate'; center?: string }
    | { mode: 'done'; center?: string }
    | { mode: 'failed'; center?: string }
    | { mode: 'reconnecting'; center?: string };

const STAGE_LABELS: Record<string, string> = {
    prepare_data: 'Preparing dataset',
    downscale: 'Preparing images',
    check_gps: 'Checking camera locations',
    check_matching_vram: 'Checking GPU memory',
    feature_extraction: 'Finding image features',
    matching: 'Matching photos',
    global_mapper: 'Building camera map',
    sor_filter: 'Cleaning sparse points',
    geo_register: 'Aligning coordinates',
    training: 'Training Gaussian splat',
    clean: 'Optimizing Gaussian splat',
    derive_crs: 'Preparing map coordinates',
    orthophoto: 'Rendering orthophoto',
    densify: 'Building dense point cloud',
    mesh: 'Building mesh',
    refine: 'Refining mesh',
    texture: 'Texturing model',
    copc: 'Preparing point cloud',
    dsm: 'Building elevation map',
    publish_results: 'Uploading results'
};

const PULL_PHASE: Record<JobPullProgress['phase'], string> = {
    'waiting': 'đang chờ',
    'pulling fs layer': 'bắt đầu',
    'downloading': 'đang tải',
    'verifying checksum': 'đang kiểm tra',
    'download complete': 'tải xong',
    'extracting': 'đang giải nén',
    'pull complete': 'xong',
    'loaded': 'xong',
    'error': 'lỗi'
};

/** What a box's image pull is called. The card and the run row must agree on this. */
const pullTitle = (pull: JobPullProgress): string => {
    if (pull.phase === 'error') return 'Tải image lỗi';
    if (pull.phase === 'loaded') return 'Đã tải xong image';
    return 'Đang tải image';
};

/**
 * Layers finished. A pass reads a 2-3 line tail, so a layer finishing between passes is
 * missed: the count is a floor, and clamping keeps a stale total from reading over 100%.
 */
const pullLayersDone = (pull: JobPullProgress): number => (
    pull.layers_total ? Math.min(pull.layers_done, pull.layers_total) : pull.layers_done
);

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

const stageLabel = (step: string) => (
    STAGE_LABELS[step] ??
    step.replace(/[_-]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase())
);

const formatElapsed = (elapsedMs: number) => {
    const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
};

const formatQuantity = (value: number) => value.toLocaleString(undefined, {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 1
});

const isByteUnit = (unit: string | null) => /^(?:b|byte|bytes)$/i.test(unit || '');

const formatProgressAmount = (progress: JobProgressEvent) => {
    if (progress.current === null || progress.total === null) return '';
    if (progress.unit === 'percent') return `${formatQuantity(progress.current)}%`;
    if (isByteUnit(progress.unit)) {
        return `${formatBytes(progress.current)} / ${formatBytes(progress.total)}`;
    }
    const amount = `${formatQuantity(progress.current)} / ${formatQuantity(progress.total)}`;
    return progress.unit ? `${amount} ${progress.unit}` : amount;
};

const formatProgressRate = (progress: JobProgressEvent) => {
    if (progress.rate == null || progress.rate <= 0) return '';
    if (isByteUnit(progress.unit)) return `${formatBytes(progress.rate)}/s`;
    const unit = progress.unit === 'percent' ? '%' : progress.unit;
    return `${formatQuantity(progress.rate)}${unit ? ` ${unit}` : ''}/s`;
};

const formatEta = (seconds: number | null | undefined) => {
    if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '';
    if (seconds === 0) return '';
    // Rounded before it is split, or a remainder rounding up to 60 reads as "1m 60s".
    const whole = Math.max(1, Math.ceil(seconds));
    if (whole < 60) return `~${whole}s left`;
    const minutes = Math.floor(whole / 60);
    if (minutes < 60) return `~${minutes}m ${whole % 60}s left`;
    return `~${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
};

const progressPhaseLabel = (progress: JobProgressEvent) => {
    const value = progress.message || progress.phase || '';
    return value.replace(/[_-]+/g, ' ').replace(/^\w/, character => character.toUpperCase());
};

const progressFile = (progress: JobProgressEvent) => {
    const path = progress.file?.trim();
    if (!path) return null;

    const name = path.split(/[\\/]/).pop() || path;
    const validIndex = progress.file_index != null &&
        Number.isFinite(progress.file_index) &&
        progress.file_index > 0;
    const validTotal = progress.file_total != null &&
        Number.isFinite(progress.file_total) &&
        progress.file_total > 0;
    const position = validIndex && validTotal ?
        `File ${progress.file_index} of ${progress.file_total}` :
        '';

    const hasFileProgress = progress.file_loaded != null &&
        progress.file_size != null &&
        Number.isFinite(progress.file_loaded) &&
        Number.isFinite(progress.file_size) &&
        progress.file_size > 0;
    const accessible = [
        `Current file: ${path}`,
        position,
        hasFileProgress ?
            `File progress: ${formatBytes(progress.file_loaded!)} of ${formatBytes(progress.file_size!)}` :
            ''
    ].filter(Boolean).join('. ');

    return {
        path,
        visual: [name, position].filter(Boolean).join(' · '),
        accessible
    };
};

class ReconstructionProgress {
    private readonly card: HTMLElement;
    private readonly ring: HTMLElement;
    private readonly valueCircle: SVGCircleElement;
    private readonly center: HTMLElement;
    private readonly status: HTMLElement;
    private readonly detail: HTMLElement;
    private readonly workerStatus: HTMLElement;
    private readonly workerStatusText: HTMLElement;
    private stage: StageEvent | null = null;
    private stageProgress: JobProgressEvent | null = null;
    private stageStartedAt = 0;
    private stageTimer: number | null = null;
    private notice = '';
    private noticeUntil = 0;

    constructor(root: HTMLElement) {
        this.card = root.querySelector('.recon-progress-card') as HTMLElement;
        this.ring = root.querySelector('.recon-progress-ring') as HTMLElement;
        this.valueCircle = root.querySelector('.recon-progress-value') as SVGCircleElement;
        this.center = root.querySelector('.recon-progress-center') as HTMLElement;
        this.status = root.querySelector('.recon-status') as HTMLElement;
        this.detail = root.querySelector('.recon-status-detail') as HTMLElement;
        this.workerStatus = root.querySelector('.recon-worker-status') as HTMLElement;
        this.workerStatusText = root.querySelector('.recon-worker-status span') as HTMLElement;
    }

    set(title: string, detail: string, visual: ProgressVisual = { mode: 'idle' }) {
        this.stopStageTimer();
        this.stage = null;
        this.stageProgress = null;
        this.notice = '';
        this.status.textContent = title;
        this.setDetail(detail);

        const value = visual.mode === 'determinate' ?
            clampPercent(visual.value) :
            visual.mode === 'done' ? 100 : 0;
        this.setRingValue(value);
        this.center.textContent = visual.center ?? (
            visual.mode === 'determinate' || visual.mode === 'done' ? `${Math.round(value)}%` :
                visual.mode === 'failed' ? '!' :
                    visual.mode === 'idle' ? '—' : '•••'
        );

        this.card.dataset.mode = visual.mode;
        this.ring.setAttribute('aria-label', title);
        this.ring.setAttribute('aria-valuemin', '0');
        this.ring.setAttribute('aria-valuemax', '100');
        if (visual.mode === 'determinate' || visual.mode === 'done') {
            this.ring.setAttribute('aria-valuenow', String(Math.round(value)));
            this.ring.removeAttribute('aria-valuetext');
        } else {
            this.ring.removeAttribute('aria-valuenow');
            this.ring.setAttribute('aria-valuetext', detail);
        }
    }

    setStage(stage: StageEvent) {
        const changedStage = this.stage?.step !== stage.step || this.stage?.index !== stage.index;
        this.stage = stage;
        this.notice = '';
        if (stage.phase === 'start') {
            if (changedStage) this.stageProgress = null;
            if (changedStage || this.stageStartedAt === 0) this.stageStartedAt = Date.now();
            this.renderActiveStage();
            if (this.stageTimer === null) {
                this.stageTimer = window.setInterval(() => this.renderActiveStage(), 1000);
            }
        } else {
            this.stopStageTimer();
            this.stageProgress = null;
            const total = Math.max(1, stage.total);
            this.status.textContent = `Completed: ${stageLabel(stage.step)}`;
            this.setDetail(`Stage ${stage.index} of ${stage.total} complete.`);
            this.center.textContent = `${stage.index}/${stage.total}`;
            this.setRingValue((stage.index / total) * 100);
            this.card.dataset.mode = stage.returncode === 0 ? 'stage-complete' : 'failed';
            this.setStageAria(stage, stage.index);
        }
    }

    setStageProgress(progress: JobProgressEvent) {
        if (this.stage && progress.stage !== this.stage.step) return;
        this.stageProgress = progress;
        if (progress.mode === 'determinate' && progress.current !== null && progress.total) {
            this.renderDeterminateProgress(progress);
        } else {
            this.renderActiveStage();
        }
    }

    setWorkerStatus(heartbeat: JobHeartbeatEvent | null) {
        if (!heartbeat) {
            this.workerStatus.hidden = true;
            this.workerStatus.removeAttribute('data-state');
            this.workerStatus.removeAttribute('title');
            return;
        }
        this.workerStatus.hidden = false;
        this.workerStatus.dataset.state = heartbeat.worker_alive ? 'online' : 'offline';
        this.workerStatusText.textContent = heartbeat.worker_alive ?
            'GPU connected' :
            'GPU connection interrupted';
        if (heartbeat.heartbeat_at) {
            const observed = new Date(heartbeat.heartbeat_at);
            if (!Number.isNaN(observed.getTime())) {
                this.workerStatus.title = `Last GPU heartbeat: ${observed.toLocaleString()}`;
            }
        } else {
            this.workerStatus.removeAttribute('title');
        }
    }

    showNotice(message: string, durationMs = 5000) {
        this.notice = message;
        this.noticeUntil = Date.now() + durationMs;
        this.setDetail(message);
    }

    destroy() {
        this.stopStageTimer();
    }

    private renderActiveStage() {
        if (!this.stage || this.stage.phase !== 'start') return;
        if (this.stageProgress?.mode === 'determinate' &&
            this.stageProgress.current !== null &&
            this.stageProgress.total) {
            this.renderDeterminateProgress(this.stageProgress);
            return;
        }
        const total = Math.max(1, this.stage.total);
        const completed = Math.max(0, this.stage.index - 1);
        this.status.textContent = stageLabel(this.stage.step);
        if (this.notice && Date.now() >= this.noticeUntil) this.notice = '';
        const elapsed = formatElapsed(Date.now() - this.stageStartedAt);
        const phase = this.stageProgress ? progressPhaseLabel(this.stageProgress) : '';
        const file = this.stageProgress ? progressFile(this.stageProgress) : null;
        const detail = [
            this.notice,
            phase,
            file?.visual,
            `Stage ${this.stage.index} of ${this.stage.total}`,
            `active for ${elapsed}`
        ].filter(Boolean).join(' · ');
        const accessibleDetail = [
            this.notice,
            phase,
            file?.accessible,
            `Stage ${this.stage.index} of ${this.stage.total}`,
            `active for ${elapsed}`
        ].filter(Boolean).join(' · ');
        this.setDetail(detail, accessibleDetail, file?.path);
        this.center.textContent = `${this.stage.index}/${this.stage.total}`;
        this.setRingValue((completed / total) * 100);
        this.card.dataset.mode = 'stage';
        this.setStageAria(this.stage, completed);
    }

    private renderDeterminateProgress(progress: JobProgressEvent) {
        const stagePercent = clampPercent((progress.current! / progress.total!) * 100);
        const phase = progressPhaseLabel(progress);
        const file = progressFile(progress);
        const detail = [
            this.notice && Date.now() < this.noticeUntil ? this.notice : '',
            phase,
            file?.visual,
            this.stage ? `Stage ${this.stage.index} of ${this.stage.total}` : '',
            formatProgressAmount(progress),
            formatProgressRate(progress),
            formatEta(progress.eta_seconds)
        ].filter(Boolean).join(' · ');
        const accessibleDetail = [
            this.notice && Date.now() < this.noticeUntil ? this.notice : '',
            phase,
            file?.accessible,
            this.stage ? `Stage ${this.stage.index} of ${this.stage.total}` : '',
            formatProgressAmount(progress),
            formatProgressRate(progress),
            formatEta(progress.eta_seconds)
        ].filter(Boolean).join(' · ');

        this.status.textContent = stageLabel(progress.stage);
        if (this.notice && Date.now() >= this.noticeUntil) this.notice = '';
        this.setDetail(detail, accessibleDetail, file?.path);
        this.center.textContent = `${Math.round(stagePercent)}%`;
        this.setRingValue(stagePercent);
        this.card.dataset.mode = 'determinate';
        this.ring.setAttribute('aria-label', stageLabel(progress.stage));
        this.ring.setAttribute('aria-valuemin', '0');
        this.ring.setAttribute('aria-valuemax', '100');
        this.ring.setAttribute('aria-valuenow', String(Math.round(stagePercent)));
        this.ring.setAttribute(
            'aria-valuetext',
            `${Math.round(stagePercent)}% of current stage. ${accessibleDetail}`
        );
    }

    private setRingValue(percent: number) {
        const value = clampPercent(percent);
        this.valueCircle.style.strokeDashoffset = String(100 - value);
        this.valueCircle.dataset.empty = String(value <= 0);
    }

    private setStageAria(stage: StageEvent, completed: number) {
        this.ring.setAttribute('aria-label', stageLabel(stage.step));
        this.ring.setAttribute('aria-valuemin', '0');
        this.ring.setAttribute('aria-valuemax', String(Math.max(1, stage.total)));
        this.ring.setAttribute('aria-valuenow', String(completed));
        this.ring.setAttribute(
            'aria-valuetext',
            `Stage ${stage.index} of ${stage.total}: ${stageLabel(stage.step)}`
        );
    }

    private setDetail(text: string, accessibleText = text, title?: string) {
        this.detail.textContent = text;
        if (title) {
            this.detail.title = title;
        } else {
            this.detail.removeAttribute('title');
        }
        if (accessibleText !== text) {
            this.detail.setAttribute('aria-label', accessibleText);
        } else {
            this.detail.removeAttribute('aria-label');
        }
    }

    private stopStageTimer() {
        if (this.stageTimer !== null) {
            window.clearInterval(this.stageTimer);
            this.stageTimer = null;
        }
    }
}

/** How long a finished or failed transfer stays on screen before the strip folds away. */
const SETTLED_LINGER_MS = 4_000;
const FAILED_LINGER_MS = 20_000;

/**
 * Artifact transfers, on their own strip below the card.
 */
class TransferProgress {
    private readonly root: HTMLElement;
    private readonly title: HTMLElement;
    private readonly track: HTMLElement;
    private readonly bar: HTMLElement;
    private readonly detail: HTMLElement;
    private timer: number | null = null;

    constructor(root: HTMLElement) {
        this.root = root.querySelector('.recon-transfer') as HTMLElement;
        this.title = root.querySelector('.recon-transfer-title') as HTMLElement;
        this.track = root.querySelector('.recon-transfer-bar') as HTMLElement;
        this.bar = root.querySelector('.recon-transfer-bar i') as HTMLElement;
        this.detail = root.querySelector('.recon-transfer-detail') as HTMLElement;
    }

    set(title: string, detail: string, visual: ProgressVisual = { mode: 'indeterminate' }) {
        this.clearTimer();
        this.root.hidden = false;
        this.root.dataset.mode = visual.mode;
        this.title.textContent = title;
        this.detail.textContent = detail;

        const determinate = visual.mode === 'determinate';
        const value = determinate ? clampPercent(visual.value) :
            visual.mode === 'done' || visual.mode === 'failed' ? 100 : 0;
        this.bar.style.width = `${value}%`;
        this.track.setAttribute('aria-label', title);
        if (determinate) {
            this.track.setAttribute('aria-valuenow', String(Math.round(value)));
            this.track.removeAttribute('aria-valuetext');
        } else {
            this.track.removeAttribute('aria-valuenow');
            this.track.setAttribute('aria-valuetext', detail);
        }

        if (visual.mode === 'done' || visual.mode === 'idle') this.hideIn(SETTLED_LINGER_MS);
        if (visual.mode === 'failed') this.hideIn(FAILED_LINGER_MS);
    }

    hide() {
        this.clearTimer();
        this.root.hidden = true;
    }

    private hideIn(delayMs: number) {
        this.timer = window.setTimeout(() => {
            this.timer = null;
            this.root.hidden = true;
        }, delayMs);
    }

    private clearTimer() {
        if (this.timer === null) return;
        window.clearTimeout(this.timer);
        this.timer = null;
    }
}

export {
    PULL_PHASE, ReconstructionProgress, TransferProgress, formatProgressAmount,
    pullLayersDone, pullTitle, stageLabel
};
export type { ProgressVisual };

import { StageEvent } from './reconstruction-types';

type ProgressVisual =
    | { mode: 'idle'; center?: string }
    | { mode: 'determinate'; value: number; center?: string }
    | { mode: 'indeterminate'; center?: string }
    | { mode: 'done'; center?: string }
    | { mode: 'failed'; center?: string }
    | { mode: 'reconnecting'; center?: string };

const STAGE_LABELS: Record<string, string> = {
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
    mesh: 'Building mesh'
};

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

class ReconstructionProgress {
    private readonly card: HTMLElement;
    private readonly ring: HTMLElement;
    private readonly valueCircle: SVGCircleElement;
    private readonly center: HTMLElement;
    private readonly status: HTMLElement;
    private readonly detail: HTMLElement;
    private stage: StageEvent | null = null;
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
    }

    set(title: string, detail: string, visual: ProgressVisual = { mode: 'idle' }) {
        this.stopStageTimer();
        this.stage = null;
        this.notice = '';
        this.status.textContent = title;
        this.detail.textContent = detail;

        const value = visual.mode === 'determinate' ?
            clampPercent(visual.value) :
            visual.mode === 'done' ? 100 : 0;
        this.valueCircle.style.strokeDashoffset = String(100 - value);
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
            if (changedStage || this.stageStartedAt === 0) this.stageStartedAt = Date.now();
            this.renderActiveStage();
            if (this.stageTimer === null) {
                this.stageTimer = window.setInterval(() => this.renderActiveStage(), 1000);
            }
        } else {
            this.stopStageTimer();
            const total = Math.max(1, stage.total);
            this.status.textContent = `Completed: ${stageLabel(stage.step)}`;
            this.detail.textContent = `Stage ${stage.index} of ${stage.total} complete.`;
            this.center.textContent = `${stage.index}/${stage.total}`;
            this.valueCircle.style.strokeDashoffset = String(100 - clampPercent((stage.index / total) * 100));
            this.card.dataset.mode = stage.returncode === 0 ? 'stage-complete' : 'failed';
            this.setStageAria(stage, stage.index);
        }
    }

    showNotice(message: string, durationMs = 5000) {
        this.notice = message;
        this.noticeUntil = Date.now() + durationMs;
        this.detail.textContent = message;
    }

    destroy() {
        this.stopStageTimer();
    }

    private renderActiveStage() {
        if (!this.stage || this.stage.phase !== 'start') return;
        const total = Math.max(1, this.stage.total);
        const completed = Math.max(0, this.stage.index - 1);
        this.status.textContent = stageLabel(this.stage.step);
        if (!this.notice || Date.now() >= this.noticeUntil) {
            this.notice = '';
            const elapsed = formatElapsed(Date.now() - this.stageStartedAt);
            this.detail.textContent =
                `Stage ${this.stage.index} of ${this.stage.total} · active for ${elapsed}`;
        }
        this.center.textContent = `${this.stage.index}/${this.stage.total}`;
        this.valueCircle.style.strokeDashoffset = String(100 - clampPercent((completed / total) * 100));
        this.card.dataset.mode = 'stage';
        this.setStageAria(this.stage, completed);
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

    private stopStageTimer() {
        if (this.stageTimer !== null) {
            window.clearInterval(this.stageTimer);
            this.stageTimer = null;
        }
    }
}

export {
    ProgressVisual,
    ReconstructionProgress
};

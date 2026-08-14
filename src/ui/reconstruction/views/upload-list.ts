import { runControls, runTitle, type Run, type RunAction, type RunState } from '../run';
import { formatEtaShort, formatRate, type TransferRate } from '../upload-rate';

type RunHandlers = {
    onSelect(id: string): void;
    onAction(id: string, action: RunAction): void;
    hasFolder(id: string): boolean;
};

const RUN_ACTION_UI: Record<RunAction, {
    label: string; title: string; wide?: boolean; danger?: boolean;
}> = {
    pause: { label: '❚❚', title: 'Tạm dừng tải lên' },
    resume: { label: '▶', title: 'Tiếp tục tải lên' },
    repick: { label: 'Chọn lại thư mục', title: 'Chọn lại đúng thư mục cũ để tải tiếp', wide: true },
    cancel: { label: '✕', title: 'Huỷ luồng và xoá ảnh đã tải lên', danger: true },
    dismiss: { label: '✕', title: 'Bỏ luồng khỏi danh sách', danger: true },
    open: { label: 'Mở', title: 'Mở model', wide: true },
    retry: { label: 'Thử lại', title: 'Chạy lại luồng', wide: true }
};

const RUN_STATE_TEXT: Record<RunState, string> = {
    queued: 'Đang chờ tải',
    uploading: 'Đang tải lên',
    paused: 'Đã tạm dừng',
    quoting: 'Đang báo giá',
    'waiting-slot': 'Đang chờ lượt',
    running: 'Đang chạy',
    done: 'Hoàn tất',
    cancelled: 'Đã huỷ',
    failed: 'Thất bại'
};

const RUN_MARK: Partial<Record<RunState, string>> = {
    uploading: '↑',
    paused: '❚❚',
    done: '✓',
    cancelled: '✕',
    failed: '!'
};

/** Rows whose bar means something: the others have no fraction to show. */
const BAR_STATES = new Set<RunState>(['queued', 'uploading', 'paused']);

/** Rows a byte rate belongs to. Outside these the meter is stale, so it is cleared. */
const RATE_STATES = new Set<RunState>(['uploading']);

const runDetail = (run: Run): string => (
    [run.percent > 0 && run.percent < 100 ? `${Math.round(run.percent)}%` : '', run.detail]
    .filter(Boolean).join(' · '));

/** The nodes of one row that change without the row being rebuilt. */
type RowNodes = {
    row: HTMLElement;
    signature: string;
    bar: HTMLElement | null;
    percent: HTMLElement;
    detail: HTMLElement;
    rate: HTMLElement;
    eta: HTMLElement;
};

/** Everything a row's structure depends on; anything else is patched into the nodes. */
const signatureOf = (run: Run, selected: boolean, controls: RunAction[]): string => [
    run.state, run.pipeline, runTitle(run), selected, controls.join(',')
].join('|');

/**
 * The list of runs, one row each, with the bytes-per-second and eta of whichever row is streaming.
 */
class UploadList {
    readonly root: HTMLElement;
    readonly note: HTMLElement;
    readonly list: HTMLElement;
    readonly newRunButton: HTMLButtonElement;
    private rows = new Map<string, RowNodes>();
    private rates = new Map<string, TransferRate>();
    private handlers: RunHandlers | null = null;

    constructor(host: HTMLElement) {
        const root = document.createElement('section');
        root.className = 'recon-runs';
        root.setAttribute('aria-label', 'Luồng của bạn');
        root.hidden = true;
        root.innerHTML = `
            <div class="recon-section-heading">
                <strong>Luồng của bạn</strong>
                <span class="recon-runs-note"></span>
                <button class="recon-button recon-primary recon-new-run" type="button"
                        title="Bắt đầu một luồng mới với dataset và pipeline khác">＋ Luồng mới</button>
            </div>
            <div class="recon-run-list"></div>`;
        host.appendChild(root);

        this.root = root;
        this.note = root.querySelector('.recon-runs-note');
        this.list = root.querySelector('.recon-run-list');
        this.newRunButton = root.querySelector('.recon-new-run');
    }

    render(runs: Run[], selectedId: string | null, cap: number | null, handlers: RunHandlers) {
        this.handlers = handlers;
        for (const id of Array.from(this.rates.keys())) {
            if (!runs.some(run => run.id === id && RATE_STATES.has(run.state))) {
                this.rates.delete(id);
            }
        }

        const previous = this.rows;
        this.rows = new Map();
        const wanted: HTMLElement[] = [];
        for (const run of runs) {
            const controls = runControls(run, handlers.hasFolder(run.id));
            const signature = signatureOf(run, run.id === selectedId, controls);
            const existing = previous.get(run.id);
            const nodes = existing?.signature === signature ?
                existing :
                this.row(run, run.id === selectedId, controls, signature);
            this.paint(nodes, run);
            this.rows.set(run.id, nodes);
            wanted.push(nodes.row);
        }
        const ordered = wanted.length === this.list.childElementCount &&
            wanted.every((node, index) => this.list.children[index] === node);
        if (!ordered) this.list.replaceChildren(...wanted);

        const running = runs.filter(run => run.state === 'running').length;
        const parked = runs.some(run => run.state === 'waiting-slot');
        this.note.textContent = parked && cap !== null ?
            `Gói đăng ký hiện tại chỉ cho phép ${cap} luồng cùng lúc` :
            running > 0 ? `${running} luồng đang chạy` : '';
        this.root.hidden = runs.length === 0;
    }

    /** Write one progress tick into a row that is already on screen. */
    setTransfer(runId: string, rate: TransferRate) {
        this.rates.set(runId, rate);
        const nodes = this.rows.get(runId);
        if (!nodes) return;
        this.paintRate(nodes, rate);
        if (nodes.bar && rate.total > 0) {
            nodes.bar.style.width = `${Math.min(100, (rate.loaded / rate.total) * 100)}%`;
        }
    }

    private paintRate(nodes: RowNodes, rate: TransferRate | undefined) {
        nodes.rate.textContent = rate ? formatRate(rate.bytesPerSecond) : '';
        nodes.eta.textContent = rate ? formatEtaShort(rate.etaSeconds) : '';
    }

    /** Everything outside the row's signature: the values that move while it stays put. */
    private paint(nodes: RowNodes, run: Run) {
        const barred = BAR_STATES.has(run.state);
        nodes.detail.textContent = runDetail(run);
        nodes.percent.textContent = barred ? `${Math.round(run.percent)}%` : '';
        if (nodes.bar) nodes.bar.style.width = `${Math.min(100, Math.max(0, run.percent))}%`;
        this.paintRate(nodes, RATE_STATES.has(run.state) ? this.rates.get(run.id) : undefined);
    }

    private row(run: Run, selected: boolean, controls: RunAction[],
        signature: string): RowNodes {
        const row = document.createElement('div');
        row.className = 'recon-run-row';
        row.dataset.state = run.state;
        row.classList.toggle('active', selected);

        const mark = document.createElement('span');
        mark.className = 'recon-run-mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = RUN_MARK[run.state] ?? '•';

        const select = document.createElement('button');
        select.type = 'button';
        select.className = 'recon-run-select';
        select.setAttribute('aria-pressed', String(selected));
        select.addEventListener('click', () => this.handlers?.onSelect(run.id));

        const top = document.createElement('span');
        top.className = 'recon-run-top';
        const name = document.createElement('span');
        name.className = 'recon-run-name';
        name.textContent = runTitle(run);
        name.title = `Luồng ${run.runName || run.preset}`;
        const chip = document.createElement('span');
        chip.className = 'recon-run-chip';
        chip.textContent = run.pipeline === 'splat' ? '3DGS' : 'MESH';
        top.append(name, chip);

        const meta = document.createElement('span');
        meta.className = 'recon-run-meta';
        const state = document.createElement('span');
        state.className = 'recon-run-state';
        state.dataset.state = run.state;
        state.textContent = RUN_STATE_TEXT[run.state];
        const detail = document.createElement('span');
        detail.className = 'recon-run-detail';
        meta.append(state, detail);
        select.append(top, meta);

        let bar: HTMLElement | null = null;
        if (BAR_STATES.has(run.state)) {
            const track = document.createElement('span');
            track.className = 'recon-run-bar';
            bar = document.createElement('i');
            track.append(bar);
            select.append(track);
        }

        const stats = document.createElement('span');
        stats.className = 'recon-run-stats';
        const percent = document.createElement('span');
        percent.className = 'recon-run-percent';
        const rate = document.createElement('span');
        rate.className = 'recon-run-rate';
        const eta = document.createElement('span');
        eta.className = 'recon-run-eta';
        stats.append(percent, rate, eta);

        row.append(mark, select, stats);

        if (controls.length > 0) {
            const actions = document.createElement('div');
            actions.className = 'recon-run-actions';
            for (const action of controls) {
                const ui = RUN_ACTION_UI[action];
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `recon-button ${ui.wide ?
                    'recon-run-text-action' : 'recon-run-action'}`;
                if (ui.danger) button.classList.add('recon-run-danger');
                button.textContent = ui.label;
                button.title = ui.title;
                button.setAttribute('aria-label', ui.title);
                button.addEventListener('click',
                    () => this.handlers?.onAction(run.id, action));
                actions.append(button);
            }
            row.append(actions);
        }

        return { row, signature, bar, percent, detail, rate, eta };
    }
}

export { UploadList };
export type { RunHandlers };

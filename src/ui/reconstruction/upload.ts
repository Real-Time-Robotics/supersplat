import { Client, type UploadOptions, type Uploadable } from 'genesis-recon';

import { describeFailure } from './failure';
import { reconFetch } from './http';
import type { ProgressVisual } from './progress';
import { Transfer } from './transfer';
import type { UploadProgress } from './types';
import { RateMeter, formatRate, type TransferRate } from './upload-rate';
import { UploadRecords, type UploadRecord } from './upload-records';
import { delay, formatBytes, formatDuration, readJson } from './utils';

const gp = new Client(`${location.origin}/api/gp`, 'session-cookie', { fetch: reconFetch });

type Named = { name: string; data: File };

type TransferHooks = {
    onSession?: (record: UploadRecord) => void;
    onPercent?: (percent: number) => void;
    onCard?: (title: string, detail: string, visual: ProgressVisual) => void;
    /** Every tick, not just whole-percent ones: the run row renders speed and eta from it. */
    onRate?: (rate: TransferRate) => void;
};

class UploadPaused extends Error {
    constructor(readonly datasetId: string) {
        super('Đã tạm dừng tải lên.');
        this.name = 'UploadPaused';
    }
}

/** The two store calls, injectable so the keyed bookkeeping can be tested without a network. */
type UploadDeps = {
    createDatasetSession(): Promise<string>;
    uploadDataset(files: Uploadable[], opts: UploadOptions): Promise<string>;
};

class ReconstructionUpload {
    private readonly records = new UploadRecords();
    private readonly rates = new Map<string, RateMeter>();
    private readonly transfers = new Map<string, Transfer>();
    private readonly deps: UploadDeps;

    constructor(deps: UploadDeps = {
        createDatasetSession: () => gp.createDatasetSession(),
        uploadDataset: (files, opts) => gp.uploadDataset(files, opts)
    }) {
        this.deps = deps;
    }

    pause(key: string) {
        this.transfers.get(key)?.pause();
    }

    /** Session teardown: stop every stream, keeping whatever the store already accepted. */
    pauseAll() {
        for (const transfer of this.transfers.values()) transfer.pause();
    }

    get active(): number {
        return this.transfers.size;
    }

    isTransferring(key: string): boolean {
        return this.transfers.has(key);
    }

    async discard(datasetId: string): Promise<void> {
        const response = await reconFetch(
            `/api/reconstruction/datasets/${encodeURIComponent(datasetId)}`, { method: 'DELETE' });
        if (!response.ok) await readJson(response);
        await this.records.remove(datasetId);
    }

    async openSessions(): Promise<UploadRecord[]> {
        const sessions = await gp.listOpenSessions();
        return this.records.reconcile(sessions.map(session => session.dataset_id));
    }

    async start(key: string, named: Named[], fingerprint: string, pipeline: string,
        preset: string, label: string, hooks: TransferHooks = {}): Promise<string> {
        const datasetId = await this.deps.createDatasetSession();
        const record: UploadRecord = {
            datasetId,
            label,
            pipeline,
            preset,
            fingerprint,
            names: named.map(f => f.name),
            totalBytes: named.reduce((sum, f) => sum + f.data.size, 0)
        };
        await this.records.put(record);
        hooks.onSession?.(record);
        return this.drive(key, named, record, hooks);
    }

    resume(key: string, record: UploadRecord, named: Named[],
        hooks: TransferHooks = {}): Promise<string> {
        const byName = new Map(named.map(file => [file.name, file.data]));
        const missing = record.names.filter(name => !byName.has(name));
        if (missing.length > 0) {
            throw new Error(`Thư mục vừa chọn thiếu ${missing.length.toLocaleString()} / ` +
                `${record.names.length.toLocaleString()} ảnh của phiên tải lên này.`);
        }
        return this.drive(key, record.names.map(name => ({ name, data: byName.get(name) })),
            record, hooks);
    }

    private async drive(key: string, named: Named[], record: UploadRecord,
        hooks: TransferHooks): Promise<string> {
        const transfer = new Transfer(named, record, {
            uploadDataset: (files, opts) => this.deps.uploadDataset(files, opts),
            sleep: delay
        });
        this.transfers.set(key, transfer);
        try {
            const outcome = await transfer.run(
                progress => this.updateStorageProgress(key, progress, hooks));
            if (outcome.state === 'done') {
                await this.records.remove(record.datasetId);
                return record.datasetId;
            }
            if (outcome.state === 'paused') throw new UploadPaused(record.datasetId);
            const described = describeFailure(outcome.error);
            hooks.onCard?.(described.title, described.detail, { mode: 'failed' });
            throw outcome.error;
        } finally {
            // In a finally so a throw cannot leave the slot claimed forever, which would
            // wedge the queue behind a run that is no longer moving.
            this.transfers.delete(key);
            this.rates.delete(key);
        }
    }

    private transferDetail(key: string, loaded: number, total: number,
        suffix = ''): [string, TransferRate] {
        let meter = this.rates.get(key);
        if (!meter) {
            meter = new RateMeter();
            this.rates.set(key, meter);
        }
        const rate = meter.sample(key, loaded, total);
        const transferred = total > 0 ?
            `${formatBytes(loaded)} / ${formatBytes(total)}` :
            formatBytes(loaded);
        const eta = total > 0 ? ` · ${formatDuration(rate.etaSeconds)}` : '';
        const estimate = rate.bytesPerSecond > 0 ?
            ` · ${formatRate(rate.bytesPerSecond)}${eta}` :
            ' · estimating…';
        return [transferred + estimate + suffix, rate];
    }

    private updateStorageProgress(key: string, progress: UploadProgress,
        hooks: TransferHooks) {
        if (progress.phase === 'presign') {
            hooks.onCard?.('Đang chuẩn bị kho lưu trữ',
                'Đang tạo URL tải lên an toàn.', { mode: 'indeterminate' });
            return;
        }
        if (progress.phase === 'upload') {
            const ratio = progress.total > 0 ? progress.loaded / progress.total : 0;
            hooks.onPercent?.(ratio * 100);
            const current = progress.file ? ` · ${progress.file}` : '';
            const [detail, rate] = this.transferDetail(
                key, progress.loaded, progress.total, current);
            hooks.onRate?.(rate);
            hooks.onCard?.('Đang tải lên kho lưu trữ', detail,
                { mode: 'determinate', value: ratio * 100 });
            return;
        }
        if (progress.phase === 'finalize') {
            hooks.onCard?.('Đang chốt dataset',
                'Kho lưu trữ đã nhận đủ ảnh.', { mode: 'indeterminate' });
            return;
        }
        hooks.onCard?.('Đang xử lý dataset',
            'Máy chủ đang kiểm tra và lập chỉ mục ảnh.', { mode: 'indeterminate' });
    }
}

export { ReconstructionUpload, UploadPaused, gp };
export type { Named, TransferHooks, UploadDeps };

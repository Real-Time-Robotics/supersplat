import { Client } from 'genesis-recon';

import { describeFailure } from './reconstruction-failure';
import { normalizeObjectName } from './reconstruction-names';
import { Transfer } from './reconstruction-transfer';
import { UploadProgress } from './reconstruction-types';
import { UploadRecords, type UploadRecord } from './reconstruction-upload-records';
import { delay, formatBytes, formatDuration } from './reconstruction-utils';
import { ReconstructionView } from './reconstruction-view';

const gp = new Client(`${location.origin}/api/gp`, 'session-cookie');

/** A transfer the user stopped. The session and its stored objects both survive. */
class UploadPaused extends Error {
    constructor(readonly datasetId: string) {
        super('Đã tạm dừng tải lên.');
        this.name = 'UploadPaused';
    }
}

class ReconstructionUpload {
    private readonly view: ReconstructionView;
    private readonly records = new UploadRecords();
    private transfer: Transfer | null = null;
    private transferKey = '';
    private transferSamples: { time: number; loaded: number }[] = [];

    constructor(view: ReconstructionView) {
        this.view = view;
    }

    pause() {
        this.transfer?.pause();
    }

    /** Sessions the control plane still holds, narrowed to the ones we can resume. */
    async openSessions(): Promise<UploadRecord[]> {
        const sessions = await gp.listOpenSessions();
        return this.records.reconcile(sessions.map(session => session.dataset_id));
    }

    async start(named: { name: string; data: File }[], fingerprint: string,
        pipeline: string, preset: string, label: string): Promise<string> {
        const datasetId = await gp.createDatasetSession();
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
        return this.drive(named, record);
    }

    resume(record: UploadRecord, files: File[]): Promise<string> {
        const byName = new Map(files.map((file, index) => [
            normalizeObjectName((file as File & { webkitRelativePath?: string })
            .webkitRelativePath || file.name, index),
            file
        ]));
        const missing = record.names.filter(name => !byName.has(name));
        if (missing.length > 0) {
            throw new Error(`Thư mục vừa chọn thiếu ${missing.length.toLocaleString()} / ` +
                `${record.names.length.toLocaleString()} ảnh của phiên tải lên này.`);
        }
        const named = record.names.map(name => ({ name, data: byName.get(name) }));
        return this.drive(named, record);
    }

    private async drive(named: { name: string; data: File }[],
        record: UploadRecord): Promise<string> {
        this.transfer = new Transfer(named, record, {
            uploadDataset: (files, opts) => gp.uploadDataset(files, opts),
            sleep: delay
        });
        const outcome = await this.transfer.run(progress => this.updateStorageProgress(progress));
        this.transfer = null;
        if (outcome.state === 'done') {
            await this.records.remove(record.datasetId);
            return record.datasetId;
        }
        if (outcome.state === 'paused') throw new UploadPaused(record.datasetId);
        const described = describeFailure(outcome.error);
        this.view.setState(described.title, described.detail, { mode: 'failed' });
        throw outcome.error;
    }

    private transferDetail(key: string, loaded: number, total: number, suffix = '') {
        const now = performance.now();
        if (this.transferKey !== key) {
            this.transferKey = key;
            this.transferSamples = [{ time: now, loaded }];
        } else {
            this.transferSamples.push({ time: now, loaded });
        }
        while (this.transferSamples.length > 2 && now - this.transferSamples[0].time > 8000) {
            this.transferSamples.shift();
        }
        const first = this.transferSamples[0];
        const elapsed = (now - first.time) / 1000;
        const speed = elapsed >= 0.4 ? (loaded - first.loaded) / elapsed : 0;
        const eta = total > loaded && speed > 0 ? (total - loaded) / speed : 0;
        const transferred = total > 0 ?
            `${formatBytes(loaded)} / ${formatBytes(total)}` :
            formatBytes(loaded);
        const estimate = speed > 0 ?
            ` · ${formatBytes(speed)}/s${total > 0 ? ` · ${formatDuration(eta)}` : ''}` :
            ' · estimating…';
        return transferred + estimate + suffix;
    }

    private updateStorageProgress(progress: UploadProgress) {
        if (progress.phase === 'presign') {
            this.view.setState('Đang chuẩn bị kho lưu trữ',
                'Đang tạo URL tải lên an toàn.', { mode: 'indeterminate' });
            return;
        }
        if (progress.phase === 'upload') {
            const ratio = progress.total > 0 ? progress.loaded / progress.total : 0;
            const current = progress.file ? ` · ${progress.file}` : '';
            this.view.setState('Đang tải lên kho lưu trữ',
                this.transferDetail('object-storage-upload', progress.loaded, progress.total, current),
                { mode: 'determinate', value: ratio * 100 });
            return;
        }
        if (progress.phase === 'finalize') {
            this.view.setState('Đang chốt dataset',
                'Kho lưu trữ đã nhận đủ ảnh.', { mode: 'indeterminate' });
            return;
        }
        this.view.setState('Đang xử lý dataset',
            'Máy chủ đang kiểm tra và lập chỉ mục ảnh.', { mode: 'indeterminate' });
    }
}

export { ReconstructionUpload, UploadPaused };

import { UploadProgress, UploadResponse } from './reconstruction-types';
import { formatBytes, formatDuration } from './reconstruction-utils';
import { ReconstructionView } from './reconstruction-view';

class ReconstructionUpload {
    private activeUpload: XMLHttpRequest | null = null;
    private transferKey = '';
    private transferSamples: { time: number; loaded: number }[] = [];

    constructor(private readonly view: ReconstructionView) {
    }

    cancel() {
        this.activeUpload?.abort();
        this.activeUpload = null;
    }

    run(files: File[], relativePaths: string[]): Promise<UploadResponse> {
        return new Promise((resolve, reject) => {
            const operationId = crypto.randomUUID();
            const source = new EventSource(`/api/reconstruction/uploads/${encodeURIComponent(operationId)}/events`);
            const form = new FormData();
            files.forEach(file => form.append('images', file, file.name));
            form.append('relativePaths', JSON.stringify(relativePaths));
            form.append('label', `SuperSplat ${new Date().toLocaleString('en-US')}`);
            form.append('operationId', operationId);

            source.addEventListener('progress', (event) => {
                this.updateStorageProgress(JSON.parse(event.data) as UploadProgress);
            });
            source.addEventListener('end', () => source.close());
            source.addEventListener('failed', (event) => {
                const data = JSON.parse(event.data) as { message?: string };
                this.view.setState(
                    'Object storage upload failed',
                    data.message || 'The upload could not be completed.',
                    { mode: 'failed' }
                );
                source.close();
            });

            const request = new XMLHttpRequest();
            this.activeUpload = request;
            request.open('POST', '/api/reconstruction/upload');
            request.upload.onprogress = (event) => {
                if (!event.lengthComputable) return;
                this.view.setState('Sending images to localhost',
                    this.transferDetail('browser-upload', event.loaded, event.total),
                    {
                        mode: 'determinate',
                        value: (event.loaded / event.total) * 100
                    });
            };
            request.onerror = () => {
                this.activeUpload = null;
                source.close();
                reject(new Error('Lost connection to the localhost server.'));
            };
            request.onabort = () => {
                this.activeUpload = null;
                source.close();
                reject(new DOMException('Upload cancelled', 'AbortError'));
            };
            request.onload = () => {
                this.activeUpload = null;
                source.close();
                let responseBody: any = {};
                try {
                    responseBody = JSON.parse(request.responseText);
                } catch {
                    // Status handling below supplies a useful fallback.
                }
                if (request.status < 200 || request.status >= 300) {
                    reject(new Error(responseBody.error || `Upload failed (${request.status})`));
                } else {
                    resolve(responseBody as UploadResponse);
                }
            };
            request.send(form);
        });
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
            this.view.setState(
                'Preparing object storage',
                'The server is creating secure upload URLs.',
                { mode: 'indeterminate' }
            );
            return;
        }
        if (progress.phase === 'upload') {
            const ratio = progress.total > 0 ? progress.loaded / progress.total : 0;
            const current = progress.file ? ` · ${progress.file}` : '';
            this.view.setState('Uploading to object storage',
                this.transferDetail('object-storage-upload', progress.loaded, progress.total, current),
                { mode: 'determinate', value: ratio * 100 });
            return;
        }
        if (progress.phase === 'finalize') {
            this.view.setState(
                'Finalizing dataset',
                'Object storage received all images.',
                { mode: 'indeterminate' }
            );
            return;
        }
        this.view.setState(
            'Processing dataset',
            'The server is validating and indexing images.',
            { mode: 'indeterminate' }
        );
    }
}

export { ReconstructionUpload };

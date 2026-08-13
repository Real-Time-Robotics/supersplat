import { reconFetch } from './http';
import type { RecentDataset } from './types';
import { messageOf, readJson } from './utils';
import { ReconstructionView } from './view';
import { Events } from '../../events';

type PopupResult = {
    action: string;
};

class ReconstructionDatasets {
    private readonly deleting = new Set<string>();

    constructor(
        private readonly events: Events,
        private readonly view: ReconstructionView,
        private readonly canStart: () => boolean,
        private readonly onDeleted: (datasetId: string) => Promise<void> | void
    ) {
    }

    async requestDelete(dataset: RecentDataset, trigger: HTMLButtonElement) {
        if (this.deleting.has(dataset.dataset_id)) return;
        const label = dataset.label || dataset.dataset_id;
        const imageCount = Number(dataset.image_count) || 0;
        const result = await this.events.invoke('showPopup', {
            type: 'yesno',
            header: 'Delete reconstruction dataset?',
            message: `Delete “${label}” and all of its source images, reconstruction runs and artifacts?`,
            selectable: true,
            warning: {
                text: `${imageCount.toLocaleString()} source image${imageCount === 1 ? '' : 's'} and every model generated from this dataset will be permanently deleted.`
            }
        }) as PopupResult | undefined;
        if (result?.action !== 'yes') return;

        this.deleting.add(dataset.dataset_id);
        trigger.disabled = true;
        this.view.setBusy(true, false);
        this.view.setState(
            'Deleting dataset',
            `${label} · removing source images, runs and artifacts`,
            { mode: 'indeterminate', center: 'Delete' }
        );

        try {
            const response = await reconFetch(
                `/api/reconstruction/datasets/${encodeURIComponent(dataset.dataset_id)}`,
                { method: 'DELETE' }
            );
            if (!response.ok) {
                if (response.status === 409) {
                    throw new Error('This dataset has a queued or running job. Cancel the job before deleting it.');
                }
                await readJson(response);
            }
            await this.onDeleted(dataset.dataset_id);
            this.view.setState(
                'Dataset deleted',
                `${label} and its reconstruction data were permanently removed.`,
                { mode: 'done' }
            );
        } catch (error) {
            this.view.setState('Could not delete dataset', messageOf(error), { mode: 'failed' });
        } finally {
            this.deleting.delete(dataset.dataset_id);
            trigger.disabled = false;
            this.view.setBusy(false, this.canStart());
        }
    }
}

export { ReconstructionDatasets };

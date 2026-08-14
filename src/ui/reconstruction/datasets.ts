import { reconFetch } from './http';
import type { RecentDataset } from './types';
import { messageOf, readJson } from './utils';
import { ReconstructionView } from './view';
import { Events } from '../../events';

type PopupResult = {
    action: string;
};

type DestructiveAsk = {
    header: string;
    message: string;
    warning?: { text: string };
};

/** A yes/no popup. True only on an explicit yes, dismissing it is a no. */
const confirmDestructive = async (events: Events, ask: DestructiveAsk): Promise<boolean> => {
    const result = await events.invoke('showPopup', {
        type: 'yesno',
        header: ask.header,
        message: ask.message,
        selectable: true,
        warning: ask.warning
    }) as PopupResult | undefined;
    return result?.action === 'yes';
};

const deleteOrThrow = async (route: string, busy: string): Promise<void> => {
    const response = await reconFetch(route, { method: 'DELETE' });
    if (!response.ok) {
        if (response.status === 409) throw new Error(busy);
        await readJson(response);   // the error body says it better than the status does
    }
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
        const confirmed = await confirmDestructive(this.events, {
            header: 'Delete reconstruction dataset?',
            message: `Delete “${label}” and all of its source images, reconstruction runs and artifacts?`,
            warning: {
                text: `${imageCount.toLocaleString()} source image${imageCount === 1 ? '' : 's'} and every model generated from this dataset will be permanently deleted.`
            }
        });
        if (!confirmed) return;

        this.deleting.add(dataset.dataset_id);
        trigger.disabled = true;
        this.view.setBusy(true, false);
        this.view.setState(
            'Deleting dataset',
            `${label} · removing source images, runs and artifacts`,
            { mode: 'indeterminate', center: 'Delete' }
        );

        try {
            await deleteOrThrow(
                `/api/reconstruction/datasets/${encodeURIComponent(dataset.dataset_id)}`,
                'This dataset has a queued or running job. Cancel the job before deleting it.');
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

export { ReconstructionDatasets, confirmDestructive, deleteOrThrow };

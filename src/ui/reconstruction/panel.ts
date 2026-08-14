import { Container } from '@playcanvas/pcui';

import { Events } from '../../events';
import { ShortcutManager } from '../../shortcut-manager';
import { i18n } from '../localization';
import { ReconstructionArtifacts } from './artifacts';
import { ReconstructionAuth } from './auth';
import { ReconstructionBilling } from './billing';
import { ReconstructionView } from './view';
import { ReconstructionWorkflow } from './workflow';

class ReconstructionPanel extends Container {
    constructor(events: Events) {
        super({
            id: 'reconstruction-panel',
            hidden: true
        });

        const view = new ReconstructionView(this.dom);
        i18n.onChange(() => {
            view.title.textContent = i18n.t('panel.reconstruction');
        }, this);

        const runtime: { workflow?: ReconstructionWorkflow } = {};
        const billing = new ReconstructionBilling(view, async () => {
            await runtime.workflow?.refreshPreparedQuote();
        });
        const artifacts = new ReconstructionArtifacts(
            events,
            view,
            () => runtime.workflow?.canStart ?? false,
            datasetId => runtime.workflow?.handleDatasetDeleted(datasetId),
            dataset => runtime.workflow?.useExistingDataset(dataset)
        );
        const workflow = new ReconstructionWorkflow(events, view, billing, artifacts);
        runtime.workflow = workflow;
        const auth = new ReconstructionAuth(view, async () => {
            billing.beginSession();
            artifacts.beginSession();
            workflow.beginSession();
            await Promise.all([
                billing.refreshCredits(),
                artifacts.refreshRecentRuns(),
                workflow.restoreOpenSessions()
            ]);
        });

        view.cancelButton.addEventListener('click', () => workflow.cancelJob());

        const setVisible = (visible: boolean) => {
            if (visible === this.hidden) {
                this.hidden = !visible;
                events.fire('reconstructionPanel.visible', visible);
                if (visible) {
                    auth.ensure();
                }
            }
        };
        events.function('reconstructionPanel.visible', () => !this.hidden);
        events.on('reconstructionPanel.setVisible', (visible: boolean) => setVisible(visible));
        events.on('reconstructionPanel.toggleVisible', () => setVisible(this.hidden));
        events.on('colorPanel.visible', (visible: boolean) => {
            if (visible) setVisible(false);
        });
        events.on('settingsPanel.visible', (visible: boolean) => {
            if (visible) setVisible(false);
        });

        this.dom.addEventListener('reconClose', () => setVisible(false));

        this.dom.addEventListener('pointerdown', (event: PointerEvent) => {
            if (event.target === this.dom) setVisible(false);
        });

        const shortcutManager: ShortcutManager = events.invoke('shortcutManager');
        this.dom.addEventListener('keydown', (event: KeyboardEvent) => {
            if (shortcutManager.matches('reconstructionPanel.toggleVisible', event)) {
                event.preventDefault();
                event.stopPropagation();
                setVisible(false);
            } else if (event.key === 'Escape') {
                event.stopPropagation();
                setVisible(false);
            }
        });
    }
}

export { ReconstructionPanel };

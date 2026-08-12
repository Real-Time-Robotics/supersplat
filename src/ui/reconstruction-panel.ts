import { Button, Container, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';
import { ReconstructionArtifacts } from './reconstruction-artifacts';
import { ReconstructionAuth } from './reconstruction-auth';
import { ReconstructionBilling } from './reconstruction-billing';
import { ReconstructionView } from './reconstruction-view';
import { ReconstructionWorkflow } from './reconstruction-workflow';

class ReconstructionPanel extends Container {
    constructor(events: Events) {
        super({
            id: 'reconstruction-panel',
            class: 'panel',
            hidden: true
        });

        const header = new Container({ class: 'panel-header' });
        const icon = new Label({
            text: '\uE344',
            class: 'panel-header-icon'
        });
        const title = new Label({ class: 'panel-header-label' });
        i18n.bindText(title, 'panel.reconstruction');
        const close = new Button({
            class: ['panel-header-button', 'reconstruction-panel-close'],
            text: '\u00D7'
        });
        close.dom.setAttribute('aria-label', 'Close Reconstruction panel');
        close.dom.setAttribute('title', 'Close');
        close.on('click', () => events.fire('reconstructionPanel.setVisible', false));
        header.append(icon);
        header.append(title);
        header.append(close);
        this.append(header);

        const view = new ReconstructionView(this.dom);
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
            await Promise.all([
                billing.refreshCredits(),
                artifacts.refreshRecentRuns(),
                workflow.restoreOpenSessions()
            ]);
            // After the credits call, so the scheduler starts on this plan's cap rather
            // than the one the previous session was signed in under.
            workflow.beginSession();
        });

        view.cancelButton.addEventListener('click', () => {
            if (artifacts.isDownloading) {
                artifacts.cancelDownload();
            } else {
                workflow.cancelJob();
            }
        });

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
    }
}

export { ReconstructionPanel };

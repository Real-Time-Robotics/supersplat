import { Container, Element as PcuiElement, TextInput } from '@playcanvas/pcui';

import { SplatRenameOp } from '../edit-ops';
import { Element, ElementType } from '../element';
import { Events } from '../events';
import { TransformableElement } from '../model/transformable-element';
import { Splat } from '../splat';
import { SceneListItem } from './scene-list-item';

const isContent = (element: Element): element is TransformableElement => {
    return element.type === ElementType.splat || element.type === ElementType.model;
};

class SceneList extends Container {
    private items = new Map<TransformableElement, SceneListItem>();
    private savedVisibility = new Map<TransformableElement, boolean>();
    private soloMode = false;

    constructor(private events: Events, args = {}) {
        super({
            ...args,
            class: 'splat-list'
        });

        const edit = new TextInput({ id: 'splat-edit' });

        events.on('scene.elementAdded', (element: Element) => {
            if (!isContent(element)) {
                return;
            }

            const kind = element.type === ElementType.splat ? 'splat' : 'model';
            const item = new SceneListItem(element.name, kind, edit);
            this.append(item);
            this.items.set(element, item);

            if (this.soloMode) {
                this.savedVisibility.set(element, element.visible);
                element.visible = false;
            }

            item.on('visible', () => {
                element.visible = true;
                if (!events.invoke('selection')) {
                    events.fire('selection', element);
                }
            });
            item.on('invisible', () => {
                element.visible = false;
            });
            if (element instanceof Splat) {
                item.on('rename', (value: string) => {
                    events.fire('edit.add', new SplatRenameOp(element, value));
                });
            }
        });

        events.on('scene.elementRemoved', (element: Element) => {
            if (!isContent(element)) {
                return;
            }
            const item = this.items.get(element);
            if (item) {
                this.remove(item);
                this.items.delete(element);
            }
            this.savedVisibility.delete(element);
        });

        events.on('selection.changed', (selection: TransformableElement, previous: TransformableElement) => {
            this.items.forEach((item, element) => {
                item.selected = element === selection;
            });
            if (this.soloMode) {
                if (previous) {
                    previous.visible = false;
                }
                if (selection) {
                    selection.visible = true;
                }
            }
        });

        events.on('scene.solo', (value: boolean) => {
            this.soloMode = value;
            const selection = events.invoke('selection') as TransformableElement;
            if (value) {
                this.items.forEach((item, element) => {
                    this.savedVisibility.set(element, element.visible);
                    element.visible = element === selection;
                });
            } else {
                this.items.forEach((item, element) => {
                    element.visible = this.savedVisibility.get(element) ?? true;
                });
                this.savedVisibility.clear();
            }
        });

        events.on('splat.name', (splat: Splat) => {
            const item = this.items.get(splat);
            if (item) {
                item.name = splat.name;
            }
        });
        events.on('splat.visibility', (splat: Splat) => this.syncVisibility(splat));
        events.on('model.visibility', (model: TransformableElement) => this.syncVisibility(model));

        this.on('click', (item: SceneListItem) => {
            const element = this.findElement(item);
            if (element) {
                if (this.soloMode && !element.visible) {
                    element.visible = true;
                }
                events.fire('selection', element);
            }
        });

        this.on('removeClicked', async (item: SceneListItem) => {
            const element = this.findElement(item);
            if (!element) {
                return;
            }
            const label = element.type === ElementType.model ? 'Model' : 'Splat';
            const result = await events.invoke('showPopup', {
                type: 'yesno',
                header: `Remove ${label}`,
                message: `Are you sure you want to remove '${element.name}' from the scene? This operation can not be undone.`
            });
            if (result?.action === 'yes') {
                element.destroy();
            }
        });
    }

    protected _onAppendChild(element: PcuiElement): void {
        super._onAppendChild(element);
        if (element instanceof SceneListItem) {
            element.on('click', () => this.emit('click', element));
            element.on('removeClicked', () => this.emit('removeClicked', element));
        }
    }

    protected _onRemoveChild(element: PcuiElement): void {
        if (element instanceof SceneListItem) {
            element.unbind('click');
            element.unbind('removeClicked');
        }
        super._onRemoveChild(element);
    }

    private findElement(item: SceneListItem) {
        for (const [element, candidate] of this.items) {
            if (candidate === item) {
                return element;
            }
        }
        return null;
    }

    private syncVisibility(element: TransformableElement) {
        const item = this.items.get(element);
        if (item && item.visible !== element.visible) {
            item.visible = element.visible;
        }
    }
}

export { SceneList };

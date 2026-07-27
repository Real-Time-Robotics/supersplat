import { Container, Label, Element as PcuiElement, TextInput } from '@playcanvas/pcui';

import deleteSvg from './svg/delete.svg';
import hiddenSvg from './svg/hidden.svg';
import shownSvg from './svg/shown.svg';

const createSvg = (svgString: string) => {
    const decoded = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decoded, 'image/svg+xml').documentElement;
};

class SceneListItem extends Container {
    private text: Label;
    private shown: PcuiElement;
    private hiddenIcon: PcuiElement;

    constructor(name: string, kind: 'splat' | 'model', edit: TextInput, args = {}) {
        super({
            ...args,
            class: ['splat-item', 'visible', `scene-item-${kind}`]
        });

        this.text = new Label({
            class: 'splat-item-text',
            text: name
        });
        this.shown = new PcuiElement({
            dom: createSvg(shownSvg),
            class: 'splat-item-visible'
        });
        this.hiddenIcon = new PcuiElement({
            dom: createSvg(hiddenSvg),
            class: 'splat-item-visible',
            hidden: true
        });
        const remove = new PcuiElement({
            dom: createSvg(deleteSvg),
            class: 'splat-item-delete'
        });

        this.append(this.text);
        this.append(this.shown);
        this.append(this.hiddenIcon);
        this.append(remove);

        const toggleVisible = (event: MouseEvent) => {
            event.stopPropagation();
            this.visible = !this.visible;
        };
        this.shown.dom.addEventListener('click', toggleVisible);
        this.hiddenIcon.dom.addEventListener('click', toggleVisible);
        remove.dom.addEventListener('click', (event: MouseEvent) => {
            event.stopPropagation();
            this.emit('removeClicked', this);
        });

        if (kind === 'splat') {
            this.text.dom.addEventListener('dblclick', (event: MouseEvent) => {
                event.stopPropagation();
                const onBlur = () => {
                    this.remove(edit);
                    this.emit('rename', edit.value);
                    edit.input.removeEventListener('blur', onBlur);
                    this.text.hidden = false;
                };
                this.text.hidden = true;
                this.appendAfter(edit, this.text);
                edit.value = this.text.value;
                edit.input.addEventListener('blur', onBlur);
                edit.focus();
            });
        }
    }

    set name(value: string) {
        this.text.value = value;
    }

    get name() {
        return this.text.value;
    }

    set selected(value: boolean) {
        if (value) {
            this.class.add('selected');
        } else {
            this.class.remove('selected');
        }
    }

    get selected() {
        return this.class.contains('selected');
    }

    set visible(value: boolean) {
        this.shown.hidden = !value;
        this.hiddenIcon.hidden = value;
        if (value) {
            this.class.add('visible');
            this.emit('visible', this);
        } else {
            this.class.remove('visible');
            this.emit('invisible', this);
        }
    }

    get visible() {
        return this.class.contains('visible');
    }
}

export { SceneListItem };

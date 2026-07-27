import { Element, ElementType } from './element';
import { Events } from './events';
import { TransformableElement } from './model/transformable-element';
import { Scene } from './scene';
import { Splat } from './splat';

const registerSelectionEvents = (events: Events, scene: Scene) => {
    let selection: TransformableElement = null;

    const setSelection = (element: TransformableElement) => {
        if (element !== selection && (!element || element.visible)) {
            const prev = selection;
            selection = element;
            events.fire('selection.changed', selection, prev);
        }
    };

    events.on('selection', (element: TransformableElement) => {
        setSelection(element);
    });

    events.function('selection', () => {
        return selection;
    });

    events.on('selection.next', () => {
        const elements = scene.elements.filter(element => (
            element.type === ElementType.splat || element.type === ElementType.model
        )) as TransformableElement[];
        if (elements.length > 1) {
            const idx = elements.indexOf(selection);
            setSelection(elements[(idx + 1) % elements.length]);
        }
    });

    events.on('scene.elementAdded', (element: Element) => {
        if (element.type === ElementType.splat || element.type === ElementType.model) {
            setSelection(element as TransformableElement);
        }
    });

    events.on('scene.elementRemoved', (element: Element) => {
        if (element === selection) {
            const elements = scene.elements.filter(candidate => (
                candidate !== element &&
                (candidate.type === ElementType.splat || candidate.type === ElementType.model)
            )) as TransformableElement[];
            setSelection(elements[0] ?? null);
        }
    });

    events.on('splat.visibility', (splat: Splat) => {
        if (splat === selection && !splat.visible) {
            setSelection(null);
        }
    });

    events.on('model.visibility', (model: TransformableElement) => {
        if (model === selection && !model.visible) {
            setSelection(null);
        }
    });

    events.on('camera.focalPointPicked', (details: { splat: Splat }) => {
        setSelection(details.splat);
    });
};

export { registerSelectionEvents };

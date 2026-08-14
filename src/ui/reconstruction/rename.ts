import { reconFetch } from './http';
import { messageOf, readJson } from './utils';

/** The gateway trims and caps at 200; the input stops the user before the round trip. */
const NAME_MAX = 200;

type RenameTarget =
    | { kind: 'dataset'; datasetId: string }
    | { kind: 'job'; jobId: string };

const routeOf = (target: RenameTarget): string => (target.kind === 'dataset' ?
    `/api/reconstruction/datasets/${encodeURIComponent(target.datasetId)}` :
    `/api/reconstruction/jobs/${encodeURIComponent(target.jobId)}/label`);

/** PUT the new name and return it as the server stored it (trimmed, capped). */
const rename = async (target: RenameTarget, label: string): Promise<string> => {
    const response = await reconFetch(routeOf(target), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label })
    });
    return (await readJson<{ label: string }>(response)).label;
};

/** A default a user is happy to keep: the kind of thing, plus when they made it. */
const defaultName = (kind: string, at: Date = new Date()): string => (
    `${kind} ${at.toLocaleString('en-US')}`);

type EditableOptions = {
    /** Shown when the name is empty — the id, usually. Never sent. */
    placeholder: string;
    onRenamed(label: string): void;
    onError(message: string): void;
};

/**
 * An in-place rename: the name is a button until it is clicked, then an input that commits
 * on Enter or blur and abandons on Escape. Returns the element to mount.
 *
 * Optimistic on purpose — the request is one field on one row, and reverting on failure
 * costs the user nothing they had not already typed.
 */
const editableName = (label: string, target: RenameTarget,
    options: EditableOptions): HTMLElement => {
    const root = document.createElement('span');
    root.className = 'recon-editable';

    const text = document.createElement('button');
    text.type = 'button';
    text.className = 'recon-editable-text';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'recon-editable-input';
    input.maxLength = NAME_MAX;
    input.placeholder = options.placeholder;
    input.hidden = true;

    let current = label;
    const paint = () => {
        text.textContent = current || options.placeholder;
        text.classList.toggle('unnamed', !current);
        text.title = `Đổi tên: ${current || options.placeholder}`;
        text.setAttribute('aria-label', text.title);
    };
    paint();

    const show = () => {
        input.value = current;
        input.hidden = false;
        text.hidden = true;
        input.focus();
        input.select();
    };
    const hide = () => {
        input.hidden = true;
        text.hidden = false;
        paint();
    };

    let committing = false;
    const commit = async () => {
        if (committing) return;
        const wanted = input.value.trim();
        if (wanted === current) {
            hide();
            return;
        }
        committing = true;
        const previous = current;
        current = wanted;          // optimistic: the row reads right before the reply lands
        hide();
        try {
            current = await rename(target, wanted);
            paint();
            options.onRenamed(current);
        } catch (error) {
            current = previous;
            paint();
            options.onError(messageOf(error));
        } finally {
            committing = false;
        }
    };

    text.addEventListener('click', show);
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            commit();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            hide();
        }
        event.stopPropagation();   // the panel owns single-key shortcuts
    });
    input.addEventListener('blur', () => {
        if (!input.hidden) commit();
    });

    root.append(text, input);
    return root;
};

export { NAME_MAX, defaultName, editableName, rename };
export type { RenameTarget };

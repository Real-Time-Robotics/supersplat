import { i18n, type LocalizeOptions } from '../localization';
import { endSession, onSessionEnded, reconFetch, sessionRestored } from './http';
import { SessionWatch } from './session-watch';
import { ReconstructionView } from './view';

type Account = {
    label: string;
    customerId: string;
};

type SessionResponse = {
    authenticated: true;
    account: Account;
    expiresAt: number;
};

type AuthValues = Record<string, string>;

type StatusText = string | (() => string);

const localized = (key: string, options?: LocalizeOptions) => () => i18n.t(key, options);

const validEmail = (value: string) => {
    const at = value.indexOf('@');
    const dot = value.lastIndexOf('.');
    return at > 0 && dot > at + 1 && dot < value.length - 1 && !/\s/.test(value);
};

const validate = (mode: string, values: AuthValues): string | null => {
    if (mode === 'api-key') {
        return values.apiKey.startsWith('gp_live_') ? null : 'panel.reconstruction.auth.invalid-api-key';
    }
    if (mode === 'register') {
        if (!validEmail(values.email) || values.email.length > 255) {
            return 'panel.reconstruction.auth.invalid-email';
        }
        if (!values.firstName || values.firstName.length > 100) return 'panel.reconstruction.auth.first-name-required';
        if (!values.lastName || values.lastName.length > 100) return 'panel.reconstruction.auth.last-name-required';
        return null;
    }
    return null;
};

class ReconstructionAuth {
    private account: Account | null = null;
    private requestInFlight = false;
    private pendingNotice = '';
    private status: StatusText = '';
    private readonly watch = new SessionWatch(() => endSession());

    constructor(
        private readonly view: ReconstructionView,
        private readonly onAuthenticated: () => void | Promise<void>
    ) {
        const tabs = view.authPanel.querySelectorAll<HTMLButtonElement>('.recon-auth-tab');
        tabs.forEach(tab => tab.addEventListener('click', () => this.setTab(tab.dataset.authTab || 'login')));
        view.authPanel.querySelectorAll<HTMLFormElement>('.recon-auth-form').forEach((form) => {
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                this.submit(form);
            });
        });
        const revealButton = view.query<HTMLButtonElement>('.recon-auth-reveal');
        const apiKeyInput = view.query<HTMLInputElement>('[data-auth-form="api-key"] input[name="apiKey"]');
        const renderReveal = () => {
            const revealed = apiKeyInput.type !== 'password';
            revealButton.textContent = i18n.t(revealed ? 'panel.reconstruction.auth.hide' : 'panel.reconstruction.auth.show');
            revealButton.setAttribute('aria-label',
                i18n.t(revealed ? 'panel.reconstruction.auth.hide-api-key' : 'panel.reconstruction.auth.show-api-key'));
        };
        revealButton.addEventListener('click', () => {
            apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
            renderReveal();
        });
        i18n.onChange(() => {
            renderReveal();
            this.renderStatus();
        });
        view.query<HTMLButtonElement>('.recon-sign-out').addEventListener('click', () => this.signOut());
        onSessionEnded(() => this.forgetSession(localized('panel.reconstruction.auth.session-expired')));
        // A timer alone cannot be trusted: a background tab throttles it and a sleeping
        // machine skips it, so every wake-up re-reads the clock as well.
        const wake = () => {
            this.watch.wake();
        };
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') wake();
        });
        window.addEventListener('focus', wake);
        window.addEventListener('pageshow', wake);
        window.addEventListener('online', wake);
    }

    async ensure() {
        const notice = this.pendingNotice;
        this.pendingNotice = '';
        if (this.account) {
            this.view.showApp(this.account.label);
            return;
        }
        this.view.showAuth();
        this.setStatus(localized('panel.reconstruction.auth.checking-session'));
        try {
            const response = await reconFetch('/api/reconstruction/session', { cache: 'no-store' });
            if (response.status === 401) {
                this.setStatus(notice ? localized(notice) : '', Boolean(notice));
                return;
            }
            const session = await this.readResponse(response);
            this.account = session.account;
            sessionRestored();
            this.watch.arm(session.expiresAt);
            await this.activate();
        } catch (error) {
            this.setStatus(error instanceof Error ? error.message : String(error), true);
        }
    }

    notice(key: string) {
        this.pendingNotice = key;
    }

    private setTab(mode: string) {
        if (this.requestInFlight) return;
        this.view.authPanel.querySelectorAll<HTMLButtonElement>('.recon-auth-tab').forEach((tab) => {
            const selected = tab.dataset.authTab === mode;
            tab.classList.toggle('active', selected);
            tab.setAttribute('aria-selected', String(selected));
        });
        this.view.authPanel.querySelectorAll<HTMLFormElement>('.recon-auth-form').forEach((form) => {
            form.hidden = form.dataset.authForm !== mode;
        });
        this.setStatus('');
    }

    private async submit(form: HTMLFormElement) {
        if (this.requestInFlight) return;
        const mode = form.dataset.authForm;
        if (mode === 'login') {
            window.location.assign('/api/reconstruction/auth/start');
            return;
        }
        const values = Object.fromEntries(
            [...new FormData(form).entries()].map(([name, value]) => [
                name,
                /password/i.test(name) ? String(value) : String(value).trim()
            ])
        );
        const validationError = validate(mode, values);
        if (validationError) {
            this.setStatus(localized(validationError), true);
            return;
        }
        this.setBusy(true);
        this.setStatus(localized(mode === 'register' ?
            'panel.reconstruction.auth.creating-account' :
            'panel.reconstruction.auth.signing-in'));
        try {
            if (mode === 'register') {
                await this.register(values);
                form.reset();
                this.setBusy(false);
                this.setTab('login');
                this.setStatus(localized('panel.reconstruction.auth.account-created', { email: values.email }));
                return;
            }
            const response = await fetch('/api/reconstruction/session/api-key', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(values)
            });
            const session = await this.readResponse(response);
            form.reset();
            this.account = session.account;
            sessionRestored();
            this.watch.arm(session.expiresAt);
            await this.activate();
        } catch (error) {
            this.setStatus(error instanceof Error ? error.message : String(error), true);
        } finally {
            this.setBusy(false);
        }
    }

    private async register(values: AuthValues) {
        const { url } = await this.readResponse<{ url: string }>(
            await fetch('/api/reconstruction/session/register', { cache: 'no-store' }));
        await this.readResponse(await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                first_name: values.firstName,
                last_name: values.lastName,
                email: values.email
            })
        }));
    }

    private async readResponse<T = SessionResponse>(response: Response): Promise<T> {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(payload.error || payload.detail || payload.title ||
                i18n.t('panel.reconstruction.auth.request-failed', { status: response.status }));
        }
        return payload as T;
    }

    private async activate() {
        if (!this.account) return;
        this.view.showApp(this.account.label);
        await this.onAuthenticated();
    }

    private async signOut() {
        try {
            await reconFetch('/api/reconstruction/session', { method: 'DELETE' });
        } finally {
            endSession();
        }
    }

    private forgetSession(message: StatusText) {
        this.watch.disarm();
        this.account = null;
        this.view.showAuth();
        this.setTab('login');
        if (message) this.setStatus(message, true);
    }

    private setBusy(busy: boolean) {
        this.requestInFlight = busy;
        this.view.authPanel.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')
        .forEach((control) => {
            control.disabled = busy;
        });
    }

    private setStatus(message: StatusText, error = false) {
        this.status = message;
        this.view.query<HTMLElement>('.recon-auth-status').classList.toggle('error', error);
        this.renderStatus();
    }

    private renderStatus() {
        this.view.query<HTMLElement>('.recon-auth-status').textContent =
            typeof this.status === 'function' ? this.status() : this.status;
    }
}

export { ReconstructionAuth };

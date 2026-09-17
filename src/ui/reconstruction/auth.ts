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
    // Absent from a server older than the expiry watch; the watch then simply idles.
    expiresAt?: number | null;
};

type PendingVerification = {
    authenticated: false;
    verificationRequired: true;
};

type AuthValues = Record<string, string>;

const validEmail = (value: string) => {
    const at = value.indexOf('@');
    const dot = value.lastIndexOf('.');
    return at > 0 && dot > at + 1 && dot < value.length - 1 && !/\s/.test(value);
};

const validate = (mode: string, values: AuthValues): string | null => {
    if (mode === 'api-key') {
        return values.apiKey.startsWith('gp_live_') ? null : 'Enter a valid Genesis API key beginning with gp_live_.';
    }
    if (mode === 'register') {
        if (!validEmail(values.email) || values.email.length > 255) {
            return 'Enter a valid email address.';
        }
        if (!values.firstName || values.firstName.length > 100) return 'First Name is required.';
        if (!values.lastName || values.lastName.length > 100) return 'Last Name is required.';
        return null;
    }
    return null;
};

class ReconstructionAuth {
    private account: Account | null = null;
    private requestInFlight = false;
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
        view.query<HTMLButtonElement>('.recon-auth-reveal').addEventListener('click', (event) => {
            const button = event.currentTarget as HTMLButtonElement;
            const input = view.query<HTMLInputElement>('[data-auth-form="api-key"] input[name="apiKey"]');
            const reveal = input.type === 'password';
            input.type = reveal ? 'text' : 'password';
            button.textContent = reveal ? 'Hide' : 'Show';
            button.setAttribute('aria-label', `${reveal ? 'Hide' : 'Show'} API key`);
        });
        view.query<HTMLButtonElement>('.recon-sign-out').addEventListener('click', () => this.signOut());
        onSessionEnded(() => this.forgetSession(
            'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại để tiếp tục.'));
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
        if (this.account) {
            this.view.showApp(this.account.label);
            return;
        }
        this.view.showAuth();
        this.setStatus('Checking your session...');
        try {
            const response = await reconFetch('/api/reconstruction/session', { cache: 'no-store' });
            if (response.status === 401) {
                this.setStatus('');
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
            this.setStatus(validationError, true);
            return;
        }
        const path = mode === 'register' ?
            '/api/reconstruction/session/register' :
            '/api/reconstruction/session/api-key';
        this.setBusy(true);
        this.setStatus(mode === 'register' ? 'Creating your account...' : 'Signing in...');
        try {
            const response = await fetch(path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(values)
            });
            const session = await this.readResponse<SessionResponse | PendingVerification>(response);
            form.reset();
            if (!session.authenticated) {
                this.setBusy(false);
                this.setTab('login');
                this.setStatus(`Account created. Open the link we sent to ${values.email} to verify it and set your password, then sign in.`);
                return;
            }
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

    private async readResponse<T = SessionResponse>(response: Response): Promise<T> {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
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

    private forgetSession(message: string) {
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

    private setStatus(message: string, error = false) {
        const status = this.view.query<HTMLElement>('.recon-auth-status');
        status.textContent = message;
        status.classList.toggle('error', error);
    }
}

export { ReconstructionAuth };

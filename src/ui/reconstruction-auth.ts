import { endSession, onSessionEnded, reconFetch, sessionRestored } from './reconstruction-http';
import { ReconstructionView } from './reconstruction-view';

type Account = {
    label: string;
    customerId: string;
};

type SessionResponse = {
    authenticated: true;
    account: Account;
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
    if (!validEmail(values.email) || values.email.length > 255) {
        return 'Enter a valid email address.';
    }
    if (!values.password || values.password.length > 256) {
        return 'Enter your password.';
    }
    if (mode !== 'register') return null;
    if (!values.firstName || values.firstName.length > 100) return 'First Name is required.';
    if (!values.lastName || values.lastName.length > 100) return 'Last Name is required.';
    if (values.password.length < 6) return 'Password must contain at least 6 characters.';
    if (values.password !== values.confirmPassword) return 'Passwords do not match.';
    return null;
};

class ReconstructionAuth {
    private account: Account | null = null;
    private requestInFlight = false;

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
        const registerForm = view.query<HTMLFormElement>('[data-auth-form="register"]');
        const password = registerForm.elements.namedItem('password') as HTMLInputElement;
        const confirmation = registerForm.elements.namedItem('confirmPassword') as HTMLInputElement;
        const syncConfirmation = () => {
            confirmation.setCustomValidity(
                confirmation.value && password.value !== confirmation.value ? 'Passwords do not match.' : ''
            );
        };
        password.addEventListener('input', syncConfirmation);
        confirmation.addEventListener('input', syncConfirmation);
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
            mode === 'api-key' ?
                '/api/reconstruction/session/api-key' :
                '/api/reconstruction/session/login';
        this.setBusy(true);
        this.setStatus(mode === 'register' ? 'Creating your account...' : 'Signing in...');
        try {
            const response = await fetch(path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(values)
            });
            const session = await this.readResponse(response);
            this.account = session.account;
            sessionRestored();
            form.reset();
            await this.activate();
        } catch (error) {
            this.setStatus(error instanceof Error ? error.message : String(error), true);
        } finally {
            this.setBusy(false);
        }
    }

    private async readResponse(response: Response): Promise<SessionResponse> {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
        return payload as SessionResponse;
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

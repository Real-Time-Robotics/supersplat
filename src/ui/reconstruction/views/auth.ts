import { i18n } from '../../localization';

/**
 * The signed-out screen.
 */
class AuthView {
    readonly root: HTMLElement;

    constructor(host: HTMLElement) {
        const root = document.createElement('section');
        root.className = 'recon-auth';
        root.innerHTML = `
            <div class="recon-auth-hero">
                <div class="recon-auth-brand">
                    <strong>Genesis Reconstruction</strong>
                    <span data-i18n="panel.reconstruction.auth.tagline"></span>
                </div>
            </div>
            <div class="recon-auth-card">
                <div class="recon-auth-tabs" role="tablist" data-i18n-label="panel.reconstruction.auth.tabs">
                    <button class="recon-auth-tab active" type="button" role="tab"
                            data-auth-tab="login" aria-selected="true"
                            data-i18n="panel.reconstruction.auth.log-in"></button>
                    <button class="recon-auth-tab" type="button" role="tab"
                            data-auth-tab="register" aria-selected="false"
                            data-i18n="panel.reconstruction.auth.register"></button>
                    <button class="recon-auth-tab" type="button" role="tab"
                            data-auth-tab="api-key" aria-selected="false"
                            data-i18n="panel.reconstruction.auth.api-key"></button>
                </div>
                <div class="recon-auth-stage">
                    <form class="recon-auth-form" data-auth-form="login">
                        <p data-i18n="panel.reconstruction.auth.login-hint"></p>
                        <button class="recon-button recon-primary" type="submit"
                                data-i18n="panel.reconstruction.auth.login-submit"></button>
                    </form>
                    <form class="recon-auth-form" data-auth-form="register" hidden>
                        <div class="recon-auth-names">
                            <label><span data-i18n="panel.reconstruction.auth.first-name"></span>
                                <input name="firstName" autocomplete="given-name" maxlength="100" required></label>
                            <label><span data-i18n="panel.reconstruction.auth.last-name"></span>
                                <input name="lastName" autocomplete="family-name" maxlength="100" required></label>
                        </div>
                        <label><span data-i18n="panel.reconstruction.auth.email"></span>
                            <input name="email" type="email" autocomplete="username"
                                   minlength="3" maxlength="255" required></label>
                        <p data-i18n="panel.reconstruction.auth.register-hint"></p>
                        <button class="recon-button recon-primary" type="submit"
                                data-i18n="panel.reconstruction.auth.register-submit"></button>
                    </form>
                    <form class="recon-auth-form" data-auth-form="api-key" hidden>
                        <label><span data-i18n="panel.reconstruction.auth.api-key-label"></span>
                            <span class="recon-auth-secret-input">
                                <input name="apiKey" type="password" autocomplete="off"
                                       spellcheck="false" placeholder="gp_live_..." required>
                                <button class="recon-auth-reveal" type="button"></button>
                            </span>
                        </label>
                        <p data-i18n="panel.reconstruction.auth.api-key-hint"></p>
                        <button class="recon-button recon-primary" type="submit"
                                data-i18n="panel.reconstruction.auth.api-key-submit"></button>
                    </form>
                </div>
                <p class="recon-auth-status" role="status"></p>
            </div>
            <footer class="recon-auth-legal">
                © ${new Date().getFullYear()} Realtime Robotics · Genesis Reconstruction
            </footer>`;
        i18n.onChange(() => {
            root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => {
                element.textContent = i18n.t(element.dataset.i18n);
            });
            root.setAttribute('aria-label', i18n.t('panel.reconstruction.auth.region'));
            root.querySelectorAll<HTMLElement>('[data-i18n-label]').forEach((element) => {
                element.setAttribute('aria-label', i18n.t(element.dataset.i18nLabel));
            });
        });
        host.appendChild(root);
        this.root = root;
    }
}

export { AuthView };

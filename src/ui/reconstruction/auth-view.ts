/**
 * The signed-out screen.
 */
class AuthView {
    readonly root: HTMLElement;

    constructor(host: HTMLElement) {
        const root = document.createElement('section');
        root.className = 'recon-auth';
        root.setAttribute('aria-label', 'Genesis Reconstruction account');
        root.innerHTML = `
            <div class="recon-auth-hero">
                <div class="recon-auth-brand">
                    <strong>Genesis Reconstruction</strong>
                    <span>Turn your photos into a production-ready 3D model.</span>
                </div>
            </div>
            <div class="recon-auth-tabs" role="tablist" aria-label="Account access">
                <button class="recon-auth-tab active" type="button" role="tab"
                        data-auth-tab="login" aria-selected="true">Log in</button>
                <button class="recon-auth-tab" type="button" role="tab"
                        data-auth-tab="register" aria-selected="false">Register</button>
                <button class="recon-auth-tab" type="button" role="tab"
                        data-auth-tab="api-key" aria-selected="false">API key</button>
            </div>
            <div class="recon-auth-stage">
                <form class="recon-auth-form" data-auth-form="login">
                    <label>Email<input name="email" type="email" autocomplete="username"
                                       minlength="3" maxlength="255" required></label>
                    <label>Password<input name="password" type="password"
                                          autocomplete="current-password" maxlength="256"
                                          required></label>
                    <button class="recon-button recon-primary" type="submit">Log in</button>
                </form>
                <form class="recon-auth-form" data-auth-form="register" hidden>
                    <div class="recon-auth-names">
                        <label>First Name<input name="firstName" autocomplete="given-name"
                                                maxlength="100" required></label>
                        <label>Last Name<input name="lastName" autocomplete="family-name"
                                               maxlength="100" required></label>
                    </div>
                    <label>Email<input name="email" type="email" autocomplete="username"
                                       minlength="3" maxlength="255" required></label>
                    <label>Password<input name="password" type="password"
                                          autocomplete="new-password" minlength="6"
                                          maxlength="256" required></label>
                    <label>Confirm Password<input name="confirmPassword" type="password"
                                                  autocomplete="new-password" minlength="6"
                                                  maxlength="256" required></label>
                    <button class="recon-button recon-primary" type="submit">Create account</button>
                </form>
                <form class="recon-auth-form" data-auth-form="api-key" hidden>
                    <label>Genesis API key
                        <span class="recon-auth-secret-input">
                            <input name="apiKey" type="password" autocomplete="off"
                                   spellcheck="false" placeholder="gp_live_..." required>
                            <button class="recon-auth-reveal" type="button"
                                    aria-label="Show API key">Show</button>
                        </span>
                    </label>
                    <p>Use an existing key without logging in. It stays in this server session
                       and is never saved in the browser.</p>
                    <button class="recon-button recon-primary" type="submit">Continue with API key</button>
                </form>
            </div>
            <p class="recon-auth-status" role="status"></p>`;
        host.appendChild(root);
        this.root = root;
    }
}

export { AuthView };

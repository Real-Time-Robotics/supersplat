/**
 * The Settings tab
 */
class SettingsView {
    readonly root: HTMLElement;
    readonly accountLabel: HTMLElement;

    constructor(host: HTMLElement) {
        const root = document.createElement('section');
        root.id = 'recon-settings-tab';
        root.className = 'recon-tab-panel';
        root.setAttribute('role', 'tabpanel');
        root.hidden = true;
        root.innerHTML = `
            <section class="recon-account">
                <div class="recon-section-heading">
                    <strong>Account</strong>
                    <span>Signed in as <strong class="recon-account-label"></strong></span>
                </div>
                <button class="recon-button recon-sign-out" type="button">Forget on this device</button>
            </section>
            <section class="recon-api">
                <div class="recon-section-heading">
                    <strong>API key</strong>
                    <span>Dùng để gọi Genesis Point từ SDK hoặc curl. Giữ kín như mật khẩu.</span>
                </div>
                <p class="recon-api-status">
                    Tạo và thu hồi API key trong trang quản lý của Genesis Point.
                    Phiên đăng nhập này không tạo key nào.
                </p>
                <a class="recon-button recon-api-manage" target="_blank" rel="noopener"
                   href="https://recons.rtrobotics.com/?tab=api-keys">Mở trang quản lý API key</a>
            </section>`;
        host.appendChild(root);

        this.root = root;
        this.accountLabel = root.querySelector('.recon-account-label');
    }
}

export { SettingsView };

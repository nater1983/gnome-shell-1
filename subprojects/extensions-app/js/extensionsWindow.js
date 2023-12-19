import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Shew from 'gi://Shew';

const Package = imports.package;
import * as Gettext from 'gettext';

import * as Config from './misc/config.js';
import {ExtensionRow} from './extensionRow.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Shew.WindowExporter.prototype, 'export');

export const ExtensionsWindow = GObject.registerClass({
    GTypeName: 'ExtensionsWindow',
    Template: 'resource:///org/gnome/Extensions/ui/extensions-window.ui',
    InternalChildren: [
        'sortModel',
        'searchFilter',
        'userListModel',
        'systemListModel',
        'userGroup',
        'userList',
        'systemGroup',
        'systemList',
        'mainStack',
        'searchBar',
        'searchButton',
        'searchEntry',
        'updatesBanner',
    ],
}, class ExtensionsWindow extends Adw.ApplicationWindow {
    _init(params) {
        super._init(params);

        if (Config.PROFILE === 'development')
            this.add_css_class('devel');

        this._exporter = new Shew.WindowExporter({window: this});
        this._exportedHandle = '';

        this.add_action_entries(
            [{
                name: 'show-about',
                activate: () => this._showAbout(),
            }, {
                name: 'logout',
                activate: () => this._logout(),
            }, {
                name: 'user-extensions-enabled',
                state: 'false',
                change_state: (a, state) => {
                    const {extensionManager} = this.application;
                    extensionManager.userExtensionsEnabled = state.get_boolean();
                },
            }]);

        this._searchEntry.connect('search-changed',
            () => (this._searchFilter.search = this._searchEntry.text));

        this._userList.set_placeholder(new Gtk.Label({
            label: _('No Matches'),
            margin_start: 12,
            margin_end: 12,
            margin_top: 12,
            margin_bottom: 12,
        }));
        this._userList.connect('row-activated', (_list, row) => row.activate());
        this._userGroup.connect('notify::visible', () => this._syncVisiblePage());

        this._systemList.set_placeholder(new Gtk.Label({
            label: _('No Matches'),
            margin_start: 12,
            margin_end: 12,
            margin_top: 12,
            margin_bottom: 12,
        }));
        this._systemList.connect('row-activated', (_list, row) => row.activate());
        this._systemGroup.connect('notify::visible', () => this._syncVisiblePage());

        const {extensionManager} = this.application;
        extensionManager.connect('notify::failed',
            () => this._syncVisiblePage());
        extensionManager.connect('notify::n-updates',
            () => this._checkUpdates());
        extensionManager.connect('notify::user-extensions-enabled',
            this._onUserExtensionsEnabledChanged.bind(this));
        this._onUserExtensionsEnabledChanged();

        this._sortModel.model = extensionManager.extensions;

        this._userList.bind_model(new Gtk.FilterListModel({
            filter: this._searchFilter,
            model: this._userListModel,
        }), extension => new ExtensionRow(extension));
        this._systemList.bind_model(new Gtk.FilterListModel({
            filter: this._searchFilter,
            model: this._systemListModel,
        }), extension => new ExtensionRow(extension));

        extensionManager.connect('extensions-loaded',
            () => this._extensionsLoaded());
    }

    uninstall(extension) {
        const dialog = new Gtk.MessageDialog({
            transient_for: this,
            modal: true,
            text: _('Remove “%s”?').format(extension.name),
            secondary_text: _('If you remove the extension, you need to return to download it if you want to enable it again'),
        });

        dialog.add_button(_('_Cancel'), Gtk.ResponseType.CANCEL);
        dialog.add_button(_('_Remove'), Gtk.ResponseType.ACCEPT)
            .get_style_context().add_class('destructive-action');

        dialog.connect('response', (dlg, response) => {
            const {extensionManager} = this.application;

            if (response === Gtk.ResponseType.ACCEPT)
                extensionManager.uninstallExtension(extension.uuid);
            dialog.destroy();
        });
        dialog.present();
    }

    async openPrefs(extension) {
        if (!this._exportedHandle) {
            try {
                this._exportedHandle = await this._exporter.export();
            } catch (e) {
                console.warn(`Failed to export window: ${e.message}`);
            }
        }

        const {extensionManager} = this.application;
        extensionManager.openExtensionPrefs(extension.uuid, this._exportedHandle);
    }

    _showAbout() {
        const aboutWindow = new Adw.AboutWindow({
            developers: [
                'Florian Müllner <fmuellner@gnome.org>',
                'Jasper St. Pierre <jstpierre@mecheye.net>',
                'Didier Roche <didrocks@ubuntu.com>',
                'Romain Vigier <contact@romainvigier.fr>',
            ],
            designers: [
                'Allan Day <allanpday@gmail.com>',
                'Tobias Bernard <tbernard@gnome.org>',
            ],
            translator_credits: _('translator-credits'),
            application_name: _('Extensions'),
            license_type: Gtk.License.GPL_2_0,
            application_icon: Package.name,
            version: Package.version,
            developer_name: _('The GNOME Project'),
            website: 'https://apps.gnome.org/app/org.gnome.Extensions/',
            issue_url: 'https://gitlab.gnome.org/GNOME/gnome-shell/issues/new',

            transient_for: this,
        });
        aboutWindow.present();
    }

    _logout() {
        this.application.get_dbus_connection().call(
            'org.gnome.SessionManager',
            '/org/gnome/SessionManager',
            'org.gnome.SessionManager',
            'Logout',
            new GLib.Variant('(u)', [0]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null);
    }

    _onUserExtensionsEnabledChanged() {
        const {userExtensionsEnabled} = this.application.extensionManager;
        const action = this.lookup_action('user-extensions-enabled');
        action.set_state(new GLib.Variant('b', userExtensionsEnabled));
    }

    _syncVisiblePage() {
        const {extensionManager} = this.application;

        if (extensionManager.failed)
            this._mainStack.visible_child_name = 'noshell';
        else if (this._userGroup.visible || this._systemGroup.visible)
            this._mainStack.visible_child_name = 'main';
        else
            this._mainStack.visible_child_name = 'placeholder';
    }

    _checkUpdates() {
        const {nUpdates} = this.application.extensionManager;

        this._updatesBanner.title = Gettext.ngettext(
            '%d extension will be updated on next login.',
            '%d extensions will be updated on next login.',
            nUpdates).format(nUpdates);
        this._updatesBanner.revealed = nUpdates > 0;
    }

    _extensionsLoaded() {
        this._syncVisiblePage();
        this._checkUpdates();
    }
});

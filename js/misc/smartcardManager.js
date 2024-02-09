// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import Gio from 'gi://Gio';
import * as Signals from './signals.js';

import * as ObjectManager from './objectManager.js';

const SMARTCARD_SETTINGS_SCHEMA = 'org.gnome.settings-daemon.peripherals.smartcard';
const SMARTCARD_REMOVAL_ACTION = 'removal-action';

const SmartcardTokenIface = `
<node>
<interface name="org.gnome.SettingsDaemon.Smartcard.Token">
  <property name="Name" type="s" access="read"/>
  <property name="Driver" type="o" access="read"/>
  <property name="IsInserted" type="b" access="read"/>
  <property name="UsedToLogin" type="b" access="read"/>
</interface>
</node>`;

let _smartcardManager = null;

/**
 * @returns {SmartcardManager}
 */
export function getSmartcardManager() {
    if (_smartcardManager == null)
        _smartcardManager = new SmartcardManager();

    return _smartcardManager;
}

class SmartcardManager extends Signals.EventEmitter {
    constructor() {
        super();

        this._objectManager = new ObjectManager.ObjectManager({
            connection: Gio.DBus.session,
            name: 'org.gnome.SettingsDaemon.Smartcard',
            objectPath: '/org/gnome/SettingsDaemon/Smartcard',
            knownInterfaces: [SmartcardTokenIface],
            onLoaded: this._onLoaded.bind(this),
        });
        this._settings = new Gio.Settings({schema_id: SMARTCARD_SETTINGS_SCHEMA});
        this._insertedTokens = {};
        this._loginToken = null;
    }

    _onLoaded() {
        let tokens = this._objectManager.getProxiesForInterface('org.gnome.SettingsDaemon.Smartcard.Token');

        for (let i = 0; i < tokens.length; i++)
            this._addToken(tokens[i]);

        this._objectManager.connect('interface-added', (objectManager, interfaceName, proxy) => {
            if (interfaceName === 'org.gnome.SettingsDaemon.Smartcard.Token')
                this._addToken(proxy);
        });

        this._objectManager.connect('interface-removed', (objectManager, interfaceName, proxy) => {
            if (interfaceName === 'org.gnome.SettingsDaemon.Smartcard.Token')
                this._removeToken(proxy);
        });
    }

    _updateToken(token) {
        let objectPath = token.get_object_path();

        delete this._insertedTokens[objectPath];

        if (token.IsInserted)
            this._insertedTokens[objectPath] = token;

        if (token.UsedToLogin)
            this._loginToken = token;
    }

    _addToken(token) {
        this._updateToken(token);

        token._smartcardSignalId = token.connect('g-properties-changed', (proxy, properties) => {
            const isInsertedChanged = !!properties.lookup_value('IsInserted', null);
            if (isInsertedChanged) {
                this._updateToken(token);

                if (token.IsInserted)
                    this.emit('smartcard-inserted', token);
                else
                    this.emit('smartcard-removed', token);
            }
        });

        // Emit a smartcard-inserted at startup if it's already plugged in
        if (token.IsInserted)
            this.emit('smartcard-inserted', token);
    }

    _removeToken(token) {
        let objectPath = token.get_object_path();

        if (this._insertedTokens[objectPath] === token) {
            delete this._insertedTokens[objectPath];
            this.emit('smartcard-removed', token);
        }

        if (token._smartcardSignalId) {
            token.disconnect(token._smartcardSignalId);
            delete token._smartcardSignalId;
        }

        if (this._loginToken === token)
            this._loginToken = null;
    }

    hasInsertedTokens() {
        return Object.keys(this._insertedTokens).length > 0;
    }

    hasInsertedLoginToken() {
        if (!this._loginToken)
            return false;

        if (!this._loginToken.IsInserted)
            return false;

        return true;
    },

    loggedInWithToken() {
        if (this._loginToken)
            return true;

        return false;
    }

    lockOnRemoval() {
        return this._settings.get_string(SMARTCARD_REMOVAL_ACTION) === 'lock-screen';
    }
}

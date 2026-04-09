/**
 * ConfigStore - Per-device configuration persistence via localStorage.
 *
 * Keys are derived from the device serial number when available,
 * falling back to vendorId + productId + product name.
 *
 * Storage key format:
 *   mouse_config_{serialNumber}
 *   mouse_config_{vendorId}_{productId}_{name}
 */

const STORAGE_PREFIX = 'mouse_config_';

export class ConfigStore {

    /**
     * Derive a stable storage key from device information.
     *
     * @param {{ name: string, vendorId: number|string, productId: number|string, serialNumber?: string }} deviceInfo
     * @returns {string}
     */
    static getDeviceKey(deviceInfo) {
        if (deviceInfo.serialNumber && deviceInfo.serialNumber.length > 0) {
            return `${STORAGE_PREFIX}${deviceInfo.serialNumber}`;
        }
        return `${STORAGE_PREFIX}${deviceInfo.vendorId}_${deviceInfo.productId}_${deviceInfo.name}`;
    }

    /**
     * Detect brand from vendorId.
     *   0x046D -> logitech
     *   0x1532 -> razer
     *
     * @param {number|string} vendorId
     * @returns {'logitech'|'razer'|'unknown'}
     */
    static _detectBrand(vendorId) {
        const vid = typeof vendorId === 'string' ? parseInt(vendorId, 16) : vendorId;
        if (vid === 0x046D) return 'logitech';
        if (vid === 0x1532) return 'razer';
        return 'unknown';
    }

    /**
     * Save a full configuration for the given device.
     *
     * @param {{ name: string, vendorId: number|string, productId: number|string, serialNumber?: string }} deviceInfo
     * @param {{ dpiX?: number, dpiY?: number, pollingRate?: number, rotation?: number }} settings
     */
    save(deviceInfo, settings) {
        const key = ConfigStore.getDeviceKey(deviceInfo);
        const config = {
            deviceKey: key,
            deviceName: deviceInfo.name,
            brand: ConfigStore._detectBrand(deviceInfo.vendorId),
            lastConnected: new Date().toISOString(),
            settings: {
                dpiX: settings.dpiX ?? 800,
                dpiY: settings.dpiY ?? settings.dpiX ?? 800,
                pollingRate: settings.pollingRate ?? 1000,
                rotation: settings.rotation ?? 0,
            },
        };
        localStorage.setItem(key, JSON.stringify(config));
    }

    /**
     * Load the stored configuration for a device.
     *
     * @param {{ name: string, vendorId: number|string, productId: number|string, serialNumber?: string }} deviceInfo
     * @returns {object|null}
     */
    load(deviceInfo) {
        const key = ConfigStore.getDeviceKey(deviceInfo);
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    /**
     * Return every saved device configuration.
     *
     * @returns {Array<object>}
     */
    getAllDevices() {
        const results = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key.startsWith(STORAGE_PREFIX)) continue;
            try {
                const config = JSON.parse(localStorage.getItem(key));
                results.push(config);
            } catch {
                // skip corrupt entries
            }
        }
        return results;
    }

    /**
     * Delete the stored configuration for a device.
     *
     * @param {{ name: string, vendorId: number|string, productId: number|string, serialNumber?: string }} deviceInfo
     */
    delete(deviceInfo) {
        const key = ConfigStore.getDeviceKey(deviceInfo);
        localStorage.removeItem(key);
    }

    /**
     * Merge partial settings into the existing configuration.
     * If no configuration exists yet, a new one is created with the
     * provided partial settings (remaining fields get defaults).
     *
     * @param {{ name: string, vendorId: number|string, productId: number|string, serialNumber?: string }} deviceInfo
     * @param {{ dpiX?: number, dpiY?: number, pollingRate?: number, rotation?: number }} partialSettings
     */
    updateSettings(deviceInfo, partialSettings) {
        const existing = this.load(deviceInfo);
        if (!existing) {
            this.save(deviceInfo, partialSettings);
            return;
        }
        existing.settings = { ...existing.settings, ...partialSettings };
        existing.lastConnected = new Date().toISOString();
        localStorage.setItem(existing.deviceKey, JSON.stringify(existing));
    }
}

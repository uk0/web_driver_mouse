/**
 * ConfigStore — Multi-profile config persistence per device serial number.
 *
 * Storage structure per device:
 * {
 *   deviceKey: "dev_{serialNumber}",
 *   deviceName, serialNumber, vendorId, productId, brand,
 *   activeProfile: "default",
 *   profiles: {
 *     "default": { name, dpiX, dpiY, pollingRate, rotation },
 *     "FPS":     { name, dpiX, dpiY, pollingRate, rotation },
 *   },
 *   lastConnected: ISO string,
 * }
 */

const API = '/api/configs';

export class ConfigStore {

  static deviceKey(info) {
    const id = info.serialNumber && info.serialNumber.length > 2
      ? info.serialNumber
      : `${info.vendorId}_${info.productId}`;
    return `dev_${id}`;
  }

  static detectBrand(vid) {
    const v = typeof vid === 'string' ? parseInt(vid, 16) : vid;
    if (v === 0x046D) return 'logitech';
    if (v === 0x1532) return 'razer';
    return 'unknown';
  }

  /** Get full device record (with all profiles). */
  async getDevice(deviceInfo) {
    const key = ConfigStore.deviceKey(deviceInfo);
    try {
      const r = await fetch(`${API}/${encodeURIComponent(key)}`);
      if (r.ok) return await r.json();
    } catch (_) {}
    return null;
  }

  /** Get or create device record. */
  async ensureDevice(deviceInfo) {
    let dev = await this.getDevice(deviceInfo);
    if (dev) return dev;
    dev = {
      deviceKey: ConfigStore.deviceKey(deviceInfo),
      deviceName: deviceInfo.name,
      serialNumber: deviceInfo.serialNumber || '',
      vendorId: deviceInfo.vendorId,
      productId: deviceInfo.productId,
      brand: ConfigStore.detectBrand(deviceInfo.vendorId),
      activeProfile: null,
      profiles: {},
      lastConnected: new Date().toISOString(),
    };
    await this._put(dev);
    return dev;
  }

  /** List profile names for a device. */
  async listProfiles(deviceInfo) {
    const dev = await this.getDevice(deviceInfo);
    if (!dev || !dev.profiles) return [];
    return Object.keys(dev.profiles);
  }

  /** Get a specific profile's settings. */
  async getProfile(deviceInfo, profileName) {
    const dev = await this.getDevice(deviceInfo);
    if (!dev || !dev.profiles) return null;
    return dev.profiles[profileName] || null;
  }

  /** Get the active profile settings (or null). */
  async getActiveProfile(deviceInfo) {
    const dev = await this.getDevice(deviceInfo);
    if (!dev || !dev.profiles || !dev.activeProfile) return null;
    return dev.profiles[dev.activeProfile] || null;
  }

  /** Save (create or update) a profile. */
  async saveProfile(deviceInfo, profileName, settings) {
    const dev = await this.ensureDevice(deviceInfo);
    dev.profiles[profileName] = {
      name: profileName,
      dpiX: settings.dpiX ?? 800,
      dpiY: settings.dpiY ?? settings.dpiX ?? 800,
      pollingRate: settings.pollingRate ?? 1000,
      rotation: settings.rotation ?? 0,
    };
    // If this is the only profile, make it active
    if (Object.keys(dev.profiles).length === 1) {
      dev.activeProfile = profileName;
    }
    dev.lastConnected = new Date().toISOString();
    await this._put(dev);
  }

  /** Set which profile is active. */
  async setActiveProfile(deviceInfo, profileName) {
    const dev = await this.getDevice(deviceInfo);
    if (!dev) return;
    dev.activeProfile = profileName;
    dev.lastConnected = new Date().toISOString();
    await this._put(dev);
  }

  /** Delete a profile. */
  async deleteProfile(deviceInfo, profileName) {
    const dev = await this.getDevice(deviceInfo);
    if (!dev || !dev.profiles) return;
    delete dev.profiles[profileName];
    if (dev.activeProfile === profileName) {
      const remaining = Object.keys(dev.profiles);
      dev.activeProfile = remaining.length > 0 ? remaining[0] : null;
    }
    await this._put(dev);
  }

  /** Rename a profile. */
  async renameProfile(deviceInfo, oldName, newName) {
    const dev = await this.getDevice(deviceInfo);
    if (!dev || !dev.profiles || !dev.profiles[oldName]) return;
    dev.profiles[newName] = { ...dev.profiles[oldName], name: newName };
    delete dev.profiles[oldName];
    if (dev.activeProfile === oldName) dev.activeProfile = newName;
    await this._put(dev);
  }

  /** Update settings of the active profile (quick save). */
  async updateActive(deviceInfo, partialSettings) {
    const dev = await this.getDevice(deviceInfo);
    if (!dev || !dev.activeProfile || !dev.profiles[dev.activeProfile]) return;
    Object.assign(dev.profiles[dev.activeProfile], partialSettings);
    dev.lastConnected = new Date().toISOString();
    await this._put(dev);
  }

  /** Get all devices (for saved devices list). */
  async getAllDevices() {
    try {
      const r = await fetch(API);
      if (r.ok) { const d = await r.json(); return d.devices || []; }
    } catch (_) {}
    return [];
  }

  /** Internal: PUT to server. */
  async _put(dev) {
    const key = dev.deviceKey;
    try {
      await fetch(`${API}/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dev),
      });
    } catch (_) {}
  }
}

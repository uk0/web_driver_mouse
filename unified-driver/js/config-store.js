/**
 * ConfigStore - Per-device configuration persistence.
 * Uses server-side API (/api/configs) with localStorage as fallback.
 */

const API_BASE = '/api/configs';
const STORAGE_PREFIX = 'mouse_config_';

export class ConfigStore {

  static getDeviceKey(deviceInfo) {
    if (deviceInfo.serialNumber && deviceInfo.serialNumber.length > 0) {
      return `${STORAGE_PREFIX}${deviceInfo.serialNumber}`;
    }
    return `${STORAGE_PREFIX}${deviceInfo.vendorId}_${deviceInfo.productId}_${deviceInfo.name}`;
  }

  static _detectBrand(vendorId) {
    const vid = typeof vendorId === 'string' ? parseInt(vendorId, 16) : vendorId;
    if (vid === 0x046D) return 'logitech';
    if (vid === 0x1532) return 'razer';
    return 'unknown';
  }

  /**
   * Save config to server (with localStorage fallback).
   */
  async save(deviceInfo, settings) {
    const key = ConfigStore.getDeviceKey(deviceInfo);
    const config = {
      deviceKey: key,
      deviceName: deviceInfo.name,
      brand: ConfigStore._detectBrand(deviceInfo.vendorId),
      serialNumber: deviceInfo.serialNumber || '',
      vendorId: deviceInfo.vendorId,
      productId: deviceInfo.productId,
      lastConnected: new Date().toISOString(),
      settings: {
        dpiX: settings.dpiX ?? 800,
        dpiY: settings.dpiY ?? settings.dpiX ?? 800,
        pollingRate: settings.pollingRate ?? 1000,
        rotation: settings.rotation ?? 0,
      },
    };

    // Save to server
    try {
      await fetch(`${API_BASE}/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
    } catch (_) {}

    // Also save to localStorage as fallback
    try { localStorage.setItem(key, JSON.stringify(config)); } catch (_) {}
  }

  /**
   * Load config from server (fallback to localStorage).
   */
  async load(deviceInfo) {
    const key = ConfigStore.getDeviceKey(deviceInfo);

    // Try server first
    try {
      const resp = await fetch(`${API_BASE}/${encodeURIComponent(key)}`);
      if (resp.ok) return await resp.json();
    } catch (_) {}

    // Fallback to localStorage
    try {
      const raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw);
    } catch (_) {}

    return null;
  }

  /**
   * Get all saved device configs from server (fallback to localStorage).
   */
  async getAllDevices() {
    // Try server
    try {
      const resp = await fetch(API_BASE);
      if (resp.ok) {
        const data = await resp.json();
        return data.devices || [];
      }
    } catch (_) {}

    // Fallback to localStorage
    const results = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k.startsWith(STORAGE_PREFIX)) continue;
        try { results.push(JSON.parse(localStorage.getItem(k))); } catch (_) {}
      }
    } catch (_) {}
    return results;
  }

  /**
   * Delete config from server and localStorage.
   */
  async delete(deviceInfo) {
    const key = ConfigStore.getDeviceKey(deviceInfo);
    try { await fetch(`${API_BASE}/${encodeURIComponent(key)}`, { method: 'DELETE' }); } catch (_) {}
    try { localStorage.removeItem(key); } catch (_) {}
  }

  /**
   * Update just the settings portion.
   */
  async updateSettings(deviceInfo, partialSettings) {
    const existing = await this.load(deviceInfo);
    if (!existing) {
      return this.save(deviceInfo, partialSettings);
    }
    existing.settings = { ...existing.settings, ...partialSettings };
    existing.lastConnected = new Date().toISOString();

    const key = ConfigStore.getDeviceKey(deviceInfo);
    try {
      await fetch(`${API_BASE}/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(existing),
      });
    } catch (_) {}
    try { localStorage.setItem(key, JSON.stringify(existing)); } catch (_) {}
  }
}

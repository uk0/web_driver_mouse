/**
 * Razer Mouse WebHID Protocol Driver
 *
 * 90-byte feature report protocol. Automatically probes all HID interfaces
 * to find the one that actually accepts feature-report writes (the control
 * interface), since Razer mice expose 3+ interfaces per device.
 */

import { getRazerDevice } from '../devices.js';

const RAZER_VENDOR_ID = 0x1532;
const REPORT_LEN = 90;
const REPORT_ID  = 0x00;

const STATUS_NEW     = 0x00;
const STATUS_BUSY    = 0x01;
const STATUS_SUCCESS = 0x02;
const STATUS_FAILURE = 0x03;

const POLLING_RATE_MAP = {
  125:  0x01, 250:  0x02, 500:  0x04, 1000: 0x08,
  2000: 0x10, 4000: 0x20, 8000: 0x40,
};

const POLLING_RATE_MAP_REV = {
  125:  0x40, 250:  0x20, 500:  0x10, 1000: 0x08,
  2000: 0x04, 4000: 0x02, 8000: 0x01,
};

const DEFAULT_TX_ID = 0x1F; // fallback for probe before device DB is loaded
const MAX_RETRIES   = 10;
const RETRY_BASE_MS = 20;

/* ------------------------------------------------------------------ */
/*  Logging helper — callers register a callback via onLog()          */
/* ------------------------------------------------------------------ */
let _logFn = null;
function _log(msg, type = 'info') {
  if (_logFn) _logFn(msg, type);
}

function _hex(buf) {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function _crc(buf) {
  let v = 0;
  for (let i = 2; i < 88; i++) v ^= buf[i];
  return v;
}

/* ------------------------------------------------------------------ */
/*  Exported class                                                    */
/* ------------------------------------------------------------------ */
export class RazerProtocol {

  _device = null;
  _deviceInfo = null;
  _txId = 0;
  _inputCallback = null;
  _boundInputHandler = null;

  constructor() {}

  /* ======================== Public API ======================== */

  /**
   * Register a log callback: (message, type) => void
   * type is 'info' | 'send' | 'receive' | 'success' | 'error'
   */
  onLog(fn) { _logFn = typeof fn === 'function' ? fn : null; }

  onInputReport(cb) {
    this._inputCallback = typeof cb === 'function' ? cb : null;
  }

  isConnected() {
    return this._device !== null && this._device.opened === true;
  }

  getDeviceInfo() {
    return this._deviceInfo ? { ...this._deviceInfo } : null;
  }

  /* ======================== Connect ======================== */

  /** Manual connect — opens browser picker then connects. */
  async connect() {
    if (!navigator.hid) throw new Error('WebHID not supported');
    _log('Requesting Razer HID device (VID 0x1532)...', 'info');
    await navigator.hid.requestDevice({ filters: [{ vendorId: RAZER_VENDOR_ID }] });
    return this._connectFromGranted();
  }

  /** Auto-reconnect — uses previously granted permissions, no picker. */
  async reconnect() {
    if (!navigator.hid) throw new Error('WebHID not supported');
    _log('Checking cached Razer device permissions...', 'info');
    return this._connectFromGranted();
  }

  /** Shared connect logic after permissions are granted. */
  async _connectFromGranted() {
    const all = await navigator.hid.getDevices();
    const razer = all.filter(d => d.vendorId === RAZER_VENDOR_ID);
    _log(`Found ${razer.length} Razer HID interface(s)`, 'info');

    if (razer.length === 0) throw new Error('No Razer device permitted.');

    // Log every interface for debugging
    for (let i = 0; i < razer.length; i++) {
      const d = razer[i];
      const cols = d.collections.map(c => {
        const fr = c.featureReports ? c.featureReports.length : 0;
        const ir = c.inputReports ? c.inputReports.length : 0;
        const or = c.outputReports ? c.outputReports.length : 0;
        return `UP:0x${c.usagePage.toString(16)} U:0x${c.usage.toString(16)} FR:${fr} IR:${ir} OR:${or}`;
      });
      _log(`  [${i}] PID:0x${d.productId.toString(16)} "${d.productName}" collections=[${cols.join(' | ')}]`, 'info');
    }

    // Group by productId
    const groups = new Map();
    for (const d of razer) {
      if (!groups.has(d.productId)) groups.set(d.productId, []);
      groups.get(d.productId).push(d);
    }

    const firstGroup = groups.values().next().value;
    _log(`Probing ${firstGroup.length} interface(s) for PID 0x${firstGroup[0].productId.toString(16)}...`, 'info');

    // Sort: prefer interfaces with vendor usagePage (0xFF00+) and featureReports
    const sorted = [...firstGroup].sort((a, b) => {
      const sa = this._scoreInterface(a);
      const sb = this._scoreInterface(b);
      return sb - sa;
    });

    // Probe each interface by trying to send + receive a battery command
    let controlDevice = null;
    for (let i = 0; i < sorted.length; i++) {
      const dev = sorted[i];
      const score = this._scoreInterface(dev);
      _log(`  Probing interface ${i} (score=${score})...`, 'info');
      try {
        if (!dev.opened) await dev.open();

        // Probe with battery level query (Class 0x07, ID 0x80)
        const probe = this._buildBuf(0x07, 0x80, 0x02, [0x00, 0x00], DEFAULT_TX_ID);
        _log(`    SEND: ${_hex(probe.slice(0, 20))}...`, 'send');
        await dev.sendFeatureReport(REPORT_ID, probe);
        await _sleep(30);

        const resp = await dev.receiveFeatureReport(REPORT_ID);
        const data = new Uint8Array(resp.buffer);
        _log(`    RECV: ${_hex(data.slice(0, 20))}... status=0x${data[0].toString(16)}`, 'receive');

        if (data[0] === STATUS_SUCCESS || data[0] === STATUS_BUSY) {
          controlDevice = dev;
          _log(`  -> Interface ${i} WORKS (status=0x${data[0].toString(16)})`, 'success');
          break;
        }
      } catch (e) {
        _log(`  -> Interface ${i} failed: ${e.message}`, 'error');
        try { if (dev.opened) await dev.close(); } catch (_) {}
      }
    }

    if (!controlDevice) {
      throw new Error('No working Razer control interface found.');
    }

    this._device = controlDevice;

    // Look up device in database
    const pid = controlDevice.productId;
    const devDb = getRazerDevice(pid);
    this._devDb = devDb;
    _log(`Device DB: "${devDb.name}" type=${devDb.type} txId=0x${devDb.txId.toString(16)} pollingReversed=${devDb.pollingReversed}`, 'info');

    // Wire up input reports
    this._boundInputHandler = this._onInput.bind(this);
    this._device.addEventListener('inputreport', this._boundInputHandler);

    // Flush any stale response from the probe before querying serial
    await _sleep(50);
    try { await this._device.receiveFeatureReport(REPORT_ID); } catch (_) {}

    // Query serial number
    _log('Querying serial number...', 'info');
    const serial = await this._querySerial();
    _log(`Serial: "${serial || '(empty)'}"`, serial ? 'success' : 'info');

    this._deviceInfo = {
      name:         devDb.name !== 'Unknown' ? devDb.name : (controlDevice.productName || 'Razer Mouse'),
      vendorId:     controlDevice.vendorId,
      productId:    controlDevice.productId,
      serialNumber: serial,
    };

    return { device: this._device, deviceInfo: { ...this._deviceInfo } };
  }

  async disconnect() {
    if (this._device) {
      if (this._boundInputHandler) {
        this._device.removeEventListener('inputreport', this._boundInputHandler);
        this._boundInputHandler = null;
      }
      if (this._device.opened) await this._device.close();
      this._device = null;
      this._deviceInfo = null;
    }
  }

  /* ======================== DPI ======================== */

  async setDPI(x, y) {
    x = Math.max(100, Math.min(30000, Math.round(x)));
    y = Math.max(100, Math.min(30000, Math.round(y)));

    _log(`Setting DPI X=${x} Y=${y}`, 'info');
    const cmd = this._buildBuf(0x04, 0x06, 0x0A, [
      0x01, 0x01, 0x01, 0x00,
      (x >> 8) & 0xFF, x & 0xFF,
      (y >> 8) & 0xFF, y & 0xFF,
      0x00, 0x00,
    ]);
    const ok = await this._sendCmd(cmd);
    if (!ok) return false;

    await _sleep(60);
    const save = this._buildBuf(0x04, 0x86, 0x01, [0x01]);
    return this._sendCmd(save);
  }

  /* ======================== Polling Rate ======================== */

  async setPollingRate(rateHz) {
    const reversed = this._devDb && this._devDb.pollingReversed;
    const map = reversed ? POLLING_RATE_MAP_REV : POLLING_RATE_MAP;
    const mask = map[rateHz];
    if (mask === undefined) throw new Error(`Unsupported rate ${rateHz} Hz`);

    _log(`Setting polling rate ${rateHz} Hz (mask=0x${mask.toString(16)}${reversed ? ' [REV]' : ''})`, 'info');
    const cmd = this._buildBuf(0x00, 0x40, 0x02, [0x01, mask]);
    return this._sendCmd(cmd);
  }

  /* ======================== Battery ======================== */

  async getBattery() {
    _log('Querying battery...', 'info');

    // Battery level
    const levelCmd = this._buildBuf(0x07, 0x80, 0x02, [0x00, 0x00]);
    const levelResp = await this._sendAndRecv(levelCmd);

    let level = 0;
    if (levelResp && levelResp[0] === STATUS_SUCCESS) {
      const raw = levelResp[9];
      level = Math.round((raw / 255) * 100);
      _log(`Battery raw=${raw} -> ${level}%`, 'success');
    } else {
      _log(`Battery level query failed (status=0x${levelResp ? levelResp[0].toString(16) : 'null'})`, 'error');
    }

    await _sleep(60);

    // Charging status
    const chargeCmd = this._buildBuf(0x07, 0x84, 0x02, [0x00, 0x00]);
    const chargeResp = await this._sendAndRecv(chargeCmd);

    let charging = false;
    if (chargeResp && chargeResp[0] === STATUS_SUCCESS) {
      charging = chargeResp[9] !== 0x00;
      _log(`Charging: ${charging}`, 'success');
    }

    return { level, charging };
  }

  /* ======================== Rotation ======================== */

  async setRotation(angle) {
    angle = Math.max(-44, Math.min(44, Math.round(angle)));
    const angleByte = angle < 0 ? (256 + angle) : angle;

    _log(`Setting rotation ${angle} deg (byte=0x${angleByte.toString(16)})`, 'info');
    const cmd = this._buildBuf(0x0B, 0x14, 0x03, [0x01, 0x01, angleByte]);
    return this._sendCmd(cmd);
  }

  /* ======================== Internal ======================== */

  _scoreInterface(dev) {
    let score = 0;
    for (const c of dev.collections) {
      if (c.usagePage >= 0xFF00) score += 10;
      if (c.featureReports && c.featureReports.length > 0) score += 100;
    }
    return score;
  }

  _onInput(event) {
    if (this._inputCallback) {
      this._inputCallback({
        reportId: event.reportId,
        data: new Uint8Array(event.data.buffer),
      });
    }
  }

  /**
   * Build 90-byte command. Uses device-specific txId by default.
   */
  _buildBuf(cls, id, size, args = [], txId = null) {
    const buf = new Uint8Array(REPORT_LEN);
    buf[0] = STATUS_NEW;
    const defaultTx = this._devDb ? this._devDb.txId : 0x1F;
    buf[1] = txId !== null ? (txId & 0xFF) : defaultTx;
    buf[5] = size;
    buf[6] = cls;
    buf[7] = id;
    for (let i = 0; i < args.length && i < 80; i++) buf[8 + i] = args[i];
    buf[88] = _crc(buf);
    return buf;
  }

  /**
   * Send feature report and return true on success.
   */
  async _sendCmd(buf) {
    if (!this.isConnected()) throw new Error('Not connected');
    _log(`SEND [${buf[6].toString(16)}:${buf[7].toString(16)}]: ${_hex(buf.slice(0, 20))}...`, 'send');
    try {
      await this._device.sendFeatureReport(REPORT_ID, buf);
      return true;
    } catch (e) {
      _log(`Send failed: ${e.message}`, 'error');
      throw e;
    }
  }

  /**
   * Send command, then poll receiveFeatureReport with retries.
   * Returns the 90-byte response or null.
   */
  async _sendAndRecv(buf) {
    await this._sendCmd(buf);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await _sleep(RETRY_BASE_MS + attempt * 10);
      try {
        const view = await this._device.receiveFeatureReport(REPORT_ID);
        const data = new Uint8Array(view.buffer);
        const status = data[0];

        _log(`RECV [attempt ${attempt}]: status=0x${status.toString(16)} ${_hex(data.slice(0, 20))}...`, 'receive');

        if (status === STATUS_SUCCESS) return data;
        if (status === STATUS_FAILURE) {
          _log('Device returned FAILURE', 'error');
          return data;
        }
        // STATUS_BUSY or STATUS_NEW -> retry
        if (status === STATUS_BUSY) {
          _log(`Busy, retrying (${attempt + 1}/${MAX_RETRIES})...`, 'info');
        }
      } catch (e) {
        _log(`receiveFeatureReport error: ${e.message}`, 'error');
        return null;
      }
    }

    _log('Max retries exceeded', 'error');
    return null;
  }

  /**
   * Query serial number: Class 0x00, ID 0x82, Size 0x16, TX 0x1F
   */
  async _querySerial() {
    try {
      const cmd = this._buildBuf(0x00, 0x82, 0x16, []);
      const resp = await this._sendAndRecv(cmd);
      if (!resp || resp[0] !== STATUS_SUCCESS) {
        _log(`Serial query failed (status=${resp ? '0x' + resp[0].toString(16) : 'null'})`, 'error');
        return '';
      }

      const chars = [];
      for (let i = 8; i < 30; i++) {
        if (resp[i] === 0x00) break;
        if (resp[i] >= 0x20 && resp[i] <= 0x7E) {
          chars.push(String.fromCharCode(resp[i]));
        }
      }
      const serial = chars.join('').trim();
      _log(`Serial response bytes: ${_hex(resp.slice(8, 30))}`, 'info');
      return serial;
    } catch (e) {
      _log(`Serial query error: ${e.message}`, 'error');
      return '';
    }
  }
}
